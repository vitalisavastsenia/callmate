import assert from "node:assert/strict";
import test from "node:test";
import twilio from "twilio";
import RequestClient from "twilio/lib/base/RequestClient.js";
import { backend, service, until } from "./helpers.mjs";
import { parseContinuation } from "../dist/server/twiml.js";

// Use the production SDK's serializers/deserializers, changing only the HTTP transport.
class LocalSdkTransport extends RequestClient {
  constructor(origin) {
    super({ autoRetry: false, timeout: 3000 }); this.origin = origin; this.axios.defaults.proxy = false;
  }
  request(options) {
    const url = new URL(options.uri);
    assert.equal(url.origin, "https://api.twilio.com");
    assert.match(url.pathname, /^\/2010-04-01\/Accounts\/AC[0-9a-f]{32}\/Calls(?:\/CA[0-9a-f]{32})?\.json$/);
    return super.request({ ...options, uri: this.origin + url.pathname, allowRedirects: false });
  }
}
const sdk = (local) => twilio(local.config.MOCK_ACCOUNT_SID, local.config.MOCK_AUTH_TOKEN,
  { httpClient: new LocalSdkTransport(local.origin), autoRetry: false });

test("official SDK creates/reads/completes calls; GET/POST webhooks and relay handshakes pass SDK signature validation", async (t) => {
  const token = "sdk-test-synthetic-auth-token";
  const target = await backend(t, { authToken: token }); const local = await service(t, target, { MOCK_AUTH_TOKEN: token }); const client = sdk(local);
  for (const method of ["GET", "POST"]) {
    const response = new twilio.twiml.VoiceResponse();
    const relay = response.connect({ action: target.origin + "/action?tenant=es%2Fru", method })
      .conversationRelay({ url: target.wsUrl + "?tenant=es%2Fru", language: "es-ES" });
    relay.parameter({ name: "customerName", value: "Łukasz & Ирина" });
    target.xml = response.toString();
    const call = await client.calls.create({ to: "+48111222333", from: "+48000111222", url: target.origin + "/twiml?tenant=es%2Fru",
      method, statusCallback: target.origin + "/status?tenant=es%2Fru", statusCallbackMethod: method,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"] });
    assert.equal(call.status, "ringing"); assert.ok(call.dateCreated instanceof Date);
    await local.request(`/api/sessions/${call.sid}/answer`, "POST");
    const setup = await target.setup(call.sid);
    assert.equal(setup.customParameters.customerName, "Łukasz & Ирина");
    assert.equal((await client.calls(call.sid).fetch()).status, "in-progress");
    target.send(call.sid, { type: "end", handoffData: '{"reason":"Человек & ayuda"}' });
    await until(() => local.controller.view(call.sid).status === "completed"); await local.controller.drain(call.sid);
    const action = target.callbacks.find((entry) => entry.path === "/action" && entry.fields.CallSid === call.sid);
    assert.equal(action.fields.SessionStatus, "ended"); assert.equal(action.fields.CallStatus, "in-progress");
    assert.equal(action.fields.HandoffData, '{"reason":"Человек & ayuda"}'); assert.equal(action.signatureValid, true);
    const completed = await client.calls(call.sid).fetch();
    assert.equal(completed.status, "completed"); assert.ok(completed.endTime instanceof Date);
  }
  assert.ok(target.handshakes.every((request) => request.signatureValid));
  assert.ok(target.twimlRequests.every((request) => request.signatureValid));
  assert.ok(target.callbacks.every((request) => request.signatureValid));
  const post = target.callbacks.find((request) => request.method === "POST");
  assert.equal(twilio.validateRequest(local.config.MOCK_AUTH_TOKEN, post.headers["x-twilio-signature"],
    target.origin + post.path + "?tenant=es%2Fru", { ...post.fields, CallSid: "tampered" }), false);
  assert.equal(JSON.stringify((await local.request("/api/config")).body).includes(local.config.MOCK_AUTH_TOKEN), false);
  await assert.rejects(client.calls("CA" + "f".repeat(32)).fetch(), (error) => error.status === 404 && error.code === 20404);
});

test("a backend using a different signing token rejects both TwiML fetches and WebSocket upgrades", async (t) => {
  const target = await backend(t, { authToken: "different-synthetic-token" }); const local = await service(t, target);
  const fetched = await local.create({ url: target.origin + "/twiml" });
  assert.equal((await local.request(`/api/sessions/${fetched.id}/answer`, "POST")).body.lastError.code, "TWIML_FETCH_FAILED");
  const relay = await local.create();
  const failed = (await local.request(`/api/sessions/${relay.id}/answer`, "POST")).body;
  assert.equal(failed.status, "failed"); assert.equal(failed.lastError.code, "BACKEND_WS_CONNECT_FAILED");
  assert.equal(target.connections, 0); assert.equal(target.handshakes[0].signatureValid, false);
});

test("SDK cancellation while queued emits no callbacks; ringing cancellation emits the terminal completed subscription", async (t) => {
  const target = await backend(t); let now = Date.now();
  const local = await service(t, target, { MOCK_DIAL_DELAY_MS: "1000" }, { now: () => now }); const client = sdk(local);
  const input = { to: "to", from: "from", twiml: target.xml, statusCallback: target.origin + "/status",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"] };
  const queued = await client.calls.create(input); assert.equal(queued.status, "queued");
  assert.equal((await client.calls(queued.sid).fetch()).status, "queued");
  assert.equal((await client.calls(queued.sid).update({ status: "canceled" })).status, "canceled");
  const canceled = await client.calls(queued.sid).fetch(); assert.equal(canceled.duration, null); assert.equal(canceled.endTime, null);
  now += 1001; local.controller.sweep(); await local.controller.drain(queued.sid);
  assert.equal(target.callbacks.length, 0); assert.equal(target.connections, 0);
  const ringing = await client.calls.create(input); now += 1001; local.controller.sweep();
  assert.equal((await client.calls(ringing.sid).fetch()).status, "ringing");
  assert.equal((await client.calls(ringing.sid).update({ status: "canceled" })).status, "canceled");
  await local.controller.drain(ringing.sid);
  const events = target.callbacks.filter((request) => request.fields.CallSid === ringing.sid);
  assert.deepEqual(events.map((request) => request.fields.CallStatus), ["initiated", "ringing", "canceled"]);
  assert.deepEqual(events.map((request) => request.fields.SequenceNumber), ["0", "1", "2"]);
  const active = await client.calls.create(input); now += 1001; local.controller.sweep();
  await local.request(`/api/sessions/${active.sid}/answer`, "POST"); await target.setup(active.sid);
  await assert.rejects(client.calls(active.sid).update({ status: "canceled" }), (error) => error.status === 400);
  assert.equal((await client.calls(active.sid).update({ status: "completed" })).status, "completed");
});

test("relay end returns control to Connect action; Pause keeps the call active until TwiML completes", async (t) => {
  const target = await backend(t); let now = Date.now();
  target.actionXml = '<Response><Pause length="2"/><Hangup/></Response>';
  const local = await service(t, target, {}, { now: () => now });
  const call = await local.create({ twiml: target.xml, statusCallback: target.origin + "/status" });
  await local.request(`/api/sessions/${call.id}/answer`, "POST"); await target.setup(call.id);
  target.send(call.id, { type: "end", handoffData: "exact 🧪 handoff" });
  await until(() => local.controller.view(call.id).events.some((event) => event.type === "twiml.pause"));
  await local.controller.drain(call.id);
  const view = local.controller.view(call.id);
  assert.equal(view.status, "in-progress"); assert.equal(view.connection, "disconnected"); assert.equal(view.endedAt, null);
  assert.equal(target.callbacks.filter((request) => request.path === "/status").length, 0);
  assert.equal(target.callbacks.find((request) => request.path === "/action").fields.HandoffData, "exact 🧪 handoff");
  assert.equal((await local.request(`/api/sessions/${call.id}/utterances`, "POST", { text: "late" })).status, 409);
  now += 1999; local.controller.sweep(); assert.equal(local.controller.view(call.id).status, "in-progress");
  now += 1; local.controller.sweep(); await local.controller.drain(call.id);
  assert.equal(local.controller.view(call.id).status, "completed");
  assert.equal(target.callbacks.filter((request) => request.path === "/action").length, 1);
  assert.equal(target.callbacks.find((request) => request.path === "/status").fields.CallStatus, "completed");
});

test("unsupported continuation fails visibly; hangup during a pending Connect action cannot be undone by its late response", async (t) => {
  const target = await backend(t); target.actionXml = '<Response><Dial>+123</Dial></Response>';
  const local = await service(t, target); const call = await local.create({ twiml: target.xml });
  await local.request(`/api/sessions/${call.id}/answer`, "POST"); await target.setup(call.id);
  target.send(call.id, { type: "end" }); await until(() => local.controller.view(call.id).status === "failed");
  assert.equal(local.controller.view(call.id).lastError.code, "UNSUPPORTED_TWIML");
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const delayed = await backend(t, { onAction: () => gate }); const other = await service(t, delayed);
  const pending = await other.create({ twiml: delayed.xml });
  await other.request(`/api/sessions/${pending.id}/answer`, "POST"); await delayed.setup(pending.id);
  delayed.send(pending.id, { type: "end" }); await until(() => delayed.callbacks.some((request) => request.path === "/action"));
  await other.request(`/api/sessions/${pending.id}/hangup`, "POST");
  release('<Response><Pause length="60"/></Response>'); await other.controller.drain(pending.id);
  assert.equal(other.controller.view(pending.id).status, "completed");
  assert.equal(other.controller.view(pending.id).events.some((event) => event.type === "twiml.pause"), false);
  assert.equal(delayed.callbacks.filter((request) => request.path === "/action").length, 1);
});

test("continuations validate XML and bounded Pause values instead of silently accepting unsupported instructions", () => {
  assert.deepEqual(parseContinuation('<Response><Pause/><Pause length="2"/><Hangup/></Response>'), { pauseSeconds: 3 });
  assert.deepEqual(parseContinuation('<Response/>'), { pauseSeconds: 0 });
  for (const xml of ['<Response>', '<!DOCTYPE Response><Response/>', '<Response><Pause length="0"/></Response>',
    '<Response><Pause length="61"/></Response>', '<Response><Pause length="1.5"/></Response>', '<Response><Say>unsupported</Say></Response>']) {
    assert.throws(() => parseContinuation(xml));
  }
});
