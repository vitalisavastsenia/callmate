import { authHeaders } from './fixtures/auth.mjs';
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { api as contracts, DomainEventSchema, ManualCallSnapshotSchema } from "@callmate/contracts";
import { reviewPlanFixture } from "@callmate/contracts/fixtures";
import { openStore } from "../dist/storage.js";
import { XMLParser } from "fast-xml-parser";
import { WebSocket } from "ws";
import { loadConfig } from "../dist/config.js";
import { createRuntime } from "../dist/server.js";
import twilio from "twilio";
import Database from "better-sqlite3";

const sid = (prefix) => prefix + randomBytes(16).toString("hex");
async function until(predicate) {
  for (let index = 0; index < 200; index++) { if (await predicate()) return; await delay(10); }
  assert.fail("Timed out waiting for console/relay traffic");
}
async function fixture(t, options = {}) {
  const calls = new Map(); const peers = []; let creates = 0; let hungUp = 0; let logs = "";
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz") {
      if (options.unavailable) { res.writeHead(503).end('{}'); return; }
      if (options.beforeHealthReply) await options.beforeHealthReply();
      res.end(JSON.stringify({ mock: true, service: "CallMate Mock ConversationRelay" })); return;
    }
    assert.equal(req.headers.authorization, "Basic " + Buffer.from("mock:mock-local-only").toString("base64"));
    if (req.method === "POST" && req.url.endsWith("/Calls.json")) {
      creates++;
      if (options.reject) { res.writeHead(401).end('{}'); return; }
      if (options.ambiguous) { res.writeHead(502).end('{}'); return; }
      const form = new URLSearchParams(raw); assert.equal(form.get("To"), "+48111111111");
      const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" }).parse(form.get("Twiml"));
      const relay = parsed.Response.Connect.ConversationRelay;
      const call = { sid: sid("CA"), account_sid: config.mockAccountSid, from: "+48000000000", to: "+48111111111",
        status: options.createStatus ?? "ringing", relay, xml: form.get("Twiml"), callbackUrl: form.get("StatusCallback"), form };
      calls.set(call.sid, call); const serialized = JSON.stringify(call);
      if (options.beforeCreateReply) await options.beforeCreateReply(call);
      if (options.loseCreateReply) res.destroy(); else res.writeHead(201).end(serialized);
      return;
    }
    const outputMatch = /^\/mock\/v1\/calls\/(CA[0-9a-f]{32})\/outputs\/(\d+)$/.exec(req.url);
    if (outputMatch) {
      const call = calls.get(outputMatch[1]), sequence = Number(outputMatch[2]);
      const output = call?.outputs?.[sequence - 1];
      if (!options.playbackReceipts || !output) { res.writeHead(404).end('{}'); return; }
      if (options.beforeOutputReply) await options.beforeOutputReply(call, sequence);
      const receipt = { mock: true, kind: 'simulated_text_playback', accountSid: config.mockAccountSid,
        callSid: call.sid, sessionId: call.sessionId, sequence, ...output };
      res.end(JSON.stringify(options.receiptTransform ? options.receiptTransform(receipt) : receipt)); return;
    }
    const id = /\/Calls\/(CA[0-9a-f]{32})\.json$/.exec(req.url)?.[1]; const call = calls.get(id);
    if (!call) { res.writeHead(404).end('{}'); return; }
    if (req.method === "POST") {
      const status = new URLSearchParams(raw).get("Status");
      assert.ok(["completed", "canceled"].includes(status)); hungUp++;
      if (options.beforeHangup) await options.beforeHangup(call, status);
      if (status === "canceled" && call.status === "in-progress") { res.writeHead(409).end('{}'); return; }
      if (options.rejectHangup) { res.writeHead(503).end('{}'); return; }
      call.status = status; call.peer?.close(1000);
      if (options.beforeHangupReply) await options.beforeHangupReply(call);
    }
    const resource = { sid: call.sid, status: call.status, account_sid: call.account_sid, from: call.from, to: call.to };
    if (req.method === "GET" && options.beforeGetReply) await options.beforeGetReply(call);
    res.end(JSON.stringify(resource));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dataDir = mkdtempSync(join(tmpdir(), "callmate-console-"));
  const config = { ...loadConfig({ CALLMATE_DATA_DIR: dataDir, NODE_ENV: "test", TELEPHONY_PROVIDER: "mock", CALLMATE_MOCK_API_BASE: origin, ...options.env }), apiPort: 0, callbackPort: 0 };
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk; done(); } });
  let runtime = createRuntime(config, stream, options.simulator, options.development, options.retention);
  await runtime.start();
  config.mockRelayUrl = `ws://127.0.0.1:${runtime.callbacks.server.address().port}/ws/voice`;
  let apiOrigin = `http://127.0.0.1:${runtime.privateApi.server.address().port}`;
  t.after(async () => { peers.forEach((peer) => peer.terminate()); await runtime.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(dataDir, { recursive: true, force: true }); });
  return { calls, config, dataDir, auth: authHeaders(dataDir), get runtime() { return runtime; }, get apiOrigin() { return apiOrigin; },
    async restart(beforeStart) {
      await runtime.close();
      if (beforeStart) beforeStart();
      runtime = createRuntime(config, stream, options.simulator, options.development, options.retention); await runtime.start();
      config.mockRelayUrl = `ws://127.0.0.1:${runtime.callbacks.server.address().port}/ws/voice`;
      apiOrigin = `http://127.0.0.1:${runtime.privateApi.server.address().port}`;
    }, get creates() { return creates; }, get hungUp() { return hungUp; }, get logs() { return logs; },
    async api(path, method = "GET", body) {
      const response = await fetch(apiOrigin + path, { method, headers: { ...authHeaders(dataDir), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
    async callback(callSid, status, sequence, options = {}) {
      const call = calls.get(callSid); const url = new URL(call.callbackUrl);
      const fields = { AccountSid: config.mockAccountSid, CallSid: callSid, From: call.from, To: call.to,
        CallStatus: status, SequenceNumber: String(sequence), CallbackSource: "call-progress-events", Timestamp: new Date().toUTCString(), ...options.fields };
      const signature = twilio.getExpectedTwilioSignature(config.mockAuthToken, options.signUrl ?? url.href, fields);
      const headers = { "content-type": "application/x-www-form-urlencoded", "x-callmate-mock": "true", host: url.host,
        "x-twilio-signature": signature, ...options.headers };
      const payload = options.payload ?? new URLSearchParams(fields).toString();
      if (options.http) {
        const response = await fetch(url, { method: "POST", headers, body: payload });
        return { statusCode: response.status, body: await response.text() };
      }
      return runtime.callbacks.inject({ method: "POST", url: url.pathname + (options.query ?? ""), headers, payload });
    },
    async answer(id, overrides = {}) {
      const call = calls.get(id); const peer = new WebSocket(call.relay.url, { headers: { "X-CallMate-Mock": "true" } });
      peers.push(peer); peer.on("error", () => {}); peer.messages = [];
      peer.on("message", (raw) => {
        const message = JSON.parse(raw.toString()); peer.messages.push(message);
        if (message.type === 'text' && message.last) (call.outputs ??= []).push({
          textSha256: createHash('sha256').update(message.token).digest('hex'), language: message.lang, completedAt: new Date().toISOString() });
      });
      peer.closed = new Promise((resolve) => peer.once("close", (code) => resolve(code)));
      await once(peer, "open"); call.peer = peer; call.status = "in-progress";
      call.sessionId = overrides.sessionId ?? sid("VX");
      peer.send(JSON.stringify({ type: "setup", callSid: id, sessionId: call.sessionId, accountSid: config.mockAccountSid,
        from: "+48000000000", to: "+48111111111", customParameters: Object.fromEntries(call.relay.Parameter.map((parameter) => [parameter.name, parameter.value])), ...overrides }));
      return peer;
    },
  };
}
const input = (text = "Hola, quisiera una cita. 🧪 ") => ({ requestId: randomUUID(), initialMessage: text, language: "es-ES" });

test("backend UI starts a real mock-format call; Answer delivers initial text once and operator replies return through the relay", async (t) => {
  const app = await fixture(t); const message = "Здравствуйте! Хочу записаться. 🧪\nБез депозита. ";
  const created = await app.api("/api/dev/conversations", "POST", { ...input(message), language: "ru-RU" });
  assert.equal(created.status, 202); const conversation = created.body.conversation;
  assert.equal(conversation.status, "ringing"); assert.equal(app.creates, 1);
  assert.ok(!app.calls.get(conversation.callSid).xml.includes(message));
  assert.ok(!JSON.stringify(conversation).includes("authToken"));
  const peer = await app.answer(conversation.callSid); await until(() => peer.messages.length === 1);
  assert.deepEqual(peer.messages[0], { type: "text", token: message, lang: "ru-RU", last: true, interruptible: true, preemptible: true });
  const reply = '<img src=x onerror="alert(1)"> Да, завтра в 18:00. 🧪 ';
  peer.send(JSON.stringify({ type: "prompt", voicePrompt: reply.slice(0, 15), lang: "ru-RU", last: false }));
  await delay(30);
  assert.equal((await app.api("/api/dev/conversations")).body.conversation.responses.length, 0);
  peer.send(JSON.stringify({ type: "prompt", voicePrompt: reply.slice(15), lang: "ru-RU", last: true }));
  let snapshot;
  await until(async () => { snapshot = (await app.api("/api/dev/conversations")).body.conversation; return snapshot.responses.length === 1; });
  assert.equal(snapshot.responses[0].text, reply); assert.equal(snapshot.responses[0].language, "ru-RU");
  assert.equal(peer.messages.length, 1); // Console replies are captured, not automatically echoed back.
  assert.equal(app.runtime.controller.history(20).items[0].id, conversation.id);
  const stopped = await app.api(`/api/dev/conversations/${conversation.id}/stop`, "POST", {});
  assert.equal(stopped.body.conversation.status, "completed"); await peer.closed;
  assert.equal(app.hungUp, 1);
  for (const text of [message, reply, app.calls.get(conversation.callSid).relay.Parameter.find((parameter) => parameter.name === "authToken").value]) assert.ok(!app.logs.includes(text));
});

test("duplicate Start is idempotent and a second active conversation cannot create another call", async (t) => {
  const app = await fixture(t); const request = input();
  const results = await Promise.all([app.api("/api/dev/conversations", "POST", request), app.api("/api/dev/conversations", "POST", request)]);
  assert.ok(results.every((result) => result.status === 202)); assert.equal(app.creates, 1);
  assert.equal((await app.api("/api/dev/conversations", "POST", { ...request, initialMessage: "changed" })).status, 409);
  assert.equal((await app.api("/api/dev/conversations", "POST", input())).status, 409);
  const stopped = await app.api(`/api/dev/conversations/${request.requestId}/stop`, "POST", {});
  assert.equal(stopped.body.conversation.status, "completed");
  assert.equal((await app.api("/api/dev/conversations", "POST", input())).status, 202);
  assert.equal(app.creates, 2);
});

test("relay correlation rejects a wrong token; provider terminal status is reflected without a second call", async (t) => {
  const app = await fixture(t); const created = (await app.api("/api/dev/conversations", "POST", input())).body.conversation;
  const bad = await app.answer(created.callSid, { customParameters: { conversationId: created.id, authToken: "invalid" } });
  assert.equal(await bad.closed, 1008); assert.equal(bad.messages.length, 0);
  const valid = await app.answer(created.callSid);
  await until(() => valid.messages.length === 1);
  app.calls.get(created.callSid).status = "busy";
  const snapshot = (await app.api(`/api/dev/conversations/${created.id}`)).body.conversation;
  assert.equal(snapshot.status, "failed"); assert.equal(snapshot.responses.length, 0); assert.equal(app.creates, 1);
});

test("backend serves private console assets and validates input; production cannot create mock calls", async (t) => {
  const app = await fixture(t);
  for (const path of ["/", "/console/app.js", "/console/styles.css"]) {
    const response = await fetch(app.apiOrigin + path); assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
  }
  for (const body of [{}, { ...input(), initialMessage: "   " }, { ...input(), initialMessage: "x".repeat(8001) }, { ...input(), language: "invalid" }, { ...input(), url: "https://example.com" }]) {
    assert.equal((await app.api("/api/dev/conversations", "POST", body)).status, 400);
  }
  assert.equal(app.creates, 0);
  assert.equal((await fetch(app.apiOrigin + "/api/dev/conversations", { headers: { Origin: "https://foreign.example" } })).status, 400);
  assert.equal((await app.runtime.callbacks.inject({ url: "/api/dev/conversations" })).statusCode, 404);
  const bad = loadConfig({ CALLMATE_DATA_DIR: join(tmpdir(), "unused"), NODE_ENV: "production", TELEPHONY_PROVIDER: "mock" });
  const { DevelopmentConversations } = await import("../dist/development-conversations.js");
  const disabledDir = mkdtempSync(join(tmpdir(), "callmate-disabled-"));
  const disabledStore = openStore(disabledDir);
  const disabled = new DevelopmentConversations(bad, disabledStore);
  await assert.rejects(disabled.start(input()), (error) => error.status === 503);
  await disabled.close(); disabledStore.close(); rmSync(disabledDir, { recursive: true, force: true });
});

test("unavailable and ambiguous mock requests are visible without automatic redial", async (t) => {
  const unavailable = await fixture(t, { unavailable: true });
  const failed = (await unavailable.api("/api/dev/conversations", "POST", input())).body.conversation;
  assert.equal(failed.status, "failed"); assert.match(failed.error, /unavailable/); assert.equal(unavailable.creates, 0);
  const ambiguous = await fixture(t, { ambiguous: true }); const request = input();
  const unknown = (await ambiguous.api("/api/dev/conversations", "POST", request)).body.conversation;
  assert.equal(unknown.status, "unknown"); assert.match(unknown.error, /no automatic retry/);
  await ambiguous.api("/api/dev/conversations", "POST", request);
  assert.equal((await ambiguous.api("/api/dev/conversations", "POST", input())).status, 409);
  assert.equal(ambiguous.creates, 1);
});

test("rejected create is visible and never retried, and shutdown hangs up outstanding ringing calls", async (t) => {
  const rejected = await fixture(t, { reject: true });
  const failed = (await rejected.api("/api/dev/conversations", "POST", input())).body.conversation;
  assert.equal(failed.status, "failed"); assert.match(failed.error, /rejected/); assert.equal(rejected.creates, 1);
  const app = await fixture(t); await app.api("/api/dev/conversations", "POST", input());
  await app.runtime.close(); assert.equal(app.hungUp, 1);
});

async function stream(t, app, id, after = 0) {
  const response = await fetch(`${app.apiOrigin}/api/v1/calls/${id}/events`, {
    headers: { ...app.auth, 'Last-Event-ID': String(after) }, signal: AbortSignal.timeout(8000),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  const close = () => reader.cancel().catch(() => {}); t.after(close);
  return { close, async next() {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end !== -1) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (frame.startsWith(':')) continue;
        const value = (key) => frame.split('\n').find((line) => line.startsWith(key + ': '))?.slice(key.length + 2);
        return { event: value('event'), id: value('id'), data: JSON.parse(value('data')) };
      }
      const chunk = await reader.read(); if (chunk.done) return null;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  } };
}

test('manual mock calls share snapshots, persisted transcript, live/replayed SSE, Stop and history without booking authority', async (t) => {
  const app = await fixture(t); const request = { ...input('  Hola, quiero información. 🧪\n '), language: 'es-ES' };
  const initial = (await app.api('/api/dev/conversations', 'POST', request)).body.conversation;
  const get = async () => {
    const result = await app.api(`/api/v1/calls/${initial.id}`); assert.equal(result.status, 200);
    contracts.getCall.response.parse(result.body); return result.body.call;
  };
  let snapshot = await get(); ManualCallSnapshotSchema.parse(snapshot);
  assert.equal(snapshot.kind, 'manual_mock'); assert.equal(snapshot.plan, null);
  assert.equal(snapshot.messages[0].originalText, request.initialMessage);
  assert.equal(snapshot.messages[0].playback, 'withheld');
  const live = await stream(t, app, initial.id);
  const events = [];
  for (let i = 1; i <= snapshot.lastEventSequence; i++) {
    const frame = await live.next(); assert.equal(frame.id, String(i)); events.push(DomainEventSchema.parse(frame.data));
  }
  const peer = await app.answer(initial.callSid); await until(() => peer.messages.length === 1);
  for (let i = 0; i < 2; i++) events.push(DomainEventSchema.parse((await live.next()).data));
  assert.equal(events.at(-2).payload.callState, 'connected');
  assert.equal(events.at(-1).payload.playback, 'generated'); // Submission never claims audible playback.
  const reply = '  Sí, mañana a las seis. 🧪\n ';
  peer.send(JSON.stringify({ type: 'prompt', voicePrompt: reply.slice(0, 12), lang: 'es-ES', last: false }));
  await delay(30); assert.equal((await get()).messages.length, 1);
  peer.send(JSON.stringify({ type: 'prompt', voicePrompt: reply.slice(12), lang: 'es-ES', last: true }));
  const received = DomainEventSchema.parse((await live.next()).data); events.push(received);
  assert.equal(received.type, 'transcript.updated'); assert.equal(received.payload.originalText, reply);
  const cursor = received.sequence; await live.close();
  snapshot = await get(); assert.equal(snapshot.messages[1].originalText, reply);
  assert.equal(snapshot.messages[1].translationEn, null); assert.equal(snapshot.outcome.status, 'pending');
  const denied = await app.api(`/api/v1/calls/${initial.id}/approvals`, 'POST', {
    approvalId: randomUUID(), plan: { planId: randomUUID(), planVersion: 1 },
    offer: { offerId: randomUUID(), offerVersion: 1 }, decision: 'approve',
  });
  assert.equal(denied.status, 400); // A valid idempotency header is required before any command.
  const approval = await fetch(`${app.apiOrigin}/api/v1/calls/${initial.id}/approvals`, { method: 'POST',
    headers: { ...app.auth, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({
      approvalId: randomUUID(), plan: { planId: randomUUID(), planVersion: 1 },
      offer: { offerId: randomUUID(), offerVersion: 1 }, decision: 'approve',
    }) });
  assert.equal(approval.status, 409); assert.equal((await approval.json()).error.code, 'CALL_NOT_ACTIVE');
  const stopped = await app.api(`/api/v1/calls/${initial.id}/stop`, 'POST', {});
  assert.equal(stopped.status, 202); contracts.stopCall.response.parse(stopped.body);
  assert.equal(stopped.body.call.callState, 'ended'); assert.equal(stopped.body.call.outcome.reason, 'user_stopped');
  assert.equal((await app.api(`/api/v1/calls/${initial.id}/stop`, 'POST', {})).body.call.revision, stopped.body.call.revision);
  assert.equal(app.hungUp, 1);
  const replay = await stream(t, app, initial.id, cursor);
  for (let i = cursor + 1; i <= stopped.body.call.lastEventSequence; i++) {
    const frame = await replay.next(); assert.equal(frame.id, String(i)); events.push(DomainEventSchema.parse(frame.data));
  }
  assert.equal(events.at(-1).payload.callState, 'ended');
  assert.ok(!events.some((event) => event.type === 'offer.updated' || event.type === 'approval.requested'));
  const history = await app.api('/api/v1/history'); contracts.history.response.parse(history.body);
  assert.equal(history.body.items[0].id, initial.id); assert.equal(history.body.items[0].kind, 'manual_mock');
  assert.equal(history.body.items[0].outcome.status, 'not_booked');
  const repository = openStore(app.dataDir); t.after(() => repository.close());
  assert.deepEqual(repository.calls.get(initial.id).call, stopped.body.call);
  assert.equal(repository.calls.events(initial.id, 0).at(-1).sequence, stopped.body.call.lastEventSequence);
  const token = app.calls.get(initial.callSid).relay.Parameter.find((p) => p.name === 'authToken').value;
  assert.ok(!JSON.stringify(repository.calls.get(initial.id)).includes(token));
  assert.ok(!JSON.stringify(repository.calls.events(initial.id, 0)).includes(token));
});

test('scripted and manual calls reserve one global slot, share paginated history and cannot collide idempotency keys', async (t) => {
  const app = await fixture(t, { simulator: { automatic: false, now: () => Date.parse('2026-10-15T10:00:00Z') } });
  const plan = (await app.api('/api/v1/plans', 'POST', reviewPlanFixture.request)).body.plan;
  const start = async (key = randomUUID()) => {
    const response = await fetch(app.apiOrigin + '/api/v1/calls', { method: 'POST', headers: {
      ...app.auth, 'content-type': 'application/json', 'idempotency-key': key,
    }, body: JSON.stringify({ planId: plan.id, planVersion: 1, mode: 'simulator' }) });
    return { status: response.status, body: await response.json() };
  };
  const scriptedRequest = { planId: plan.id, planVersion: 1, mode: 'simulator' };
  const request = input(); const manual = (await app.api('/api/dev/conversations', 'POST', request)).body.conversation;
  assert.throws(() => app.runtime.simulator.start(scriptedRequest, randomUUID()), { code: 'CALL_ALREADY_ACTIVE' });
  assert.equal((await start(request.requestId)).body.error.code, 'IDEMPOTENCY_CONFLICT');
  await app.api(`/api/v1/calls/${manual.id}/stop`, 'POST', {});
  const key = randomUUID(); app.runtime.simulator.start(scriptedRequest, key);
  const scripted = await start(key); assert.equal(scripted.status, 202);
  assert.equal((await app.api('/api/dev/conversations', 'POST', input())).body.error.code, 'CALL_ALREADY_ACTIVE');
  assert.equal((await app.api('/api/dev/conversations', 'POST', { ...input(), requestId: key })).body.error.code, 'IDEMPOTENCY_CONFLICT');
  await app.api(`/api/v1/calls/${scripted.body.call.id}/stop`, 'POST', {}); await app.runtime.simulator.tick();
  const third = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  const firstPage = (await app.api('/api/v1/history?limit=1')).body;
  assert.equal(firstPage.items[0].id, third.id);
  const secondPage = (await app.api(`/api/v1/history?limit=1&cursor=${third.id}`)).body;
  assert.equal(secondPage.items[0].id, scripted.body.call.id);
  const last = (await app.api(`/api/v1/history?limit=1&cursor=${scripted.body.call.id}`)).body;
  assert.equal(last.items[0].id, manual.id);
  assert.equal(app.creates, 2);
});

test('operator hangup persists completion and emits SSE without console polling or invented booking success', async (t) => {
  const app = await fixture(t); const manual = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  const peer = await app.answer(manual.callSid); await until(() => peer.messages.length === 1);
  const connected = app.runtime.controller.get(manual.id);
  const live = await stream(t, app, manual.id, connected.lastEventSequence);
  app.calls.get(manual.callSid).status = 'completed'; peer.close(1000);
  await until(() => app.runtime.controller.get(manual.id).callState === 'ended');
  const finished = app.runtime.controller.get(manual.id); assert.equal(finished.outcome.reason, 'development_only');
  const frames = [];
  for (let i = connected.lastEventSequence + 1; i <= finished.lastEventSequence; i++) frames.push((await live.next()).data);
  assert.equal(frames.at(-1).payload.callState, 'ended');
  assert.ok(!frames.some((event) => event.type === 'booking.updated' && event.payload.outcome.status === 'confirmed'));
});

test('Unicode history and idempotency survive backend restart; deletion clears snapshot, replay and console projections', async (t) => {
  const app = await fixture(t); const request = { ...input('  Здравствуйте! 🧪\n '), language: 'ru-RU' };
  const created = (await app.api('/api/dev/conversations', 'POST', request)).body.conversation;
  const peer = await app.answer(created.callSid); await until(() => peer.messages.length === 1);
  peer.send(JSON.stringify({ type: 'prompt', voicePrompt: '  Да, конечно. 🧪 ', lang: 'ru-RU', last: true }));
  await until(() => app.runtime.controller.get(created.id).messages.length === 2);
  assert.equal((await app.api(`/api/v1/calls/${created.id}/conversation`, 'DELETE')).status, 409);
  await app.api(`/api/v1/calls/${created.id}/stop`, 'POST', {});
  const completed = app.runtime.controller.get(created.id);
  await app.restart();
  const restored = (await app.api(`/api/v1/calls/${created.id}`)).body.call;
  assert.deepEqual(restored, completed);
  assert.equal((await app.api('/api/dev/conversations')).body.conversation.responses[0].text, '  Да, конечно. 🧪 ');
  assert.equal((await app.api('/api/dev/conversations', 'POST', request)).body.conversation.id, created.id);
  assert.equal(app.creates, 1);
  const live = await stream(t, app, created.id, completed.lastEventSequence);
  assert.equal((await app.api(`/api/v1/calls/${created.id}/conversation`, 'DELETE')).status, 200);
  assert.equal((await live.next()).data.type, 'conversation.deleted'); await live.close();
  const deleted = (await app.api(`/api/v1/calls/${created.id}`)).body.call;
  assert.deepEqual(deleted.messages, []); assert.equal(deleted.conversationData, 'deleted');
  const view = (await app.api('/api/dev/conversations')).body.conversation;
  assert.equal(view.initialMessage, ''); assert.deepEqual(view.responses, []);
  const reset = await stream(t, app, created.id);
  assert.equal((await reset.next()).event, 'reset'); assert.equal(await reset.next(), null);
  const repository = openStore(app.dataDir);
  assert.equal(repository.calls.events(created.id, 0).length, 1);
  assert.ok(!repository.calls.command(request.requestId).body.includes(request.initialMessage)); repository.close();
  await app.restart();
  assert.equal((await app.api('/api/dev/conversations', 'POST', request)).body.conversation.initialMessage, '');
  assert.equal(app.creates, 1);
});

test('Stop during an outstanding create keeps the shared slot until the returned provider call is hung up', async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const app = await fixture(t, { beforeCreateReply: () => gate }); const request = input();
  t.after(() => release());
  const start = app.api('/api/dev/conversations', 'POST', request);
  await until(() => app.creates === 1 && app.calls.size === 1);
  const stopped = await app.api(`/api/v1/calls/${request.requestId}/stop`, 'POST', {});
  assert.equal(stopped.body.call.callState, 'ending'); assert.equal(stopped.body.call.outcome.status, 'pending');
  assert.equal((await app.api('/api/dev/conversations', 'POST', input())).body.error.code, 'CALL_ALREADY_ACTIVE');
  release(); const result = await start;
  assert.equal(result.body.conversation.status, 'completed'); assert.equal(app.hungUp, 1); assert.equal(app.creates, 1);
  const events = app.runtime.controller.replayEvents(request.requestId, 0);
  assert.deepEqual(events.filter((e) => e.type === 'call.status').map((e) => e.payload.callState), ['creating', 'ending', 'ended']);
  assert.equal(app.runtime.controller.get(request.requestId).messages[0].playback, 'withheld');
});

test('unconfirmed hangup stays active in shared snapshots and history rather than allowing a second call', async (t) => {
  const app = await fixture(t, { rejectHangup: true });
  const manual = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  const result = await app.api(`/api/v1/calls/${manual.id}/stop`, 'POST', {});
  assert.equal(result.status, 202); assert.equal(result.body.call.callState, 'ending');
  assert.equal(result.body.call.outcome.status, 'pending');
  assert.equal((await app.api('/api/dev/conversations', 'POST', input())).body.error.code, 'CALL_ALREADY_ACTIVE');
  assert.equal((await app.api('/api/v1/history')).body.items[0].callState, 'ending');
  assert.match((await app.api('/api/dev/conversations')).body.conversation.error, /Hangup could not be confirmed/);
  app.calls.get(manual.callSid).status = 'completed';
  await until(() => app.runtime.controller.get(manual.id).callState === 'ended');
});

test('unknown creation remains reserved and idempotent after restart instead of being treated as an interrupted script', async (t) => {
  const app = await fixture(t, { ambiguous: true }); const request = input();
  const first = (await app.api('/api/dev/conversations', 'POST', request)).body.conversation;
  assert.equal(first.status, 'unknown');
  await app.restart();
  const snapshot = (await app.api(`/api/v1/calls/${first.id}`)).body.call;
  assert.equal(snapshot.kind, 'manual_mock'); assert.equal(snapshot.callState, 'reconciliation_required');
  assert.equal(snapshot.outcome.status, 'pending');
  assert.equal((await app.api('/api/dev/conversations', 'POST', request)).body.conversation.id, first.id);
  assert.equal((await app.api('/api/dev/conversations', 'POST', input())).body.error.code, 'CALL_ALREADY_ACTIVE');
  assert.equal(app.creates, 1);
});

test('queued mock dialing and later ringing are reflected in common snapshots without a browser poll', async (t) => {
  const app = await fixture(t, { createStatus: 'queued' });
  const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  assert.equal(app.runtime.controller.get(created.id).callState, 'dialing');
  app.calls.get(created.callSid).status = 'ringing';
  await until(() => app.runtime.controller.get(created.id).callState === 'ringing');
  const states = app.runtime.controller.replayEvents(created.id, 0).filter((e) => e.type === 'call.status').map((e) => e.payload.callState);
  assert.deepEqual(states, ['creating', 'dialing', 'ringing']);
});

test('official signed HTTP progress callbacks persist ordering and duplicates do not publish extra events', async (t) => {
  const app = await fixture(t); const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  const call = app.calls.get(created.callSid);
  assert.equal(call.form.get('StatusCallbackMethod'), 'POST');
  assert.deepEqual(call.form.getAll('StatusCallbackEvent'), ['initiated', 'ringing', 'answered', 'completed']);
  const live = await stream(t, app, created.id, app.runtime.controller.get(created.id).lastEventSequence);
  assert.equal((await app.callback(call.sid, 'in-progress', 2, { http: true })).statusCode, 204);
  const event = (await live.next()).data; assert.equal(event.type, 'call.status'); assert.equal(event.payload.callState, 'connected');
  const connected = app.runtime.controller.get(created.id);
  assert.equal(connected.messages[0].playback, 'withheld'); // Answered callback is not relay text submission.
  for (const [status, sequence] of [['in-progress', 2], ['ringing', 1], ['initiated', 0]]) {
    assert.equal((await app.callback(call.sid, status, sequence)).statusCode, 204);
    assert.deepEqual(app.runtime.controller.get(created.id), connected);
  }
  const duplicates = await Promise.all(Array.from({ length: 10 }, () => app.callback(call.sid, 'in-progress', 2)));
  assert.ok(duplicates.every((response) => response.statusCode === 204));
  assert.deepEqual(app.runtime.controller.get(created.id), connected);
  const repository = openStore(app.dataDir);
  assert.equal(repository.calls.get(created.id).internal.correlation.callbackSequence, 2); repository.close();
  assert.equal((await app.callback(call.sid, 'completed', 3)).statusCode, 204);
  assert.equal((await live.next()).data.type, 'booking.updated'); assert.equal((await live.next()).data.payload.callState, 'ended');
  const ended = app.runtime.controller.get(created.id);
  for (const [status, sequence] of [['completed', 3], ['in-progress', 100], ['failed', 101], ['ringing', 1]]) {
    assert.equal((await app.callback(call.sid, status, sequence)).statusCode, 204);
    assert.deepEqual(app.runtime.controller.get(created.id), ended);
  }
  assert.equal(app.runtime.controller.replayEvents(created.id, 0).length, ended.lastEventSequence);
  assert.equal(app.creates, 1); assert.equal(app.hungUp, 0);
});

test('higher-numbered regressions and stale REST results cannot move connected calls backwards', async (t) => {
  const app = await fixture(t); const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  await app.callback(created.callSid, 'in-progress', 2);
  const connected = app.runtime.controller.get(created.id);
  await app.callback(created.callSid, 'ringing', 10);
  assert.deepEqual(app.runtime.controller.get(created.id), connected);
  await app.api(`/api/dev/conversations/${created.id}`); // The provider fixture still reports ringing.
  assert.deepEqual(app.runtime.controller.get(created.id), connected);
  await app.callback(created.callSid, 'completed', 9); // Older than the durable cursor, even though terminal.
  assert.deepEqual(app.runtime.controller.get(created.id), connected);
  await app.callback(created.callSid, 'completed', 11);
  assert.equal(app.runtime.controller.get(created.id).callState, 'ended');
});

test('terminal callbacks before the create response returns cannot be overwritten by its stale ringing result', async (t) => {
  let app; let terminalSnapshot;
  app = await fixture(t, { beforeCreateReply: async (call) => {
    assert.equal((await app.callback(call.sid, 'completed', 3, { http: true })).statusCode, 204);
    terminalSnapshot = app.runtime.controller.get(new URL(call.callbackUrl).pathname.split('/').at(-1));
  } });
  const request = input(); const created = (await app.api('/api/dev/conversations', 'POST', request)).body.conversation;
  assert.equal(created.status, 'completed'); assert.deepEqual(app.runtime.controller.get(created.id), terminalSnapshot);
  assert.equal(app.creates, 1); assert.equal(app.hungUp, 0);
});

test('an answered callback before the create response cannot be regressed by queued or ringing create results', async (t) => {
  let app;
  app = await fixture(t, { createStatus: 'queued', beforeCreateReply: async (call) => {
    await app.callback(call.sid, 'in-progress', 2, { http: true });
  } });
  const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  assert.equal(created.status, 'connected'); assert.equal(app.runtime.controller.get(created.id).callState, 'connected');
  assert.equal(app.runtime.controller.get(created.id).messages[0].playback, 'withheld');
});

test('a late poll cannot reopen a completed call or interfere with the next attempt', async (t) => {
  let release; let waiting = false; let hold = true;
  const gate = new Promise((resolve) => { release = resolve; }); t.after(() => release());
  const app = await fixture(t, { beforeGetReply: async () => { if (hold) { hold = false; waiting = true; await gate; } } });
  const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  const pending = app.api(`/api/dev/conversations/${created.id}`); await until(() => waiting);
  await app.callback(created.callSid, 'completed', 3);
  const ended = app.runtime.controller.get(created.id);
  const next = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  release(); await pending;
  assert.deepEqual(app.runtime.controller.get(created.id), ended);
  assert.equal(app.runtime.controller.get(next.id).callState, 'ringing'); assert.equal(app.creates, 2);
});

test('Stop and recovery states cannot be cleared by newer nonterminal callbacks', async (t) => {
  const app = await fixture(t, { rejectHangup: true });
  const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  await app.api(`/api/v1/calls/${created.id}/stop`, 'POST', {});
  const stopping = app.runtime.controller.get(created.id);
  await app.callback(created.callSid, 'in-progress', 2);
  assert.deepEqual(app.runtime.controller.get(created.id), stopping);
  await app.restart();
  const recovering = app.runtime.controller.get(created.id);
  assert.equal(recovering.callState, 'reconciliation_required');
  await app.callback(created.callSid, 'ringing', 1); await app.callback(created.callSid, 'in-progress', 2);
  assert.deepEqual(app.runtime.controller.get(created.id), recovering);
  await app.callback(created.callSid, 'completed', 3);
  assert.equal(app.runtime.controller.get(created.id).outcome.reason, 'user_stopped'); assert.equal(app.creates, 1);
});

test('callback cursor, terminal tombstone and deletion remain effective across backend restarts', async (t) => {
  const app = await fixture(t); const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  await app.callback(created.callSid, 'completed', 3); const ended = app.runtime.controller.get(created.id);
  await app.restart();
  assert.equal((await app.callback(created.callSid, 'in-progress', 100)).statusCode, 204);
  assert.deepEqual(app.runtime.controller.get(created.id), ended);
  await app.api(`/api/v1/calls/${created.id}/conversation`, 'DELETE');
  const deleted = app.runtime.controller.get(created.id); await app.restart();
  await app.callback(created.callSid, 'completed', 3); await app.callback(created.callSid, 'ringing', 101);
  assert.deepEqual(app.runtime.controller.get(created.id), deleted);
  const repository = openStore(app.dataDir);
  assert.equal(repository.calls.get(created.id).internal.correlation.callbackSequence, 3);
  assert.equal(repository.calls.events(created.id, 0).length, 1); repository.close();
  assert.equal(app.creates, 1);
});

test('signed callback can correlate a lost create response without another call or a replayed greeting', async (t) => {
  const app = await fixture(t, { loseCreateReply: true });
  const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  assert.equal(created.callSid, null); assert.equal(created.status, 'unknown');
  const call = [...app.calls.values()][0];
  assert.equal((await app.callback(call.sid, 'completed', 3)).statusCode, 204);
  const view = (await app.api(`/api/dev/conversations/${created.id}`)).body.conversation;
  assert.equal(view.callSid, call.sid); assert.equal(view.status, 'completed');
  assert.equal(app.runtime.controller.get(created.id).messages[0].playback, 'withheld'); assert.equal(app.creates, 1);
});

test('callback authentication, encoding and correlation failures cannot consume a sequence or leak payloads', async (t) => {
  const app = await fixture(t); const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  const original = app.runtime.controller.get(created.id);
  const cases = [
    { headers: { 'x-twilio-signature': '' } }, { headers: { 'x-twilio-signature': 'invalid' } },
    { headers: { 'x-callmate-mock': 'false' } }, { headers: { origin: 'http://localhost:3000' } },
    { headers: { 'sec-fetch-site': 'same-site' } }, { headers: { host: 'foreign.example' } },
    { signUrl: 'http://localhost/wrong-path' }, { query: '?extra=1' },
    { fields: { CallSid: sid('CA') } }, { fields: { AccountSid: sid('AC') } },
    { fields: { From: '+34999999999' } }, { fields: { To: '+34999999999' } },
    { fields: { SequenceNumber: '-1' } }, { fields: { SequenceNumber: '9007199254740992' } },
    { fields: { SequenceNumber: '1.5' } }, { fields: { Timestamp: 'invalid-date' } },
    { payload: 'CallStatus=ringing&CallStatus=completed' },
    { payload: 'x'.repeat(17_000) }, { headers: { 'content-type': 'application/json' }, payload: '{}' },
  ];
  for (const options of cases) {
    const response = await app.callback(created.callSid, 'in-progress', 99, options);
    assert.ok([400, 403].includes(response.statusCode), `${response.statusCode}: ${JSON.stringify(options)}`);
    assert.deepEqual(app.runtime.controller.get(created.id), original);
  }
  const response = await app.callback(created.callSid, 'in-progress', 2, { fields: { CustomMetadata: 'private-callback-body-value' } });
  assert.equal(response.statusCode, 204);
  const repository = openStore(app.dataDir);
  assert.equal(repository.calls.get(created.id).internal.correlation.callbackSequence, 2);
  assert.ok(!JSON.stringify(repository.calls.get(created.id)).includes('private-callback-body-value')); repository.close();
  assert.ok(!app.logs.includes('private-callback-body-value')); assert.ok(!app.logs.includes(app.config.mockAuthToken));
});

test('callback cursor, lifecycle and SSE roll back together so failed processing can be retried', async (t) => {
  const app = await fixture(t); const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  const original = app.runtime.controller.get(created.id); const db = new Database(join(app.dataDir, 'callmate.sqlite'));
  try {
    db.exec("CREATE TRIGGER fail_callback BEFORE INSERT ON call_events BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    assert.equal((await app.callback(created.callSid, 'in-progress', 2)).statusCode, 500);
    assert.deepEqual(app.runtime.controller.get(created.id), original);
    const repository = openStore(app.dataDir);
    assert.equal(repository.calls.get(created.id).internal.correlation.callbackSequence, undefined); repository.close();
    db.exec('DROP TRIGGER fail_callback');
    assert.equal((await app.callback(created.callSid, 'in-progress', 2)).statusCode, 204);
    assert.equal(app.runtime.controller.get(created.id).callState, 'connected');
    assert.equal(app.runtime.controller.get(created.id).lastEventSequence, original.lastEventSequence + 1);
  } finally { db.close(); }
});

test('terminal callback racing graceful recovery hangup is acknowledged once and preserves the interrupted outcome', async (t) => {
  let app; let status;
  app = await fixture(t, { beforeHangupReply: async (call) => {
    status = (await app.callback(call.sid, 'completed', 3, { http: true })).statusCode;
  } });
  const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  await app.runtime.close(); assert.equal(status, 204);
  const repository = openStore(app.dataDir);
  const ended = repository.calls.get(created.id);
  assert.equal(ended.call.callState, 'ended'); assert.equal(ended.call.outcome.reason, 'technical_failure');
  assert.equal(repository.calls.events(created.id, 0).filter((event) => event.type === 'booking.updated').length, 1);
  assert.equal(repository.calls.active(), undefined); repository.close();
  assert.equal(app.hungUp, 1); assert.equal(app.creates, 1);
});

async function controlledFixture(t, options = {}) {
  const clock = { ms: Date.now() };
  const app = await fixture(t, { ...options, env: { CALLMATE_SILENCE_TIMEOUT_SECONDS: '5', ...options.env },
    development: { now: () => clock.ms, automatic: false, ...options.development } });
  return Object.assign(app, { clock,
    record(id) { const repository = openStore(app.dataDir); try { return repository.calls.get(id); } finally { repository.close(); } },
    async duration(seconds) {
      const settings = (await app.api('/api/v1/settings')).body;
      settings.defaultCallLimits.maxDurationSeconds = seconds;
      assert.equal((await app.api('/api/v1/settings', 'PUT', settings)).status, 200);
    },
  });
}

test('manual duration covers dialing, freezes settings at Start and finalizes once without a browser', async (t) => {
  const app = await controlledFixture(t, { createStatus: 'queued' }); await app.duration(30);
  const request = input(); const created = (await app.api('/api/dev/conversations', 'POST', request)).body.conversation;
  const initial = app.record(created.id); assert.equal(initial.internal.controls.maxDurationSeconds, 30);
  await app.duration(600); // Editing defaults does not extend an existing call.
  app.clock.ms = Date.parse(initial.internal.controls.durationDeadlineAt) - 1;
  await app.runtime.development.tick(); assert.equal(app.runtime.controller.get(created.id).callState, 'dialing');
  app.clock.ms++;
  await Promise.all(Array.from({ length: 8 }, () => app.runtime.development.tick()));
  const ended = app.runtime.controller.get(created.id);
  assert.equal(ended.callState, 'ended'); assert.equal(ended.outcome.reason, 'technical_failure');
  assert.match(ended.outcome.summaryEn, /duration limit/); assert.equal(app.calls.get(created.callSid).status, 'canceled');
  assert.equal(app.hungUp, 1); assert.equal(app.creates, 1);
  const errors = app.runtime.controller.replayEvents(created.id, 0).filter((event) => event.type === 'call.error');
  assert.equal(errors.length, 1); assert.match(errors[0].payload.message, /duration limit/);
  await app.api(`/api/v1/calls/${created.id}/stop`, 'POST', {});
  await app.api('/api/dev/conversations', 'POST', request);
  assert.deepEqual(app.runtime.controller.get(created.id), ended); assert.equal(app.creates, 1); assert.equal(app.hungUp, 1);
  assert.equal((await app.api('/api/dev/conversations', 'POST', input())).status, 202);
});

test('silence follows validated partial speech and DTMF, not polls, empty frames or progress callbacks', async (t) => {
  const app = await controlledFixture(t);
  const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  assert.equal(app.record(created.id).internal.controls.silenceDeadlineAt, null);
  app.clock.ms += 20_000; await app.runtime.development.tick(); // Ringing has no silence deadline.
  const peer = await app.answer(created.callSid); await until(() => peer.messages.length === 1);
  const base = app.clock.ms; const snapshot = app.runtime.controller.get(created.id);
  app.clock.ms = base + 4000;
  peer.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Hola', lang: 'es-ES', last: false }));
  await until(() => Date.parse(app.record(created.id).internal.controls.silenceDeadlineAt) === base + 9000);
  assert.deepEqual(app.runtime.controller.get(created.id), snapshot); // Activity alone is internal metadata.
  app.clock.ms = base + 8000;
  peer.send(JSON.stringify({ type: 'dtmf', digit: '1' }));
  await until(() => Date.parse(app.record(created.id).internal.controls.silenceDeadlineAt) === base + 13_000);
  app.clock.ms = base + 12_000;
  peer.send(JSON.stringify({ type: 'prompt', voicePrompt: '   ', lang: 'es-ES', last: false }));
  await app.callback(created.callSid, 'in-progress', 2);
  await app.runtime.development.tick();
  assert.equal(Date.parse(app.record(created.id).internal.controls.silenceDeadlineAt), base + 13_000);
  app.clock.ms = base + 13_000; await app.runtime.development.tick(); await peer.closed;
  const ended = app.runtime.controller.get(created.id);
  assert.equal(ended.callState, 'ended'); assert.equal(ended.outcome.reason, 'technical_failure');
  assert.match(ended.outcome.summaryEn, /silence deadline/); assert.equal(ended.messages.length, 1);
  assert.equal(app.calls.get(created.callSid).status, 'completed'); assert.equal(app.hungUp, 1);
});

test('a prompt or relay setup arriving at the silence deadline cannot reset it or release initial text', async (t) => {
  for (const attachFirst of [true, false]) await t.test(String(attachFirst), async (t) => {
    const app = await controlledFixture(t);
    const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
    let peer;
    if (attachFirst) { peer = await app.answer(created.callSid); await until(() => peer.messages.length === 1); }
    else await app.callback(created.callSid, 'in-progress', 2);
    app.clock.ms = Date.parse(app.record(created.id).internal.controls.silenceDeadlineAt);
    if (attachFirst) {
      peer.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Too late', lang: 'en-US', last: true }));
      await until(() => app.record(created.id).internal.stopRequested);
    } else peer = await app.answer(created.callSid);
    await until(async () => {
      await app.runtime.development.tick(); return app.runtime.controller.get(created.id).callState === 'ended';
    });
    await peer.closed;
    assert.equal(app.runtime.controller.get(created.id).messages.length, 1);
    assert.equal(peer.messages.length, attachFirst ? 1 : 0);
    assert.equal(app.record(created.id).internal.controls.stopReason, 'silence_timeout');
  });
});

test('Stop during preflight releases the slot without creating a call, even after another Start', async (t) => {
  let release; let waiting = false; let first = true;
  const gate = new Promise((resolve) => { release = resolve; }); t.after(() => release());
  const app = await controlledFixture(t, { beforeHealthReply: async () => {
    if (first) { first = false; waiting = true; await gate; }
  } });
  const request = input(); const pending = app.api('/api/dev/conversations', 'POST', request);
  await until(() => waiting);
  const stopped = await app.api(`/api/v1/calls/${request.requestId}/stop`, 'POST', {});
  assert.equal(stopped.body.call.callState, 'ended'); assert.equal(stopped.body.call.outcome.reason, 'user_stopped');
  assert.equal(app.creates, 0);
  const next = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  release(); assert.equal((await pending).body.conversation.status, 'completed');
  assert.deepEqual(app.runtime.controller.get(request.requestId), stopped.body.call);
  assert.equal(app.runtime.controller.get(next.id).callState, 'ringing'); assert.equal(app.creates, 1);
});

test('concurrent Stop cancels queued/ringing calls, hangs up connected calls and stays idempotent', async (t) => {
  for (const status of ['queued', 'ringing', 'in-progress']) await t.test(status, async (t) => {
    const app = await controlledFixture(t, { createStatus: status });
    const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
    const results = await Promise.all(Array.from({ length: 10 }, () => app.api(`/api/v1/calls/${created.id}/stop`, 'POST', {})));
    assert.ok(results.every((result) => result.status === 202 && result.body.call.callState === 'ended'));
    assert.equal(app.calls.get(created.callSid).status, status === 'in-progress' ? 'completed' : 'canceled');
    assert.equal(app.hungUp, 1); const ended = app.runtime.controller.get(created.id);
    await app.api(`/api/dev/conversations/${created.id}/stop`, 'POST', {});
    assert.deepEqual(app.runtime.controller.get(created.id), ended); assert.equal(app.hungUp, 1);
  });
});

test('answer racing a dialing cancellation keeps the slot and retries as a connected hangup', async (t) => {
  const updates = [];
  const app = await controlledFixture(t, { beforeHangup: async (call, status) => {
    updates.push(status); if (status === 'canceled') call.status = 'in-progress';
  } });
  const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  await app.api(`/api/v1/calls/${created.id}/stop`, 'POST', {});
  assert.equal(app.runtime.controller.get(created.id).callState, 'ending');
  assert.equal((await app.api('/api/dev/conversations', 'POST', input())).status, 409);
  await app.runtime.development.tick();
  assert.deepEqual(updates, ['canceled', 'completed']);
  assert.equal(app.runtime.controller.get(created.id).outcome.reason, 'user_stopped'); assert.equal(app.creates, 1);
});

test('duration expiry before a delayed create response retains the slot and cancels the eventual call', async (t) => {
  let release; let waiting = false;
  const gate = new Promise((resolve) => { release = resolve; }); t.after(() => release());
  const app = await controlledFixture(t, { beforeCreateReply: async () => { waiting = true; await gate; } }); await app.duration(30);
  const request = input(); const pending = app.api('/api/dev/conversations', 'POST', request); await until(() => waiting);
  app.clock.ms += 30_000; await app.runtime.development.tick();
  assert.equal(app.runtime.controller.get(request.requestId).callState, 'ending');
  assert.equal((await app.api('/api/dev/conversations', 'POST', input())).status, 409);
  release(); await pending;
  const ended = app.runtime.controller.get(request.requestId);
  assert.equal(ended.callState, 'ended'); assert.equal(ended.outcome.reason, 'technical_failure');
  assert.equal(app.calls.values().next().value.status, 'canceled'); assert.equal(app.creates, 1);
});

test('failed deadline hangup and its reason survive restart without redial or overriding with user Stop', async (t) => {
  const options = { rejectHangup: true };
  const app = await controlledFixture(t, options); await app.duration(30);
  const request = input(); const created = (await app.api('/api/dev/conversations', 'POST', request)).body.conversation;
  app.clock.ms += 30_000; await app.runtime.development.tick();
  const expired = app.record(created.id);
  assert.equal(expired.call.callState, 'ending'); assert.equal(expired.internal.controls.stopReason, 'duration_limit');
  await app.api(`/api/v1/calls/${created.id}/stop`, 'POST', {});
  assert.equal(app.record(created.id).internal.controls.stopReason, 'duration_limit');
  await app.restart();
  assert.deepEqual(app.record(created.id).internal.controls, expired.internal.controls);
  assert.equal((await app.api('/api/dev/conversations', 'POST', input())).status, 409);
  assert.equal((await app.api('/api/dev/conversations', 'POST', request)).body.conversation.id, created.id);
  await app.callback(created.callSid, 'canceled', 3);
  const ended = app.runtime.controller.get(created.id);
  assert.equal(ended.outcome.reason, 'technical_failure'); assert.match(ended.outcome.summaryEn, /duration limit/);
  assert.equal(app.creates, 1);
});

test('background timer enforces the deadline without any UI requests or provider callbacks', async (t) => {
  const app = await controlledFixture(t, { development: { automatic: true } }); await app.duration(30);
  const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  app.clock.ms += 30_000;
  await until(() => app.runtime.controller.get(created.id).callState === 'ended');
  assert.equal(app.runtime.controller.get(created.id).outcome.reason, 'technical_failure'); assert.equal(app.hungUp, 1);
});

test('duration expiry during preflight prevents a create even when the health reply arrives late', async (t) => {
  let release; let waiting = false;
  const gate = new Promise((resolve) => { release = resolve; }); t.after(() => release());
  const app = await controlledFixture(t, { beforeHealthReply: async () => { waiting = true; await gate; } }); await app.duration(30);
  const request = input(); const pending = app.api('/api/dev/conversations', 'POST', request); await until(() => waiting);
  app.clock.ms += 30_000; await app.runtime.development.tick();
  const ended = app.runtime.controller.get(request.requestId);
  assert.equal(ended.callState, 'ended'); assert.equal(ended.outcome.reason, 'technical_failure');
  release(); await pending;
  assert.deepEqual(app.runtime.controller.get(request.requestId), ended); assert.equal(app.creates, 0);
});

test('a stalled provider poll does not delay the local deadline decision or allow late speech', async (t) => {
  let release; let waiting = false; let first = true;
  const gate = new Promise((resolve) => { release = resolve; }); t.after(() => release());
  const app = await controlledFixture(t, { beforeGetReply: async () => {
    if (first) { first = false; waiting = true; await gate; }
  } }); await app.duration(30);
  const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  const poll = app.runtime.development.tick(); await until(() => waiting);
  app.clock.ms += 30_000; const deadline = app.runtime.development.tick();
  assert.equal(app.runtime.controller.get(created.id).callState, 'ending');
  assert.equal(app.record(created.id).internal.controls.stopReason, 'duration_limit');
  const peer = await app.answer(created.callSid);
  release(); await Promise.all([poll, deadline]);
  await until(async () => { await app.runtime.development.tick(); return app.runtime.controller.get(created.id).callState === 'ended'; });
  await peer.closed;
  assert.equal(peer.messages.length, 0); assert.equal(app.creates, 1);
  assert.equal(app.runtime.controller.get(created.id).outcome.reason, 'technical_failure');
});


test('automatic retention removes real manual mock text without restoring it on Start or callback replay', async (t) => {
  const clock = { ms: Date.now() };
  const app = await fixture(t, { development: { now: () => clock.ms, automatic: false },
    retention: { now: () => clock.ms, automatic: false } });
  const request = { ...input('  Здравствуйте! Private initial text. 🧪 '), language: 'ru-RU' };
  const created = (await app.api('/api/dev/conversations', 'POST', request)).body.conversation;
  const peer = await app.answer(created.callSid); await until(() => peer.messages.length === 1);
  peer.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Private operator response. Спасибо.', lang: 'ru-RU', last: true }));
  await until(() => app.runtime.controller.get(created.id).messages.length === 2);
  await app.api(`/api/v1/calls/${created.id}/stop`, 'POST', {});
  const completed = app.runtime.controller.get(created.id);
  clock.ms += 30 * 86_400_000;
  assert.equal(app.runtime.retention.sweep(), 1);
  const deleted = app.runtime.controller.get(created.id);
  assert.equal(deleted.conversationData, 'deleted'); assert.deepEqual(deleted.messages, []);
  assert.deepEqual(deleted.outcome, completed.outcome);
  for (const [status, sequence] of [['completed', 3], ['in-progress', 100]]) {
    assert.equal((await app.callback(created.callSid, status, sequence)).statusCode, 204);
  }
  await app.restart();
  const replay = (await app.api('/api/dev/conversations', 'POST', request)).body.conversation;
  assert.equal(replay.initialMessage, ''); assert.deepEqual(replay.responses, []); assert.equal(replay.conversationData, 'deleted');
  assert.deepEqual(app.runtime.controller.get(created.id), deleted);
  assert.equal(app.creates, 1);
});

test('manual test-rate budget blocks zero-budget Starts before contacting the mock', async (t) => {
  const app = await fixture(t, { env: { CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE: '60' } });
  const store = openStore(app.dataDir);
  try { const settings = store.getSettings(); settings.defaultCallLimits.maxEstimatedCost.amountMinor = 0; store.setSettings(settings); }
  finally { store.close(); }
  const request = input(); const result = await app.api('/api/dev/conversations', 'POST', request);
  assert.equal(result.status, 409); assert.equal(result.body.error.code, 'BUDGET_EXCEEDED');
  assert.equal(app.creates, 0); assert.equal(app.runtime.controller.history(10).items.length, 0);
});

test('preflight time consumes the explicit test budget and prevents a provider create', async (t) => {
  const clock = { ms: Date.now() };
  const app = await fixture(t, { env: { CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE: '6000' },
    development: { now: () => clock.ms, automatic: false },
    beforeHealthReply() { clock.ms += 2000; } });
  const result = await app.api('/api/dev/conversations', 'POST', input());
  const call = app.runtime.controller.get(result.body.conversation.id);
  assert.equal(app.creates, 0); assert.equal(call.callState, 'ended'); assert.equal(call.outcome.reason, 'technical_failure');
  assert.equal(call.usage.estimate.amountMinor, 200); assert.equal(call.usage.testUsage.elapsedMs, 2000);
  assert.equal(app.runtime.controller.replayEvents(call.id, 0).some((e) => e.type === 'call.error' && e.payload.code === 'BUDGET_EXCEEDED'), true);
});

test('budget cancellation during Calls creation hangs up once without redial', async (t) => {
  const clock = { ms: Date.now() };
  const app = await fixture(t, { env: { CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE: '6000' },
    development: { now: () => clock.ms, automatic: false },
    beforeCreateReply() { clock.ms += 2000; } });
  const request = input(); const result = await app.api('/api/dev/conversations', 'POST', request);
  const call = app.runtime.controller.get(result.body.conversation.id);
  assert.equal(app.creates, 1); assert.equal(app.hungUp, 1); assert.equal(call.callState, 'ended');
  assert.equal(call.outcome.reason, 'technical_failure'); assert.equal(call.usage.estimate.amountMinor, 200);
  const replay = await app.api('/api/dev/conversations', 'POST', request);
  assert.deepEqual(replay.body.conversation.usage, call.usage); assert.equal(app.creates, 1);
});

test('usage continues through failed hangup, excludes duplicate callbacks, and survives restart/deletion', async (t) => {
  const clock = { ms: Date.now() }; const options = { rejectHangup: true,
    env: { CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE: '6000' }, development: { now: () => clock.ms, automatic: false } };
  const app = await fixture(t, options); const request = input();
  const created = (await app.api('/api/dev/conversations', 'POST', request)).body.conversation;
  const peer = await app.answer(created.callSid); await until(() => peer.messages.length === 1);
  const settings = (await app.api('/api/v1/settings')).body; settings.defaultCallLimits.maxEstimatedCost.amountMinor = 1;
  await app.api('/api/v1/settings', 'PUT', settings);
  // Existing attempt keeps its original budget despite the new default.
  clock.ms += 1000; await app.runtime.development.tick();
  assert.equal(app.runtime.controller.get(created.id).callState, 'connected');
  assert.equal(app.runtime.controller.get(created.id).usage.estimate.amountMinor, 100);
  clock.ms += 1000; await app.runtime.development.tick();
  assert.ok(['ending', 'reconciliation_required'].includes(app.runtime.controller.get(created.id).callState));
  assert.equal(app.runtime.controller.get(created.id).usage.estimate.amountMinor, 200);
  const activeConflict = await app.api('/api/dev/conversations', 'POST', input()); assert.equal(activeConflict.status, 409);
  clock.ms += 1000; options.rejectHangup = false;
  await app.runtime.development.tick(); const completed = app.runtime.controller.get(created.id);
  assert.equal(completed.callState, 'ended'); assert.equal(completed.outcome.reason, 'technical_failure');
  assert.equal(completed.usage.estimate.amountMinor, 300); // Honest overrun until confirmed termination.
  assert.equal(completed.usage.testUsage.budget.amountMinor, 200); assert.equal(completed.usage.settledTotal, null);
  const events = app.runtime.controller.replayEvents(created.id, 0); events.forEach((e) => DomainEventSchema.parse(e));
  assert.equal(events.filter((e) => e.type === 'call.error' && e.payload.code === 'BUDGET_EXCEEDED').length, 1);
  const snapshot = structuredClone(completed);
  clock.ms += 1000;
  await app.callback(created.callSid, 'completed', 10); await app.callback(created.callSid, 'in-progress', 20);
  assert.deepEqual(app.runtime.controller.get(created.id), snapshot);
  app.runtime.controller.deleteConversation(created.id); app.config.testRateMinorPerMinute = 600;
  await app.restart();
  const replay = (await app.api('/api/dev/conversations', 'POST', request)).body.conversation;
  assert.deepEqual(replay.usage, snapshot.usage); assert.equal(app.creates, 1); assert.equal(replay.conversationData, 'deleted');
  assert.deepEqual(app.runtime.controller.history(10).items[0].usage, snapshot.usage);
});

test('automatic usage enforcement runs without a browser and stops queued mock calls', async (t) => {
  const clock = { ms: Date.now() };
  const app = await fixture(t, { createStatus: 'queued', env: { CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE: '6000' },
    development: { now: () => clock.ms } });
  const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  clock.ms += 2000;
  await until(() => app.runtime.controller.get(created.id).callState === 'ended');
  assert.equal(app.hungUp, 1); assert.equal(app.runtime.controller.get(created.id).usage.estimate.amountMinor, 200);
});

test('failed usage event insertion rolls back meter and snapshot together before retry', async (t) => {
  const clock = { ms: Date.now() };
  const app = await fixture(t, { env: { CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE: '60' },
    development: { now: () => clock.ms, automatic: false } });
  const created = (await app.api('/api/dev/conversations', 'POST', input())).body.conversation;
  const before = app.runtime.controller.get(created.id); const events = app.runtime.controller.replayEvents(created.id, 0);
  const db = new Database(join(app.dataDir, 'callmate.sqlite'));
  try {
    db.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON call_events WHEN json_extract(NEW.value, '$.type') = 'usage.updated' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    clock.ms += 1000;
    await assert.rejects(app.runtime.development.tick());
    assert.deepEqual(app.runtime.controller.get(created.id), before);
    assert.deepEqual(app.runtime.controller.replayEvents(created.id, 0), events);
    db.exec('DROP TRIGGER fail_usage'); await app.runtime.development.tick();
    assert.equal(app.runtime.controller.get(created.id).usage.estimate.amountMinor, 1);
    assert.equal(app.runtime.controller.replayEvents(created.id, 0).filter((e) => e.type === 'usage.updated').length, 1);
  } finally { db.close(); }
});

// These exercise the application controller and real local REST/WebSocket traffic,
// injecting only model generation. They never contact OpenAI or a telephone network.
const dialogueProposal = (input, candidate) => ({ turnId: input.turnId, turnVersion: input.turnVersion,
  candidate, translations: [{ messageId: input.triggerMessageId, translationEn: "Contact reply translated for the owner." }] });

test('reviewed mock Start without a dialogue engine fails without scripted confirmation or a call attempt', async t => {
  const app = await fixture(t);
  const plan = (await app.api('/api/v1/plans', 'POST', dialogueRequest())).body.plan;
  const response = await fetch(app.apiOrigin + '/api/v1/calls', { method: 'POST', headers: {
    ...app.auth, 'content-type': 'application/json', 'idempotency-key': randomUUID(),
  }, body: JSON.stringify({ planId: plan.id, planVersion: plan.version, mode: 'simulator' }) });
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'PROVIDER_NOT_READY');
  assert.equal(app.creates, 0); assert.deepEqual((await app.api('/api/v1/history')).body.items, []);
  const db = new Database(join(app.dataDir, 'callmate.sqlite'), { readonly: true });
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM commands').get().n, 0); } finally { db.close(); }
});

test('Codex provider uses the CLI adapter for actual relay turns and reports local login readiness', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'callmate-codex-server-'));
  const previousPath = process.env.PATH;
  writeFileSync(join(directory, 'codex'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
if (process.argv.includes('status')) { console.log('Logged in using ChatGPT'); process.exit(0); }
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], JSON.stringify({
  turnId: input.turnId, turnVersion: input.turnVersion, candidate: { action: 'ask_availability' },
  translations: [{ messageId: input.triggerMessageId, translationEn: 'Hello, how can I help?' }]
}));
`, { mode: 0o700 });
  process.env.PATH = `${directory}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; rmSync(directory, { recursive: true, force: true }); });
  const f = await dialogueCall(t, undefined, { env: { CALLMATE_DIALOGUE_PROVIDER: 'codex' } });
  f.prompt('Hola, ¿qué necesita?'); await until(() => f.peer.messages.length === 2);
  assert.match(f.peer.messages[1].token, /disponibilidad/);
  const call = await f.snapshot(); assert.equal(call.outcome.status, 'pending');
  assert.equal(call.messages[1].translationEn, 'Hello, how can I help?');
  const report = (await f.app.api('/api/v1/readiness')).body;
  assert.equal(report.capabilities.find(c => c.name === 'dialogue_integration').ready, true);
  assert.match(report.checks.find(c => c.name === 'dialogue').message, /ChatGPT login/);
  writeFileSync(join(directory, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  assert.equal((await f.app.api('/api/v1/readiness')).body.capabilities.find(c => c.name === 'dialogue_integration').ready, false);
  await f.app.api(`/api/v1/calls/${f.id}/stop`, 'POST', {});
  const blocked = await f.start(undefined, randomUUID());
  assert.equal(blocked.status, 503); assert.equal(blocked.body.error.code, 'PROVIDER_NOT_READY');
  assert.equal(f.app.creates, 1);
});
function dialogueRequest() {
  const request = structuredClone(reviewPlanFixture.request);
  const year = new Date().getUTCFullYear() + 1;
  for (const window of request.availability) for (const endpoint of [window.start, window.end]) {
    endpoint.localDate = `${year}-10-20`; endpoint.instant = endpoint.instant.replace(/^\d{4}/, String(year));
  }
  return request;
}
async function dialogueCall(t, model, extra = {}) {
  const app = await fixture(t, { ...extra, development: { automatic: false, model, ...extra.development } });
  const plan = (await app.api('/api/v1/plans', 'POST', { ...dialogueRequest(), ...extra.request, ...(extra.language ? { language: extra.language } : {}) })).body.plan;
  const key = randomUUID();
  const start = async (request = { planId: plan.id, planVersion: plan.version, mode: 'simulator' }, commandKey = key) => {
    const response = await fetch(app.apiOrigin + '/api/v1/calls', { method: 'POST', headers: {
      ...app.auth, 'content-type': 'application/json', 'idempotency-key': commandKey }, body: JSON.stringify(request) });
    return { status: response.status, body: await response.json() };
  };
  const created = await start(); assert.equal(created.status, 202, JSON.stringify(created.body));
  const id = created.body.call.id;
  const peer = await app.answer([...app.calls.keys()][0]); await until(() => peer.messages.length === 1);
  const prompt = (text, last = true) => peer.send(JSON.stringify({ type: 'prompt', voicePrompt: text, lang: extra.language ?? 'es-ES', last }));
  const snapshot = async () => (await app.api(`/api/v1/calls/${id}`)).body.call;
  return { app, id, peer, prompt, snapshot, start, plan };
}

test('dialogue mock: finalized contact replies drive the library, policy and relay; translations and generated replies persist', async t => {
  const inputs = [];
  const model = { async generate(input) { inputs.push(input); return dialogueProposal(input,
    input.messages.find(m => m.id === input.triggerMessageId).originalText.includes('precio')
      ? { action: 'clarify', missing: ['price'] } : { action: 'ask_availability' }); } };
  const f = await dialogueCall(t, model);
  assert.match(f.peer.messages[0].token, /inteligencia artificial/);
  f.prompt('Hola, ', false); await delay(30); assert.equal(inputs.length, 0);
  f.prompt('¿qué necesita?'); await until(() => f.peer.messages.length === 2);
  assert.equal(inputs.length, 1); assert.equal(inputs[0].plan.id, f.plan.id);
  assert.match(f.peer.messages[1].token, /disponibilidad/);
  assert.doesNotMatch(f.peer.messages[1].token, /Hola|asistente|llamo en nombre/);
  f.prompt('¿Qué precio?'); await until(() => f.peer.messages.length === 3);
  assert.match(f.peer.messages[2].token, /precio total/);
  const call = await f.snapshot();
  assert.equal(call.messages.length, 5); assert.equal(call.messages[1].translationEn, 'Contact reply translated for the owner.');
  assert.equal(call.messages.at(-1).playback, 'generated'); assert.equal(call.outcome.status, 'pending');
  const duplicate = await f.start(); assert.equal(duplicate.status, 202); assert.equal(f.app.creates, 1);
  const readiness = (await f.app.api('/api/v1/readiness')).body;
  assert.equal(readiness.capabilities.find(c => c.name === 'dialogue_integration').ready, true);
  assert.equal(readiness.capabilities.find(c => c.name === 'live_calls').enabled, false);
  const history = (await f.app.api('/api/v1/history')).body; assert.equal(history.items[0].id, f.id);
});

test('dialogue mock: supported contact languages are received and translated without changing the reviewed agent language', async t => {
  const inputs = [];
  const f = await dialogueCall(t, { async generate(input) {
    inputs.push(input); return dialogueProposal(input, { action: 'ask_availability' });
  } });
  for (const [language, text] of [['ru-RU', 'Здравствуйте, что вам нужно?'], ['pl-PL', 'Dzień dobry, w czym pomóc?'], ['en-US', 'Hello, how can I help?']]) {
    const before = f.peer.messages.length;
    f.peer.send(JSON.stringify({ type: 'prompt', voicePrompt: text, lang: language, last: true }));
    await until(() => f.peer.messages.length === before + 1);
    const call = await f.snapshot(); const contact = call.messages.findLast(m => m.speaker === 'business');
    assert.equal(contact.originalText, text); assert.equal(contact.language, language);
    assert.equal(contact.translationEn, 'Contact reply translated for the owner.');
    assert.equal(inputs.at(-1).messages.find(m => m.id === contact.id).language, language);
    assert.equal(f.peer.messages.at(-1).lang, 'es-ES'); assert.deepEqual(call.plan.request, f.plan.request);
    assert.equal(call.outcome.status, 'pending');
  }
  const errors = new Database(join(f.app.dataDir, 'callmate.sqlite'), { readonly: true });
  try { assert.equal(errors.prepare("SELECT count(*) AS n FROM call_events WHERE attempt_id=? AND json_extract(value,'$.type')='call.error'").get(f.id).n, 0); } finally { errors.close(); }
});

test('dialogue mock: unsupported recognition language reports an actionable error and allows a supported reply next', async t => {
  let turns = 0;
  const f = await dialogueCall(t, { async generate(input) { turns++; return dialogueProposal(input, { action: 'ask_availability' }); } });
  f.peer.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Hello', lang: 'ja-JP', last: true }));
  const db = new Database(join(f.app.dataDir, 'callmate.sqlite'), { readonly: true });
  try {
    let error;
    await until(() => { error = db.prepare("SELECT value FROM call_events WHERE attempt_id=? AND json_extract(value,'$.type')='call.error' ORDER BY sequence DESC LIMIT 1").get(f.id); return error; });
    assert.match(JSON.parse(error.value).payload.message, /unsupported language.*mock operator.*resend/);
    assert.equal(turns, 0); assert.equal((await f.snapshot()).callState, 'connected');
    f.prompt('Hola, ¿qué necesita?'); await until(() => f.peer.messages.length === 2);
    assert.equal(turns, 1); assert.equal((await f.snapshot()).messages.length, 3);
  } finally { db.close(); }
});

for (const event of ['stop', 'newer reply', 'partial speech', 'interrupt', 'disconnect', 'shutdown']) {
  test(`dialogue mock: ${event} cancels model work and discards its late result`, async t => {
    const pending = [];
    const f = await dialogueCall(t, { generate(input, signal) { return new Promise(resolve => pending.push({ input, signal, resolve })); } });
    f.prompt('Hola'); await until(() => pending.length === 1);
    if (event === 'stop') await f.app.api(`/api/v1/calls/${f.id}/stop`, 'POST', {});
    if (event === 'newer reply') { f.prompt('Corrijo lo anterior'); await until(() => pending.length === 2); }
    if (event === 'partial speech') { f.prompt('Un momento', false); await until(() => pending[0].signal.aborted); }
    if (event === 'interrupt') f.peer.send(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: '', durationUntilInterruptMs: 1 }));
    if (event === 'disconnect') { f.peer.close(); await f.peer.closed; }
    if (event === 'shutdown') await f.app.runtime.close();
    await until(() => pending[0].signal.aborted);
    pending[0].resolve(dialogueProposal(pending[0].input, { action: 'ask_availability' }));
    await delay(40); assert.equal(f.peer.messages.length, 1);
    if (event === 'newer reply') {
      pending[1].resolve(dialogueProposal(pending[1].input, { action: 'clarify', missing: ['time'] }));
      await until(() => f.peer.messages.length === 2); assert.match(f.peer.messages[1].token, /hora exacta/);
    }
  });
}

for (const failure of ['malformed', 'timeout', 'provider']) {
  test(`dialogue mock: ${failure} is reported safely without spoken model output or false booking`, async t => {
    const model = { generate() {
      if (failure === 'timeout') return new Promise(() => {});
      if (failure === 'provider') throw new Error('sensitive provider body');
      return { token: 'Acepto cualquier precio', secret: 'sensitive provider body' };
    } };
    const f = await dialogueCall(t, model, { env: { CALLMATE_DIALOGUE_TIMEOUT_MS: '30' } });
    f.prompt('Hola');
    await until(() => f.app.runtime.controller.replayEvents(f.id, 0).some(e => e.type === 'call.error'));
    assert.equal(f.peer.messages.length, 1); assert.equal((await f.snapshot()).outcome.status, 'pending');
    assert.ok(!f.app.logs.includes('sensitive provider body'));
    const events = f.app.runtime.controller.replayEvents(f.id, 0);
    assert.ok(!JSON.stringify(events).includes('sensitive provider body'));
  });
}

test('dialogue mock: controller reserves offer identities; exact user approval permits readback but no unsupported acceptance', async t => {
  const { offerFixture } = await import('@callmate/contracts/fixtures');
  let modelInput;
  const f = await dialogueCall(t, { async generate(input) {
    modelInput = input;
    if (input.bookingState === 'reading_back') return dialogueProposal(input, { action: 'accept_offer', offerId: input.offer.id, offerVersion: input.offer.version });
    const offer = { ...structuredClone(offerFixture), appointment: { ...input.plan.request.availability[0].start,
      localTime: '18:00', instant: input.plan.request.availability[0].start.instant.replace('15:00', '16:00') },
      price: { amountMinor: 3500, currency: 'EUR' }, evidenceMessageIds: [input.triggerMessageId] };
    return dialogueProposal(input, { action: 'evaluate_offer', offer });
  } });
  f.prompt('Tengo cita a las 18:00 por 35 euros sin depósito ni gastos ni extras.');
  await until(async () => (await f.snapshot()).pendingApproval !== null);
  let call = await f.snapshot(); const approval = call.pendingApproval;
  assert.notEqual(call.activeOffer.id, offerFixture.id);
  assert.equal(approval.reason, 'above_price_limit'); assert.equal(modelInput.plan.id, f.plan.id);
  const body = { approvalId: approval.id, decision: 'approve', plan: approval.plan,
    offer: { offerId: approval.offer.id, offerVersion: approval.offer.version } };
  const decide = async (value, key) => {
    const response = await fetch(f.app.apiOrigin + `/api/v1/calls/${f.id}/approvals`, { method: 'POST',
      headers: { ...f.app.auth, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(value) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await decide({ ...body, offer: { ...body.offer, offerVersion: 99 } }, randomUUID())).status, 409);
  const key = randomUUID(); const accepted = await decide(body, key); assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  await until(() => f.peer.messages.some(m => m.token.includes('Todavía no estoy aceptando')));
  assert.equal((await decide(body, key)).status, 200);
  f.prompt('Sí, son correctos'); await until(() => f.app.runtime.controller.replayEvents(f.id, 0).some(e => e.type === 'call.error'));
  assert.equal(f.peer.messages.length, 3);
  call = await f.snapshot(); assert.equal(call.bookingState, 'reading_back'); assert.equal(call.outcome.status, 'pending');
  assert.ok(!f.peer.messages.some(m => /^Acepto la cita/.test(m.token)));
  await f.app.api(`/api/v1/calls/${f.id}/stop`, 'POST', {});
  assert.notEqual((await f.snapshot()).outcome.status, 'confirmed');
});

test('dialogue mock: Stop from an event subscriber prevents release after transcript persistence', async t => {
  let release;
  const f = await dialogueCall(t, { generate(input) { return new Promise(resolve => { release = () => resolve(dialogueProposal(input, { action: 'ask_availability' })); }); } });
  f.prompt('Hola'); await until(() => !!release);
  const before = await f.snapshot();
  // Stop synchronously when the generated reply event is published: persistence succeeds,
  // but the voice boundary must recheck the now-ending call before releasing text.
  let stop;
  const unsubscribe = f.app.runtime.controller.observe(f.id, () => {
    if (f.app.runtime.controller.get(f.id).messages.length > before.messages.length && !stop) {
      stop = f.app.runtime.controller.stop(f.id);
    }
  });
  release(); await until(() => !!stop); await stop; unsubscribe();
  assert.equal(f.peer.messages.length, 1); assert.equal((await f.snapshot()).callState, 'ended');
});

test('dialogue mock: recovery hangs up an orphan without replaying dialogue or creating another call', async t => {
  let turns = 0;
  const f = await dialogueCall(t, { async generate(input) { turns++; return dialogueProposal(input, { action: 'ask_availability' }); } });
  f.prompt('Hola'); await until(() => f.peer.messages.length === 2);
  await f.app.restart();
  const call = await f.snapshot(); assert.equal(call.callState, 'ended');
  assert.equal(f.app.creates, 1); assert.equal(turns, 1); assert.equal(f.peer.messages.length, 2);
  assert.notEqual(call.outcome.status, 'confirmed');
  const replay = await f.start(); assert.equal(replay.status, 202); assert.equal(f.app.creates, 1);
});

test('dialogue model configuration fails closed and never prints supplied credential values', () => {
  for (const env of [
    { CALLMATE_DIALOGUE_PROVIDER: 'openai' },
    { CALLMATE_DIALOGUE_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic-secret', CALLMATE_DIALOGUE_MODEL: 'example' },
    { CALLMATE_DIALOGUE_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic-secret', CALLMATE_DIALOGUE_MODEL: 'example', NODE_ENV: 'production', TELEPHONY_PROVIDER: 'mock' },
  ]) assert.throws(() => loadConfig(env), error => !error.message.includes('synthetic-secret') && /configuration/.test(error.message));
  const configured = loadConfig({ CALLMATE_DIALOGUE_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic-secret', CALLMATE_DIALOGUE_MODEL: 'example', NODE_ENV: 'development', TELEPHONY_PROVIDER: 'mock' });
  assert.equal(configured.dialogueProvider, 'openai');
});

test('dialogue mock: failed response persistence rolls back translations and sends no relay text', async t => {
  let release;
  const f = await dialogueCall(t, { generate(input) { return new Promise(resolve => { release = () => resolve(dialogueProposal(input, { action: 'ask_availability' })); }); } });
  f.prompt('Hola'); await until(() => !!release);
  const before = await f.snapshot();
  const db = new Database(join(f.app.dataDir, 'callmate.sqlite'));
  try {
    db.exec("CREATE TRIGGER fail_dialogue BEFORE INSERT ON call_events WHEN json_extract(NEW.value, '$.type') = 'transcript.updated' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    release();
    await until(() => f.app.runtime.controller.replayEvents(f.id, 0).some(e => e.type === 'call.error'));
    assert.deepEqual((await f.snapshot()).messages, before.messages);
    assert.equal(f.peer.messages.length, 1);
    db.exec('DROP TRIGGER fail_dialogue');
  } finally { db.close(); }
});

async function offeredDialogue(t, extra = {}) {
  const { offerFixture } = await import('@callmate/contracts/fixtures');
  let price = 3500;
  const f = await dialogueCall(t, { async generate(input) {
    return dialogueProposal(input, { action: 'evaluate_offer', offer: { ...structuredClone(offerFixture),
      appointment: { ...input.plan.request.availability[0].start, localTime: '18:00',
        instant: input.plan.request.availability[0].start.instant.replace('15:00', '16:00') },
      price: { amountMinor: price, currency: 'EUR' }, evidenceMessageIds: [input.triggerMessageId] } });
  } }, extra);
  f.prompt('Cita a las 18:00 por 35 euros sin condiciones adicionales.');
  await until(async () => (await f.snapshot()).pendingApproval !== null);
  return { ...f, changePrice(value) { price = value; } };
}

test('dialogue mock: a changed offer invalidates the old approval and advances the controller-owned offer version', async t => {
  const f = await offeredDialogue(t); const original = (await f.snapshot()).pendingApproval;
  f.changePrice(4000); f.prompt('Corrijo: son 40 euros.');
  await until(async () => (await f.snapshot()).activeOffer?.version === 2);
  const call = await f.snapshot();
  assert.equal(call.activeOffer.id, original.offer.id); assert.notEqual(call.pendingApproval.id, original.id);
  assert.equal(call.pendingApproval.offer.price.amountMinor, 4000);
  const events = f.app.runtime.controller.replayEvents(f.id, 0);
  assert.ok(events.some(e => e.type === 'approval.resolved' && e.payload.approvalId === original.id && e.payload.status === 'invalidated'));
  const result = await fetch(f.app.apiOrigin + `/api/v1/calls/${f.id}/approvals`, { method: 'POST', headers: {
    ...f.app.auth, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({
      approvalId: original.id, decision: 'approve', plan: original.plan, offer: { offerId: original.offer.id, offerVersion: original.offer.version } }) });
  assert.equal(result.status, 409); assert.ok(!f.peer.messages.some(m => m.token.startsWith('Acepto')));
});

test('dialogue mock: expired approval resolves and ends the provider call without accepting', async t => {
  const f = await offeredDialogue(t, { env: { CALLMATE_SIMULATOR_APPROVAL_SECONDS: '1' } });
  await delay(1050); await f.app.runtime.development.tick();
  const call = await f.snapshot(); assert.equal(call.pendingApproval, null); assert.equal(call.callState, 'ended');
  assert.equal(call.outcome.reason, 'policy_declined'); assert.equal(f.app.hungUp, 1);
  assert.ok(f.app.runtime.controller.replayEvents(f.id, 0).some(e => e.type === 'approval.resolved' && e.payload.status === 'expired'));
});

test('dialogue mock: business refusal produces a controlled closing and relay end command', async t => {
  const f = await dialogueCall(t, { async generate(input) { return dialogueProposal(input, { action: 'end_call', reason: 'business_declined' }); } });
  f.prompt('Lo siento, no podemos atenderle.');
  await until(() => f.peer.messages.some(m => m.type === 'end'));
  assert.match(f.peer.messages[1].token, /Gracias|gracias/);
  assert.equal((await f.snapshot()).outcome.reason, 'business_declined');
  await f.app.callback([...f.app.calls.keys()][0], 'completed', 1);
  assert.equal((await f.snapshot()).callState, 'ended');
});

test('dialogue mock: approval cannot release old-offer readback while newer contact speech is incomplete', async t => {
  const f = await offeredDialogue(t); const approval = (await f.snapshot()).pendingApproval;
  f.prompt('Un momento, corrijo ', false); await delay(30);
  const result = await fetch(f.app.apiOrigin + `/api/v1/calls/${f.id}/approvals`, { method: 'POST', headers: {
    ...f.app.auth, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({
      approvalId: approval.id, decision: 'approve', plan: approval.plan, offer: { offerId: approval.offer.id, offerVersion: approval.offer.version } }) });
  assert.equal(result.status, 409); assert.equal((await f.snapshot()).pendingApproval.id, approval.id);
  assert.ok(!f.peer.messages.some(m => m.token.includes('Todavía no estoy aceptando')));
});

for (const [language, hello, price, repeat, waiting, readback, unavailable, affirmation] of [
  ['es-ES', 'Hola', /precio total/, /repetir/, /consultar esta propuesta/, /Todavía no estoy aceptando/, /Acepto la cita/, 'Sí, todo correcto, gracias'],
  ['ru-RU', 'Здравствуйте', /стоимость стрижки/, /повторите/, /согласовать это предложение/, /пока не принимаю/, /Я принимаю запись/, 'Да всё так спасибо'],
  ['en-US', 'Hello', /total price/, /repeat/, /check this proposal/, /not accepting/, /I accept the appointment/, 'Yes, that is correct, thank you'],
  ['pl-PL', 'Dzień dobry', /cenę strzyżenia/, /powtórzyć/, /uzgodnić tę propozycję/, /Jeszcze nie akceptuję/, /Akceptuję termin/, 'Tak, wszystko się zgadza, dziękuję'],
]) test(`dialogue mock: ${language} reaches TwiML, model context, policy replies and durable transcript IDs`, async t => {
  let turn = 0; const inputs = [];
  const { offerFixture } = await import('@callmate/contracts/fixtures');
  const f = await dialogueCall(t, { async generate(input) {
    inputs.push(input); turn++;
    const candidate = turn === 1 ? { action: 'clarify', missing: ['price', 'conditions'] }
      : turn === 2 ? { action: 'repeat', reason: 'not_heard' }
      : turn === 3 ? { action: 'evaluate_offer', offer: { ...structuredClone(offerFixture),
        appointment: input.plan.request.availability[0].start, price: { amountMinor: 3500, currency: "EUR" }, evidenceMessageIds: [input.triggerMessageId] } }
      : { action: 'accept_offer', offerId: input.offer.id, offerVersion: input.offer.version };
    return dialogueProposal(input, candidate);
  } }, { language, playbackReceipts: true });
  assert.equal([...f.app.calls.values()][0].relay.language, language);
  assert.equal(f.peer.messages[0].lang, language);
  let call = await f.snapshot(); assert.equal(call.messages[0].phrase.id, 'haircut.greeting');
  assert.match(call.messages[0].translationEn, /I am an AI assistant/);
  assert.doesNotMatch(call.messages[0].originalText + call.messages[0].translationEn, /Zeus|Зевс|CallMate/i);
  assert.ok(call.messages[0].originalText.includes(f.plan.request.bookingName));
  assert.ok(f.peer.messages[0].token.includes(f.plan.request.bookingName));
  assert.ok(call.messages[0].translationEn.includes('on behalf of ' + f.plan.request.bookingName));
  f.prompt(hello); await until(() => f.peer.messages.length === 2);
  assert.match(f.peer.messages[1].token, price);
  assert.match((await f.snapshot()).messages.at(-1).translationEn, /total price/);
  assert.doesNotMatch((await f.snapshot()).messages.at(-1).translationEn, /deposit|prepayment|cancellation|extras/);
  f.prompt(hello); await until(() => f.peer.messages.length === 3);
  assert.match(f.peer.messages[2].token, repeat);
  f.prompt(hello); await until(async () => (await f.snapshot()).pendingApproval !== null);
  assert.match(f.peer.messages[3].token, waiting);
  call = await f.snapshot(); const approval = call.pendingApproval;
  const approved = await fetch(f.app.apiOrigin + `/api/v1/calls/${f.id}/approvals`, { method: "POST", headers: { ...f.app.auth, "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify({
    approvalId: approval.id, decision: 'approve', plan: approval.plan,
    offer: { offerId: approval.offer.id, offerVersion: approval.offer.version },
  }) });
  assert.equal(approved.status, 200, JSON.stringify(await approved.json()));
  await until(() => f.peer.messages.length === 5); assert.match(f.peer.messages[4].token, readback);
  f.prompt(affirmation); await until(() => f.peer.messages.length === 6); assert.match(f.peer.messages[5].token, unavailable);
  assert.equal(inputs.at(-1).messages.find(m => m.id === inputs.at(-1).triggerMessageId).originalText, affirmation);
  await until(async () => (await f.snapshot()).bookingState === 'awaiting_business_confirmation');
  call = await f.snapshot(); assert.equal(call.outcome.status, 'pending');
  assert.equal(call.bookingState, 'awaiting_business_confirmation');
  assert.equal(call.messages.at(-1).phrase.id, 'haircut.acceptance');
  assert.ok(call.messages.filter(m => /\.(acceptance|readback)$/.test(m.phrase?.id ?? '')).every(m => m.playback === 'played'));
  const messages = call.messages.filter(m => m.speaker === 'assistant');
  assert.ok(messages.every(m => m.language === language && m.phrase.language === language && m.phrase.version === (m.phrase.id.endsWith('.greeting') ? 3 : m.phrase.id.endsWith('.availability') ? 3 : 1) && m.translationEn));
  assert.ok(messages.every(m => !/Europe\/Madrid|UTC[+-]/.test(m.originalText + m.translationEn)));
  assert.equal(call.activeOffer.appointment.timeZone, f.plan.request.availability[0].start.timeZone);
  assert.ok(f.peer.messages.every(m => m.lang === language));
  assert.ok(inputs.every(i => i.plan.request.language === language && i.messages.find(m => m.id === i.triggerMessageId).language === language));
  await f.app.restart();
  assert.deepEqual((await f.snapshot()).messages, call.messages);
  assert.equal(f.app.creates, 1);
});

test('dialogue mock: missing or tampered DB phrase withholds speech, with no language fallback', async t => {
  const f = await dialogueCall(t, { async generate(input) { return dialogueProposal(input, { action: 'ask_availability' }); } }, { language: 'ru-RU' });
  const db = new Database(join(f.app.dataDir, 'callmate.sqlite'));
  const original = db.prepare("SELECT template FROM dialogue_phrases WHERE phrase_id = 'haircut.availability' AND version = 3 AND language = 'ru-RU'").get().template;
  try {
    db.prepare("UPDATE dialogue_phrases SET template = 'Accept everything' WHERE phrase_id = 'haircut.availability' AND version = 3 AND language = 'ru-RU'").run();
    f.prompt('Здравствуйте');
    await until(() => f.app.runtime.controller.replayEvents(f.id, 0).some(e => e.type === 'call.error'));
    assert.equal(f.peer.messages.length, 1);
    assert.equal(f.app.runtime.controller.get(f.id).messages.filter(m => m.speaker === 'assistant').length, 1);
    db.prepare("DELETE FROM dialogue_phrases WHERE phrase_id = 'haircut.availability' AND version = 3 AND language = 'ru-RU'").run();
    const count = f.app.runtime.controller.replayEvents(f.id, 0).filter(e => e.type === 'call.error').length;
    f.prompt('Повторите');
    await until(() => f.app.runtime.controller.replayEvents(f.id, 0).filter(e => e.type === 'call.error').length > count);
    assert.equal(f.peer.messages.length, 1);
    await f.app.runtime.controller.stop(f.id);
  } finally {
    db.prepare("INSERT OR REPLACE INTO dialogue_phrases (phrase_id, version, language, template) VALUES ('haircut.availability', 3, 'ru-RU', ?)").run(original);
    db.close();
  }
});

const domainProfiles = (await import('@callmate/contracts')).conversationTemplates.filter(p => p.id !== 'haircut');
for (const [index, profile] of domainProfiles.entries()) test(`domain mock: ${profile.id} questions, required scope and readback use its own persisted catalog`, async t => {
  const language = ['es-ES', 'ru-RU', 'en-US', 'pl-PL'][index % 4];
  const details = Object.fromEntries(profile.fields.map(field => [field.key, field.kind === 'choice' ? field.options[0].value : field.kind === 'number' ? 2 : 'Toyota Corolla']));
  let turn = 0; const inputs = [];
  const { offerFixture } = await import('@callmate/contracts/fixtures');
  const f = await dialogueCall(t, { async generate(input) {
    inputs.push(input); turn++;
    const candidate = turn === 1 ? { action: 'ask_requirements' } : turn === 2 ? { action: 'ask_availability' }
      : { action: 'evaluate_offer', offer: { ...structuredClone(offerFixture), service: profile.service[2],
        templateDetails: turn === 3 ? null : details, appointment: input.plan.request.availability[0].start,
        evidenceMessageIds: [input.triggerMessageId] } };
    return dialogueProposal(input, candidate);
  } }, { language, request: { templateId: profile.id, templateDetails: details, service: profile.aliases[0] } });
  assert.equal([...f.app.calls.values()][0].relay.language, language);
  assert.equal((await f.snapshot()).messages[0].phrase.id, `${profile.id}.greeting`);
  f.prompt(profile.service[index % 4]); await until(() => f.peer.messages.length === 2);
  let call = await f.snapshot(); assert.equal(call.messages.at(-1).phrase.id, `${profile.id}.requirements`);
  assert.equal(call.messages.at(-1).translationEn, profile.requirements[2]);
  f.prompt(profile.service[index % 4]); await until(() => f.peer.messages.length === 3);
  assert.equal((await f.snapshot()).messages.at(-1).phrase.id, `${profile.id}.availability`);
  const availabilityReply = (await f.snapshot()).messages.at(-1);
  assert.doesNotMatch(availabilityReply.originalText + availabilityReply.translationEn, /Europe\/Madrid|UTC[+-]/);
  f.prompt('Details still unknown'); await until(() => f.peer.messages.length === 4);
  call = await f.snapshot(); assert.equal(call.messages.at(-1).phrase.id, `${profile.id}.clarification`);
  assert.match(call.messages.at(-1).translationEn, /confirm.*details/); assert.equal(call.bookingState, 'offer_received');
  f.prompt(JSON.stringify({ service: profile.service[2], details, priceEUR: 25, appointment: f.plan.request.availability[0].start }));
  await until(() => f.peer.messages.length === 5);
  call = await f.snapshot(); assert.equal(call.messages.at(-1).phrase.id, `${profile.id}.readback`);
  assert.match(call.messages.at(-1).translationEn, /not accepting/); assert.equal(call.activeOffer.version, 2);
  assert.deepEqual(call.activeOffer.templateDetails, details); assert.equal(call.bookingState, 'reading_back'); assert.equal(call.outcome.status, 'pending');
  assert.ok(inputs.every(input => input.plan.request.templateId === profile.id));
  assert.ok(f.peer.messages.every(m => m.lang === language));
  assert.ok(call.messages.filter(m => m.speaker === 'assistant').every(m => m.phrase.id.startsWith(profile.id + '.') && m.translationEn));
  assert.ok(!f.peer.messages.some(m => /haircut|corte de pelo|стрижк|strzyż/i.test(m.token)));
  await f.app.api(`/api/v1/calls/${f.id}/stop`, 'POST', {});
});

async function autoApprovalCall(t, extra = {}) {
  const { offerFixture } = await import('@callmate/contracts/fixtures');
  return dialogueCall(t, { async generate(input) {
    const candidate = input.bookingState === 'reading_back'
      ? { action: 'accept_offer', offerId: input.offer.id, offerVersion: input.offer.version }
      : input.bookingState === 'awaiting_business_confirmation'
        ? { action: 'record_business_confirmation', offerId: input.offer.id, offerVersion: input.offer.version, evidenceMessageIds: [input.triggerMessageId] }
        : { action: 'evaluate_offer', offer: { ...structuredClone(offerFixture), appointment: input.plan.request.availability[0].start,
          price: { amountMinor: 5000, currency: 'EUR' }, evidenceMessageIds: [input.triggerMessageId] } };
    return dialogueProposal(input, candidate);
  } }, { language: 'ru-RU', playbackReceipts: true, ...extra,
    request: { pricePolicy: { maximum: { amountMinor: 5000, currency: 'EUR' }, allowUnknownPrice: false }, ...extra.request } });
}

for (const [language, assent, confirmation] of [
  ['ru-RU', 'Да всё верно', 'Да подтверждаю'],
  ['es-ES', 'Sí, todo correcto', 'Sí, confirmo'],
  ['en-US', 'Yes, that is correct', 'Yes, I confirm'],
  ['pl-PL', 'Tak, wszystko się zgadza', 'Tak, potwierdzam'],
]) test(`haircut booking details/${language}: name and approved phone, no conditions questionnaire, separate confirmation`, async t => {
  const { offerFixture } = await import('@callmate/contracts/fixtures');
  const ownPhone = '+12025550199';
  let supplied = false, clarifiedTime = false;
  const f = await dialogueCall(t, { async generate(input) {
    let candidate;
    if (!supplied) { supplied = true; candidate = { action: 'clarify', missing: ['name', 'price', 'conditions'] }; }
    else if (!clarifiedTime) { clarifiedTime = true; candidate = { action: 'clarify', missing: ['time'] }; }
    else if (input.bookingState === 'reading_back') candidate = { action: 'accept_offer', offerId: input.offer.id, offerVersion: input.offer.version };
    else if (input.bookingState === 'awaiting_business_confirmation') candidate = { action: 'record_business_confirmation', offerId: input.offer.id, offerVersion: input.offer.version, evidenceMessageIds: [input.triggerMessageId] };
    else candidate = { action: 'evaluate_offer', offer: { ...structuredClone(offerFixture),
      appointment: input.plan.request.availability[0].start, evidenceMessageIds: [input.triggerMessageId],
      conditions: { deposit: 'unknown', cancellationFee: 'unknown', paidAddOn: 'unknown' } } };
    return dialogueProposal(input, candidate);
  } }, { language, playbackReceipts: true, request: { shareableContact: { phone: ownPhone, email: null } } });
  f.prompt('What name and phone number should I use for the haircut?');
  await until(() => f.peer.messages.length === 2);
  let call = await f.snapshot();
  const details = call.messages.at(-1);
  assert.equal(details.phrase.id, 'haircut.booking_details');
  assert.ok(details.originalText.includes(f.plan.request.bookingName));
  assert.ok(details.originalText.includes(ownPhone));
  assert.doesNotMatch(details.translationEn, /\?|deposit|cancellation|extras/);
  assert.equal(call.outcome.status, 'pending');
  assert.equal(call.activeOffer, null);
  f.prompt('Which exact appointment time do you mean?');
  await until(() => f.peer.messages.length === 3);
  const timeReply = (await f.snapshot()).messages.at(-1);
  assert.equal(timeReply.translationEn, 'Could you confirm the exact time of the appointment?');
  assert.doesNotMatch(timeReply.originalText + timeReply.translationEn, /zona horaria|часовой пояс|time zone|strefę czasową|UTC|Europe\//);
  f.prompt('A haircut for Alex Example at the agreed time costs 25 euros.');
  await until(async () => (await f.snapshot()).messages.some(m => m.phrase?.id.endsWith('.readback') && m.playback === 'played'));
  f.prompt(assent);
  await until(async () => (await f.snapshot()).bookingState === 'awaiting_business_confirmation');
  f.prompt(confirmation);
  await until(() => f.peer.messages.some(m => m.type === 'end'));
  call = await f.snapshot();
  assert.equal(call.outcome.status, 'confirmed');
  assert.deepEqual(call.outcome.offer.conditions, { deposit: 'unknown', cancellationFee: 'unknown', paidAddOn: 'unknown' });
  assert.ok(call.messages.filter(m => m.speaker === 'assistant').every(m => !/deposit|prepayment|cancellation fee|paid extras/.test(m.translationEn)));
  await f.app.restart();
  assert.equal((await f.snapshot()).outcome.status, 'confirmed');
});

for (const [language, assent, confirmation] of [
  ['ru-RU', 'Да всё так спасибо', 'Да, записал вас'],
  ['ru-RU', 'Да всё так спасибо', 'Да подтверждаю'],
  ['ru-RU', 'Да всё так спасибо', 'Да я уже подтвердил это'],
  ['es-ES', 'Sí, todo correcto, gracias', 'La reserva está confirmada'],
  ['es-ES', 'Sí, confirmo', 'Sí, confirmo'],
  ['es-ES', 'Sí, confirmo', 'Sí, ya lo he confirmado'],
  ['en-US', 'Yes, that is correct, thank you', 'The appointment is booked'],
  ['en-US', 'Yes, I confirm', 'Yes, I confirm'],
  ['en-US', 'Yes, I confirm', 'Yes, I already confirmed that'],
  ['pl-PL', 'Tak, wszystko się zgadza, dziękuję', 'Rezerwacja jest potwierdzona'],
  ['pl-PL', 'Tak, potwierdzam', 'Tak, potwierdzam'],
  ['pl-PL', 'Tak, potwierdzam', 'Tak, już to potwierdziłem'],
]) test(`mock auto-approval/${language}/${confirmation}: inclusive price limit → received readback → acceptance → separate booking confirmation`, async t => {
  const f = await autoApprovalCall(t, { language });
  f.prompt('Synthetic complete offer for 50 EUR');
  await until(async () => (await f.snapshot()).messages.some(m => m.phrase?.id.endsWith('.readback') && m.playback === 'played'));
  let call = await f.snapshot(); assert.equal(call.pendingApproval, null); assert.equal(call.outcome.status, 'pending');
  assert.equal(call.activeOffer.price.amountMinor, call.plan.request.pricePolicy.maximum.amountMinor);
  assert.ok(!f.peer.messages.some(m => /^(Я принимаю|Acepto|I accept|Akceptuję)/.test(m.token)));
  f.prompt(assent);
  await until(async () => (await f.snapshot()).bookingState === 'awaiting_business_confirmation');
  call = await f.snapshot(); assert.equal(call.pendingApproval, null); assert.equal(call.outcome.status, 'pending');
  assert.equal(call.messages.filter(m => m.phrase?.id.endsWith('.acceptance')).length, 1);
  const acceptance = call.messages.find(m => m.phrase?.id.endsWith('.acceptance')); assert.equal(acceptance.playback, 'played');
  assert.ok(!f.peer.messages.some(m => m.type === 'end'));
  f.prompt(confirmation);
  await until(() => f.peer.messages.some(m => m.type === 'end'));
  call = await f.snapshot(); assert.equal(call.outcome.status, 'confirmed'); assert.equal(call.mode, 'simulator');
  assert.equal(call.messages.at(-1).phrase.id, 'haircut.closing_confirmed');
  assert.ok(!call.messages.some(m => m.phrase?.id === 'haircut.confirm_booking'));
  const evidence = call.messages.find(m => call.outcome.confirmationMessageIds.includes(m.id));
  assert.equal(evidence.originalText, confirmation); assert.ok(call.messages.indexOf(evidence) > call.messages.indexOf(acceptance));
  assert.deepEqual(JSON.parse(f.peer.messages.at(-1).handoffData), { reasonCode: 'dialogue_complete', bookingStatus: 'confirmed', simulation: true });
  await f.app.callback([...f.app.calls.keys()][0], 'completed', 1);
  assert.equal((await f.snapshot()).outcome.status, 'confirmed');
  await f.app.restart(); assert.equal((await f.snapshot()).outcome.status, 'confirmed');
  await f.app.api(`/api/v1/calls/${f.id}/conversation`, 'DELETE');
  const db = new Database(join(f.app.dataDir, 'callmate.sqlite'), { readonly: true });
  try { assert.equal(JSON.parse(db.prepare('SELECT internal FROM call_attempts WHERE id=?').get(f.id).internal).dialoguePlayback, undefined); }
  finally { db.close(); }
});

test('dialogue agreement deletion uses persistent snapshots without contacting the provider', async t => {
  const f = await autoApprovalCall(t);
  const path = `/api/v1/calls/${f.id}/agreement`;
  assert.equal((await f.app.api(path, 'DELETE')).status, 409);
  f.prompt('Synthetic complete offer');
  await until(async () => (await f.snapshot()).messages.some(m => m.phrase?.id.endsWith('.readback') && m.playback === 'played'));
  f.prompt('Да всё так спасибо');
  await until(async () => (await f.snapshot()).bookingState === 'awaiting_business_confirmation');
  f.prompt('Да подтверждаю');
  await until(() => f.peer.messages.some(m => m.type === 'end'));
  await f.app.callback([...f.app.calls.keys()][0], 'completed', 1);
  const before = await f.snapshot(); const hungUp = f.app.hungUp; const creates = f.app.creates;
  const deleted = await f.app.api(path, 'DELETE');
  assert.equal(deleted.status, 200); assert.ok(deleted.body.call.agreementDeletedAt);
  assert.deepEqual(deleted.body.call.outcome, before.outcome);
  assert.deepEqual(deleted.body.call.messages, before.messages);
  assert.equal(f.app.hungUp, hungUp); assert.equal(f.app.creates, creates);
  await f.app.restart();
  assert.equal((await f.snapshot()).agreementDeletedAt, deleted.body.call.agreementDeletedAt);
  assert.deepEqual((await f.app.api(path, 'DELETE')).body.call, deleted.body.call);
  assert.equal((await f.app.api('/api/v1/history')).body.items[0].agreementDeletedAt, deleted.body.call.agreementDeletedAt);
});

for (const [name, extra] of [
  ['missing', { playbackReceipts: false }],
  ['wrong session', { receiptTransform: r => ({ ...r, sessionId: 'VX' + 'f'.repeat(32) }) }],
  ['wrong text', { receiptTransform: r => ({ ...r, textSha256: 'f'.repeat(64) }) }],
  ['wrong sequence', { receiptTransform: r => ({ ...r, sequence: r.sequence + 1 }) }],
  ['wrong language', { receiptTransform: r => ({ ...r, language: 'es-ES' }) }],
]) test(`mock auto-approval: ${name} receipt cannot authorize acceptance`, async t => {
  const f = await autoApprovalCall(t, extra);
  f.prompt('Synthetic complete offer'); await until(() => f.peer.messages.length === 2);
  f.prompt('Да всё так спасибо');
  await until(() => f.app.runtime.controller.replayEvents(f.id, 0).some(e => e.type === 'call.error'));
  const call = await f.snapshot(); assert.equal(call.outcome.status, 'pending');
  assert.ok(!call.messages.some(m => m.phrase?.id.endsWith('.acceptance')));
});

for (const [name, request] of [
  ['above the price limit', { pricePolicy: { maximum: { amountMinor: 4999, currency: 'EUR' }, allowUnknownPrice: false } }],
  ['explicit approval requested', { bookingAuthority: 'ask_before_accepting' }],
]) test(`mock auto-approval: ${name} still asks the user`, async t => {
  const f = await autoApprovalCall(t, { request });
  f.prompt('Synthetic complete offer'); await until(async () => (await f.snapshot()).pendingApproval !== null);
  const call = await f.snapshot(); assert.equal(call.bookingState, 'awaiting_approval');
  assert.ok(!call.messages.some(m => /\.(readback|acceptance)$/.test(m.phrase?.id ?? '')));
});

for (const [language, assent, unsafeReadbackReply, unsafeConfirmations, confirmation] of [
  ['ru-RU', 'Да всё так спасибо', 'Да, но цена теперь другая',
    ['Наверное да, но нужно проверить', 'Да подтверждаю, но время другое'], 'Да я уже подтвердил это'],
  ['es-ES', 'Sí, confirmo', 'Sí, pero el precio ha cambiado',
    ['Sí, no lo he confirmado', 'Quizás sí', 'Sí, confirmo, pero a otra hora'], 'Sí, ya lo he confirmado'],
  ['en-US', 'Yes, I confirm', 'Yes, but the price has changed',
    ["Yes, I haven't confirmed it", 'I think so', 'Yes, I confirm, but at another time'], 'Yes, I already confirmed that'],
  ['pl-PL', 'Tak, potwierdzam', 'Tak, ale cena się zmieniła',
    ['Tak, jeszcze nie potwierdziłem', 'Chyba tak', 'Tak, potwierdzam, ale o innej godzinie'], 'Tak, już to potwierdziłem'],
]) test(`mock auto-approval/${language}: an overconfident model cannot accept or confirm an ambiguous or corrected reply`, async t => {
  const f = await autoApprovalCall(t, { language });
  f.prompt('Synthetic complete offer'); await until(async () => (await f.snapshot()).messages.at(-1).playback === 'played');
  f.prompt(unsafeReadbackReply); await until(() => f.peer.messages.length === 3);
  assert.equal((await f.snapshot()).messages.at(-1).phrase.id, 'haircut.confirm_details');
  assert.ok(!(await f.snapshot()).messages.some(m => m.phrase?.id.endsWith('.acceptance')));
  f.prompt(assent); await until(async () => (await f.snapshot()).bookingState === 'awaiting_business_confirmation');
  for (const reply of unsafeConfirmations) {
    const before = f.peer.messages.length;
    f.prompt(reply); await until(() => f.peer.messages.length === before + 1);
    assert.equal((await f.snapshot()).messages.at(-1).phrase.id, 'haircut.confirm_booking');
    assert.equal((await f.snapshot()).outcome.status, 'pending');
    assert.ok(!f.peer.messages.some(m => m.type === 'end'));
  }
  f.prompt(confirmation); await until(async () => (await f.snapshot()).outcome.status === 'confirmed');
});

test('mock auto-approval: interruption while a receipt is in flight cannot mark the readback played', async t => {
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const f = await autoApprovalCall(t, { beforeOutputReply: async (_call, sequence) => { if (sequence === 2) { entered = true; await gate; } } });
  f.prompt('Synthetic complete offer'); await until(() => entered);
  f.peer.send(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: '', durationUntilInterruptMs: 1 }));
  await until(async () => (await f.snapshot()).messages.at(-1).playback === 'interrupted');
  release(); await delay(30);
  f.prompt('Да всё так спасибо');
  await until(() => f.app.runtime.controller.replayEvents(f.id, 0).some(e => e.type === 'call.error'));
  const call = await f.snapshot(); assert.ok(!call.messages.some(m => m.phrase?.id.endsWith('.acceptance')));
  assert.equal(call.outcome.status, 'pending');
});
