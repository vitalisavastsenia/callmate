import { authHeaders } from './fixtures/auth.mjs';
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { XMLParser } from "fast-xml-parser";
import { WebSocket } from "ws";
import { loadConfig } from "../dist/config.js";
import { openStore } from "../dist/storage.js";

const sid = (prefix) => prefix + randomBytes(16).toString("hex");
const input = () => ({ requestId: randomUUID(), initialMessage: "  Здравствуйте! Una cita, por favor. 🧪 ", language: "es-ES" });
async function until(predicate) {
  for (let index = 0; index < 300; index++) { if (await predicate()) return; await delay(20); }
  assert.fail("Timed out waiting for recovery");
}
async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "callmate-recovery-"));
  const calls = new Map(); const peers = []; let child; let address;
  const control = { offline: false, rejectHangup: false, loseCreateReply: false, holdHealth: false };
  const counts = { creates: 0, reads: 0, hangups: 0 };
  const provider = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    response.setHeader("content-type", "application/json");
    if (control.offline) { response.writeHead(503).end("{}"); return; }
    if (request.url === "/healthz") {
      if (!control.holdHealth) response.end(JSON.stringify({ mock: true, service: "CallMate Mock ConversationRelay" }));
      return;
    }
    assert.equal(request.headers.authorization, "Basic " + Buffer.from("mock:mock-local-only").toString("base64"));
    if (request.url.endsWith("/Calls.json") && request.method === "POST") {
      counts.creates++;
      const fields = new URLSearchParams(raw);
      const relay = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" }).parse(fields.get("Twiml")).Response.Connect.ConversationRelay;
      const call = { sid: sid("CA"), account_sid: config.mockAccountSid, from: fields.get("From"), to: fields.get("To"), status: "ringing", relay };
      calls.set(call.sid, call);
      if (control.loseCreateReply) response.destroy();
      else response.writeHead(201).end(JSON.stringify(call));
      return;
    }
    const id = /\/Calls\/(CA[0-9a-f]{32})\.json$/.exec(request.url)?.[1];
    const call = calls.get(id);
    if (request.method === "GET") counts.reads++;
    if (!call) { response.writeHead(404).end("{}"); return; }
    if (request.method === "POST") {
      counts.hangups++;
      const status = new URLSearchParams(raw).get("Status");
      assert.ok(["completed", "canceled"].includes(status));
      if (control.rejectHangup) { response.writeHead(503).end("{}"); return; }
      call.status = status; call.peer?.close(1000);
    }
    response.end(JSON.stringify({ sid: call.sid, account_sid: call.account_sid, from: call.from, to: call.to, status: call.status }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const config = { ...loadConfig({ CALLMATE_DATA_DIR: dataDir, NODE_ENV: "test", TELEPHONY_PROVIDER: "mock",
    CALLMATE_MOCK_API_BASE: `http://127.0.0.1:${provider.address().port}` }), apiPort: 0, callbackPort: 0 };
  const crash = async () => {
    if (!child) return;
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; child = undefined;
  };
  const start = async () => {
    child = fork(new URL("./fixtures/recovery-runtime.mjs", import.meta.url), [], {
      env: { ...process.env, CALLMATE_TEST_CONFIG: JSON.stringify(config) }, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let diagnostics = ""; child.stderr.on("data", (chunk) => { diagnostics += chunk; });
    address = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Recovery runtime startup timed out")), 15000);
      child.once("message", (message) => { clearTimeout(timeout); resolve(message); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error(`Recovery runtime exited: ${diagnostics}`)); });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    });
  };
  t.after(async () => {
    await crash(); peers.forEach((peer) => peer.terminate()); provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve)); rmSync(dataDir, { recursive: true, force: true });
  });
  await start();
  return { calls, counts, control, config, crash, start,
    record(id) { const store = openStore(dataDir); try { return store.calls.get(id); } finally { store.close(); } },
    edit(id, work) { const store = openStore(dataDir); try { const attempt = store.calls.get(id); work(attempt); store.calls.save(attempt); } finally { store.close(); } },
    events(id) { const store = openStore(dataDir); try { return store.calls.events(id, 0); } finally { store.close(); } },
    async api(path, method = "GET", body) {
      const response = await fetch(address.api + path, { method, signal: AbortSignal.timeout(10000), headers: { ...authHeaders(dataDir), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
    async answer(call, overrides = {}) {
      const peer = new WebSocket(address.relay, { headers: { "X-CallMate-Mock": "true" } }); peers.push(peer);
      peer.on("error", () => {}); peer.messages = [];
      peer.on("message", (raw) => peer.messages.push(JSON.parse(raw.toString())));
      peer.closed = new Promise((resolve) => peer.once("close", resolve));
      await once(peer, "open"); call.peer = peer; call.status = "in-progress";
      peer.send(JSON.stringify({ type: "setup", callSid: call.sid, sessionId: sid("VX"), accountSid: config.mockAccountSid,
        from: call.from, to: call.to, customParameters: Object.fromEntries(call.relay.Parameter.map((p) => [p.name, p.value])), ...overrides }));
      return peer;
    },
  };
}

test("SIGKILL recovery ends queued, ringing and connected orphans without dialing or replaying speech", async (t) => {
  for (const state of ["queued", "ringing", "in-progress"]) await t.test(state, async (t) => {
    const app = await fixture(t); const request = input();
    const created = (await app.api("/api/dev/conversations", "POST", request)).body.conversation;
    const call = app.calls.get(created.callSid); let sessionId = null;
    if (state === "in-progress") {
      const peer = await app.answer(call); await until(() => peer.messages.length === 1);
      peer.send(JSON.stringify({ type: "prompt", voicePrompt: "  Sí, dígame. 🧪 ", lang: "es-ES", last: true }));
      await until(() => app.record(created.id).call.messages.length === 2);
      sessionId = app.record(created.id).internal.correlation.sessionId; assert.match(sessionId, /^VX/);
    } else call.status = state;
    const before = app.record(created.id); const token = call.relay.Parameter.find((p) => p.name === "authToken").value;
    assert.ok(!JSON.stringify(before).includes(token)); assert.match(before.internal.correlation.tokenHash, /^[a-f0-9]{64}$/);
    await app.crash(); await app.start();
    const after = app.record(created.id);
    assert.equal(after.call.callState, "ended"); assert.equal(after.call.outcome.reason, "technical_failure");
    assert.equal(after.internal.callSid, call.sid); assert.equal(after.internal.correlation.sessionId, sessionId);
    assert.deepEqual(after.call.messages, before.call.messages);
    assert.equal(app.counts.creates, 1); assert.equal(app.counts.hangups, 1); assert.equal(call.status, state === "in-progress" ? "completed" : "canceled");
    const events = app.events(created.id);
    assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: events.length }, (_, i) => i + 1));
    assert.equal(events.at(-1).payload.callState, "ended");
    assert.ok(!JSON.stringify(events).includes(token)); assert.ok(!JSON.stringify(events).includes(before.internal.correlation.tokenHash));
    assert.equal((await app.api("/api/dev/conversations", "POST", request)).body.conversation.id, created.id);
    assert.equal(app.counts.creates, 1);
    await app.crash(); await app.start(); // Terminal recovery is itself idempotent.
    assert.deepEqual(app.record(created.id), after); assert.equal(app.counts.hangups, 1);
  });
});

test("provider terminal states after a crash are reconciled without a hangup request", async (t) => {
  for (const [provider, expected] of [["completed", "ended"], ["canceled", "ended"], ["busy", "busy"], ["no-answer", "no_answer"], ["failed", "failed"]]) await t.test(provider, async (t) => {
    const app = await fixture(t); const created = (await app.api("/api/dev/conversations", "POST", input())).body.conversation;
    await app.crash(); app.calls.get(created.callSid).status = provider; await app.start();
    assert.equal(app.record(created.id).call.callState, expected);
    assert.equal(app.counts.hangups, 0); assert.equal(app.counts.creates, 1);
  });
});

test("outages and failed hangups retain the slot and recover in the background when the provider returns", async (t) => {
  const app = await fixture(t); const created = (await app.api("/api/dev/conversations", "POST", input())).body.conversation;
  await app.crash(); app.control.offline = true; await app.start();
  assert.equal(app.record(created.id).call.callState, "reconciliation_required");
  assert.equal((await app.api("/api/dev/conversations", "POST", input())).status, 409);
  app.control.offline = false; app.control.rejectHangup = true;
  await until(() => app.counts.hangups > 0);
  assert.equal(app.record(created.id).call.outcome.status, "pending");
  assert.equal((await app.api("/api/dev/conversations", "POST", input())).status, 409);
  app.control.rejectHangup = false;
  await until(() => app.record(created.id).call.callState === "ended");
  assert.equal(app.counts.creates, 1); assert.equal(app.calls.get(created.callSid).status, "canceled");
});

test("404 is not completion; changed provider identity and mismatched resources cannot hang up unrelated calls", async (t) => {
  const app = await fixture(t); const created = (await app.api("/api/dev/conversations", "POST", input())).body.conversation;
  await app.crash(); const call = app.calls.get(created.callSid); app.calls.delete(call.sid); await app.start();
  assert.equal(app.record(created.id).call.callState, "reconciliation_required"); assert.equal(app.counts.hangups, 0);
  await app.crash(); app.calls.set(call.sid, call);
  const originalAccount = app.config.mockAccountSid; app.config.mockAccountSid = sid("AC");
  const reads = app.counts.reads; await app.start();
  assert.equal(app.counts.reads, reads); assert.equal(app.counts.hangups, 0);
  await app.api(`/api/v1/calls/${created.id}/stop`, "POST", {});
  assert.equal(app.counts.hangups, 0); assert.equal((await app.api("/api/dev/conversations", "POST", input())).status, 409);
  await app.crash(); app.config.mockAccountSid = originalAccount; call.to = "+34999999999"; await app.start();
  assert.equal(app.counts.hangups, 0); assert.equal(app.record(created.id).call.outcome.status, "pending");
  call.to = "+48111111111";
  await until(() => app.record(created.id).call.callState === "ended"); assert.equal(app.counts.creates, 1);
});

test("a lost create response is resolved by authenticated late setup after SIGKILL, without a second greeting", async (t) => {
  const app = await fixture(t); app.control.loseCreateReply = true; const request = input();
  const created = (await app.api("/api/dev/conversations", "POST", request)).body.conversation;
  assert.equal(created.status, "unknown"); assert.equal(created.callSid, null);
  const call = [...app.calls.values()][0]; await app.crash(); await app.start();
  assert.equal(app.record(created.id).call.callState, "reconciliation_required");
  assert.equal((await app.api("/api/dev/conversations", "POST", input())).status, 409);
  const bad = await app.answer(call, { customParameters: { conversationId: created.id, authToken: "invalid" } });
  assert.equal(await bad.closed, 1008); assert.equal(app.record(created.id).internal.callSid, null);
  const foreign = await app.answer(call, { accountSid: sid("AC") });
  assert.equal(await foreign.closed, 1008); assert.equal(app.record(created.id).internal.callSid, null);
  const valid = await app.answer(call); await valid.closed;
  await until(() => app.record(created.id).call.callState === "ended");
  const recovered = app.record(created.id);
  assert.equal(recovered.internal.callSid, call.sid); assert.match(recovered.internal.correlation.sessionId, /^VX/);
  assert.equal((await app.api(`/api/dev/conversations/${created.id}`)).body.conversation.sessionId, recovered.internal.correlation.sessionId);
  assert.deepEqual(valid.messages, []); assert.equal(recovered.call.messages[0].playback, "withheld");
  assert.equal(app.counts.creates, 1); assert.equal(app.counts.hangups, 1);
  assert.equal((await app.api("/api/dev/conversations", "POST", request)).body.conversation.id, created.id);
});

test("crash before submitting the create intent releases only the provably undialed reservation", async (t) => {
  const app = await fixture(t); app.control.holdHealth = true; const request = input();
  const pending = app.api("/api/dev/conversations", "POST", request).catch(() => {});
  await until(() => app.record(request.requestId)?.internal.correlation.creation === "prepared");
  await app.crash(); await pending; app.control.holdHealth = false; await app.start();
  assert.equal(app.record(request.requestId).call.callState, "failed"); assert.equal(app.counts.creates, 0);
  assert.equal((await app.api("/api/dev/conversations", "POST", request)).body.conversation.id, request.requestId);
  assert.equal(app.counts.creates, 0);
  assert.equal((await app.api("/api/dev/conversations", "POST", input())).status, 202); assert.equal(app.counts.creates, 1);
});

test("a disconnected relay is an orphan and is ended without browser polling", async (t) => {
  const app = await fixture(t); const created = (await app.api("/api/dev/conversations", "POST", input())).body.conversation;
  const call = app.calls.get(created.callSid); const peer = await app.answer(call);
  await until(() => peer.messages.length === 1); peer.terminate();
  await until(() => app.record(created.id).call.callState === "ended");
  assert.equal(app.record(created.id).call.outcome.reason, "technical_failure");
  assert.equal(app.counts.creates, 1); assert.equal(app.counts.hangups, 1);
});

test("legacy active attempts remain reserved without guessing provider identity; completed legacy attempts remain readable", async (t) => {
  const app = await fixture(t); const request = input();
  const created = (await app.api("/api/dev/conversations", "POST", request)).body.conversation;
  await app.crash(); app.edit(created.id, (attempt) => { delete attempt.internal.correlation; });
  const reads = app.counts.reads; await app.start();
  assert.equal(app.record(created.id).call.callState, "reconciliation_required");
  assert.equal(app.counts.reads, reads); assert.equal(app.counts.hangups, 0);
  assert.equal((await app.api("/api/dev/conversations", "POST", input())).status, 409);
  await app.crash();
  // Simulate an already terminal record from the previous version, not a user recovery override.
  app.edit(created.id, (attempt) => {
    attempt.call.callState = "ended"; attempt.call.bookingState = "not_booked";
    attempt.call.outcome = { status: "not_booked", reason: "development_only", summaryEn: "Manual mock call ended." };
    attempt.internal.status = "completed";
  });
  await app.start();
  const view = (await app.api("/api/dev/conversations", "POST", request)).body.conversation;
  assert.equal(view.status, "completed"); assert.equal(view.sessionId, null); assert.equal(app.counts.creates, 1);
});
