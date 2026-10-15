import assert from "node:assert/strict";
import test from "node:test";
import { CallSnapshotSchema } from "@callmate/contracts";
import {
  BookingTransitionError, checkAcceptancePlayback, checkConfirmationEvidence, checkOfferEvidence,
  deriveOutcome, reduceBooking,
} from "../dist/index.js";
import { buildSnapshot } from "./support/builders.mjs";
import { loadConversations } from "./support/conversations.mjs";
import { renderAcceptance, renderReadback } from "../dist/language/spanish.js";

const now = "2026-10-15T10:01:20Z";
const id = (n) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const success = () => loadConversations().find((item) => item.id === "dialogue-within-plan-confirmation");
const waiting = () => success().turns[1].snapshot;
const eventRef = (offer) => ({ offerId: offer.id, offerVersion: offer.version });
const merge = (snapshot, update) => {
  const { acceptance, ...fields } = update;
  return CallSnapshotSchema.parse({ ...snapshot, ...fields });
};
const receiptFor = (snapshot = waiting()) => {
  const message = snapshot.messages.find((item) => item.speaker === "assistant" && item.originalText.startsWith("Acepto"));
  return {
    permit: {
      id: id(1), attemptId: snapshot.id, planId: snapshot.plan.id, planVersion: snapshot.plan.version,
      turnId: message.turnId, turnVersion: 1, outputId: id(2),
      offer: { id: snapshot.activeOffer.id, version: snapshot.activeOffer.version },
      approvedSpanishText: message.originalText, expiresAt: "2026-10-15T10:01:12Z",
    },
    offer: structuredClone(snapshot.activeOffer), readbackMessageId: message.id, acceptanceMessageId: message.id,
    startedAt: "2026-10-15T10:01:10Z", observedAt: "2026-10-15T10:01:11Z",
  };
};
// This fixture-only reviewer matches one expected statement. It is not a general Spanish verifier.
const verifyFixtureMeaning = ({ evidence, offer }) => evidence.some((message) =>
  message.originalText === success().messages.at(-1).originalText)
  && offer.service === "Haircut" && offer.price?.amountMinor === 2500 ? "affirmed" : "ambiguous";
const confirmationEvent = () => ({
  type: "business_confirmation", evidenceMessageIds: success().expectedOutcome.confirmationMessageIds,
  verifyMeaning: verifyFixtureMeaning,
});
const confirmationCheck = (snapshot = waiting(), receipt = receiptFor(snapshot), overrides = {}) =>
  checkConfirmationEvidence({ snapshot, receipt, now, ...confirmationEvent(), ...overrides });
const approvalFor = (snapshot) => ({
  id: id(3), attemptId: snapshot.id, plan: { planId: snapshot.plan.id, planVersion: snapshot.plan.version },
  offer: snapshot.activeOffer, reason: "user_confirmation_required",
  createdAt: "2026-10-15T10:01:05Z", expiresAt: "2026-10-15T10:01:30Z",
});

test("booking reducer replays offer, readback, actual acceptance playback, and business confirmation", () => {
  const fixture = success();
  let snapshot = fixture.turns[0].snapshot;
  let update = reduceBooking(snapshot, { type: "offer_received", offer: fixture.turns[0].proposal.candidate.offer }, now);
  assert.equal(update.bookingState, "offer_received");
  snapshot = merge(snapshot, update);
  update = reduceBooking(snapshot, { type: "readback_started", ...eventRef(snapshot.activeOffer) }, now);
  assert.equal(update.bookingState, "reading_back");
  snapshot = merge(snapshot, update);
  snapshot = CallSnapshotSchema.parse({ ...snapshot, messages: fixture.messages.slice(0, 3) });
  const receipt = receiptFor(snapshot);
  update = reduceBooking(snapshot, { type: "acceptance_played", receipt }, now);
  assert.equal(update.bookingState, "awaiting_business_confirmation");
  assert.equal(update.outcome.status, "pending");
  snapshot = CallSnapshotSchema.parse({ ...merge(snapshot, update), messages: fixture.messages });
  update = reduceBooking(snapshot, confirmationEvent(), now, update.acceptance);
  assert.equal(update.bookingState, "confirmed");
  assert.deepEqual(update.outcome.offer, fixture.expectedOutcome.offer);
  assert.deepEqual(update.outcome.confirmationMessageIds, fixture.expectedOutcome.confirmationMessageIds);
  assert.equal(update.outcome.confirmedAt, fixture.messages.at(-1).createdAt);
  for (const fact of ["2026-10-20", "18:00", "Europe/Madrid", "Alex Example", "€25.00", "Duration is unknown."]) {
    assert.ok(update.outcome.summaryEn.includes(fact));
  }
});

test("functions do not mutate inputs or expose mutable references, including to a semantic reviewer", () => {
  const snapshot = waiting();
  const receipt = receiptFor(snapshot);
  const original = structuredClone({ snapshot, receipt });
  const output = deriveOutcome(snapshot, {
    ...confirmationEvent(), verifyMeaning: (input) => {
      input.offer.service = "Changed by reviewer";
      input.evidence[0].originalText = "Changed by reviewer";
      return "affirmed";
    },
  }, now, receipt);
  output.offer.service = "Changed by caller";
  assert.deepEqual({ snapshot, receipt }, original);
  const update = reduceBooking(snapshot, { type: "call_finished", reason: "user_stopped" }, now, receipt);
  update.activeOffer.service = "Changed by caller";
  update.acceptance.offer.service = "Changed by caller";
  assert.deepEqual({ snapshot, receipt }, original);
});

test("offer evidence requires distinct finalized business messages in this transcript", () => {
  const snapshot = waiting();
  assert.deepEqual(checkOfferEvidence(snapshot.activeOffer, snapshot.messages), { valid: true });
  for (const evidenceMessageIds of [[id(100)], [snapshot.messages[0].id], [snapshot.messages[1].id, snapshot.messages[1].id]]) {
    assert.equal(checkOfferEvidence({ ...snapshot.activeOffer, evidenceMessageIds }, snapshot.messages).valid, false);
  }
  const messages = structuredClone(snapshot.messages);
  messages[1].final = false;
  assert.equal(checkOfferEvidence(snapshot.activeOffer, messages).valid, false);
  assert.equal(checkOfferEvidence(snapshot.activeOffer, [...snapshot.messages, snapshot.messages[0]]).reason, "duplicate_message_ids");
});

test("confirmation cannot precede played acceptance or use assistant/provisional/future evidence", () => {
  const snapshot = waiting();
  const receipt = receiptFor(snapshot);
  assert.equal(confirmationCheck(snapshot, null).valid, false);
  for (const playback of ["generated", "withheld", "playing", "interrupted"]) {
    const changed = structuredClone(snapshot);
    changed.messages[2].playback = playback;
    assert.equal(confirmationCheck(changed, receipt).valid, false);
  }
  for (const ids of [[snapshot.messages[2].id], [snapshot.messages[1].id], [id(100)], []]) {
    assert.equal(confirmationCheck(snapshot, receipt, { evidenceMessageIds: ids }).valid, false);
  }
  const provisional = structuredClone(snapshot);
  provisional.messages.at(-1).final = false;
  assert.equal(confirmationCheck(provisional, receipt).valid, false);
  assert.equal(confirmationCheck(snapshot, receipt, { now: "2026-10-15T10:01:14Z" }).valid, false);
});

test("confirmation checks bind receipt to the exact attempt, plan, offer, turn and approved speech", () => {
  const snapshot = waiting();
  for (const mutate of [
    (receipt) => { receipt.permit.attemptId = id(99); },
    (receipt) => { receipt.permit.planVersion += 1; },
    (receipt) => { receipt.permit.offer.version += 1; },
    (receipt) => { receipt.permit.turnId = id(99); },
    (receipt) => { receipt.permit.approvedSpanishText = "Unrelated generated text"; },
    (receipt) => { receipt.offer.price.amountMinor += 1; },
    (receipt) => { receipt.readbackMessageId = id(99); },
  ]) {
    const receipt = receiptFor(snapshot);
    mutate(receipt);
    assert.equal(confirmationCheck(snapshot, receipt).valid, false);
  }
});

test("a permitted non-committing readback cannot be supplied as played acceptance", () => {
  const snapshot = { ...waiting(), bookingState: "reading_back" };
  const receipt = receiptFor(snapshot);
  const message = snapshot.messages.find((item) => item.id === receipt.acceptanceMessageId);
  const readback = renderReadback(snapshot.plan, snapshot.activeOffer);
  message.originalText = readback;
  receipt.permit.approvedSpanishText = readback;
  assert.equal(receipt.readbackMessageId, receipt.acceptanceMessageId);
  assert.deepEqual(checkAcceptancePlayback(snapshot, receipt, now), {
    valid: false, reason: "acceptance_text_mismatch",
  });
  assert.throws(() => reduceBooking(snapshot, { type: "acceptance_played", receipt }, now), /complete acceptance/);
  assert.equal(snapshot.bookingState, "reading_back");
});

test("permit expiry is checked at playback start, not retroactively at confirmation", () => {
  const snapshot = waiting();
  const receipt = receiptFor(snapshot);
  assert.ok(Date.parse(receipt.permit.expiresAt) < Date.parse(now));
  assert.deepEqual(confirmationCheck(snapshot, receipt), { valid: true });
  receipt.startedAt = receipt.permit.expiresAt;
  receipt.observedAt = receipt.startedAt;
  assert.equal(confirmationCheck(snapshot, receipt).reason, "invalid_playback_time");
  receipt.startedAt = "2026-10-15T10:01:11Z";
  receipt.observedAt = "2026-10-15T10:01:10Z";
  assert.equal(confirmationCheck(snapshot, receipt).valid, false);
});

test("unknown or forbidden conditions cannot produce confirmation", () => {
  for (const field of ["deposit", "cancellationFee", "paidAddOn"]) {
    for (const condition of ["unknown", "required"]) {
      const snapshot = structuredClone(waiting());
      snapshot.activeOffer.conditions[field] = condition;
      assert.equal(confirmationCheck(snapshot, receiptFor(snapshot)).reason, "unresolved_conditions");
    }
  }
});

test("missing, ambiguous, contradictory, throwing or asynchronous semantic verification fails closed", () => {
  const snapshot = waiting();
  for (const verifyMeaning of [undefined, () => "ambiguous", () => "contradicted", () => { throw new Error("failed"); },
    () => Promise.resolve("affirmed"), async () => { throw new Error("Async verifier failed"); }]) {
    const event = { type: "business_confirmation", evidenceMessageIds: confirmationEvent().evidenceMessageIds,
      ...(verifyMeaning ? { verifyMeaning } : {}) };
    const outcome = deriveOutcome(snapshot, event, now, receiptFor(snapshot));
    assert.equal(outcome.status, "uncertain");
    assert.equal(outcome.reason, "ambiguous_confirmation");
  }
});

test("later business speech cannot be ignored in favor of stale confirmation evidence", () => {
  const snapshot = structuredClone(waiting());
  snapshot.messages.push({ ...snapshot.messages.at(-1), id: id(100), turnId: id(101),
    originalText: "Perdón, esa cita ya no está disponible.", createdAt: "2026-10-15T10:01:16Z" });
  assert.equal(confirmationCheck(snapshot, receiptFor(snapshot)).reason, "stale_confirmation");
  let reviewed = false;
  const check = confirmationCheck(snapshot, receiptFor(snapshot), {
    evidenceMessageIds: [...confirmationEvent().evidenceMessageIds, id(100)],
    verifyMeaning: ({ businessMessagesAfterAcceptance }) => {
      reviewed = true;
      assert.equal(businessMessagesAfterAcceptance.at(-1).originalText, "Perdón, esa cita ya no está disponible.");
      return "contradicted";
    },
  });
  assert.equal(reviewed, true);
  assert.equal(check.valid, false);
});

test("approval events match the exact offer and never bypass readback or playback", () => {
  let snapshot = buildSnapshot();
  const approval = approvalFor(snapshot);
  let update = reduceBooking(snapshot, { type: "approval_requested", approval }, now);
  assert.equal(update.bookingState, "awaiting_approval");
  snapshot = merge(snapshot, update);
  assert.throws(() => reduceBooking(snapshot, { type: "readback_started", ...eventRef(snapshot.activeOffer) }, now), BookingTransitionError);
  update = reduceBooking(snapshot, { type: "approval_resolved", approvalId: approval.id, status: "approved" }, now);
  assert.equal(update.bookingState, "offer_received");
  assert.equal(update.pendingApproval, null);
  assert.equal(update.acceptance, null);
  assert.equal(update.outcome.status, "pending");
  const wrongOffer = approvalFor(buildSnapshot());
  wrongOffer.offer = { ...wrongOffer.offer, price: { amountMinor: 9999, currency: "EUR" } };
  assert.throws(() => reduceBooking(buildSnapshot(), { type: "approval_requested", approval: wrongOffer }, now), /exact offer/);
});

test("rejected and expired approvals end without booking; expiry boundary is exclusive", () => {
  const base = buildSnapshot();
  const approval = approvalFor(base);
  const snapshot = merge(base, reduceBooking(base, { type: "approval_requested", approval }, now));
  const rejected = reduceBooking(snapshot, { type: "approval_resolved", approvalId: approval.id, status: "rejected" }, now);
  assert.equal(rejected.outcome.status, "not_booked");
  assert.equal(rejected.pendingApproval, null);
  assert.throws(() => reduceBooking(snapshot, { type: "approval_resolved", approvalId: approval.id, status: "approved" }, approval.expiresAt), /expired/);
  assert.throws(() => reduceBooking(snapshot, { type: "approval_resolved", approvalId: approval.id, status: "expired" }, now), /not expired/);
  const expired = reduceBooking(snapshot, { type: "approval_resolved", approvalId: approval.id, status: "expired" }, approval.expiresAt);
  assert.equal(expired.outcome.status, "not_booked");
});

test("changed offer clears pending approval, stale approval resolutions and versions are rejected", () => {
  const base = buildSnapshot();
  const approval = approvalFor(base);
  const snapshot = merge(base, reduceBooking(base, { type: "approval_requested", approval }, now));
  const offer = { ...snapshot.activeOffer, version: 2, price: { amountMinor: 3500, currency: "EUR" } };
  const update = reduceBooking(snapshot, { type: "offer_received", offer }, now);
  assert.equal(update.bookingState, "offer_received");
  assert.equal(update.pendingApproval, null);
  assert.equal(update.acceptance, null);
  const changed = merge(snapshot, update);
  assert.throws(() => reduceBooking(changed, { type: "approval_resolved", approvalId: approval.id, status: "approved" }, now), /stale/);
  assert.throws(() => reduceBooking(changed, { type: "offer_received", offer: base.activeOffer }, now), /stale/);
  assert.throws(() => reduceBooking(base, { type: "offer_received", offer: { ...base.activeOffer, price: { amountMinor: 1, currency: "EUR" } } }, now), /new version/);
});

test("approval invalidation clears the pending request without granting booking authority", () => {
  const base = buildSnapshot();
  const approval = approvalFor(base);
  const snapshot = merge(base, reduceBooking(base, { type: "approval_requested", approval }, now));
  const update = reduceBooking(snapshot, { type: "approval_resolved", approvalId: approval.id, status: "invalidated" }, now);
  assert.equal(update.bookingState, "offer_received");
  assert.equal(update.pendingApproval, null);
  assert.equal(update.acceptance, null);
  assert.equal(update.outcome.status, "pending");
});

test("changed offers during readback or after acceptance produce uncertainty, not another booking", () => {
  for (const bookingState of ["reading_back", "awaiting_business_confirmation"]) {
    const snapshot = { ...waiting(), bookingState };
    const update = reduceBooking(snapshot, { type: "offer_received", offer: { ...snapshot.activeOffer, version: 2 } }, now,
      bookingState === "reading_back" ? null : receiptFor(snapshot));
    assert.equal(update.outcome.status, "uncertain");
    assert.equal(update.activeOffer.version, 1);
  }
});

test("duplicate offer and played-acceptance events do not restart booking progress", () => {
  const snapshot = waiting();
  const receipt = receiptFor(snapshot);
  const duplicate = reduceBooking(snapshot, { type: "offer_received", offer: snapshot.activeOffer }, now, receipt);
  assert.equal(duplicate.bookingState, "awaiting_business_confirmation");
  const played = reduceBooking(snapshot, { type: "acceptance_played", receipt }, now, receipt);
  assert.equal(played.bookingState, "awaiting_business_confirmation");
  assert.deepEqual(played.acceptance, receipt);
});

test("invalid transitions and incomplete playback cannot produce booking progress", () => {
  const snapshot = buildSnapshot();
  assert.throws(() => reduceBooking(snapshot, confirmationEvent(), now), /follow acceptance/);
  assert.throws(() => reduceBooking(snapshot, { type: "acceptance_played", receipt: receiptFor() }, now), /follow readback/);
  assert.throws(() => reduceBooking(snapshot, { type: "readback_started", offerId: id(999), offerVersion: 1 }, now), /stale/);
  const reading = { ...waiting(), bookingState: "reading_back" };
  reading.messages[2].playback = "interrupted";
  assert.throws(() => reduceBooking(reading, { type: "acceptance_played", receipt: receiptFor() }, now), /complete acceptance/);
  assert.throws(() => reduceBooking({ ...snapshot, callState: "ending" }, { type: "readback_started", ...eventRef(snapshot.activeOffer) }, now), /connected/);
});

test("call endings before acceptance derive not-booked outcomes from actual reasons", () => {
  for (const reason of ["no_availability", "business_declined", "busy", "no_answer", "user_stopped", "policy_declined", "technical_failure"]) {
    const update = reduceBooking(buildSnapshot(), { type: "call_finished", reason }, now);
    assert.equal(update.bookingState, "not_booked");
    assert.equal(update.outcome.reason, reason);
    assert.ok(update.outcome.summaryEn.length > 0);
  }
});

test("existing confirmation can be recorded while hangup/reconciliation is in progress", () => {
  for (const callState of ["ending", "reconciliation_required"]) {
    const snapshot = { ...waiting(), callState };
    const receipt = receiptFor(snapshot);
    assert.equal(reduceBooking(snapshot, confirmationEvent(), now, receipt).outcome.status, "confirmed");
    assert.equal(reduceBooking({ ...snapshot, bookingState: "reading_back" },
      { type: "acceptance_played", receipt }, now).bookingState, "awaiting_business_confirmation");
    assert.throws(() => reduceBooking({ ...snapshot, bookingState: "offer_received" },
      { type: "readback_started", ...eventRef(snapshot.activeOffer) }, now), /connected/);
  }
});

test("Stop, disconnect, or failure near acceptance remains uncertain, including without a receipt", () => {
  for (const bookingState of ["reading_back", "awaiting_business_confirmation"]) {
    for (const reason of ["user_stopped", "technical_failure", "no_availability"]) {
      const snapshot = { ...waiting(), bookingState };
      const update = reduceBooking(snapshot, { type: "call_finished", reason }, now);
      assert.equal(update.outcome.status, "uncertain");
      assert.equal(update.outcome.reason, "disconnected_near_confirmation");
    }
  }
  for (const reason of ["creation_unknown", "provider_state_unknown", "ambiguous_confirmation", "disconnected_near_confirmation"]) {
    assert.equal(deriveOutcome(buildSnapshot(), { type: "uncertainty", reason }, now).reason, reason);
  }
});

test("terminal booking outcomes are stable across Stop, duplicate confirmation, and late offers", () => {
  const snapshot = waiting();
  const receipt = receiptFor(snapshot);
  const confirmed = merge(snapshot, reduceBooking(snapshot, confirmationEvent(), now, receipt));
  for (const terminal of [confirmed, success().outcomeSnapshot,
    merge(buildSnapshot(), reduceBooking(buildSnapshot(), { type: "call_finished", reason: "user_stopped" }, now)),
    merge(snapshot, reduceBooking(snapshot, { type: "uncertainty", reason: "ambiguous_confirmation" }, now))]) {
    const original = structuredClone(terminal.outcome);
    for (const event of [{ type: "call_finished", reason: "user_stopped" }, confirmationEvent(),
      { type: "offer_received", offer: { ...snapshot.activeOffer, version: 2 } }]) {
      assert.deepEqual(reduceBooking(terminal, event, now, receipt).outcome, original);
      if (event.type !== "offer_received") assert.deepEqual(deriveOutcome(terminal, event, now, receipt), original);
    }
  }
});

test("confirmed outcome preserves permitted unknown price, unknown duration, and integer cent precision", () => {
  for (const [price, expected] of [[null, "explicitly authorized unknown price"],
    [{ amountMinor: Number.MAX_SAFE_INTEGER, currency: "EUR" }, "€90071992547409.91"]]) {
    const snapshot = structuredClone(waiting());
    snapshot.activeOffer.price = price;
    if (price === null) snapshot.plan.request.pricePolicy.allowUnknownPrice = true;
    snapshot.messages[2].originalText = renderAcceptance(snapshot.plan, snapshot.activeOffer);
    // A trusted semantic review is required for each changed test offer; no lexical inference here.
    const outcome = deriveOutcome(snapshot, { ...confirmationEvent(), verifyMeaning: () => "affirmed" }, now, receiptFor(snapshot));
    assert.equal(outcome.status, "confirmed");
    assert.ok(outcome.summaryEn.includes(expected));
    assert.equal(outcome.offer.durationMinutes, null);
    assert.deepEqual(outcome.offer.price, price);
  }
});

test("long business names fit confirmed summaries without changing the approved plan or appointment details", () => {
  const base = waiting();
  const baseOutcome = deriveOutcome(base, confirmationEvent(), now, receiptFor(base));
  const prefix = "Haircut confirmed with ";
  const suffix = baseOutcome.summaryEn.slice(prefix.length + base.plan.request.business.name.length);
  const nameBudget = 4000 - prefix.length - suffix.length;
  for (const nameLength of [nameBudget, nameBudget + 1, 4000]) {
    const snapshot = structuredClone(base);
    const businessName = "B".repeat(nameLength);
    snapshot.plan.request.business.name = businessName;
    const original = structuredClone(snapshot);
    const receipt = receiptFor(snapshot);
    const expectedName = nameLength <= nameBudget ? businessName : `${businessName.slice(0, nameBudget - 1)}…`;
    const outcome = deriveOutcome(snapshot, confirmationEvent(), now, receipt);
    const update = reduceBooking(snapshot, confirmationEvent(), now, receipt);
    assert.equal(outcome.status, "confirmed");
    assert.equal(outcome.summaryEn, `${prefix}${expectedName}${suffix}`);
    assert.equal(outcome.summaryEn.length, 4000);
    assert.deepEqual(outcome.offer, snapshot.activeOffer);
    assert.equal(update.bookingState, "confirmed");
    assert.deepEqual(update.outcome, outcome);
    assert.equal(merge(snapshot, update).plan.request.business.name, businessName);
    assert.deepEqual(snapshot, original);
  }
});

test("retention does not require reconstructing evidence for an already confirmed terminal booking", () => {
  const snapshot = { ...success().outcomeSnapshot, conversationData: "deleted", messages: [] };
  assert.deepEqual(deriveOutcome(snapshot, { type: "call_finished", reason: "user_stopped" }, now), snapshot.outcome);
  assert.deepEqual(reduceBooking(snapshot, { type: "uncertainty", reason: "provider_state_unknown" }, now).outcome, snapshot.outcome);
});

test("English results translate supported Spanish service names and preserve the original offer", () => {
  for (const service of ["corte de pelo", "Corte de cabello"]) {
    const snapshot = structuredClone(waiting());
    snapshot.activeOffer.service = service;
    const outcome = deriveOutcome(snapshot, { ...confirmationEvent(), verifyMeaning: () => "affirmed" }, now, receiptFor(snapshot));
    assert.equal(outcome.status, "confirmed");
    assert.match(outcome.summaryEn, /^Haircut confirmed with/);
    assert.equal(outcome.offer.service, service);
  }
});

test("malformed inputs and future receipts fail safely", () => {
  const snapshot = waiting();
  assert.throws(() => reduceBooking(snapshot, { type: "call_finished", reason: "user_stopped" }, "not a date"));
  assert.equal(checkAcceptancePlayback(snapshot, {}, now).valid, false);
  assert.equal(checkAcceptancePlayback(snapshot, { ...receiptFor(snapshot), observedAt: "2026-10-15T10:01:21Z" }, now).valid, false);
  assert.equal(confirmationCheck(snapshot, receiptFor(snapshot), {
    evidenceMessageIds: [...confirmationEvent().evidenceMessageIds, ...confirmationEvent().evidenceMessageIds],
  }).valid, false);
});
