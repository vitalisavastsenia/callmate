import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { backend, service, until } from "./helpers.mjs";
import { parseTwiml } from "../dist/server/twiml.js";
import { loadConfig } from "../dist/server/config.js";

for (const [language, prompt, tokens] of [
  ["ru-RU", "Здравствуйте, хочу записаться на стрижку завтра.", ["Да, ", "есть время ", "в 18:00. Ждём вас!"]],
  ["es-ES", "¿Puedo reservar una cita para mañana?", ["Sí, ", "mañana a las ", "18:00. ¡Gracias!"]],
]) {
  test(`${language} preserves Unicode caller prompts and streamed replies over HTTP and WebSocket`, async (t) => {
    const target = await backend(t); const local = await service(t, target);
    const call = await local.create({ language });
    assert.equal(call.language, language);
    await local.request(`/api/sessions/${call.id}/answer`, "POST"); await target.setup(call.id);
    assert.equal((await local.request(`/api/sessions/${call.id}/utterances`, "POST", { text: prompt })).status, 200);
    await until(() => target.messages.some((item) => item.message.type === "prompt"));
    assert.deepEqual(target.messages.find((item) => item.message.type === "prompt").message,
      { type: "prompt", voicePrompt: prompt, lang: language, last: true });
    tokens.forEach((token, i) => target.send(call.id, { type: "text", token, last: i === tokens.length - 1 }));
    await until(() => local.controller.view(call.id).transcript.some((item) => item.speaker === "assistant" && item.final));
    const { body } = await local.request(`/api/sessions/${call.id}`);
    assert.equal(body.ttsLanguage, language);
    assert.equal(body.transcript.at(-1).lang, language);
    assert.equal(body.transcript.at(-1).text, tokens.join(""));
  });
}

test("Polish prompt, streamed tokens including empty/leading/trailing spaces, interrupt and DTMF use the relay", async (t) => {
  const target = await backend(t); const local = await service(t, target); const call = await local.create({ customParameters: { taskId: "polski-001" } });
  await local.request(`/api/sessions/${call.id}/answer`, "POST"); await target.setup(call.id);
  const input = "Mamy termin o 18:00, ale kosztuje 35 euro. Łódź, dziękuję!";
  assert.equal((await local.request(`/api/sessions/${call.id}/utterances`, "POST", { text: input })).status, 200);
  await until(() => target.messages.length === 2);
  assert.deepEqual(target.messages[1].message, { type: "prompt", voicePrompt: input, lang: "pl-PL", last: true });
  await local.request(`/api/sessions/${call.id}/utterances`, "POST", { text: "Część", last: false });
  const tokens = ["Dzień dobry! ", "", "Czy macie ", "wolny termin? "];
  tokens.forEach((token, index) => target.send(call.id, { type: "text", token, ...(index === tokens.length - 1 ? { last: true } : {}) }));
  await until(() => local.controller.view(call.id).transcript.some((entry) => entry.speaker === "assistant" && entry.final));
  const output = local.controller.view(call.id).transcript.find((entry) => entry.speaker === "assistant");
  assert.equal(output.text, tokens.join("")); assert.equal(output.lang, "pl-PL");
  await local.request(`/api/sessions/${call.id}/interrupt`, "POST", { utteranceUntilInterrupt: "Dzień dobry,", durationUntilInterruptMs: 650 });
  await local.request(`/api/sessions/${call.id}/dtmf`, "POST", { digit: "#" });
  await until(() => target.messages.some((entry) => entry.message.type === "dtmf"));
  assert.deepEqual(target.messages.find((entry) => entry.message.type === "interrupt").message,
    { type: "interrupt", utteranceUntilInterrupt: "Dzień dobry,", durationUntilInterruptMs: 650 });
  assert.deepEqual(target.messages.at(-1).message, { type: "dtmf", digit: "#" });
  assert.equal((await local.request(`/api/sessions/${call.id}/dtmf`, "POST", { digit: "12" })).status, 400);
  assert.ok(local.controller.view(call.id).events.some((entry) => entry.type === "playback.cancel"));
});

test("language, sendDigits and play have explicit behavior; end preserves exact string and Connect action fields", async (t) => {
  const target = await backend(t); const local = await service(t, target); const call = await local.create({ twiml: target.xml });
  await local.request(`/api/sessions/${call.id}/answer`, "POST"); const setup = await target.setup(call.id);
  target.send(call.id, { type: "language", ttsLanguage: "es-ES", transcriptionLanguage: "en-US" });
  target.send(call.id, { type: "sendDigits", digits: "9www1#" });
  target.send(call.id, { type: "play", source: "https://example.com/media.mp3" }); // Recorded only; never fetched.
  target.send(call.id, { type: "text", token: "Hola ", last: true });
  await until(() => local.controller.view(call.id).transcript.some((entry) => entry.text === "Hola "));
  const view = local.controller.view(call.id);
  assert.equal(view.language, "en-US"); assert.equal(view.ttsLanguage, "es-ES"); assert.equal(view.transcript.at(-1).lang, "es-ES");
  assert.equal(view.lastError.code, "UNSUPPORTED_MEDIA_PLAYBACK");
  assert.ok(view.events.some((entry) => entry.type === "sendDigits"));
  const handoffData = ' {"reasonCode":"completed", "original":"zażółć"} ';
  target.send(call.id, { type: "end", handoffData });
  await until(() => local.controller.view(call.id).status === "completed"); await local.controller.drain(call.id);
  assert.equal(local.controller.view(call.id).handoffData, handoffData);
  const action = target.callbacks.find((entry) => entry.path === "/action");
  assert.equal(action.fields.SessionId, setup.sessionId); assert.equal(action.fields.SessionStatus, "ended");
  assert.equal(action.fields.CallStatus, "in-progress"); assert.equal(action.fields.HandoffData, handoffData);
  assert.equal(target.messages.some((entry) => entry.message.type === "end"), false);
});

test("unknown/malformed messages cause error, valid frames reset the counter, tenth invalid closes 1007", async (t) => {
  const target = await backend(t); const local = await service(t, target); const call = await local.create();
  await local.request(`/api/sessions/${call.id}/answer`, "POST"); await target.setup(call.id);
  for (let i = 0; i < 9; i++) target.send(call.id, { type: "unknown" });
  target.send(call.id, { type: "text", token: "" });
  for (let i = 0; i < 9; i++) target.send(call.id, '{"type":"end","handoffData":{}}');
  await until(() => target.messages.filter((entry) => entry.message.type === "error").length === 18);
  assert.equal(local.controller.view(call.id).status, "in-progress");
  target.send(call.id, "not JSON");
  await until(() => target.closes.length === 1);
  assert.equal(target.closes[0].code, 1007); assert.equal(target.closes[0].reason, "Too many consecutive malformed messages.");
  assert.equal(local.controller.view(call.id).status, "failed");
  assert.equal(local.controller.view(call.id).lastError.code, "INVALID_RELAY_MESSAGE");
  assert.equal(target.messages.filter((entry) => entry.message.type === "error").length, 19);
});

test("unexpected backend closure is failed, never auto-reconnects, and new calls use new session IDs", async (t) => {
  const target = await backend(t); const local = await service(t, target); const first = await local.create();
  await local.request(`/api/sessions/${first.id}/answer`, "POST"); const firstSetup = await target.setup(first.id);
  target.sockets.get(first.id).close(1000, "Unexpected normal transport close");
  await until(() => local.controller.view(first.id).status === "failed");
  assert.equal(local.controller.view(first.id).lastError.code, "BACKEND_WS_DISCONNECTED");
  assert.equal((await local.request(`/api/sessions/${first.id}/answer`, "POST")).status, 409);
  const second = await local.create(); await local.request(`/api/sessions/${second.id}/answer`, "POST"); const secondSetup = await target.setup(second.id);
  assert.notEqual(firstSetup.sessionId, secondSetup.sessionId); assert.equal(target.connections, 2);
});

test("HTTP 404 during Answer explains the missing backend handler and preserves a terminal failed call", async (t) => {
  const target = await backend(t); const local = await service(t, target);
  const call = await local.create({ relayWsUrl: target.wsUrl.replace("/voice", "/missing-relay") });
  const result = await local.request(`/api/sessions/${call.id}/answer`, "POST");
  assert.equal(result.status, 200); assert.equal(result.body.status, "failed");
  assert.equal(result.body.lastError.code, "BACKEND_WS_CONNECT_FAILED");
  assert.match(result.body.lastError.message, /HTTP 404/);
  assert.match(result.body.lastError.message, /relay path does not exist/);
  assert.equal(target.messages.length, 0); assert.equal(target.connections, 0);
  await until(() => local.controller.view(call.id).lastClose !== null);
  assert.match(local.controller.view(call.id).lastError.message, /HTTP 404/);
  assert.equal((await local.request(`/api/sessions/${call.id}/answer`, "POST")).status, 409);
  const valid = await local.create(); await local.request(`/api/sessions/${valid.id}/answer`, "POST");
  await target.setup(valid.id); assert.equal(local.controller.view(valid.id).connection, "connected");
});

test("two simultaneous calls have separate sockets, token buffers, languages and caller inputs", async (t) => {
  const target = await backend(t); const local = await service(t, target);
  const a = await local.create({ language: "pl-PL" }); const b = await local.create({ language: "es-ES" });
  await Promise.all([local.request(`/api/sessions/${a.id}/answer`, "POST"), local.request(`/api/sessions/${b.id}/answer`, "POST")]);
  await Promise.all([target.setup(a.id), target.setup(b.id)]);
  target.send(a.id, { type: "text", token: "A ", last: false }); target.send(b.id, { type: "text", token: "B ", last: false });
  target.send(a.id, { type: "text", token: "jeden", last: true }); target.send(b.id, { type: "text", token: "dos", last: true });
  await until(() => local.controller.view(a.id).transcript.at(-1)?.final && local.controller.view(b.id).transcript.at(-1)?.final);
  assert.equal(local.controller.view(a.id).transcript.at(-1).text, "A jeden"); assert.equal(local.controller.view(b.id).transcript.at(-1).text, "B dos");
  await local.request(`/api/sessions/${a.id}/utterances`, "POST", { text: "tylko A" });
  await until(() => target.messages.some((entry) => entry.message.type === "prompt"));
  assert.equal(target.messages.find((entry) => entry.message.type === "prompt").callSid, a.id);
  assert.equal(local.controller.view(b.id).transcript.length, 1);
});

test("invalid/unsupported/DTD TwiML and failed backend connections remain visible failures", async (t) => {
  const target = await backend(t); const local = await service(t, target);
  for (const [input, expected] of [
    [{ twiml: "<Response>" }, "INVALID_TWIML"],
    [{ twiml: "<Response><Say>Hello</Say></Response>" }, "UNSUPPORTED_TWIML"],
    [{ twiml: '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><Response>&x;</Response>' }, "INVALID_TWIML"],
    [{ relayWsUrl: "ws://127.0.0.1:1/voice" }, "BACKEND_WS_CONNECT_FAILED"],
    [{ url: target.origin + "/missing" }, "TWIML_FETCH_FAILED"],
    [{ url: target.origin + "/redirect" }, "TWIML_FETCH_FAILED"],
  ]) {
    const call = await local.create(input); const result = await local.request(`/api/sessions/${call.id}/answer`, "POST");
    assert.equal(result.body.status, "failed"); assert.equal(result.body.lastError.code, expected);
  }
});

test("SSRF allowlist, untrusted origins/hosts, XML structure limits and credential redaction", async (t) => {
  const target = await backend(t); const local = await service(t, target);
  for (const input of [{ relayWsUrl: "wss://api.twilio.com/voice" }, { url: "http://169.254.169.254/" },
    { statusCallback: "http://example.com/" }, { relayWsUrl: target.wsUrl + "?access_token=secret" },
    { url: `http://user:secret@127.0.0.1:${new URL(target.origin).port}/twiml` }]) {
    assert.equal((await local.request("/api/sessions", "POST", input)).status, 400);
  }
  assert.throws(() => loadConfig({ NODE_ENV: "production" }));
  for (const headers of [{ host: "evil.test" }, { host: "localhost", origin: "http://evil.test" }, { host: "localhost", "sec-fetch-site": "cross-site" }]) {
    assert.equal((await local.app.inject({ url: "/api/sessions", headers })).statusCode, 403);
  }
  assert.throws(() => parseTwiml(`<Response><Connect><ConversationRelay url="${target.wsUrl}"/><Say>bad</Say></Connect></Response>`, local.config, "pl-PL"));
  const call = await local.create({ customParameters: { taskId: "safe", password: "not-for-logs" } });
  await local.request(`/api/sessions/${call.id}/answer`, "POST"); await target.setup(call.id);
  const exported = await local.request(`/api/sessions/${call.id}/events`);
  assert.equal(exported.body.mockGenerated, true); assert.equal(JSON.stringify(exported.body).includes("not-for-logs"), false);
  assert.equal(target.messages[0].message.customParameters.password, "not-for-logs"); // Round-trip payload, redacted diagnostics.
  assert.equal((await local.request("/healthz")).body.ok, true);
});

test("operator lock, refresh, and browser closure do not duplicate setup or drop an active relay", async (t) => {
  const target = await backend(t); const local = await service(t, target); const call = await local.create();
  const connect = async () => {
    const ws = new WebSocket(local.origin.replace("http:", "ws:") + "/operator", { origin: local.origin });
    const events = []; ws.on("message", (raw) => events.push(JSON.parse(raw.toString()))); await once(ws, "open");
    await until(() => events.length > 0);
    return { ws, events, id: events[0].operatorId,
      send(type, requestId) { ws.send(JSON.stringify({ type, requestId, callSid: call.id })); } };
  };
  const first = await connect(); const other = await connect();
  t.after(() => { first.ws.terminate(); other.ws.terminate(); });
  first.send("claim", "1"); await until(() => local.controller.view(call.id).operatorId === first.id);
  other.send("answer", "2"); await until(() => other.events.some((event) => event.type === "error"));
  assert.equal(other.events.find((event) => event.type === "error").code, "OPERATOR_LOCKED");
  first.send("answer", "3"); await target.setup(call.id);
  assert.equal((await local.request(`/api/sessions/${call.id}/utterances`, "POST", { text: "locked" })).status, 409);
  first.ws.close(); await until(() => local.controller.view(call.id).operatorId === null);
  other.send("claim", "4"); await until(() => local.controller.view(call.id).operatorId === other.id);
  assert.equal(target.connections, 1); assert.equal(target.messages.filter((entry) => entry.message.type === "setup").length, 1);
  other.ws.close(); await until(() => local.controller.view(call.id).operatorId === null);
  assert.equal(local.controller.view(call.id).status, "in-progress");
  const foreign = new WebSocket(local.origin.replace("http:", "ws:") + "/operator", { origin: "http://evil.test" });
  await assert.rejects(once(foreign, "open"), /403/);
});
