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
import { XMLParser } from "fast-xml-parser";
import { WebSocket } from "ws";
import { loadConfig } from "../dist/config.js";
import { createRuntime } from "../dist/server.js";

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
      const call = { sid: sid("CA"), status: "ringing", relay, xml: form.get("Twiml") };
      calls.set(call.sid, call); res.writeHead(201).end(JSON.stringify(call)); return;
    }
    const id = /\/Calls\/(CA[0-9a-f]{32})\.json$/.exec(req.url)?.[1]; const call = calls.get(id);
    if (!call) { res.writeHead(404).end('{}'); return; }
    if (req.method === "POST") {
      assert.equal(new URLSearchParams(raw).get("Status"), "completed"); hungUp++;
      call.status = "completed"; call.peer?.close(1000);
    }
    res.end(JSON.stringify({ sid: call.sid, status: call.status }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dataDir = mkdtempSync(join(tmpdir(), "callmate-console-"));
  const config = { ...loadConfig({ CALLMATE_DATA_DIR: dataDir, NODE_ENV: "test", TELEPHONY_PROVIDER: "mock", CALLMATE_MOCK_API_BASE: origin }), apiPort: 0, callbackPort: 0 };
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk; done(); } });
  const runtime = createRuntime(config, stream);
  await runtime.start();
  config.mockRelayUrl = `ws://127.0.0.1:${runtime.callbacks.server.address().port}/ws/voice`;
  const apiOrigin = `http://127.0.0.1:${runtime.privateApi.server.address().port}`;
  t.after(async () => { peers.forEach((peer) => peer.terminate()); await runtime.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(dataDir, { recursive: true, force: true }); });
  return { calls, runtime, apiOrigin, get creates() { return creates; }, get hungUp() { return hungUp; }, get logs() { return logs; },
    async api(path, method = "GET", body) {
      const response = await fetch(apiOrigin + path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
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
  assert.deepEqual(app.runtime.simulator.history(20).items, []);
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
  const disabled = new DevelopmentConversations(bad);
  await assert.rejects(disabled.start(input()), (error) => error.status === 503);
  await disabled.close();
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
