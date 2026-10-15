import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
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
    const id = /\/Calls\/(CA[0-9a-f]{32})\.json$/.exec(req.url)?.[1]; const call = calls.get(id);
    if (!call) { res.writeHead(404).end('{}'); return; }
    if (req.method === "POST") {
      assert.equal(new URLSearchParams(raw).get("Status"), "completed"); hungUp++;
      if (options.rejectHangup) { res.writeHead(503).end('{}'); return; }
      call.status = "completed"; call.peer?.close(1000);
      if (options.beforeHangupReply) await options.beforeHangupReply(call);
    }
    const resource = { sid: call.sid, status: call.status, account_sid: call.account_sid, from: call.from, to: call.to };
    if (req.method === "GET" && options.beforeGetReply) await options.beforeGetReply(call);
    res.end(JSON.stringify(resource));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dataDir = mkdtempSync(join(tmpdir(), "callmate-console-"));
  const config = { ...loadConfig({ CALLMATE_DATA_DIR: dataDir, NODE_ENV: "test", TELEPHONY_PROVIDER: "mock", CALLMATE_MOCK_API_BASE: origin }), apiPort: 0, callbackPort: 0 };
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk; done(); } });
  let runtime = createRuntime(config, stream, options.simulator);
  await runtime.start();
  config.mockRelayUrl = `ws://127.0.0.1:${runtime.callbacks.server.address().port}/ws/voice`;
  let apiOrigin = `http://127.0.0.1:${runtime.privateApi.server.address().port}`;
  t.after(async () => { peers.forEach((peer) => peer.terminate()); await runtime.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(dataDir, { recursive: true, force: true }); });
  return { calls, config, dataDir, get runtime() { return runtime; }, get apiOrigin() { return apiOrigin; },
    async restart(beforeStart) {
      await runtime.close();
      if (beforeStart) beforeStart();
      runtime = createRuntime(config, stream, options.simulator); await runtime.start();
      config.mockRelayUrl = `ws://127.0.0.1:${runtime.callbacks.server.address().port}/ws/voice`;
      apiOrigin = `http://127.0.0.1:${runtime.privateApi.server.address().port}`;
    }, get creates() { return creates; }, get hungUp() { return hungUp; }, get logs() { return logs; },
    async api(path, method = "GET", body) {
      const response = await fetch(apiOrigin + path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
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
      peer.on("message", (raw) => peer.messages.push(JSON.parse(raw.toString())));
      peer.closed = new Promise((resolve) => peer.once("close", (code) => resolve(code)));
      await once(peer, "open"); call.peer = peer; call.status = "in-progress";
      peer.send(JSON.stringify({ type: "setup", callSid: id, sessionId: sid("VX"), accountSid: config.mockAccountSid,
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
    headers: { 'Last-Event-ID': String(after) }, signal: AbortSignal.timeout(8000),
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
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({
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
      'content-type': 'application/json', 'idempotency-key': key,
    }, body: JSON.stringify({ planId: plan.id, planVersion: 1, mode: 'simulator' }) });
    return { status: response.status, body: await response.json() };
  };
  const request = input(); const manual = (await app.api('/api/dev/conversations', 'POST', request)).body.conversation;
  assert.equal((await start()).body.error.code, 'CALL_ALREADY_ACTIVE');
  assert.equal((await start(request.requestId)).body.error.code, 'IDEMPOTENCY_CONFLICT');
  await app.api(`/api/v1/calls/${manual.id}/stop`, 'POST', {});
  const key = randomUUID(); const scripted = await start(key); assert.equal(scripted.status, 202);
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
