import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocket } from "ws";
import { loadConfig } from "../dist/config.js";
import { createRuntime } from "../dist/server.js";

const sid = (prefix) => prefix + randomBytes(16).toString("hex");
const setupMessage = (overrides = {}) => ({ type: "setup", sessionId: sid("VX"), callSid: sid("CA"),
  accountSid: "AC" + "0".repeat(32), from: "+48000000000", to: "+48111111111", customParameters: { taskId: "relay-test" }, ...overrides });
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); }
  assert.fail("Timed out waiting for the backend development relay");
}
async function backend(t, env = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "callmate-relay-"));
  let logs = "";
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk; done(); } });
  const config = { ...loadConfig({ CALLMATE_DATA_DIR: dataDir, NODE_ENV: "test", TELEPHONY_PROVIDER: "mock", ...env }), apiPort: 0, callbackPort: 0 };
  const runtime = createRuntime(config, stream); const sockets = [];
  t.after(async () => { sockets.forEach((socket) => socket.terminate()); await runtime.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await runtime.start();
  const url = `ws://127.0.0.1:${runtime.callbacks.server.address().port}/ws/voice`;
  const socket = (headers = { "X-CallMate-Mock": "true" }, target = url) => {
    const ws = new WebSocket(target, { headers }); sockets.push(ws);
    ws.on("error", () => {});
    ws.received = []; ws.on("message", (raw) => ws.received.push(JSON.parse(raw.toString())));
    ws.closed = new Promise((resolve) => ws.once("close", (code) => resolve(code)));
    ws.sendMessage = (message) => ws.send(JSON.stringify(message));
    return ws;
  };
  return { runtime, url, socket, get logs() { return logs; },
    async connected(message = setupMessage()) {
      const ws = socket(); await once(ws, "open"); ws.sendMessage(message);
      await until(() => ws.received.some((item) => item.type === "text" && item.last));
      assert.match(ws.received[0].token, /Scripted echo only/); ws.received.length = 0;
      return ws;
    },
    async rejected(headers, path = url) {
      const ws = socket(headers, path);
      return new Promise((resolve) => ws.once("unexpected-response", (req, res) => {
        const status = res.statusCode; req.destroy(); res.destroy(); ws.terminate(); resolve(status);
      }));
    },
  };
}

test("development gate rejects production/live/fake, missing marker, browser origins and wrong listener/path", async (t) => {
  for (const env of [{ NODE_ENV: "production" }, { CALLMATE_MODE: "live" }, { TELEPHONY_PROVIDER: "fake" }]) {
    const app = await backend(t, env);
    assert.equal(await app.rejected({ "X-CallMate-Mock": "true" }), 404);
  }
  const app = await backend(t);
  for (const headers of [{}, { "X-CallMate-Mock": "false" }, { "X-CallMate-Mock": "true", Origin: "http://localhost:8080" },
    { "X-CallMate-Mock": "true", "Sec-Fetch-Site": "same-origin" }]) assert.equal(await app.rejected(headers), 403);
  assert.equal(await app.rejected({ "X-CallMate-Mock": "true" }, app.url + "?token=private-query"), 404);
  const privateUrl = `http://127.0.0.1:${app.runtime.privateApi.server.address().port}/ws/voice`;
  assert.equal((await fetch(privateUrl)).status, 404);
  assert.equal((await app.runtime.callbacks.inject({ url: "/api/v1/settings" })).statusCode, 404);
});

test("Answer setup and Unicode prompts stream exact scripted replies without changing booking history", async (t) => {
  const app = await backend(t);
  for (const [lang, text, prefix] of [
    ["ru-RU", "Здравствуйте! Завтра в 18:00? 🧪 ", "Тестовое эхо"],
    ["es-ES", "¿Mañana a las 18:00? ¡Sí! 🧪 ", "Eco de desarrollo"],
    ["pl-PL", "Dzień dobry, Łódź! 🧪 ", "Echo testowe"],
    ["en-US", "A haircut tomorrow? 🧪 ", "Development echo"],
  ]) {
    const ws = await app.connected();
    ws.sendMessage({ type: "prompt", voicePrompt: text, lang, last: true });
    await until(() => ws.received.some((message) => message.last));
    assert.equal(ws.received.length, 2); assert.equal(ws.received[0].last, false); assert.equal(ws.received[1].last, true);
    assert.ok(ws.received.every((message) => message.type === "text" && message.lang === lang));
    const output = ws.received.map((message) => message.token).join("");
    assert.ok(output.startsWith(prefix)); assert.ok(output.endsWith(text));
    ws.close(); await ws.closed;
  }
  assert.deepEqual(app.runtime.simulator.history(20).items, []);
});

test("partial prompts wait for last, interrupt clears partial input, and DTMF does not fabricate a booking", async (t) => {
  const app = await backend(t); const ws = await app.connected();
  ws.sendMessage({ type: "prompt", voicePrompt: "¿Mañana ", lang: "es-ES", last: false });
  await delay(30); assert.equal(ws.received.length, 0);
  ws.sendMessage({ type: "prompt", voicePrompt: "a las seis? ", lang: "es-ES", last: true });
  await until(() => ws.received.length === 2);
  assert.ok(ws.received.map((message) => message.token).join("").endsWith("¿Mañana a las seis? "));
  ws.received.length = 0;
  ws.sendMessage({ type: "prompt", voicePrompt: "discard me", lang: "es-ES", last: false });
  ws.sendMessage({ type: "interrupt", utteranceUntilInterrupt: "", durationUntilInterruptMs: 0 });
  ws.sendMessage({ type: "dtmf", digit: "#" });
  ws.sendMessage({ type: "prompt", voicePrompt: "Nuevo turno", lang: "es-ES", last: true });
  await until(() => ws.received.length === 2);
  const output = ws.received.map((message) => message.token).join("");
  assert.ok(output.endsWith("Nuevo turno")); assert.ok(!output.includes("discard me"));
});

test("setup must be first/once and closed session or call identities cannot be immediately replayed", async (t) => {
  const app = await backend(t);
  const early = app.socket(); await once(early, "open");
  early.sendMessage({ type: "prompt", voicePrompt: "Hello", lang: "en-US", last: true });
  assert.equal(await early.closed, 1008);
  const identity = setupMessage(); const ws = await app.connected(identity);
  ws.sendMessage(identity); assert.equal(await ws.closed, 1008);
  for (const replay of [identity, { ...setupMessage(), callSid: identity.callSid }, { ...setupMessage(), sessionId: identity.sessionId }]) {
    const duplicate = app.socket(); await once(duplicate, "open"); duplicate.sendMessage(replay);
    assert.equal(await duplicate.closed, 1008);
  }
  const fresh = await app.connected(); assert.equal(fresh.readyState, WebSocket.OPEN);
});

test("malformed/oversized frames, unsupported types and bounded input fail without killing the backend", async (t) => {
  const app = await backend(t);
  for (const [raw, code] of [["not json", 1007], [JSON.stringify({ type: "unknown" }), 1007],
    [JSON.stringify({ type: "prompt", voicePrompt: "a".repeat(8001), lang: "en-US", last: true }), 1007],
    ["x".repeat(32_769), 1009]]) {
    const ws = await app.connected(); ws.send(raw); assert.equal(await ws.closed, code);
  }
  const binary = await app.connected(); binary.send(Buffer.from("not text")); assert.equal(await binary.closed, 1007);
  const valid = await app.connected(); assert.equal(valid.readyState, WebSocket.OPEN);
});

test("concurrent calls are isolated, socket limits recover after close, and /end terminates only its session", async (t) => {
  const app = await backend(t); const peers = [];
  for (let index = 0; index < 5; index++) peers.push(await app.connected());
  assert.equal(await app.rejected({ "X-CallMate-Mock": "true" }), 503);
  peers[0].sendMessage({ type: "prompt", voicePrompt: "только один", lang: "ru-RU", last: true });
  await until(() => peers[0].received.length === 2);
  assert.ok(peers.slice(1).every((ws) => ws.received.length === 0));
  peers[0].received.length = 0;
  peers[0].sendMessage({ type: "prompt", voicePrompt: "/end", lang: "ru-RU", last: true });
  await until(() => peers[0].received.some((message) => message.type === "end"));
  assert.equal(JSON.parse(peers[0].received[0].handoffData).bookingStatus, "not_booked");
  peers[0].close(); await peers[0].closed;
  const fresh = await app.connected(); assert.equal(fresh.readyState, WebSocket.OPEN);
});

test("shutdown closes active relay sockets and logs omit transcript, parameters and raw errors", async (t) => {
  const app = await backend(t);
  const ws = await app.connected(setupMessage({ customParameters: { taskId: "private-task", password: "private-secret" } }));
  ws.sendMessage({ type: "prompt", voicePrompt: "private-transcript", lang: "en-US", last: true });
  await until(() => ws.received.length === 2);
  ws.sendMessage({ type: "error", description: "private-provider-error" });
  assert.equal(await ws.closed, 1011);
  const active = await app.connected(); await app.runtime.close(); await active.closed;
  assert.equal(active.readyState, WebSocket.CLOSED);
  for (const value of ["private-task", "private-secret", "private-transcript", "private-provider-error"]) assert.ok(!app.logs.includes(value));
});
