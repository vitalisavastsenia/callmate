import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalDecisionSchema, CallSnapshotSchema, CandidateActionSchema, DialogueInputSchema,
  DomainEventSchema, E164Schema, EventCursorSchema, PlaybackPermitSchema,
  RequestDraftSchema, StartCallRequestSchema, ZonedTimeSchema, api,
} from "../dist/index.js";
import {
  approvalFixture, awaitingApprovalFixture, confirmedCallFixture, connectedCallFixture,
  ids, reviewPlanFixture, transcriptEventFixture, uncertainCallFixture,
} from "../dist/fixtures.js";

const copy = (value) => structuredClone(value);
const rejects = (schema, value) => assert.equal(schema.safeParse(value).success, false);

test("shared snapshots support the four UI states and stay JSON serializable", () => {
  for (const fixture of [connectedCallFixture, awaitingApprovalFixture, confirmedCallFixture, uncertainCallFixture]) {
    assert.deepEqual(CallSnapshotSchema.parse(JSON.parse(JSON.stringify(fixture))), fixture);
  }
});

test("review data cannot carry credentials or silent extra authority", () => {
  rejects(RequestDraftSchema, { ...reviewPlanFixture.request, apiKey: "example-placeholder" });
  rejects(RequestDraftSchema, { ...reviewPlanFixture.request, paymentAllowed: true });
});

test("reject malformed destinations and require explicit simulator/live choice", () => {
  rejects(E164Schema, "612 345 678");
  rejects(E164Schema, "+000000000");
  rejects(StartCallRequestSchema, { planId: ids.plan, planVersion: 1 });
});

test("service and call budgets cannot swap currency or use fractional minor units", () => {
  const wrongCurrency = copy(reviewPlanFixture.request);
  wrongCurrency.pricePolicy.maximum.currency = "USD";
  rejects(RequestDraftSchema, wrongCurrency);
  const fractional = copy(reviewPlanFixture.request);
  fractional.callLimits.maxEstimatedCost.amountMinor = 0.5;
  rejects(RequestDraftSchema, fractional);
});

test("reject timezone mismatch, invalid dates, and nonexistent spring DST times", () => {
  const original = reviewPlanFixture.request.availability[0].start;
  rejects(ZonedTimeSchema, { ...original, instant: "2026-10-20T17:00:00Z" });
  rejects(ZonedTimeSchema, { ...original, localDate: "2026-02-30" });
  rejects(ZonedTimeSchema, { localDate: "2026-03-29", localTime: "02:30", timeZone: "Europe/Madrid",
    instant: "2026-03-29T01:30:00Z" });
});

test("explicit resolved instants distinguish both autumn DST occurrences", () => {
  const base = { localDate: "2026-10-25", localTime: "02:30", timeZone: "Europe/Madrid" };
  assert.ok(ZonedTimeSchema.safeParse({ ...base, instant: "2026-10-25T00:30:00Z" }).success);
  assert.ok(ZonedTimeSchema.safeParse({ ...base, instant: "2026-10-25T01:30:00Z" }).success);
});

test("availability end must follow start and all windows share one zone", () => {
  const reversed = copy(reviewPlanFixture.request);
  reversed.availability[0].end = reversed.availability[0].start;
  rejects(RequestDraftSchema, reversed);
  const mixed = copy(reviewPlanFixture.request);
  mixed.availability.push({
    start: { localDate: "2026-10-20", localTime: "17:00", timeZone: "Atlantic/Canary", instant: "2026-10-20T16:00:00Z" },
    end: { localDate: "2026-10-20", localTime: "19:00", timeZone: "Atlantic/Canary", instant: "2026-10-20T18:00:00Z" },
  });
  rejects(RequestDraftSchema, mixed);
});

test("call duration cannot exceed the MVP cap", () => {
  const request = copy(reviewPlanFixture.request);
  request.callLimits.maxDurationSeconds = 601;
  rejects(RequestDraftSchema, request);
});

test("terminal phone status alone cannot claim successful or pending booking", () => {
  rejects(CallSnapshotSchema, { ...connectedCallFixture, callState: "ended" });
  rejects(CallSnapshotSchema, { ...confirmedCallFixture, bookingState: "pending" });
});

test("confirmed evidence must refer to finalized business speech in this attempt", () => {
  const missing = copy(confirmedCallFixture);
  missing.outcome.confirmationMessageIds = [ids.approval];
  rejects(CallSnapshotSchema, missing);
  const provisional = copy(confirmedCallFixture);
  provisional.messages.at(-1).final = false;
  rejects(CallSnapshotSchema, provisional);
  const assistant = copy(confirmedCallFixture);
  assistant.messages.at(-1).speaker = "assistant";
  assistant.messages.at(-1).playback = "played";
  rejects(CallSnapshotSchema, assistant);
});

test("pending approvals must match the attempt, plan version, and offer version", () => {
  for (const mutate of [
    (value) => { value.pendingApproval.attemptId = ids.plan; },
    (value) => { value.pendingApproval.plan.planVersion = 2; },
    (value) => { value.activeOffer.version = 3; },
  ]) {
    const snapshot = copy(awaitingApprovalFixture);
    mutate(snapshot);
    rejects(CallSnapshotSchema, snapshot);
  }
  rejects(CallSnapshotSchema, { ...awaitingApprovalFixture, pendingApproval: null });
});

test("approval decision cannot replace the offer or choose its own expiry", () => {
  const decision = { approvalId: ids.approval, plan: approvalFixture.plan,
    offer: { offerId: ids.offer, offerVersion: 2 }, decision: "approve" };
  assert.ok(ApprovalDecisionSchema.safeParse(decision).success);
  rejects(ApprovalDecisionSchema, { ...decision, expiresAt: "2099-01-01T00:00:00Z" });
  rejects(ApprovalDecisionSchema, { ...decision, offer: approvalFixture.offer });
});

test("retention may remove transcript while preserving confirmed booking metadata", () => {
  assert.ok(CallSnapshotSchema.safeParse({ ...confirmedCallFixture, conversationData: "deleted", messages: [] }).success);
  rejects(CallSnapshotSchema, { ...confirmedCallFixture, conversationData: "deleted" });
  rejects(CallSnapshotSchema, { ...connectedCallFixture, conversationData: "deleted", messages: [] });
});

test("SSE rejects unknown versions/types, zero sequences, and malformed payloads", () => {
  for (const patch of [{ contractVersion: 2 }, { type: "book_anything" }, { sequence: 0 }, { payload: {} }]) {
    rejects(DomainEventSchema, { ...transcriptEventFixture, ...patch });
  }
  assert.equal(EventCursorSchema.parse("0"), 0);
  assert.equal(EventCursorSchema.parse("12"), 12);
  for (const cursor of ["-1", "1.5", "2e3", "9007199254740992"]) rejects(EventCursorSchema, cursor);
});

test("dialogue accepts only a finalized business trigger", () => {
  const input = { attemptId: ids.attempt, turnId: ids.turn, turnVersion: 1,
    plan: connectedCallFixture.plan, bookingState: "offer_received", offer: connectedCallFixture.activeOffer,
    triggerMessageId: ids.businessMessage, messages: connectedCallFixture.messages };
  assert.ok(DialogueInputSchema.safeParse(input).success);
  rejects(DialogueInputSchema, { ...input, triggerMessageId: ids.approval });
  rejects(DialogueInputSchema, { ...input, messages: [{ ...input.messages[0], final: false }] });
});

test("model actions cannot dial, accept unbound offers, or confirm without evidence", () => {
  rejects(CandidateActionSchema, { action: "start_call", phone: "+12025550123" });
  rejects(CandidateActionSchema, { action: "accept_offer", offerId: ids.offer });
  rejects(CandidateActionSchema, { action: "record_business_confirmation", offerId: ids.offer,
    offerVersion: 1, evidenceMessageIds: [] });
});

test("playback permission includes output, turn, plan and offer binding", () => {
  const permit = { id: ids.event, attemptId: ids.attempt, planId: ids.plan, planVersion: 1,
    turnId: ids.turn, turnVersion: 1, outputId: ids.event, offer: { id: ids.offer, version: 1 },
    approvedSpanishText: "Confirmo la cita para el día veinte a las seis de la tarde.",
    expiresAt: "2026-10-15T10:02:00Z" };
  assert.ok(PlaybackPermitSchema.safeParse(permit).success);
  const { outputId, ...unbound } = permit;
  rejects(PlaybackPermitSchema, unbound);
});

test("history pagination is bounded and contracts expose no callback routes", () => {
  rejects(api.history.query, { limit: 101 });
  assert.equal(api.history.query.parse({}).limit, 20);
  assert.ok(Object.values(api).every((route) => route.path.startsWith("/api/v1/")));
});
