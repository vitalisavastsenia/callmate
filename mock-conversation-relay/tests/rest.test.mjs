import assert from "node:assert/strict";
import test from "node:test";
import { backend, service, until } from "./helpers.mjs";
import { isDevelopmentMockTraffic, MockTelephonyProvider } from "../dist/client/mock-telephony-provider.js";

test("Twilio Calls inline create -> pending UI/API -> answer -> fetch -> completion", async (t) => {
  const target = await backend(t); const local = await service(t, target);
  const created = await local.form(local.root + ".json", { To: "+48111222333", From: "+48000111222", Twiml: target.xml });
  assert.equal(created.status, 201); const id = created.body.sid;
  assert.match(id, /^CA[0-9a-f]{32}$/); assert.equal(created.body.status, "ringing");
  assert.equal(created.body.direction, "outbound-api"); assert.ok(Number.isFinite(Date.parse(created.body.date_created)));
  assert.equal((await local.request("/api/sessions")).body.sessions[0].id, id);
  const answered = await local.request(`/api/sessions/${id}/answer`, "POST");
  assert.equal(answered.body.status, "in-progress"); assert.equal(answered.body.connection, "connected");
  const setup = await target.setup(id);
  assert.deepEqual(setup.customParameters, { taskId: "task-demo-001", customerName: "Alex & Ola" });
  for (const key of ["sessionId", "accountSid", "parentCallSid", "callSid", "from", "to", "forwardedFrom", "callType", "callerName", "direction", "callStatus", "customParameters"]) assert.ok(Object.hasOwn(setup, key));
  assert.match(setup.sessionId, /^VX[0-9a-f]{32}$/);
  assert.equal(target.messages[0].message.type, "setup");
  assert.equal((await local.request(local.root + `/${id}.json`, "GET", undefined, { authorization: local.auth })).body.status, "in-progress");
  const ended = await local.form(local.root + `/${id}.json`, { Status: "completed" });
  assert.equal(ended.body.status, "completed"); assert.equal(typeof ended.body.duration, "string");
  assert.ok(ended.body.start_time); assert.ok(ended.body.end_time);
  assert.equal((await local.form(local.root + `/${id}.json`, { Status: "completed" })).body.status, "completed");
  await until(() => target.closes.length === 1);
  assert.equal(target.messages.filter((item) => item.message.type === "setup").length, 1);
  assert.equal(target.messages.some((item) => item.message.type === "end"), false);
});

test("Url overrides inline Twiml; fetch method and call fields are correct; greeting is separate from AI output", async (t) => {
  const target = await backend(t); const local = await service(t, target);
  const result = await local.form(local.root + ".json", { To: "fictional-to", From: "fictional-from", Url: target.origin + "/twiml", Method: "GET", Twiml: "bad inline" });
  const id = result.body.sid; const answer = await local.request(`/api/sessions/${id}/answer`, "POST");
  assert.equal(answer.body.status, "in-progress"); await target.setup(id);
  assert.equal(target.twimlRequests[0].method, "GET");
  assert.equal(target.twimlRequests[0].fields.CallSid, id);
  assert.equal(target.twimlRequests[0].headers["x-callmate-mock"], "true");
  assert.equal(answer.body.transcript[0].speaker, "platform"); assert.equal(answer.body.transcript[0].text, "Dzień dobry.");
  assert.equal(target.messages.length, 1);
});

test("direct fallback and explicit override round-trip custom parameters, with deterministic test-only IDs", async (t) => {
  const target = await backend(t); let sequence = 0;
  const local = await service(t, target, {}, { makeId: (prefix) => prefix + String(++sequence).padStart(32, "0") });
  for (const explicit of [false, true]) {
    const call = await local.create({ customParameters: { taskId: "task exact 🧪", customerName: "Łukasz" }, ...(explicit ? { relayWsUrl: target.wsUrl + "?test=1" } : {}) });
    assert.match(call.operatorUrl, new RegExp(`\\?callId=${call.id}$`));
    await local.request(`/api/sessions/${call.id}/answer`, "POST");
    const setup = await target.setup(call.id); assert.deepEqual(setup.customParameters, { taskId: "task exact 🧪", customerName: "Łukasz" });
    assert.equal(local.controller.view(call.id).relayWsUrl, target.wsUrl + (explicit ? "?test=1" : ""));
  }
  assert.equal(target.connections, 2);
});

test("reject, invalid transitions, missing records, active deletion, and immutable terminal states", async (t) => {
  const target = await backend(t); const local = await service(t, target); const call = await local.create();
  assert.equal((await local.request(`/api/sessions/${call.id}`, "DELETE")).status, 409);
  assert.equal((await local.request(`/api/sessions/${call.id}/utterances`, "POST", { text: "not connected" })).status, 409);
  assert.equal((await local.request(`/api/sessions/${call.id}/reject`, "POST")).body.status, "busy");
  assert.equal(target.connections, 0);
  assert.equal((await local.request(`/api/sessions/${call.id}/answer`, "POST")).status, 409);
  assert.equal((await local.request(`/api/sessions/${call.id}/hangup`, "POST")).body.status, "busy");
  assert.equal((await local.request(`/api/sessions/${call.id}`, "DELETE")).status, 204);
  assert.equal((await local.request(`/api/sessions/${call.id}`)).status, 404);
});

test("Basic auth, account validation, bounded input, and consistent façade errors", async (t) => {
  const target = await backend(t); const local = await service(t, target);
  assert.equal((await local.form(local.root + ".json", {}, "bad")).body.code, 20003);
  assert.equal((await local.form(local.root.replace(local.config.MOCK_ACCOUNT_SID, "ACbad") + ".json", { To: "to", From: "from", Twiml: target.xml })).status, 404);
  assert.equal((await local.form(local.root + ".json", { From: "from", Twiml: target.xml })).status, 400);
  assert.equal((await local.form(local.root + ".json", { To: "to", From: "from" })).status, 400);
  assert.equal((await local.form(local.root + ".json", { To: "to", From: "from", Twiml: "x".repeat(4001) })).status, 400);
  assert.equal((await local.request("/api/sessions", "POST", { unknown: true })).status, 400);
  assert.equal((await local.request("/api/sessions", "POST", { twiml: "x".repeat(40_000) })).status, 400);
  assert.equal((await local.request(local.root + `/CA${"f".repeat(32)}.json`, "GET", undefined, { authorization: local.auth })).body.code, 20404);
});

test("subscribed callbacks are ordered, signed mock traffic, and delivery failures are observable", async (t) => {
  const target = await backend(t); const local = await service(t, target);
  const fields = new URLSearchParams({ To: "to", From: "from", Twiml: target.xml, StatusCallback: target.origin + "/status" });
  for (const event of ["initiated", "ringing", "answered", "completed"]) fields.append("StatusCallbackEvent", event);
  const call = await local.form(local.root + ".json", fields); const id = call.body.sid;
  await local.request(`/api/sessions/${id}/answer`, "POST"); await target.setup(id);
  await local.request(`/api/sessions/${id}/hangup`, "POST"); await local.controller.drain(id);
  const events = target.callbacks.filter((entry) => entry.path === "/status");
  assert.deepEqual(events.map((entry) => entry.fields.CallStatus), ["initiated", "ringing", "in-progress", "completed"]);
  assert.deepEqual(events.map((entry) => entry.fields.SequenceNumber), ["0", "1", "2", "3"]);
  for (const event of events) { assert.equal(event.headers["x-callmate-mock"], "true"); assert.equal(event.signatureValid, true); }
  assert.equal(local.controller.view(id).callbacks.length, 4);
  const failed = await local.create({ statusCallback: target.origin + "/broken-status", statusCallbackEvents: ["ringing"] });
  await local.controller.drain(failed.id);
  assert.equal(local.controller.view(failed.id).callbacks[0].status, 503);
  assert.equal(local.controller.view(failed.id).lastError.code, "CALLBACK_DELIVERY_FAILED");
});

test("mock provider adapter uses only configured HTTP origin, repeated event fields, and explicit development mode", async (t) => {
  const target = await backend(t); const local = await service(t, target);
  const options = { environment: "test", provider: "mock", baseUrl: local.origin, accountSid: local.config.MOCK_ACCOUNT_SID,
    username: "mock", password: "mock-local-only" };
  assert.throws(() => new MockTelephonyProvider({ ...options, environment: "production" }));
  assert.throws(() => new MockTelephonyProvider({ ...options, baseUrl: "https://api.twilio.com" }));
  assert.equal(isDevelopmentMockTraffic({ environment: "production", provider: "mock", mockHeader: "true" }), false);
  assert.equal(isDevelopmentMockTraffic({ environment: "development", provider: "twilio", mockHeader: "true" }), false);
  assert.equal(isDevelopmentMockTraffic({ environment: "development", provider: "mock", mockHeader: undefined }), false);
  assert.equal(isDevelopmentMockTraffic({ environment: "development", provider: "mock", mockHeader: "true" }), true);
  const provider = new MockTelephonyProvider(options);
  const call = await provider.createCall({ from: "fictional from", to: "fictional to", twiml: target.xml, statusCallback: target.origin + "/status" });
  assert.equal((await provider.getCall(call.sid)).status, "ringing");
  assert.equal((await provider.hangup(call.sid)).status, "completed");
  await local.controller.drain(call.sid);
  assert.deepEqual(target.callbacks.filter((entry) => entry.path === "/status").map((entry) => entry.fields.CallStatus), ["initiated", "ringing", "completed"]);
});

test("auto-answer opens exactly one relay and backend end without handoff still reports SessionStatus ended", async (t) => {
  const target = await backend(t); const local = await service(t, target, { AUTO_ANSWER: "true" });
  const call = await local.create({ twiml: target.xml }); await target.setup(call.id);
  assert.equal((await local.request(`/api/sessions/${call.id}/answer`, "POST")).status, 409);
  target.send(call.id, { type: "end" }); await until(() => local.controller.view(call.id).status === "completed");
  await local.controller.drain(call.id);
  assert.equal(target.callbacks.find((entry) => entry.path === "/action").fields.SessionStatus, "ended");
  assert.equal(target.connections, 1);
  const manual = await local.create({ autoAnswer: false }); assert.equal(manual.status, "ringing");
});

test("ringing/max duration, active cap, retention cleanup, bounded logs and graceful shutdown", async (t) => {
  const target = await backend(t); let now = Date.now();
  const local = await service(t, target, { MAX_ACTIVE_CALLS: "1", CALL_TIMEOUT_SECONDS: "10", SESSION_RETENTION_MINUTES: "1" }, { now: () => now });
  const pending = await local.create({ timeout: 2 });
  assert.equal((await local.request("/api/sessions", "POST", {})).status, 409);
  now += 2001; local.controller.sweep(); assert.equal(local.controller.view(pending.id).status, "no-answer");
  const call = await local.create(); await local.request(`/api/sessions/${call.id}/answer`, "POST"); await target.setup(call.id);
  for (let i = 0; i < 205; i++) local.controller.digits(call.id, { digit: "1" });
  assert.equal(local.controller.view(call.id).events.length, 200); assert.ok(local.controller.view(call.id).droppedEvents > 0);
  now += 10_001; local.controller.sweep(); assert.equal(local.controller.view(call.id).lastError.code, "CALL_TIMEOUT");
  now += 60_001; local.controller.sweep(); assert.equal(local.controller.list().length, 0);
  const active = await local.create(); await local.request(`/api/sessions/${active.id}/answer`, "POST"); await target.setup(active.id);
  await local.controller.shutdown(); assert.equal(local.controller.view(active.id).status, "failed");
  assert.equal(local.controller.view(active.id).lastError.code, "SERVICE_SHUTDOWN");
  assert.equal((await local.request("/api/sessions", "POST", {})).status, 503);
});
