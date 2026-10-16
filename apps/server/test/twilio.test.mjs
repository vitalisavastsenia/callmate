import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import twilio from "twilio";
import { WebSocket, WebSocketServer } from "ws";
import { XMLParser } from "fast-xml-parser";
import { approvedPlanFixture } from "@callmate/contracts/fixtures";
import { TwilioMock } from "../dist/twilio/mock.js";
import { LoopbackTwilioClient, MockTwilioAdapter } from "../dist/twilio/mock-adapter.js";
import { createServer, formType, listen, mockAccountSid, mockAuthToken, mockFrom,
  readForm, signed, stop } from "../dist/twilio/local-http.js";

const context = () => ({ attemptId: randomUUID(), plan: structuredClone(approvedPlanFixture) });
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); }
  throw new Error("Timed out waiting for a local protocol event");
}
async function setup(t, consume = () => true) {
  const mock = await new TwilioMock().start();
  const adapter = await new MockTwilioAdapter(mock.baseUrl, consume).start();
  t.after(async () => { await adapter.close(); await mock.close(); });
  const input = context();
  const call = await adapter.startCall(input);
  assert.equal(call.status, "accepted");
  const id = call.providerCallId;
  return { mock, adapter, input, id,
    async connect() {
      await mock.progress(id, "initiated"); await mock.progress(id, "ringing"); await mock.progress(id, "in-progress");
      await mock.connectRelay(id);
      await until(() => adapter.observations.some((event) => event.type === "relay.message" && event.message.type === "setup"));
    } };
}
function permit(input, overrides = {}) {
  return { id: randomUUID(), attemptId: input.attemptId, planId: input.plan.id, planVersion: input.plan.version,
    turnId: randomUUID(), turnVersion: 1, outputId: randomUUID(), offer: null,
    approvedSpanishText: "Hola, quisiera pedir una cita.", expiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides };
}
async function post(url, fields, signature = signed(url, fields)) {
  return fetch(url, { method: "POST", headers: { "content-type": formType, "X-Twilio-Signature": signature },
    body: new URLSearchParams(fields), signal: AbortSignal.timeout(3000) });
}

test("SDK Calls create uses Basic auth, repeated form subscriptions, and Twilio resource deserialization", async (t) => {
  const { mock, adapter, input, id } = await setup(t);
  assert.match(id, /^CA[0-9a-f]{32}$/);
  const request = mock.requests[0];
  assert.equal(request.method, "POST");
  assert.equal(request.path, `/2010-04-01/Accounts/${mockAccountSid}/Calls.json`);
  assert.deepEqual(request.fields.StatusCallbackEvent, ["initiated", "ringing", "answered", "completed"]);
  assert.equal(request.fields.To, input.plan.request.business.phone);
  assert.equal(request.fields.From, mockFrom);
  assert.equal(request.fields.Record, "false");
  assert.equal(request.fields.TimeLimit, String(input.plan.request.callLimits.maxDurationSeconds));
  const resource = await adapter.client.calls(id).fetch();
  assert.equal(resource.sid, id); assert.equal(resource.accountSid, mockAccountSid);
  assert.equal(resource.status, "queued"); assert.ok(resource.dateCreated instanceof Date);
  assert.equal(resource.startTime, null); assert.equal(resource.price, null);
  assert.deepEqual(await adapter.queryCall(id), { status: "found", providerCallId: id, callState: "dialing" });
  assert.equal((await adapter.startCall(input)).providerCallId, id);
  assert.equal(mock.calls.size, 1);
});

test("REST errors use documented error envelopes and are understood by the real SDK", async (t) => {
  const { mock, adapter } = await setup(t);
  const url = `${mock.baseUrl}/2010-04-01/Accounts/${mockAccountSid}/Calls.json`;
  const unauthenticated = await fetch(url, { method: "POST" });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { code: 20003, message: "Authenticate",
    more_info: "https://www.twilio.com/docs/errors/20003", status: 401 });
  const authorization = `Basic ${Buffer.from(`${mockAccountSid}:${mockAuthToken}`).toString("base64")}`;
  const missingTo = await fetch(url, { method: "POST", headers: { authorization, "content-type": formType }, body: "" });
  assert.equal(missingTo.status, 400); assert.equal((await missingTo.json()).code, 21201);
  await assert.rejects(adapter.client.calls.create({ to: "bad-number", from: mockFrom }), { code: 21211, status: 400 });
  await assert.rejects(adapter.client.calls(`CA${"f".repeat(32)}`).fetch(), { code: 20404, status: 404 });
  assert.equal((await adapter.queryCall(`CA${"f".repeat(32)}`)).status, "unknown");
});

test("signed callbacks validate the exact URL and all fields, then reject uncorrelated calls", async (t) => {
  const { mock, adapter, input, id } = await setup(t);
  const url = adapter.callbackUrl("status", input.attemptId);
  const fields = mock.callbackFields(id, "ringing", 0);
  assert.equal((await post(url, fields, "bad-signature")).status, 403);
  assert.equal((await post(url, { ...fields, FutureTwilioField: "added" }, signed(url, fields))).status, 403);
  const evolved = { ...fields, FutureTwilioField: "added" };
  assert.equal((await post(url, evolved)).status, 204);
  assert.equal((await post(url + "&extra=1", fields, signed(url, fields))).status, 403);
  for (const mismatch of [{ AccountSid: `AC${"1".repeat(32)}` }, { CallSid: `CA${"1".repeat(32)}` },
    { To: "+12025550199" }, { From: "+12025550199" }]) {
    assert.equal((await post(url, { ...fields, ...mismatch })).status, 403);
  }
  assert.equal((await post(adapter.callbackUrl("status", randomUUID()), fields)).status, 403);
  assert.equal(adapter.observations.length, 1);
});

test("duplicate/out-of-order callbacks do not regress state or reopen a terminal call", async (t) => {
  const { mock, adapter, id } = await setup(t);
  await mock.deliverStatus(id, "ringing", 1);
  await mock.deliverStatus(id, "ringing", 1);
  await mock.deliverStatus(id, "initiated", 0);
  await mock.deliverStatus(id, "in-progress", 2);
  await mock.deliverStatus(id, "completed", 3);
  await mock.deliverStatus(id, "ringing", 4);
  assert.deepEqual(adapter.observations.map((event) => event.callState), ["ringing", "connected", "ended"]);
});

test("voice callback returns real SDK TwiML, with signed WS setup and final-only business utterances", async (t) => {
  const { mock, adapter, input, id, connect } = await setup(t);
  await connect();
  const setupEvent = adapter.observations.find((event) => event.type === "relay.message");
  assert.equal(setupEvent.message.type, "setup");
  assert.equal(setupEvent.message.callSid, id);
  assert.equal(setupEvent.message.accountSid, mockAccountSid);
  assert.equal(setupEvent.message.customParameters.attemptId, input.attemptId);
  assert.match(setupEvent.message.sessionId, /^VX[0-9a-f]{32}$/);
  const voice = await post(adapter.callbackUrl("voice", input.attemptId), {
    AccountSid: mockAccountSid, CallSid: id, From: mockFrom, To: input.plan.request.business.phone, CallStatus: "in-progress" });
  const xml = new XMLParser({ ignoreAttributes: false }).parse(await voice.text());
  assert.equal(xml.Response.Connect.ConversationRelay["@_language"], "es-ES");
  assert.equal(xml.Response.Connect["@_action"], adapter.callbackUrl("action", input.attemptId));
  mock.send(id, { type: "prompt", voicePrompt: "El martes", lang: "es-ES", last: false });
  mock.send(id, { type: "prompt", voicePrompt: "El martes a las seis.", lang: "es-ES", last: true });
  mock.send(id, { type: "dtmf", digit: "1" });
  mock.send(id, { type: "interrupt", utteranceUntilInterrupt: "Hola,", durationUntilInterruptMs: 120 });
  mock.send(id, { type: "error", description: "Synthetic provider error" });
  await until(() => adapter.observations.filter((event) => event.type === "relay.message").length === 6);
  assert.deepEqual(adapter.observations.filter((event) => event.type === "business.utterance"), [
    { type: "business.utterance", attemptId: input.attemptId, text: "El martes a las seis.", language: "es-ES" }]);
});

test("approved text crosses the actual WS once; end handoffData stays a string and action returns Hangup", async (t) => {
  const { mock, adapter, input, id, connect } = await setup(t);
  await connect();
  const authorized = permit(input);
  await adapter.sendAuthorizedText(authorized);
  await until(() => mock.calls.get(id).received.length === 1);
  assert.deepEqual(mock.calls.get(id).received[0], { type: "text", token: authorized.approvedSpanishText,
    last: true, lang: "es-ES", interruptible: true, preemptible: true });
  await assert.rejects(adapter.sendAuthorizedText(authorized), /not current/);
  assert.equal(adapter.observations.some((event) => event.type === "assistant.output" || event.type === "playback.completed"), false);
  const handoffData = JSON.stringify({ reason: "local-demo-finished" });
  await adapter.endSession(input.attemptId, handoffData);
  await until(() => mock.calls.get(id).status === "completed");
  assert.deepEqual(mock.calls.get(id).received[1], { type: "end", handoffData });
  assert.deepEqual(adapter.observations.find((event) => event.type === "relay.ended"),
    { type: "relay.ended", attemptId: input.attemptId, sessionStatus: "ended", handoffData });
  assert.equal((await adapter.queryCall(id)).callState, "ended");
  assert.deepEqual(mock.failures, []);
});

test("expired, mismatched, unapproved permits and output after Stop are rejected", async (t) => {
  let allow = false;
  const { mock, adapter, input, id, connect } = await setup(t, () => allow);
  await assert.rejects(adapter.sendAuthorizedText(permit(input)), /not current/);
  await connect();
  await assert.rejects(adapter.sendAuthorizedText(permit(input)), /not current/);
  allow = true;
  for (const override of [{ expiresAt: "2020-01-01T00:00:00Z" }, { planId: randomUUID() }, { planVersion: 2 }, { attemptId: randomUUID() }]) {
    await assert.rejects(adapter.sendAuthorizedText(permit(input, override)), /not current/);
  }
  assert.equal((await adapter.requestHangup(id)).status, "acknowledged");
  await assert.rejects(adapter.sendAuthorizedText(permit(input)), /not current/);
  assert.equal(mock.calls.get(id).received.length, 0);
  assert.equal((await adapter.queryCall(id)).callState, "ended");
});

for (const status of ["busy", "no-answer", "failed"]) {
  test(`terminal ${status} uses the completed subscription and maps to the private contract`, async (t) => {
    const { mock, adapter, id } = await setup(t);
    await mock.progress(id, "initiated"); await mock.progress(id, status);
    assert.equal(adapter.observations.at(-1).callState, status.replace("-", "_"));
    assert.equal((await adapter.queryCall(id)).callState, status.replace("-", "_"));
  });
}
test("Stop cancels queued/ringing calls; queued cancellation sends no callback", async (t) => {
  const { mock, adapter, id } = await setup(t);
  assert.equal((await adapter.requestHangup(id)).status, "acknowledged");
  assert.equal(mock.calls.get(id).status, "canceled");
  assert.deepEqual(adapter.observations, []);
  assert.equal(mock.requests.at(-1).fields.Status, "canceled");
  const next = await adapter.startCall(context());
  await mock.progress(next.providerCallId, "ringing");
  await adapter.requestHangup(next.providerCallId);
  assert.equal(adapter.observations.at(-1).callState, "ended");
});

test("WS upgrade rejects unsigned connections; setup rejects signed but mismatched sessions", async (t) => {
  const { mock, adapter, input, id } = await setup(t);
  await mock.progress(id, "in-progress");
  const url = adapter.relayUrl(input.attemptId);
  const unsigned = new WebSocket(url);
  await assert.rejects(once(unsigned, "open"), /403/);
  const peer = new WebSocket(url, { headers: { "X-Twilio-Signature": signed(url, {}) } });
  await once(peer, "open");
  const closed = once(peer, "close");
  peer.send(JSON.stringify({ type: "setup", sessionId: `VX${"1".repeat(32)}`, accountSid: mockAccountSid,
    callSid: `CA${"1".repeat(32)}`, from: mockFrom, to: input.plan.request.business.phone,
    customParameters: { attemptId: input.attemptId } }));
  assert.equal((await closed)[0], 1008);
  assert.equal(adapter.observations.some((event) => event.type === "relay.message"), false);
});

test("socket loss blocks output and never synthesizes playback or automatic redial", async (t) => {
  const { mock, adapter, input, id, connect } = await setup(t);
  await connect();
  mock.calls.get(id).ws.terminate();
  await until(() => adapter.observations.some((event) => event.type === "relay.closed"));
  await assert.rejects(adapter.sendAuthorizedText(permit(input)), /not current/);
  assert.equal(mock.calls.size, 1);
  assert.equal((await adapter.queryCall(id)).callState, "connected"); // Transport loss does not prove PSTN hangup.
});

test("mock validates outgoing frames, preserves token whitespace, and closes after ten consecutive malformed frames", async (t) => {
  const mock = await new TwilioMock().start();
  const peers = new WebSocketServer({ noServer: true });
  let socket;
  let origin;
  const received = [];
  const server = createServer((req, res) => { void (async () => {
    await readForm(req);
    if (req.url === "/voice") {
      const response = new twilio.twiml.VoiceResponse();
      response.connect({ action: `${origin}/action` }).conversationRelay({ url: origin.replace("http:", "ws:") + "/relay", language: "es-ES" });
      res.writeHead(200, { "content-type": "text/xml" }).end(response.toString());
    } else res.writeHead(204).end();
  })().catch(() => res.writeHead(400).end()); });
  server.on("upgrade", (req, conn, head) => peers.handleUpgrade(req, conn, head, (ws) => {
    socket = ws; ws.on("message", (data) => received.push(JSON.parse(data.toString())));
  }));
  origin = await listen(server);
  t.after(async () => { for (const ws of peers.clients) ws.terminate(); await mock.close(); await stop(server); });
  const client = twilio(mockAccountSid, mockAuthToken, { httpClient: new LoopbackTwilioClient(mock.baseUrl) });
  const call = await client.calls.create({ to: "+12025550123", from: mockFrom, url: origin + "/voice", method: "POST",
    statusCallback: origin + "/status", statusCallbackMethod: "POST", record: false });
  await mock.progress(call.sid, "in-progress"); await mock.connectRelay(call.sid);
  await until(() => received.some((message) => message.type === "setup"));
  socket.send('{"type":"end","handoffData":{"wrong":"object"}}');
  await until(() => received.some((message) => message.type === "error"));
  assert.equal(mock.calls.get(call.sid).ws.readyState, WebSocket.OPEN);
  socket.send(JSON.stringify({ type: "text", token: " leading and trailing ", last: false }));
  await until(() => mock.calls.get(call.sid).received.length === 1);
  assert.equal(mock.calls.get(call.sid).received[0].token, " leading and trailing ");
  const closed = once(socket, "close");
  for (let i = 0; i < 10; i++) socket.send("malformed");
  const [code, reason] = await closed;
  assert.equal(code, 1007); assert.equal(reason.toString(), "Too many consecutive malformed messages.");
  assert.equal(received.filter((message) => message.type === "error").length, 11);
});

test("local SDK transport refuses remote origins and unsupported provider endpoints", async () => {
  for (const url of ["https://api.twilio.com", "http://localhost:1234", "http://127.0.0.1.evil.test", "http://user@127.0.0.1", "http://127.0.0.1/path"]) {
    assert.throws(() => new LoopbackTwilioClient(url));
  }
  const client = new LoopbackTwilioClient("http://127.0.0.1:1");
  assert.throws(() => client.request({ method: "GET", uri: "https://api.twilio.com/Accounts.json" }));
  assert.throws(() => client.request({ method: "GET", uri: "https://example.com/" }));
});
