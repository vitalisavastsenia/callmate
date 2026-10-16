import { authHeaders } from './fixtures/auth.mjs';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { api, CallSnapshotSchema, DomainEventSchema, SimulatorScenarioSchema } from "@callmate/contracts";
import { reviewPlanFixture } from "@callmate/contracts/fixtures";
import { loadConfig } from "../dist/config.js";
import { createRuntime } from "../dist/server.js";
import { openStore } from "../dist/storage.js";
import { FakeTelephony } from "../dist/simulator-adapters.js";

const local = { host: "localhost:3000" };
const terminal = (call) => ["ended", "busy", "no_answer", "failed"].includes(call.callState);
function setup(t, scenario = "within_plan", extra = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "callmate-simulator-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const clock = { ms: Date.parse("2026-10-15T10:00:00Z") };
  const config = loadConfig({ CALLMATE_DATA_DIR: dataDir, CALLMATE_LOG_LEVEL: "silent",
    CALLMATE_SIMULATOR_SCENARIO: scenario, CALLMATE_SIMULATOR_STEP_MS: "50",
    CALLMATE_SIMULATOR_APPROVAL_SECONDS: "1", ...extra.env });
  const local = { host: "localhost:3000", ...authHeaders(dataDir) };
  const options = { automatic: false, now: () => clock.ms, ...extra.options };
  let runtime = createRuntime(config, undefined, options, undefined, { now: () => clock.ms });
  t.after(() => runtime.close());
  const http = async (method, url, payload, key) => {
    const response = await runtime.privateApi.inject({ method, url,
      headers: { ...local, ...(key ? { "idempotency-key": key } : {}) }, ...(payload === undefined ? {} : { payload }) });
    return { status: response.statusCode, data: response.json() };
  };
  return {
    dataDir, clock, config, http,
    get runtime() { return runtime; },
    async restart() { await runtime.close(); runtime = createRuntime(config, undefined, options, undefined, { now: () => clock.ms }); },
    async begin(request = structuredClone(reviewPlanFixture.request), key = randomUUID()) {
      const plan = await http("POST", "/api/v1/plans", request);
      assert.equal(plan.status, 201, JSON.stringify(plan.data));
      api.createPlan.response.parse(plan.data);
      const body = { planId: plan.data.plan.id, planVersion: 1, mode: "simulator" };
      const result = await http("POST", "/api/v1/calls", body, key);
      assert.equal(result.status, 202, JSON.stringify(result.data));
      CallSnapshotSchema.parse(result.data.call);
      return { ...result.data.call, command: { body, key } };
    },
    async get(id) {
      const response = await http("GET", `/api/v1/calls/${id}`);
      assert.equal(response.status, 200);
      return CallSnapshotSchema.parse(response.data.call);
    },
    async tick(count = 1) { for (let i = 0; i < count; i++) { clock.ms += 50; await runtime.simulator.tick(); } },
    async until(id, predicate) {
      for (let i = 0; i < 30; i++) {
        const call = await this.get(id);
        if (predicate(call)) return call;
        await this.tick();
      }
      throw new Error("Simulator did not reach the expected state");
    },
    decide(id, approval, decision = "approve", key = randomUUID()) {
      return http("POST", `/api/v1/calls/${id}/approvals`, {
        approvalId: approval.id, plan: approval.plan,
        offer: { offerId: approval.offer.id, offerVersion: approval.offer.version }, decision,
      }, key);
    },
  };
}

test("UI request extensions fail safely when unsupported by the backend simulator", async (t) => {
  const app = setup(t);
  const request = structuredClone(reviewPlanFixture.request);
  const ask = { ...request, requestType: "ask", goal: "Ask about opening hours", timeZone: "Europe/Madrid",
    questions: ["When are you open?"], service: "", bookingName: "", availability: [] };
  for (const draft of [ask, { ...request, bookingName: "" },
    { ...request, callLimits: { ...request.callLimits, maxEstimatedCost: { amountMinor: 200, currency: "EUR" } } }]) {
    const response = await app.http("POST", "/api/v1/plans", draft);
    assert.equal(response.status, 400);
    assert.equal(response.data.error.code, "INVALID_REQUEST");
  }
  assert.equal((await app.http("GET", "/api/v1/history")).data.items.length, 0);
});

test("HTTP plan/start flow confirms only after simulated playback and final business evidence", async (t) => {
  const app = setup(t);
  const call = await app.begin();
  assert.equal(call.callState, "creating");
  const waiting = await app.until(call.id, (call) => call.bookingState === "awaiting_business_confirmation");
  assert.equal(waiting.outcome.status, "pending");
  assert.equal(waiting.messages.filter((message) => message.speaker === "assistant" && message.playback === "played").length, 1);
  const finished = await app.until(call.id, terminal);
  assert.equal(finished.outcome.status, "confirmed");
  const evidence = finished.messages.find((message) => message.id === finished.outcome.confirmationMessageIds[0]);
  assert.equal(evidence.speaker, "business");
  assert.equal(evidence.final, true);
  assert.match(finished.outcome.summaryEn, /No real booking/);
  assert.equal(finished.usage.status, "unavailable");
  const events = app.runtime.simulator.replayEvents(call.id, 0);
  events.forEach((event, index) => { DomainEventSchema.parse(event); assert.equal(event.sequence, index + 1); });
  assert.equal(events.at(-1).sequence, finished.lastEventSequence);
  assert.equal(events.at(-1).snapshotRevision, finished.revision);
  assert.deepEqual(events.filter((event) => event.type === "call.status").map((event) => event.payload.callState),
    ["creating", "dialing", "ringing", "connected", "ended"]);
});

test("concurrent Start retries share one attempt; different commands conflict and reserve one slot", async (t) => {
  const app = setup(t);
  const first = await app.begin();
  const retry = () => app.http("POST", "/api/v1/calls", first.command.body, first.command.key);
  const results = await Promise.all([retry(), retry(), retry()]);
  results.forEach((result) => { assert.equal(result.status, 202); assert.equal(result.data.call.id, first.id); });
  const conflict = await app.http("POST", "/api/v1/calls", { ...first.command.body, mode: "live" }, first.command.key);
  assert.equal(conflict.data.error.code, "IDEMPOTENCY_CONFLICT");
  const second = await app.http("POST", "/api/v1/calls", first.command.body, randomUUID());
  assert.equal(second.data.error.code, "CALL_ALREADY_ACTIVE");
  assert.equal((await app.http("GET", "/api/v1/history")).data.items.length, 1);
  assert.equal((await app.http("POST", "/api/v1/calls", first.command.body)).status, 400);
});

test("plan validation enforces future windows, current limits, versions and explicit mode", async (t) => {
  const app = setup(t);
  const request = structuredClone(reviewPlanFixture.request);
  app.clock.ms = Date.parse("2026-10-21T00:00:00Z");
  assert.equal((await app.http("POST", "/api/v1/plans", request)).status, 400);
  app.clock.ms = Date.parse("2026-10-15T10:00:00Z");
  const oversized = structuredClone(request);
  oversized.callLimits.maxEstimatedCost.amountMinor = 201;
  assert.equal((await app.http("POST", "/api/v1/plans", oversized)).status, 400);
  const plan = (await app.http("POST", "/api/v1/plans", request)).data.plan;
  const body = { planId: plan.id, planVersion: 2, mode: "simulator" };
  assert.equal((await app.http("POST", "/api/v1/calls", body, randomUUID())).data.error.code, "PLAN_VERSION_MISMATCH");
  assert.equal((await app.http("POST", "/api/v1/calls", { ...body, planVersion: 1, mode: "live" }, randomUUID())).data.error.code, "MODE_MISMATCH");
  app.clock.ms = Date.parse("2026-10-21T00:00:00Z");
  assert.equal((await app.http("POST", "/api/v1/calls", { ...body, planVersion: 1 }, randomUUID())).status, 400);
  const live = setup(t, "within_plan", { env: { CALLMATE_MODE: "live" } });
  assert.equal((await live.http("POST", "/api/v1/calls", { ...body, mode: "live" }, randomUUID())).data.error.code, "PROVIDER_NOT_READY");
});

test("valid exact-offer approval gates acceptance and its idempotency survives completion", async (t) => {
  const app = setup(t, "approval_required");
  const call = await app.begin();
  const waiting = await app.until(call.id, (call) => call.pendingApproval !== null);
  assert.equal(waiting.pendingApproval.reason, "above_price_limit");
  assert.ok(!waiting.messages.some((message) => message.speaker === "assistant"));
  const wrong = structuredClone(waiting.pendingApproval);
  wrong.offer.version++;
  assert.equal((await app.decide(call.id, wrong)).data.error.code, "APPROVAL_STALE");
  const key = randomUUID();
  const approved = await app.decide(call.id, waiting.pendingApproval, "approve", key);
  assert.equal(approved.status, 200);
  assert.equal(approved.data.call.outcome.status, "pending");
  const finished = await app.until(call.id, terminal);
  assert.equal(finished.outcome.status, "confirmed");
  const replay = await app.decide(call.id, waiting.pendingApproval, "approve", key);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.call.outcome.status, "confirmed");
  assert.equal((await app.decide(call.id, waiting.pendingApproval, "reject", key)).data.error.code, "IDEMPOTENCY_CONFLICT");
});

test("rejected and expired approvals never play acceptance; expiry uses the backend deadline", async (t) => {
  for (const action of ["reject", "expire"]) {
    const app = setup(t, "approval_required");
    const call = await app.begin();
    const waiting = await app.until(call.id, (call) => call.pendingApproval !== null);
    if (action === "reject") assert.equal((await app.decide(call.id, waiting.pendingApproval, "reject")).status, 200);
    else {
      app.clock.ms = Date.parse(waiting.pendingApproval.expiresAt);
      assert.equal((await app.decide(call.id, waiting.pendingApproval)).data.error.code, "APPROVAL_EXPIRED");
    }
    const finished = await app.get(call.id);
    assert.equal(finished.outcome.status, "not_booked");
    assert.equal(finished.pendingApproval, null);
    assert.ok(!finished.messages.some((message) => message.speaker === "assistant"));
    assert.equal(app.runtime.simulator.replayEvents(call.id, 0).find((event) => event.type === "approval.resolved").payload.status,
      action === "reject" ? "rejected" : "expired");
  }
});

test("changed offers invalidate pending approvals and already-granted unspoken permission", async (t) => {
  for (const approveOld of [false, true]) {
    const app = setup(t, "changed_offer");
    const call = await app.begin();
    const first = await app.until(call.id, (call) => call.pendingApproval !== null);
    if (approveOld) assert.equal((await app.decide(call.id, first.pendingApproval)).status, 200);
    const changed = await app.until(call.id, (call) => call.activeOffer?.version === 2);
    assert.equal(changed.bookingState, "awaiting_approval");
    assert.equal(changed.pendingApproval.offer.version, 2);
    assert.ok(!changed.messages.some((message) => message.speaker === "assistant"));
    assert.equal((await app.decide(call.id, first.pendingApproval)).data.error.code, "APPROVAL_STALE");
    if (!approveOld) assert.ok(app.runtime.simulator.replayEvents(call.id, 0).some((event) =>
      event.type === "approval.resolved" && event.payload.approvalId === first.pendingApproval.id && event.payload.status === "invalidated"));
    assert.equal((await app.decide(call.id, changed.pendingApproval)).status, 200);
    assert.equal((await app.until(call.id, terminal)).outcome.offer.version, 2);
  }
});

test("Stop cancels a pending dialogue result even when the fake model ignores cancellation", async (t) => {
  let resolve, input;
  const dialogue = { propose(value) { input = value; return new Promise((done) => { resolve = done; }); } };
  const app = setup(t, "pending_reply", { options: { dialogue } });
  const call = await app.begin();
  await app.tick(3); // Connected; the next step waits for a reply.
  app.clock.ms += 50;
  const pending = app.runtime.simulator.tick();
  assert.ok(resolve);
  const stopped = await app.http("POST", `/api/v1/calls/${call.id}/stop`, {});
  assert.equal(stopped.status, 202);
  assert.equal(stopped.data.call.callState, "ending");
  await app.tick();
  resolve({ turnId: input.turnId, turnVersion: input.turnVersion,
    candidate: { action: "evaluate_offer", offer: input.offer }, translations: [] });
  await pending;
  const finished = await app.get(call.id);
  assert.equal(finished.outcome.reason, "user_stopped");
  assert.ok(!finished.messages.some((message) => message.speaker === "assistant"));
  assert.equal((await app.http("POST", `/api/v1/calls/${call.id}/stop`, {})).data.call.revision, finished.revision);
});

test("the duration deadline ends a stalled model; late approval grants cannot authorize speech", async (t) => {
  const app = setup(t, "pending_reply");
  const call = await app.begin();
  await app.tick(3);
  app.clock.ms += 50;
  const pending = app.runtime.simulator.tick();
  app.clock.ms = Date.parse(call.createdAt) + call.plan.request.callLimits.maxDurationSeconds * 1000;
  await app.runtime.simulator.tick();
  await pending;
  assert.equal((await app.get(call.id)).outcome.reason, "technical_failure");

  const approvals = setup(t, "approval_required");
  const second = await approvals.begin();
  const waiting = await approvals.until(second.id, (call) => call.pendingApproval !== null);
  await approvals.decide(second.id, waiting.pendingApproval);
  approvals.clock.ms = Date.parse(waiting.pendingApproval.expiresAt);
  await approvals.runtime.simulator.tick();
  const finished = await approvals.get(second.id);
  assert.equal(finished.outcome.status, "not_booked");
  assert.ok(!finished.messages.some((message) => message.speaker === "assistant"));
});

test("disconnect and Stop near acceptance stay uncertain; Stop preserves a confirmed result", async (t) => {
  const disconnected = setup(t, "disconnect");
  const first = await disconnected.begin();
  assert.equal((await disconnected.until(first.id, terminal)).outcome.status, "uncertain");
  for (const state of ["awaiting_business_confirmation", "confirmed"]) {
    const app = setup(t);
    const call = await app.begin();
    await app.until(call.id, (call) => call.bookingState === state);
    await app.http("POST", `/api/v1/calls/${call.id}/stop`, {});
    await app.tick();
    assert.equal((await app.get(call.id)).outcome.status, state === "confirmed" ? "confirmed" : "uncertain");
  }
});

test("scripted no availability, busy, no answer and provider failure cannot confirm a booking", async (t) => {
  for (const scenario of ["no_availability", "busy", "no_answer", "provider_failure"]) {
    SimulatorScenarioSchema.parse(scenario);
    const app = setup(t, scenario);
    const call = await app.begin();
    const finished = await app.until(call.id, terminal);
    assert.equal(finished.outcome.status, "not_booked");
    assert.equal(finished.outcome.reason, scenario === "provider_failure" ? "technical_failure" : scenario);
  }
});

test("restart retains command tombstones, closes interrupted simulations, and never resumes dialing", async (t) => {
  for (const afterAcceptance of [false, true]) {
    const app = setup(t);
    const call = await app.begin();
    if (afterAcceptance) await app.until(call.id, (call) => call.bookingState === "awaiting_business_confirmation");
    await app.restart();
    const recovered = await app.get(call.id);
    assert.equal(recovered.callState, "ended");
    assert.equal(recovered.outcome.status, afterAcceptance ? "uncertain" : "not_booked");
    const retry = await app.http("POST", "/api/v1/calls", call.command.body, call.command.key);
    assert.equal(retry.data.call.id, call.id);
    assert.equal(retry.data.call.revision, recovered.revision);
    await app.tick(5);
    assert.equal((await app.get(call.id)).revision, recovered.revision);
    const second = await app.begin();
    assert.notEqual(second.id, call.id);
  }
});

test("history pagination and deletion preserve booking metadata and purge transcript replay", async (t) => {
  const app = setup(t);
  const first = await app.begin();
  const completed = await app.until(first.id, terminal);
  const second = await app.begin();
  assert.equal((await app.http("DELETE", `/api/v1/calls/${second.id}/conversation`)).data.error.code, "DATA_NOT_DELETABLE");
  const page = await app.http("GET", "/api/v1/history?limit=1");
  api.history.response.parse(page.data);
  assert.equal(page.data.items[0].id, second.id);
  assert.equal(page.data.nextCursor, second.id);
  assert.equal((await app.http("GET", `/api/v1/history?limit=1&cursor=${second.id}`)).data.items[0].id, first.id);
  assert.equal((await app.http("GET", "/api/v1/history?limit=101")).status, 400);
  const response = await app.http("DELETE", `/api/v1/calls/${first.id}/conversation`);
  assert.equal(response.status, 200);
  const deleted = await app.get(first.id);
  assert.deepEqual(deleted.messages, []);
  assert.equal(deleted.outcome.status, "confirmed");
  assert.deepEqual(deleted.outcome.offer, completed.outcome.offer);
  assert.equal(app.runtime.simulator.replayEvents(first.id, 0), null);
  const events = app.runtime.simulator.replayEvents(first.id, completed.lastEventSequence);
  assert.deepEqual(events.map((event) => event.type), ["conversation.deleted"]);
  assert.ok(!JSON.stringify(events).includes(completed.messages[0].originalText));
  assert.equal((await app.http("DELETE", `/api/v1/calls/${first.id}/conversation`)).status, 200);
  await app.restart();
  assert.equal((await app.http("POST", "/api/v1/calls", first.command.body, first.command.key)).data.call.id, first.id);
  assert.equal((await app.get(first.id)).conversationData, "deleted");
});

test("snapshot and event updates roll back as one transaction", async (t) => {
  const app = setup(t);
  const call = await app.begin();
  const repository = openStore(app.dataDir);
  t.after(() => repository.close());
  const original = repository.calls.get(call.id);
  assert.throws(() => repository.calls.transaction(() => {
    const changed = structuredClone(original);
    changed.call.revision++;
    changed.call.lastEventSequence++;
    repository.calls.save(changed, [{ id: "invalid-event" }]);
  }));
  assert.deepEqual(repository.calls.get(call.id), original);
  assert.equal(repository.calls.events(call.id, 0).length, 1);
});

test("fake telephony uses internal simulator IDs and acknowledges local hangup", async () => {
  const fake = new FakeTelephony();
  const result = await fake.startCall({ attemptId: randomUUID(), plan: { request: { business: { phone: "never-dial-this" } } } });
  assert.match(result.providerCallId, /^simulator:/);
  assert.equal((await fake.queryCall(result.providerCallId)).status, "found");
  assert.equal((await fake.requestHangup(result.providerCallId)).status, "acknowledged");
  assert.equal((await fake.queryCall(result.providerCallId)).status, "unknown");
});

async function eventStream(app, id, cursor) {
  if (!app.runtime.privateApi.server.listening) {
    app.config.apiPort = 0;
    app.config.callbackPort = 0;
    await app.runtime.start();
  }
  const port = app.runtime.privateApi.server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/calls/${id}/events`, {
    headers: { ...authHeaders(app.dataDir), ...(cursor === undefined ? {} : { "Last-Event-ID": String(cursor) }) }, signal: AbortSignal.timeout(5000),
  });
  const reader = response.body.getReader();
  let buffer = "";
  const decoder = new TextDecoder();
  return { response, close: () => reader.cancel().catch(() => {}), async next() {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith(":")) continue;
        const value = (key) => frame.split("\n").find((line) => line.startsWith(`${key}: `))?.slice(key.length + 2);
        return { event: value("event"), id: value("id"), data: JSON.parse(value("data")) };
      }
      const chunk = await reader.read();
      if (chunk.done) return null;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  } };
}

test("real SSE replays persisted frames then tails live transitions without sequence gaps", async (t) => {
  const app = setup(t);
  const call = await app.begin();
  await app.tick(2);
  const stream = await eventStream(app, call.id, 0);
  t.after(() => stream.close());
  assert.match(stream.response.headers.get("content-type"), /text\/event-stream/);
  for (let sequence = 1; sequence <= 3; sequence++) {
    const frame = await stream.next();
    assert.equal(frame.event, "callmate");
    assert.equal(frame.id, String(sequence));
    assert.equal(DomainEventSchema.parse(frame.data).sequence, sequence);
    assert.equal(frame.data.attemptId, call.id);
  }
  await app.tick();
  const live = await stream.next();
  assert.equal(live.data.payload.callState, "connected");
  assert.equal(live.id, "4");
  await stream.close();
  await app.tick();
  const reconnected = await eventStream(app, call.id, 4);
  t.after(() => reconnected.close());
  const next = await reconnected.next();
  assert.equal(next.id, "5");
  assert.equal(next.data.type, "transcript.updated");
  assert.equal(app.runtime.simulator.get(call.id).id, call.id);
});

test("SSE resets missing replay ranges, publishes deletion, and rejects malformed cursors before opening", async (t) => {
  const app = setup(t);
  const call = await app.begin();
  const completed = await app.until(call.id, terminal);
  const deletion = await eventStream(app, call.id, completed.lastEventSequence);
  t.after(() => deletion.close());
  app.runtime.simulator.deleteConversation(call.id);
  assert.equal((await deletion.next()).data.type, "conversation.deleted");
  const port = app.runtime.privateApi.server.address().port;
  const base = `http://127.0.0.1:${port}/api/v1/calls/${call.id}/events`;
  for (const cursor of ["invalid", "-1", "1.5", "9007199254740992"]) {
    const response = await fetch(base, { headers: { ...authHeaders(app.dataDir), "Last-Event-ID": cursor } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "EVENT_CURSOR_INVALID");
  }
  for (const cursor of [0, completed.lastEventSequence + 100]) {
    const reset = await eventStream(app, call.id, cursor);
    assert.deepEqual(await reset.next(), { id: undefined, event: "reset", data: { reason: "snapshot_required" } });
    assert.equal(await reset.next(), null);
  }
  const callbackPort = app.runtime.callbacks.server.address().port;
  assert.equal((await fetch(`http://127.0.0.1:${callbackPort}/api/v1/calls/${call.id}/events`)).status, 404);
});

test("graceful runtime shutdown closes an idle event stream", async (t) => {
  const app = setup(t);
  const call = await app.begin();
  const stream = await eventStream(app, call.id, call.lastEventSequence);
  t.after(() => stream.close());
  await app.runtime.close();
  assert.equal(app.runtime.privateApi.server.listening, false);
  assert.equal(await stream.next(), null);
});

test("ask-before-accepting authority requires approval even for an in-budget offer", async (t) => {
  const app = setup(t);
  const request = structuredClone(reviewPlanFixture.request);
  request.bookingAuthority = "ask_before_accepting";
  const call = await app.begin(request);
  const waiting = await app.until(call.id, (call) => call.pendingApproval !== null);
  assert.equal(waiting.pendingApproval.reason, "user_confirmation_required");
  await app.decide(call.id, waiting.pendingApproval);
  assert.equal((await app.until(call.id, terminal)).outcome.status, "confirmed");
});

test('silence deadline cancels a stalled dialogue and ignores its eventual result', async (t) => {
  let resolve; let input;
  const dialogue = { propose(value) { input = value; return new Promise((done) => { resolve = done; }); } };
  const app = setup(t, 'pending_reply', { env: { CALLMATE_SILENCE_TIMEOUT_SECONDS: '5' }, options: { dialogue } });
  const call = await app.begin(); await app.tick(3);
  app.clock.ms += 50; const pending = app.runtime.simulator.tick(); assert.ok(resolve);
  app.clock.ms += 5000; await app.runtime.simulator.tick();
  const ended = await app.get(call.id);
  assert.equal(ended.callState, 'ended'); assert.equal(ended.outcome.reason, 'technical_failure');
  assert.match(ended.outcome.summaryEn, /silence deadline/);
  resolve({ turnId: input.turnId, turnVersion: input.turnVersion,
    candidate: { action: 'evaluate_offer', offer: input.offer }, translations: [] }); await pending;
  assert.deepEqual(await app.get(call.id), ended);
  assert.ok(!ended.messages.some((message) => message.speaker === 'assistant'));
});

test('Stop while dialing is idempotent even with overlapping timer ticks', async (t) => {
  const app = setup(t); const call = await app.begin(); await app.tick();
  assert.equal((await app.get(call.id)).callState, 'dialing');
  await Promise.all(Array.from({ length: 5 }, () => app.http('POST', `/api/v1/calls/${call.id}/stop`, {})));
  await Promise.all(Array.from({ length: 5 }, () => app.runtime.simulator.tick()));
  const ended = await app.get(call.id);
  assert.equal(ended.callState, 'ended'); assert.equal(ended.outcome.reason, 'user_stopped');
  const events = app.runtime.controller.replayEvents(call.id, 0).filter((event) => event.type === 'call.status');
  assert.deepEqual(events.map((event) => event.payload.callState), ['creating', 'dialing', 'ending', 'ended']);
});

test('test-rate budget refuses a zero-budget Start without reserving a call or consuming its command', async (t) => {
  const app = setup(t, 'within_plan', { env: { CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE: '60' } });
  const request = structuredClone(reviewPlanFixture.request); request.callLimits.maxEstimatedCost.amountMinor = 0;
  const plan = await app.http('POST', '/api/v1/plans', request); const key = randomUUID();
  const response = await app.http('POST', '/api/v1/calls', { planId: plan.data.plan.id, planVersion: 1, mode: 'simulator' }, key);
  assert.equal(response.status, 409); assert.equal(response.data.error.code, 'BUDGET_EXCEEDED');
  const store = openStore(app.dataDir);
  try { assert.equal(store.calls.active(), undefined); assert.equal(store.calls.command(key), undefined); }
  finally { store.close(); }
});

test('test-rate usage is durable, replayable and stops at the exact budget boundary before dialing further', async (t) => {
  const app = setup(t, 'within_plan', { env: { CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE: '60' } });
  const request = structuredClone(reviewPlanFixture.request); request.callLimits.maxEstimatedCost.amountMinor = 2;
  const call = await app.begin(request);
  assert.equal(call.usage.testUsage.rateMinorPerMinute, 60); assert.equal(call.usage.estimate.amountMinor, 0);
  app.clock.ms += 1999; await app.runtime.simulator.tick();
  const before = await app.get(call.id); assert.equal(before.callState, 'dialing'); assert.equal(before.usage.estimate.amountMinor, 2);
  app.clock.ms++; await app.runtime.simulator.tick();
  const ended = await app.get(call.id); assert.equal(ended.callState, 'ended'); assert.equal(ended.outcome.reason, 'technical_failure');
  assert.equal(ended.usage.testUsage.elapsedMs, 2000); assert.equal(ended.usage.estimate.amountMinor, 2);
  assert.equal(ended.usage.settledTotal, null); assert.equal(ended.usage.status, 'estimated');
  const events = app.runtime.controller.replayEvents(call.id, 0);
  assert.equal(events.filter((e) => e.type === 'call.error' && e.payload.code === 'BUDGET_EXCEEDED').length, 1);
  assert.equal(events.at(-1).type, 'usage.updated');
  events.forEach((event, index) => { DomainEventSchema.parse(event); assert.equal(event.sequence, index + 1); });
  await app.runtime.simulator.tick(); assert.deepEqual(await app.get(call.id), ended);
  const replay = await app.http('POST', '/api/v1/calls', call.command.body, call.command.key);
  assert.deepEqual(replay.data.call, ended); assert.deepEqual(app.runtime.controller.history(10).items[0].usage, ended.usage);
});

test('rates and budget freeze per attempt, survive restart and retention, and never become settled charges', async (t) => {
  const app = setup(t, 'within_plan', { env: { CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE: '60' } });
  const call = await app.begin(); app.clock.ms += 1500;
  app.config.testRateMinorPerMinute = 600;
  const store = openStore(app.dataDir);
  try { const settings = store.getSettings(); settings.defaultCallLimits.maxEstimatedCost.amountMinor = 1; store.setSettings(settings); }
  finally { store.close(); }
  await app.restart(); const ended = await app.get(call.id);
  assert.equal(ended.callState, 'ended'); assert.equal(ended.usage.estimate.amountMinor, 2);
  assert.equal(ended.usage.testUsage.rateMinorPerMinute, 60); assert.equal(ended.usage.testUsage.budget.amountMinor, call.usage.testUsage.budget.amountMinor);
  app.clock.ms += 31 * 86400000; assert.equal(app.runtime.retention.sweep(), 1);
  assert.deepEqual((await app.get(call.id)).usage, ended.usage);
  await app.restart(); assert.deepEqual((await app.get(call.id)).usage, ended.usage);
});

test('budget termination preserves confirmed bookings and uncertainty after acceptance', async (t) => {
  for (const state of ['confirmed', 'awaiting_business_confirmation']) {
    const app = setup(t, 'within_plan', { env: { CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE: '6000' } });
    const call = await app.begin(); const prior = await app.until(call.id, (c) => c.bookingState === state);
    app.clock.ms = Date.parse(call.createdAt) + 2000; await app.runtime.simulator.tick();
    const ended = await app.get(call.id); assert.equal(ended.callState, 'ended');
    if (state === 'confirmed') assert.deepEqual(ended.outcome, prior.outcome);
    else assert.equal(ended.outcome.status, 'uncertain');
    assert.equal(ended.usage.estimate.amountMinor, 200); assert.equal(ended.usage.settledTotal, null);
  }
});

test('a slow dialogue response cannot send acceptance after the test budget expires', async (t) => {
  let resolveProposal; let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const app = setup(t, 'within_plan', { env: { CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE: '6000' }, options: {
    dialogue: { propose() { started(); return new Promise((resolve) => { resolveProposal = resolve; }); } },
  } });
  const call = await app.begin(); await app.tick(3);
  app.clock.ms += 50; const pending = app.runtime.simulator.tick(); await entered;
  app.clock.ms = Date.parse(call.createdAt) + 2000;
  resolveProposal({}); await pending;
  const ended = await app.get(call.id); assert.equal(ended.callState, 'ended'); assert.equal(ended.messages.some((m) => m.speaker === 'assistant'), false);
  assert.equal(app.runtime.controller.replayEvents(call.id, 0).some((e) => e.type === 'call.error' && e.payload.code === 'BUDGET_EXCEEDED'), true);
});

test('legacy attempts without a test meter stay unavailable when test rates are later enabled', async (t) => {
  const app = setup(t); const call = await app.begin(); app.config.testRateMinorPerMinute = 6000;
  app.clock.ms += 2000; await app.runtime.simulator.tick();
  assert.equal((await app.get(call.id)).usage.status, 'unavailable');
  await app.restart(); assert.equal((await app.get(call.id)).usage.testUsage, undefined);
});
