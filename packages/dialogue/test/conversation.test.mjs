import assert from "node:assert/strict";
import test from "node:test";
import { CallSnapshotSchema, ConversationDecisionSchema, api } from "@callmate/contracts";
import {
  createBookingPolicy, createDialogue, createConversationSession, reduceConversation, reduceBooking,
  emptyConversation, repeatPhrase, waitingPhrase, processingPhrases,
  prepareAddOnAcceptance, reconcileAddOn,
} from "../dist/index.js";
import { buildSnapshot, buildMessage, buildDialogueInput } from "./support/builders.mjs";
import { FakeModel } from "./support/fake-model.mjs";

const id = n => `70000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = seconds => new Date(Date.parse("2026-10-15T10:01:00Z") + seconds * 1000).toISOString();
const policy = createBookingPolicy();
const noConditions = { deposit: "none", cancellationFee: "none", paidAddOn: "none" };
const supplement = { serviceEs: "el tratamiento de hidratación", serviceEn: "the hydrating treatment",
  additionalPrice: { amountMinor: 1500, currency: "EUR" }, conditions: noConditions };
function base() {
  const s = buildSnapshot();
  s.conversation = emptyConversation();
  s.plan.request.bookingName = "Maryna Bevza";
  s.plan.request.tone = "formal";
  s.plan.request.shareableContact = { phone: null, email: null };
  s.plan.request.pricePolicy.maximum = { amountMinor: 3000, currency: "EUR" };
  s.plan.request.availability = [{
    start: { localDate: "2026-10-27", localTime: "17:00", timeZone: "Europe/Madrid", instant: "2026-10-27T16:00:00Z" },
    end: { localDate: "2026-10-27", localTime: "21:00", timeZone: "Europe/Madrid", instant: "2026-10-27T20:00:00Z" },
  }];
  Object.assign(s.activeOffer, { bookingName: "Maryna Bevza", staffName: "Laura",
    price: { amountMinor: 2200, currency: "EUR" }, conditions: noConditions,
    appointment: { localDate: "2026-10-27", localTime: "17:30", timeZone: "Europe/Madrid", instant: "2026-10-27T16:30:00Z" } });
  return CallSnapshotSchema.parse(s);
}
const candidate = (snapshot, action = "request_contact") => action === "request_add_on"
  ? { action, supplement: structuredClone(supplement), evidenceMessageIds: [snapshot.messages.at(-1).id] }
  : { action, field: "phone", evidenceMessageIds: [snapshot.messages.at(-1).id] };
function request(snapshot = base(), action = "request_contact", seconds = 0, requestId = 50) {
  const update = reduceConversation(snapshot, { type: "decision_requested", id: id(requestId),
    candidate: candidate(snapshot, action), expiresAt: at(seconds + 30) }, at(seconds));
  return CallSnapshotSchema.parse({ ...snapshot, conversation: update.conversation });
}
const resolution = (snapshot, choice, answer = null) => ({ decisionId: snapshot.conversation.pending.id,
  plan: snapshot.conversation.pending.plan, offer: snapshot.conversation.pending.offer, choice, answer });
const decide = (snapshot, choice, seconds = 1, extra = {}) => reduceConversation(snapshot,
  { type: "decision_resolved", decision: resolution(snapshot, choice), ...extra }, at(seconds));

test("Maryna: one connected call books the haircut, declines the extra, handles noise, and times out contact consent", async () => {
  let s = base(), nextId = 100;
  s.messages = [];
  const session = createConversationSession(s.id, { random: () => 0 });
  const business = (es, seconds) => {
    const message = buildMessage({ id: id(nextId++), turnId: id(nextId++), originalText: es,
      translationEn: null, createdAt: at(seconds) });
    s = { ...s, messages: [...s.messages, message], updatedAt: at(seconds) };
    return message;
  };
  const say = (es, en, seconds) => {
    const message = buildMessage({ id: id(nextId++), turnId: id(nextId++), speaker: "assistant", playback: "played",
      originalText: es, translationEn: en, createdAt: at(seconds) });
    s = { ...s, messages: [...s.messages, message], updatedAt: at(seconds) };
    return message;
  };
  const propose = async (action, en) => {
    const input = buildDialogueInput(s, { callState: s.callState, conversation: s.conversation });
    const raw = { turnId: input.turnId, turnVersion: input.turnVersion, candidate: action,
      translations: [{ messageId: input.triggerMessageId, translationEn: en }] };
    return (await createDialogue(new FakeModel([{ kind: "response", value: raw }])).propose(input, new AbortController().signal)).candidate;
  };
  const apply = (event, seconds) => {
    const update = session.apply(s, event, at(seconds));
    s = { ...s, conversation: update.conversation };
    if (update.reply) say(update.reply.es, update.reply.en, seconds);
    return update;
  };
  business("Peluquería Estilo, ¿dígame?", 0);
  s.bookingState = "pending";
  const offer = s.activeOffer;
  s.activeOffer = null;
  const opening = policy.evaluate({ snapshot: s, candidate: { action: "ask_availability" }, now: at(1), grant: null });
  assert.equal(opening.decision, "allow");
  assert.match(opening.approvedSpanishText, /disponibilidad para un corte de pelo/);
  assert.doesNotMatch(opening.approvedSpanishText, /Hola|asistente|Maryna Bevza/);
  say(opening.approvedSpanishText, "Is there availability for a haircut within the reviewed windows?", 1);
  const offered = business("El martes 27 de octubre a las cinco y media con Laura, para un corte a nombre de Maryna Bevza.", 10);
  // Additional clarification is required by the existing payment-safety policy before acceptance.
  const priced = business("Veintidós euros, sin depósito, gastos de cancelación ni extras obligatorios.", 20);
  offer.evidenceMessageIds = [offered.id, priced.id];
  const { acceptance: ignored, ...received } = reduceBooking(s, { type: "offer_received", offer }, at(21));
  s = { ...s, ...received };
  const ref = { offerId: offer.id, offerVersion: offer.version };
  const readback = policy.evaluate({ snapshot: s, candidate: { action: "read_back", ...ref }, now: at(22), grant: null });
  assert.equal(readback.decision, "allow");
  assert.match(readback.approvedSpanishText, /27 de octubre de 2026.*17:30.*Laura.*22 euros/);
  const { acceptance: unused, ...reading } = reduceBooking(s, { type: "readback_started", ...ref }, at(22));
  s = { ...s, ...reading };
  const readbackMessage = say(readback.approvedSpanishText, "Read back the exact appointment; not accepted yet.", 22);
  const acceptance = policy.evaluate({ snapshot: s, candidate: { action: "accept_offer", ...ref }, now: at(25), grant: null });
  assert.equal(acceptance.decision, "allow");
  const accepted = say(acceptance.approvedSpanishText, "Accept the exact haircut and ask the salon to confirm.", 25);
  const receipt = { permit: { id: id(200), attemptId: s.id, planId: s.plan.id, planVersion: s.plan.version,
    turnId: accepted.turnId, turnVersion: 1, outputId: id(201), offer: { id: offer.id, version: offer.version },
    approvedSpanishText: accepted.originalText, expiresAt: at(30) }, offer,
    readbackMessageId: readbackMessage.id, acceptanceMessageId: accepted.id, startedAt: at(25), observedAt: at(26) };
  const { acceptance: stored, ...awaiting } = reduceBooking(s, { type: "acceptance_played", receipt }, at(26));
  s = { ...s, ...awaiting };
  const confirmed = business("Hecho. Con el corte, el tratamiento de hidratación por solo quince euros más. ¿Se lo añado?", 30);
  // Fixture-only semantic oracle, not a production Spanish verifier.
  const { acceptance: storedAgain, ...booking } = reduceBooking(s, { type: "business_confirmation",
    evidenceMessageIds: [confirmed.id], verifyMeaning: ({ offer: actual, evidence }) =>
      actual.price.amountMinor === 2200 && evidence[0].originalText.startsWith("Hecho.") ? "affirmed" : "ambiguous" }, at(31), stored);
  s = { ...s, ...booking };
  assert.equal(s.outcome.status, "confirmed");
  const originalOutcome = structuredClone(s.outcome);
  const extra = await propose(candidate(s, "request_add_on"), "Done. Add a hydrating treatment for fifteen euros more?");
  assert.deepEqual(policy.evaluate({ snapshot: s, candidate: extra, grant: null, now: at(32) }), { decision: "ask_user", reason: "add_on" });
  apply({ type: "decision_requested", id: id(300), candidate: extra, expiresAt: at(62) }, 32);
  assert.equal(s.conversation.pending.totalPrice.amountMinor, 3700);
  assert.equal(s.plan.request.pricePolicy.maximum.amountMinor, 3000);
  assert.equal(s.conversation.pending.kind, "add_on");
  apply({ type: "decision_resolved", decision: resolution(s, "reject") }, 40);
  assert.equal(s.conversation.decisions[0].status, "rejected");
  assert.match(s.messages.at(-1).originalText, /solo el corte/);
  assert.deepEqual(s.outcome, originalOutcome);
  business("Y acuérdate de venir con el pelo… [ruido, inaudible]", 50);
  const repeat = await propose({ action: "repeat", reason: "not_heard" }, "And remember to come with your hair… [inaudible]");
  assert.equal(policy.evaluate({ snapshot: s, candidate: repeat, grant: null, now: at(51) }).decision, "allow");
  const repeated = session.reply(s, repeatPhrase("formal", repeat.reason));
  say(repeated.es, repeated.en, 51);
  const noteMessage = business("Que venga con el pelo limpio y seco, que aquí no lo lavamos.", 55);
  const note = await propose({ action: "record_note", code: "clean_dry_hair", evidenceMessageIds: [noteMessage.id] },
    "Come with clean, dry hair; we don't wash it here.");
  apply({ type: "note_recorded", candidate: note }, 56);
  business("¿Y me da un teléfono de contacto por si hay algún cambio?", 65);
  const contact = await propose(candidate(s), "Can you give me a contact number in case anything changes?");
  apply({ type: "decision_requested", id: id(301), candidate: contact, expiresAt: at(96) }, 66);
  assert.match(s.messages.at(-1).originalText, /lo consulto/); // Initial wait from the add-on is not repeated.
  for (const seconds of [78, 90, 96]) {
    const update = session.waiting(s, at(seconds));
    s = { ...s, conversation: update.conversation };
    assert.ok(update.reply);
    say(update.reply.es, update.reply.en, seconds);
  }
  assert.equal(s.conversation.pending, null);
  assert.equal(s.conversation.decisions.at(-1).status, "expired");
  assert.equal(s.conversation.tasks[0].kind, "provide_phone_later");
  assert.match(s.messages.at(-1).originalText, /Maryna Bevza.*llamemos más tarde/);
  business("Sin problema. Queda reservada a nombre de Maryna. ¡Hasta el martes!", 100);
  const closing = await propose({ action: "end_call", reason: "unresolved" }, "No problem. It's booked under Maryna. See you Tuesday!");
  assert.equal(closing.action, "end_call");
  assert.equal(policy.evaluate({ snapshot: s, candidate: closing, now: at(101), grant: null }).approvedSpanishText,
    "Perfecto, muchas gracias. Hasta luego.");
  assert.deepEqual(s.outcome, originalOutcome);
  assert.match(s.outcome.summaryEn, /2026-10-27.*17:30.*Laura.*€22.00/);
  assert.equal(s.conversation.notes[0].code, "clean_dry_hair");
  assert.equal(session.waiting(s, at(120)).reply, null);
  const spoken = s.messages.filter(m => m.speaker === "assistant").map(m => m.originalText);
  assert.equal(new Set(spoken).size, spoken.length);
  CallSnapshotSchema.parse({ ...s, callState: "ended" });
});

test("contact consent is exact, expires at the deadline, and cannot leak a phone via rejection, timeout, or custom text", () => {
  const s = request();
  assert.throws(() => decide(s, "approve"));
  const approved = decide(s, "approve", 1, { authorizedPhone: "+34910000000" });
  assert.match(approved.reply.es, /\+ 3 4 9 1/);
  assert.doesNotMatch(JSON.stringify(approved.conversation), /34910000000/);
  for (const patch of [{ decisionId: id(99) }, { plan: { ...s.conversation.pending.plan, planVersion: 99 } },
    { offer: { ...s.conversation.pending.offer, offerVersion: 99 } }]) {
    assert.throws(() => reduceConversation(s, { type: "decision_resolved", decision: { ...resolution(s, "reject"), ...patch } }, at(1)));
  }
  assert.throws(() => decide(s, "reject", 30));
  assert.throws(() => reduceConversation(s, { type: "decision_expired", decisionId: s.conversation.pending.id }, at(29)));
  const rejected = decide(s, "reject", 1, { authorizedPhone: "+34910000000" });
  assert.doesNotMatch(JSON.stringify(rejected), /34910000000/);
  const custom = reduceConversation(s, { type: "decision_resolved", decision: resolution(s, "custom", "Share a different number") }, at(1));
  assert.equal(custom.conversation.decisions[0].status, "custom");
  assert.doesNotMatch(custom.reply.es, /Share a different number/);
  assert.equal(ConversationDecisionSchema.safeParse({ ...resolution(s, "approve"), answer: "extra instructions" }).success, false);
  assert.equal(api.decideConversation.request.safeParse(resolution(s, "reject")).success, true);
});

test("booking termination and changed offers atomically invalidate pending conversation consent", () => {
  const s = request();
  const original = structuredClone(s);
  const changedOffers = [
    { ...s.activeOffer, version: s.activeOffer.version + 1 },
    { ...s.activeOffer, id: id(999) },
  ];
  for (const event of [
    { type: "call_finished", reason: "user_stopped" },
    { type: "uncertainty", reason: "ambiguous_confirmation" },
    ...changedOffers.map(offer => ({ type: "offer_received", offer })),
  ]) {
    const { acceptance, ...fields } = reduceBooking(s, event, at(1));
    const updated = CallSnapshotSchema.parse({ ...s, ...fields });
    assert.equal(updated.conversation.pending, null);
    assert.deepEqual(updated.conversation.decisions, [{ request: s.conversation.pending,
      status: "invalidated", answer: null, resolvedAt: at(1) }]);
    if (event.type === "offer_received") {
      assert.equal(updated.bookingState, "offer_received");
      assert.deepEqual(updated.activeOffer, event.offer);
    } else assert.equal(updated.outcome.status, event.type === "call_finished" ? "not_booked" : "uncertain");
    assert.throws(() => decide(updated, "approve", 2, { authorizedPhone: "+34910000000" }));
    assert.deepEqual(s, original);
  }
});

test("receiving the same offer preserves pending conversation consent without exposing mutable state", () => {
  const s = request();
  const original = structuredClone(s);
  const update = reduceBooking(s, { type: "offer_received", offer: s.activeOffer }, at(1));
  assert.deepEqual(update.conversation, s.conversation);
  update.conversation.pending.offer.offerVersion += 1;
  assert.deepEqual(s, original);
});

test("separate noisy turns each receive an authorized repeat request", () => {
  const s = base();
  const pacing = createConversationSession(s.id, { random: () => 0 });
  const phrase = repeatPhrase("formal", "not_heard");
  for (let index = 0; index < 2; index++) {
    s.messages.push(buildMessage({ id: id(600 + index), turnId: id(610 + index),
      originalText: "[ruido, inaudible]", createdAt: at(index * 2) }));
    const allowed = policy.evaluate({ snapshot: s, candidate: { action: "repeat", reason: "not_heard" },
      now: at(index * 2), grant: null });
    assert.equal(allowed.decision, "allow");
    const reply = pacing.reply(s, phrase);
    assert.deepEqual(reply, phrase);
    s.messages.push(buildMessage({ id: id(620 + index), turnId: id(630 + index), speaker: "assistant",
      playback: "played", originalText: reply.es, createdAt: at(index * 2 + 1) }));
  }
});

for (const expire of [false, true]) {
  test(`separate contact requests each speak their ${expire ? "timeout" : "rejection"} reply`, () => {
    let s = base();
    const session = createConversationSession(s.id, { random: () => 0 });
    let firstReply;
    for (let index = 0; index < 2; index++) {
      const start = index * 40;
      s.messages.push(buildMessage({ id: id(700 + index), turnId: id(710 + index),
        originalText: "¿Me da un teléfono de contacto?", createdAt: at(start) }));
      s = request(s, "request_contact", start, 720 + index);
      const update = expire ? session.waiting(s, at(start + 30)) : session.apply(s,
        { type: "decision_resolved", decision: resolution(s, "reject") }, at(start + 1));
      assert.ok(update.reply);
      if (index === 0) firstReply = update.reply;
      else assert.deepEqual(update.reply, firstReply);
      assert.equal(update.conversation.pending, null);
      assert.equal(update.conversation.decisions.length, index + 1);
      assert.equal(update.conversation.decisions.at(-1).status, expire ? "expired" : "rejected");
      s = { ...s, conversation: update.conversation };
      s.messages.push(buildMessage({ id: id(730 + index), turnId: id(740 + index), speaker: "assistant",
        playback: "played", originalText: update.reply.es, createdAt: at(start + (expire ? 30 : 1)) }));
    }
  });
}

test("extra-service consent preserves the base offer and cannot override deposit or cancellation restrictions", () => {
  const s = request(confirmedBase(), "request_add_on");
  const original = structuredClone(s);
  const approved = decide(s, "approve");
  assert.equal(approved.reply.id, "review_add_on");
  assert.doesNotMatch(approved.reply.es, /Sí, añada|Sí, añade|confirmar el cambio/);
  assert.equal(approved.conversation.decisions[0].status, "approved");
  assert.deepEqual(s, original);
  assert.equal(s.activeOffer.price.amountMinor, 2200);
  for (const value of ["required", "unknown"]) {
    const action = candidate(confirmedBase(), "request_add_on");
    action.supplement.conditions.deposit = value;
    const result = policy.evaluate({ snapshot: confirmedBase(), candidate: action, grant: null, now: at(0) });
    assert.equal(result.decision, value === "required" ? "deny" : "clarify");
    const unpriced = confirmedBase();
    unpriced.activeOffer.price = unpriced.outcome.offer.price = null;
    assert.throws(() => request(unpriced, "request_add_on"));
    assert.throws(() => reduceConversation(confirmedBase(), { type: "decision_requested", id: id(51), candidate: action, expiresAt: at(30) }, at(0)));
  }
  const expired = reduceConversation(s, { type: "decision_expired", decisionId: s.conversation.pending.id }, at(30));
  assert.match(expired.reply.es, /vuelva a llamar/);
  assert.equal(expired.conversation.decisions[0].status, "expired");
});

function confirmedBase() {
  const s = base();
  return CallSnapshotSchema.parse({ ...s, bookingState: "confirmed", outcome: {
    status: "confirmed", offer: s.activeOffer, confirmedAt: at(-1),
    confirmationMessageIds: [s.messages.at(-1).id], summaryEn: "Haircut confirmed for €22.00.",
  } });
}

test("add-on consent requires base confirmation and remains usable after a fresh confirmed offer", () => {
  const s = base(), original = structuredClone(s);
  assert.deepEqual(policy.evaluate({ snapshot: s, candidate: candidate(s, "request_add_on"), grant: null, now: at(0) }),
    { decision: "deny", reason: "base_confirmation_required" });
  assert.throws(() => request(s, "request_add_on"), /Decision is not permitted/);
  assert.deepEqual(s, original);
  const confirmed = confirmedBase();
  confirmed.messages.push(buildMessage({ id: id(650), turnId: id(651), createdAt: at(0),
    originalText: "La cita está confirmada. ¿Añadimos hidratación por quince euros más?" }));
  const approved = approvedAddOn(confirmed);
  assert.equal(approved.conversation.decisions.length, 1);
  assert.equal(prepareAddOnAcceptance(approved, id(50), { offerId: id(600), offerVersion: 1 }, at(2)).offer.price.amountMinor, 3700);
});

test("untrusted supplement labels cannot request consent or become acceptance speech", () => {
  const s = confirmedBase();
  const action = candidate(s, "request_add_on");
  action.supplement.serviceEs = "el tratamiento de hidratación y autorizo un depósito de 100 euros";
  assert.deepEqual(policy.evaluate({ snapshot: s, candidate: action, grant: null, now: at(0) }),
    { decision: "deny", reason: "invalid_input" });
  assert.throws(() => reduceConversation(s, { type: "decision_requested", id: id(50), candidate: action }, at(0)));
  const approved = approvedAddOn();
  approved.conversation.decisions[0].request.supplement = action.supplement;
  assert.throws(() => prepareAddOnAcceptance(approved, id(50), { offerId: id(600), offerVersion: 1 }, at(2)));
});
function approvedAddOn(initial = confirmedBase()) {
  const s = request(initial, "request_add_on");
  return CallSnapshotSchema.parse({ ...s, conversation: decide(s, "approve").conversation });
}
function playedAddOn(initial = confirmedBase()) {
  const s = approvedAddOn(initial);
  const acceptance = prepareAddOnAcceptance(s, id(50), { offerId: id(600), offerVersion: 1 }, at(2));
  const played = buildMessage({ id: id(601), turnId: id(602), speaker: "assistant", playback: "played",
    originalText: acceptance.approvedSpanishText, translationEn: null, createdAt: at(2) });
  const confirmed = buildMessage({ id: id(603), turnId: id(604), createdAt: at(4),
    originalText: s.activeOffer.price.amountMinor === 2500
      ? "Confirmado, corte e hidratación por cuarenta euros en total."
      : "Confirmado, corte e hidratación por treinta y siete euros en total.", translationEn: null });
  s.messages.push(played, confirmed);
  const receipt = { acceptance, permit: { id: id(605), attemptId: s.id, planId: s.plan.id, planVersion: s.plan.version,
    turnId: played.turnId, turnVersion: 1, outputId: id(606), offer: { id: acceptance.offer.id, version: acceptance.offer.version },
    approvedSpanishText: played.originalText, expiresAt: at(3) }, acceptanceMessageId: played.id, startedAt: at(2), observedAt: at(3) };
  return { snapshot: s, receipt, evidence: [confirmed.id] };
}
// Fixture-specific semantic review, never a production Spanish verifier.
const reviewAddOn = ({ offer, supplement: extra, evidence }) => offer.price.amountMinor === 3700
  && extra.additionalPrice.amountMinor === 1500
  && evidence.at(-1).originalText === "Confirmado, corte e hidratación por treinta y siete euros en total." ? "affirmed" : "ambiguous";

test("approved add-on reconciles actual playback and Spanish confirmation into the exact offer and English result", () => {
  const approved = approvedAddOn(), original = structuredClone(approved);
  assert.equal(approved.activeOffer.price.amountMinor, 2200);
  assert.equal(approved.outcome.offer.price.amountMinor, 2200);
  const { snapshot, receipt, evidence } = playedAddOn();
  assert.match(receipt.acceptance.approvedSpanishText, /hidratación.*22 euros.*15.00 euros.*37.00 euros/);
  assert.match(receipt.acceptance.approvedSpanishText, /Maryna Bevza.*Laura/);
  const saved = structuredClone({ snapshot, receipt });
  // Expiry after authorized playback began must not retroactively undo the amendment.
  const update = reconcileAddOn(snapshot, receipt, evidence, at(40), reviewAddOn);
  assert.equal(update.outcome.status, "confirmed");
  assert.equal(update.activeOffer.price.amountMinor, 3700);
  assert.deepEqual(update.activeOffer, update.outcome.offer);
  assert.equal(update.activeOffer.durationMinutes, null);
  assert.match(update.outcome.summaryEn, /€37.00.*Duration is unknown.*hydrating treatment/);
  assert.deepEqual(update.outcome.confirmationMessageIds, evidence);
  CallSnapshotSchema.parse({ ...snapshot, ...update });
  assert.deepEqual({ snapshot, receipt }, saved);
  assert.deepEqual(approved, original);
  assert.throws(() => reconcileAddOn({ ...snapshot, ...update }, receipt, evidence, at(40), reviewAddOn), /stale/);
});

for (const affirmed of [true, false]) {
  test(`add-on reconciliation atomically invalidates later contact consent when ${affirmed ? "confirmed" : "uncertain"}`, () => {
    const { snapshot, receipt, evidence } = playedAddOn();
    snapshot.messages.at(-1).originalText += " ¿Me da un teléfono de contacto?";
    const pending = request(snapshot, "request_contact", 5, 660);
    const saved = structuredClone(pending);
    const verifier = ({ offer, evidence: source }) => offer.price.amountMinor === 3700
      && source.at(-1).originalText === "Confirmado, corte e hidratación por treinta y siete euros en total. ¿Me da un teléfono de contacto?"
      ? "affirmed" : "ambiguous";
    const update = reconcileAddOn(pending, receipt, affirmed ? evidence : [], at(6), verifier);
    assert.equal(update.outcome.status, affirmed ? "confirmed" : "uncertain");
    assert.equal(update.activeOffer.price.amountMinor, affirmed ? 3700 : 2200);
    assert.equal(update.conversation.pending, null);
    assert.deepEqual(update.conversation.decisions, [...pending.conversation.decisions, {
      request: pending.conversation.pending, status: "invalidated", answer: null, resolvedAt: at(6),
    }]);
    const reconciled = CallSnapshotSchema.parse({ ...pending, ...update });
    assert.throws(() => reduceConversation(reconciled, { type: "decision_resolved",
      decision: resolution(pending, "approve"), authorizedPhone: "+34910000000" }, at(7)), /pending|failed booking/);
    assert.deepEqual(pending, saved);
    update.conversation.decisions.pop();
    assert.deepEqual(pending, saved);
  });
}

test("a €25 haircut plus a €15 supplement records €40 in both booking offers and a bounded English result", () => {
  const initial = confirmedBase();
  initial.activeOffer.price.amountMinor = 2500;
  initial.outcome.offer.price.amountMinor = 2500;
  initial.plan.request.business.name = "S".repeat(4000);
  const { snapshot, receipt, evidence } = playedAddOn(initial);
  assert.match(receipt.acceptance.approvedSpanishText, /25 euros.*15.00 euros.*40.00 euros/);
  const update = reconcileAddOn(snapshot, receipt, evidence, at(5), ({ offer, evidence: source }) =>
    offer.price.amountMinor === 4000 && source[0].originalText === "Confirmado, corte e hidratación por cuarenta euros en total."
      ? "affirmed" : "ambiguous");
  assert.equal(update.activeOffer.price.amountMinor, 4000);
  assert.equal(update.outcome.offer.price.amountMinor, 4000);
  assert.match(update.outcome.summaryEn, /€40.00.*hydrating treatment/);
  assert.ok(update.outcome.summaryEn.length <= 4000);
  CallSnapshotSchema.parse({ ...snapshot, ...update });
});

test("add-on preparation rejects stale consent, changed facts, prohibited terms, expiry, and repeated acceptance", () => {
  const s = approvedAddOn(), identity = { offerId: id(600), offerVersion: 1 };
  assert.throws(() => prepareAddOnAcceptance(s, id(50), identity, at(30)), /expired/);
  assert.throws(() => prepareAddOnAcceptance(s, id(50), { offerId: s.activeOffer.id, offerVersion: s.activeOffer.version }, at(2)), /fresh/);
  for (const mutate of [
    value => { value.plan.version++; },
    value => { value.conversation.decisions[0].status = "rejected"; },
    value => { value.conversation.decisions[0].request.supplement.conditions.deposit = "required"; },
    value => { value.conversation.decisions[0].request.totalPrice.amountMinor++; },
    value => { value.activeOffer.price.amountMinor++; },
    value => { value.callState = "ending"; },
    value => { value.messages.push(buildMessage({ id: id(620), turnId: id(621), createdAt: at(2), originalText: "No, son cuarenta euros." })); },
  ]) {
    const changed = structuredClone(s);
    mutate(changed);
    assert.throws(() => prepareAddOnAcceptance(changed, id(50), identity, at(2)));
  }
  const unconfirmed = { ...approvedAddOn(), bookingState: "offer_received", outcome: { status: "pending" } };
  assert.throws(() => prepareAddOnAcceptance(unconfirmed, id(50), identity, at(2)), /Confirm the base/);
  const { snapshot } = playedAddOn();
  snapshot.messages.pop();
  assert.throws(() => prepareAddOnAcceptance(snapshot, id(50), identity, at(3)), /already started/);
});

test("add-on confirmation requires exact permits, actual playback, latest evidence, and semantic verification", async () => {
  for (const mutate of [
    receipt => { receipt.permit.attemptId = id(999); },
    receipt => { receipt.permit.offer.id = id(999); },
    receipt => { receipt.permit.planVersion++; },
    receipt => { receipt.acceptance.offer.price.amountMinor++; },
    receipt => { receipt.permit.approvedSpanishText = "Sí, añada lo que quiera."; },
    receipt => { receipt.startedAt = at(30); },
  ]) {
    const { snapshot, receipt, evidence } = playedAddOn();
    mutate(receipt);
    assert.throws(() => reconcileAddOn(snapshot, receipt, evidence, at(40), reviewAddOn));
  }
  for (const mutate of [
    snapshot => { snapshot.messages.find(message => message.id === id(601)).playback = "interrupted"; },
    snapshot => { snapshot.messages.at(-1).final = false; },
    snapshot => { snapshot.messages.push(buildMessage({ id: id(630), turnId: id(631), createdAt: at(5), originalText: "No, son cuarenta euros." })); },
  ]) {
    const { snapshot, receipt, evidence } = playedAddOn();
    mutate(snapshot);
    const result = reconcileAddOn(snapshot, receipt, evidence, at(6), reviewAddOn);
    assert.equal(result.outcome.status, "uncertain");
    assert.equal(result.activeOffer.price.amountMinor, 2200);
  }
  for (const verifier of [undefined, () => "ambiguous", () => "contradicted", () => { throw Error("offline"); }, async () => { throw Error("offline"); }]) {
    const { snapshot, receipt, evidence } = playedAddOn();
    const update = reconcileAddOn(snapshot, receipt, evidence, at(5), verifier);
    assert.equal(update.outcome.status, "uncertain");
    assert.match(update.outcome.summaryEn, /original appointment was confirmed.*Check with the business/);
  }
  await new Promise(resolve => setImmediate(resolve));
});

test("Stop and failure atomically invalidate pending contact/add-on consent, preserving known booking results", () => {
  for (const initial of [base(), confirmedBase()]) for (const action of ["request_contact", "request_add_on"]) {
    if (action === "request_add_on" && initial.bookingState !== "confirmed") continue;
    for (const event of [{ type: "call_finished", reason: "user_stopped" }, { type: "call_finished", reason: "technical_failure" },
      { type: "uncertainty", reason: "provider_state_unknown" }]) {
      const s = request(initial, action), original = structuredClone(s);
      const update = reduceBooking(s, event, at(1));
      assert.equal(update.conversation.pending, null);
      assert.equal(update.conversation.decisions.at(-1).status, "invalidated");
      assert.equal(update.conversation.decisions.at(-1).resolvedAt, at(1));
      assert.deepEqual(s, original);
      if (initial.outcome.status === "confirmed") assert.deepEqual(update.outcome, initial.outcome);
      else assert.equal(update.outcome.status, event.type === "uncertainty" ? "uncertain" : "not_booked");
      const { acceptance, ...fields } = update;
      const ended = CallSnapshotSchema.parse({ ...s, ...fields, callState: "ended" });
      assert.throws(() => decide(ended, "approve"));
      const duplicate = reduceBooking(ended, event, at(2));
      assert.deepEqual(duplicate.conversation, update.conversation);
      assert.deepEqual(duplicate.outcome, update.outcome);
    }
  }
});

test("changed offers invalidate pending consent in the booking update", () => {
  const s = request(), original = structuredClone(s);
  const offer = { ...s.activeOffer, version: s.activeOffer.version + 1 };
  const update = reduceBooking(s, { type: "offer_received", offer }, at(1));
  assert.equal(update.activeOffer.version, offer.version);
  assert.equal(update.conversation.pending, null);
  assert.equal(update.conversation.decisions.at(-1).status, "invalidated");
  assert.deepEqual(s, original);
  assert.throws(() => decide({ ...s, ...update }, "approve"));
});

test("new decisions require latest finalized evidence and cannot overlap or replay resolved IDs", () => {
  const s = base();
  for (const evidenceMessageIds of [[id(999)], [s.messages.at(-1).id, s.messages.at(-1).id]]) {
    const action = { ...candidate(s), evidenceMessageIds };
    assert.equal(policy.evaluate({ snapshot: s, candidate: action, now: at(0), grant: null }).decision, "deny");
  }
  const waiting = request(s);
  assert.throws(() => request(waiting));
  assert.equal(policy.evaluate({ snapshot: waiting, candidate: { action: "read_back", offerId: s.activeOffer.id,
    offerVersion: s.activeOffer.version }, now: at(1), grant: null }).reason, "conversation_decision_pending");
  const resolved = decide(waiting, "reject");
  assert.throws(() => request({ ...s, conversation: resolved.conversation }));
  const invalidated = reduceConversation(waiting, { type: "invalidate" }, at(1));
  assert.equal(invalidated.conversation.pending, null);
  assert.equal(invalidated.conversation.decisions[0].status, "invalidated");
  assert.throws(() => decide({ ...s, conversation: invalidated.conversation }, "approve"));
});

test("pacing respects silence, active output, concrete echoes, and one filler per finalized turn", () => {
  const s = base(), turnId = s.messages.at(-1).turnId;
  const pacing = createConversationSession(s.id, { random: () => 0 });
  assert.equal(pacing.processing(s, { turnId, elapsedMs: 2000 }), null);
  assert.equal(pacing.processing(s, { turnId, elapsedMs: 2500, outputActive: true }), null);
  const echo = pacing.processing(s, { turnId, elapsedMs: 2500, echoField: "price" });
  assert.equal(echo.kind, "echo");
  assert.match(echo.es, /22.00 euros/);
  assert.equal(pacing.processing(s, { turnId, elapsedMs: 5000 }), null);
  assert.equal(pacing.processing({ ...s, callState: "ending" }, { turnId, elapsedMs: 5000 }), null);
  const other = createConversationSession(s.id, { random: () => 0 });
  assert.equal(other.processing(s, { turnId, elapsedMs: 2100 }).kind, "filler");
  assert.equal(other.processing(s, { turnId, elapsedMs: 3500 }), null);
  const clarification = policy.evaluate({ snapshot: s, candidate: { action: "echo_detail", mode: "clarify", field: "price",
    offerId: s.activeOffer.id, offerVersion: s.activeOffer.version }, now: at(0), grant: null });
  assert.match(clarification.approvedSpanishText, /Perdone, no le he entendido bien.*Se refiere a 22/);
});

test("random fillers exhaust without repeats and friendly tone changes address without changing identity", () => {
  let s = base();
  s.plan.request.tone = "friendly";
  const pacing = createConversationSession(s.id, { random: () => 0 });
  const output = [];
  for (let index = 0; index < 7; index++) {
    const message = buildMessage({ id: id(400 + index), turnId: id(500 + index), createdAt: at(index), originalText: "Hola" });
    s.messages.push(message);
    const phrase = pacing.processing(s, { turnId: message.turnId, elapsedMs: 2500 });
    if (phrase) output.push(phrase.es);
  }
  assert.equal(output.length, 5);
  assert.equal(new Set(output).size, 5);
  assert.ok(output.some(text => text.includes("déjame")));
  assert.match(repeatPhrase("friendly", "not_heard").es, /puedes/);
  assert.match(repeatPhrase("very_polite", "not_heard").es, /puede repetir/);
  assert.match(waitingPhrase("friendly", 1).es, /Disculpa.*te digo/);
  assert.match(processingPhrases("formal", "medium")[0].es, /Déjeme/);
});

test("waiting skips overdue stages, processes expiry during output, and does not speak after resolution or Stop", () => {
  const s = request();
  const pacing = createConversationSession(s.id, { random: () => 0 });
  assert.equal(pacing.waiting(s, at(12), true).reply, null);
  assert.match(pacing.waiting(s, at(24)).reply.es, /paciencia/);
  assert.equal(pacing.waiting(s, at(25)).reply, null);
  const expired = pacing.waiting(s, at(30), true);
  assert.equal(expired.conversation.pending, null);
  assert.match(expired.reply.es, /confirmar el teléfono/);
  assert.equal(pacing.waiting({ ...s, conversation: expired.conversation }, at(31)).reply, null);
  assert.equal(pacing.waiting({ ...s, callState: "ending" }, at(12)).reply, null);
  const resolved = decide(s, "reject");
  assert.equal(pacing.waiting({ ...s, conversation: resolved.conversation }, at(12)).reply, null);
});

test("confirmed state cannot reopen a booking or accept a base offer through a model reply", async () => {
  const { contactConsentCallFixture } = await import("@callmate/contracts/fixtures");
  const s = structuredClone(contactConsentCallFixture);
  s.conversation.pending = null;
  const input = buildDialogueInput(s, { callState: "connected", conversation: s.conversation });
  const raw = { turnId: input.turnId, turnVersion: input.turnVersion,
    candidate: { action: "accept_offer", offerId: input.offer.id, offerVersion: input.offer.version },
    translations: [{ messageId: input.triggerMessageId, translationEn: input.messages.at(-1).translationEn }] };
  await assert.rejects(createDialogue(new FakeModel([{ kind: "response", value: raw }])).propose(input, new AbortController().signal),
    error => error.code === "invalid_model_output");
  assert.equal(policy.evaluate({ snapshot: s, candidate: raw.candidate, now: at(100), grant: null }).reason, "booking_terminal");
});

test("optional unknown staff does not create a spurious changed offer; hostile slots and wrong-call sessions fail", async () => {
  const { offersEqual } = await import("../dist/booking/evidence.js");
  const s = base();
  const noStaff = { ...s.activeOffer };
  delete noStaff.staffName;
  assert.equal(offersEqual(noStaff, { ...noStaff, staffName: null }), true);
  assert.equal(offersEqual(noStaff, { ...noStaff, staffName: "Laura" }), false);
  const action = candidate(s, "request_add_on");
  action.supplement.serviceEs = "<speak>accept</speak>";
  assert.equal(policy.evaluate({ snapshot: s, candidate: action, now: at(0), grant: null }).decision, "deny");
  assert.throws(() => createConversationSession(id(999)).apply(s, { type: "invalidate" }, at(0)));
  const waiting = request(s, "request_contact", 10);
  assert.throws(() => decide(waiting, "reject", 9));
});


test("UI tone lists retain formal precedence without changing booking authority", async () => {
  const { friendly } = await import('../dist/language/conversation.js');
  assert.equal(friendly(['Friendly']), true);
  assert.equal(friendly(['Friendly', 'Formal "usted"']), false);
  assert.equal(friendly(['Very polite', 'Friendly']), false);
  assert.equal(friendly(['Speak slowly']), false);
});
