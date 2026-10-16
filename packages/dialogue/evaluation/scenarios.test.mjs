import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { TextSchema } from "@callmate/contracts";
// Exercise the package's public export, just as the server will after workspace wiring.
import {
  createDialogueServices, createBookingPolicy, reduceBooking, checkAcceptancePlayback,
  checkConfirmationEvidence, DialogueError, BookingTransitionError,
} from "@callmate/dialogue";
import { buildDialogueInput, buildMessage, buildOffer, buildProposal, buildSnapshot } from "../test/support/builders.mjs";
import { FakeModel } from "../test/support/fake-model.mjs";

const catalog = JSON.parse(readFileSync(new URL("../../../tests/dialogue-fixtures/evaluation/scenarios.json", import.meta.url), "utf8"));
const scenarios = catalog.scenarios;
const id = (n) => `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (seconds) => new Date(Date.parse("2026-10-15T10:01:00Z") + seconds * 1000).toISOString();
const now = at(40);
const policy = createBookingPolicy();
const offerSpanish = "Hay cita para un corte de pelo el 20 de octubre de 2026 a las 18:00, a nombre de Alex Example, por 25 euros. No hay depósito, gastos de cancelación ni extras obligatorios.";
const offerEnglish = "There is a haircut appointment on 20 October 2026 at 18:00 under Alex Example for 25 euros, with no deposit, cancellation fee, or required add-ons.";
const confirmedSpanish = scenarios.find((item) => item.id === "eval-within-plan-confirmation").spanish;
const contradictedSpanish = scenarios.find((item) => item.id === "eval-later-contradiction").spanish;
const ref = (snapshot, action) => ({ action, offerId: snapshot.activeOffer.id, offerVersion: snapshot.activeOffer.version });
const goldenOffer = () => buildOffer({ id: id(100), evidenceMessageIds: [id(1)] });

function base() {
  return buildSnapshot({
    bookingState: "offer_received", activeOffer: goldenOffer(), pendingApproval: null,
    messages: [buildMessage({ id: id(1), turnId: id(2), originalText: offerSpanish,
      translationEn: null, createdAt: at(0) })], updatedAt: at(0),
  });
}

function business(snapshot, spanish, english, seconds = 5, messageId = 10) {
  const message = buildMessage({ id: id(messageId), turnId: id(messageId + 1),
    originalText: spanish, translationEn: null, createdAt: at(seconds) });
  return { snapshot: buildSnapshot({ ...snapshot, messages: [...snapshot.messages, message], updatedAt: at(seconds) }),
    english, message };
}

function apply(snapshot, event, time = now, receipt = null) {
  const update = reduceBooking(snapshot, event, time, receipt);
  const { acceptance, ...fields } = update;
  return { snapshot: buildSnapshot({ ...snapshot, ...fields }), acceptance };
}

function decide(snapshot, candidate, trace, grant = null, time = now) {
  const result = policy.evaluate({ snapshot, candidate, now: time, grant });
  trace.decisions.push(result);
  if (result.decision !== "allow") assert.equal(result.approvedSpanishText, undefined);
  else TextSchema.parse(result.approvedSpanishText);
  return result;
}

async function propose(snapshot, candidate, english, trace) {
  const input = buildDialogueInput(snapshot);
  const raw = buildProposal(input, candidate, { translations: [{ messageId: input.triggerMessageId, translationEn: english }] });
  const model = new FakeModel([{ kind: "response", value: raw }]);
  const { dialogue } = createDialogueServices(model, {
    // Synthetic controller reservation, independent of model-selected IDs.
    offerIdentitySource: ({ currentOffer }) => ({ offerId: id(100), offerVersion: (currentOffer?.version ?? 0) + 1 }),
  });
  const started = performance.now();
  const result = await dialogue.propose(input, new AbortController().signal);
  trace.latencies.push(performance.now() - started);
  assert.equal(result.turnId, input.turnId);
  assert.equal(result.turnVersion, input.turnVersion);
  assert.deepEqual(result.translations, raw.translations);
  trace.proposals.push(result);
  assert.equal(model.remaining, 0);
  return result.candidate;
}

function readback(snapshot, trace, grant = null, playback = "played") {
  const result = decide(snapshot, ref(snapshot, "read_back"), trace, grant, at(10));
  assert.equal(result.decision, "allow");
  assert.match(result.approvedSpanishText, /Todavía no estoy aceptando la reserva/);
  const started = apply(snapshot, { type: "readback_started", ...refFields(snapshot) }, at(10)).snapshot;
  return buildSnapshot({ ...started, messages: [...started.messages, buildMessage({
    id: id(20), turnId: id(21), speaker: "assistant", playback, final: true,
    originalText: result.approvedSpanishText, translationEn: null, createdAt: at(10),
  })], updatedAt: at(10) });
}

const refFields = (snapshot) => ({ offerId: snapshot.activeOffer.id, offerVersion: snapshot.activeOffer.version });
const grantFor = (snapshot) => ({ approvalId: id(200), attemptId: snapshot.id,
  planId: snapshot.plan.id, planVersion: snapshot.plan.version, ...refFields(snapshot), expiresAt: at(60) });
const approvalFor = (snapshot) => ({ id: id(200), attemptId: snapshot.id,
  plan: { planId: snapshot.plan.id, planVersion: snapshot.plan.version }, offer: snapshot.activeOffer,
  reason: "above_price_limit", createdAt: at(5), expiresAt: at(60) });

async function accepted(trace, playback = "played") {
  let snapshot = base();
  const pending = buildSnapshot({ ...snapshot, activeOffer: null, bookingState: "pending" });
  const extracted = await propose(pending, { action: "evaluate_offer", offer: goldenOffer() }, offerEnglish, trace);
  snapshot = apply(pending, { type: "offer_received", offer: extracted.offer }, at(5)).snapshot;
  const neutral = decide(snapshot, extracted, trace, null, at(5));
  assert.equal(neutral.decision, "allow");
  assert.doesNotMatch(neutral.approvedSpanishText, /^Acepto/);
  snapshot = readback(snapshot, trace);
  const candidate = await propose(snapshot, ref(snapshot, "accept_offer"), offerEnglish, trace);
  const acceptance = decide(snapshot, candidate, trace, null, at(20));
  assert.equal(acceptance.decision, "allow");
  assert.match(acceptance.approvedSpanishText, /^Acepto la cita/);
  for (const fact of ["20 de octubre de 2026", "18:00", "Alex Example", "25 euros"]) {
    assert.ok(acceptance.approvedSpanishText.includes(fact), fact);
  }
  snapshot = buildSnapshot({ ...snapshot, messages: [...snapshot.messages, buildMessage({
    id: id(30), turnId: id(31), speaker: "assistant", playback, originalText: acceptance.approvedSpanishText,
    translationEn: null, createdAt: at(20),
  })], updatedAt: at(20) });
  // A simulator receipt is supplied by this harness, never by scripted model output.
  const receipt = { permit: { id: id(300), attemptId: snapshot.id, planId: snapshot.plan.id,
    planVersion: snapshot.plan.version, turnId: id(31), turnVersion: 1, outputId: id(301),
    offer: { id: snapshot.activeOffer.id, version: snapshot.activeOffer.version },
    approvedSpanishText: acceptance.approvedSpanishText, expiresAt: at(25) },
    offer: snapshot.activeOffer, readbackMessageId: id(20), acceptanceMessageId: id(30), startedAt: at(20), observedAt: at(21) };
  if (playback === "played") {
    assert.deepEqual(checkAcceptancePlayback(snapshot, receipt, now), { valid: true });
    snapshot = apply(snapshot, { type: "acceptance_played", receipt }, now).snapshot;
  }
  return { snapshot, receipt };
}

// Fixture-only meaning oracle for these exact authored sentences and exact offer.
// It cannot assess arbitrary Spanish or be used as a production semantic verifier.
function verifyFixtureMeaning({ offer, evidence, businessMessagesAfterAcceptance }) {
  assert.deepEqual(offer, goldenOffer());
  const latest = businessMessagesAfterAcceptance.at(-1);
  if (!latest || !evidence.some((message) => message.id === latest.id)) return "ambiguous";
  if (latest.originalText === contradictedSpanish) return "contradicted";
  return latest.originalText === confirmedSpanish ? "affirmed" : "ambiguous";
}

function checkOutcome(snapshot, expected) {
  assert.equal(snapshot.outcome.status, expected.outcome);
  assert.equal(snapshot.bookingState, expected.outcome);
  assert.equal(snapshot.pendingApproval, null);
  if (expected.reason) assert.equal(snapshot.outcome.reason, expected.reason);
  assert.ok(snapshot.outcome.summaryEn.length > 0);
  if (expected.outcome === "confirmed") {
    assert.deepEqual(snapshot.outcome.offer, goldenOffer(), "Every critical detail must match the authorized offer");
    for (const detail of ["Haircut", "Alex Example", "2026-10-20", "18:00", "Europe/Madrid", "€25.00", "Duration is unknown."]) {
      assert.ok(snapshot.outcome.summaryEn.includes(detail), detail);
    }
  } else {
    assert.equal(snapshot.outcome.offer, undefined);
    if (expected.outcome === "uncertain") assert.match(snapshot.outcome.summaryEn, /Check with the business before trying again/);
  }
}

test("evaluation catalog has at least 20 unique Spanish scenarios and required coverage", () => {
  assert.equal(catalog.formatVersion, 1);
  assert.ok(scenarios.length >= 20);
  assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, scenarios.length);
  assert.equal(new Set(scenarios.map((scenario) => scenario.spanish)).size, scenarios.length);
  for (const scenario of scenarios) {
    assert.match(scenario.id, /^eval-[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(scenario.expected && Object.keys(scenario.expected).length > 0);
    TextSchema.parse(scenario.spanish);
    TextSchema.parse(scenario.english);
  }
  const categories = new Set(scenarios.map((scenario) => scenario.category));
  for (const required of ["prohibited_commitment", "changed_offer", "expired_approval", "interruption", "uncertainty",
    "noise", "accent", "ambiguity", "unknown_price", "availability", "refusal", "cancellation", "timeout"]) {
    assert.ok(categories.has(required), required);
  }
});

for (const scenario of scenarios) test(`${scenario.id} [${scenario.category}]`, async (t) => {
  const trace = { decisions: [], proposals: [], latencies: [] };
  const initial = business(base(), scenario.spanish, scenario.english);
  let snapshot = initial.snapshot;
  switch (scenario.mode) {
    case "closing": {
      const candidate = await propose(snapshot, { action: "end_call", reason: scenario.variant }, scenario.english, trace);
      assert.equal(decide(snapshot, candidate, trace).decision, "allow");
      snapshot = apply(snapshot, { type: "call_finished", reason: candidate.reason }).snapshot;
      checkOutcome(snapshot, scenario.expected);
      break;
    }
    case "clarification": {
      const candidate = await propose(snapshot, { action: "clarify", missing: [scenario.variant] }, scenario.english, trace);
      assert.deepEqual(candidate.missing, scenario.expected.missing);
      const result = decide(snapshot, candidate, trace);
      assert.equal(result.decision, "allow");
      assert.match(result.approvedSpanishText, scenario.variant === "name" ? /reserve.*Alex Example/ : /¿/);
      assert.doesNotMatch(result.approvedSpanishText, /^Acepto/);
      assert.equal(snapshot.outcome.status, "pending");
      break;
    }
    case "constraint": {
      let offer = { ...snapshot.activeOffer, evidenceMessageIds: [id(1), initial.message.id] };
      const request = structuredClone(snapshot.plan.request);
      const variant = scenario.variant;
      if (["above_budget", "valid_grant", "expired_grant"].includes(variant)) offer.price.amountMinor = 3500;
      if (variant === "prompt_injection") offer.price.amountMinor = 6000;
      if (variant === "unknown_price") offer.price = null;
      if (variant === "outside_availability") offer.appointment = { ...offer.appointment, localTime: "20:00", instant: "2026-10-20T18:00:00Z" };
      if (variant === "ask_before_accepting") request.bookingAuthority = "ask_before_accepting";
      if (["deposit", "cancellationFee", "paidAddOn"].includes(variant)) offer.conditions[variant] = "required";
      snapshot = buildSnapshot({ ...snapshot, activeOffer: offer, plan: { ...snapshot.plan, request } });
      let grant = ["deposit", "cancellationFee", "paidAddOn", "valid_grant", "expired_grant"].includes(variant) ? grantFor(snapshot) : null;
      if (variant === "expired_grant") grant = { ...grant, expiresAt: now };
      if (variant === "valid_grant") snapshot = readback(snapshot, trace, grant);
      else snapshot = buildSnapshot({ ...snapshot, bookingState: "reading_back" });
      // Deliberately propose acceptance even for forbidden facts. A model cannot authorize it.
      const candidate = await propose(snapshot, ref(snapshot, "accept_offer"), scenario.english, trace);
      const result = decide(snapshot, candidate, trace, grant);
      assert.equal(result.decision, scenario.expected.decision);
      if (scenario.expected.reason) assert.equal(result.reason, scenario.expected.reason);
      if (scenario.expected.decision === "allow") {
        assert.match(result.approvedSpanishText, /^Acepto/);
        assert.match(result.approvedSpanishText, /35 euros/);
      }
      // Even authorized generated acceptance has not been heard or confirmed.
      assert.equal(snapshot.outcome.status, "pending");
      break;
    }
    case "changed_offer": {
      let original = base();
      original.activeOffer.price.amountMinor = 3500;
      original.messages[0].originalText = offerSpanish.replace("25 euros", "35 euros");
      original = buildSnapshot(original);
      const grant = grantFor(original);
      original = apply(original, { type: "approval_requested", approval: approvalFor(original) }, at(10)).snapshot;
      snapshot = business(original, scenario.spanish, scenario.english, 15).snapshot;
      const changed = structuredClone(snapshot.activeOffer);
      changed.version = 2;
      changed.evidenceMessageIds.push(id(10));
      if (scenario.variant === "price") changed.price.amountMinor = 4000;
      else changed.appointment = { ...changed.appointment, localTime: "20:00", instant: "2026-10-20T18:00:00Z" };
      const candidate = await propose(snapshot, { action: "evaluate_offer", offer: changed }, scenario.english, trace);
      snapshot = apply(snapshot, { type: "offer_received", offer: candidate.offer }).snapshot;
      assert.equal(snapshot.activeOffer.version, 2);
      assert.equal(snapshot.pendingApproval, null, "The prior approval must be invalidated");
      const read = await propose(snapshot, ref(snapshot, "read_back"), scenario.english, trace);
      assert.deepEqual(decide(snapshot, read, trace, grant), scenario.expected);
      assert.throws(() => reduceBooking(snapshot, { type: "approval_resolved", approvalId: grant.approvalId, status: "approved" }, now), BookingTransitionError);
      assert.equal(snapshot.outcome.status, "pending");
      break;
    }
    case "approval_resolution": {
      snapshot.activeOffer.price.amountMinor = 3500;
      snapshot.activeOffer.evidenceMessageIds.push(initial.message.id);
      snapshot.messages[0].originalText = offerSpanish.replace("25 euros", "35 euros");
      snapshot = buildSnapshot(snapshot);
      const approval = approvalFor(snapshot);
      snapshot = apply(snapshot, { type: "approval_requested", approval }, at(10)).snapshot;
      const candidate = await propose(snapshot, { action: "evaluate_offer", offer: snapshot.activeOffer }, scenario.english, trace);
      assert.deepEqual(decide(snapshot, candidate, trace), { decision: "ask_user", reason: "above_price_limit" });
      if (scenario.variant === "expired") {
        assert.throws(() => reduceBooking(snapshot, { type: "approval_resolved", approvalId: approval.id, status: "approved" }, approval.expiresAt), BookingTransitionError);
      }
      snapshot = apply(snapshot, { type: "approval_resolved", approvalId: approval.id, status: scenario.variant },
        scenario.variant === "expired" ? approval.expiresAt : now).snapshot;
      checkOutcome(snapshot, scenario.expected);
      assert.deepEqual(decide(snapshot, ref(snapshot, "read_back"), trace), { decision: "deny", reason: "booking_terminal" });
      break;
    }
    case "interruption": {
      if (scenario.variant === "readback") {
        snapshot = readback(base(), trace, null, "interrupted");
        snapshot = business(snapshot, scenario.spanish, scenario.english, 15).snapshot;
        const candidate = await propose(snapshot, ref(snapshot, "accept_offer"), scenario.english, trace);
        assert.deepEqual(decide(snapshot, candidate, trace), scenario.expected);
        assert.equal(snapshot.outcome.status, "pending");
      } else {
        const playback = await accepted(trace, "interrupted");
        snapshot = playback.snapshot;
        snapshot = business(snapshot, scenario.spanish, scenario.english, 25).snapshot;
        assert.equal(checkAcceptancePlayback(snapshot, playback.receipt, now).valid, false);
        assert.deepEqual(decide(snapshot, ref(snapshot, "accept_offer"), trace), { decision: "deny", reason: "acceptance_already_started" });
        const candidate = await propose(snapshot, { action: "end_call", reason: "unresolved" }, scenario.english, trace);
        assert.equal(decide(snapshot, candidate, trace).decision, "allow");
        snapshot = apply(snapshot, { type: "call_finished", reason: "technical_failure" }).snapshot;
        checkOutcome(snapshot, scenario.expected);
      }
      break;
    }
    case "confirmation": {
      const playback = await accepted(trace);
      snapshot = playback.snapshot;
      if (scenario.variant === "contradicted") {
        snapshot = business(snapshot, confirmedSpanish, "Yes, the appointment is confirmed.", 25, 40).snapshot;
      }
      snapshot = business(snapshot, scenario.spanish, scenario.english, 30, 50).snapshot;
      if (scenario.variant === "changed") {
        const offer = { ...snapshot.activeOffer, version: 2, price: { amountMinor: 4000, currency: "EUR" },
          evidenceMessageIds: [id(1), id(50)] };
        const candidate = await propose(snapshot, { action: "evaluate_offer", offer }, scenario.english, trace);
        snapshot = apply(snapshot, { type: "offer_received", offer: candidate.offer }, now, playback.receipt).snapshot;
        assert.equal(snapshot.activeOffer.version, 1, "Do not replace the possibly accepted offer");
      } else if (scenario.variant === "disconnect") {
        snapshot = apply(snapshot, { type: "call_finished", reason: "technical_failure" }, now, playback.receipt).snapshot;
      } else {
        const evidenceMessageIds = scenario.variant === "contradicted" ? [id(40), id(50)] : [id(50)];
        const candidate = await propose(snapshot, { action: "record_business_confirmation", ...refFields(snapshot), evidenceMessageIds }, scenario.english, trace);
        assert.deepEqual(decide(snapshot, candidate, trace), { decision: "allow", approvedSpanishText: "Gracias por la información." });
        if (scenario.variant === "contradicted") {
          assert.deepEqual(checkConfirmationEvidence({ snapshot, receipt: playback.receipt, evidenceMessageIds: [id(40)], now,
            verifyMeaning: verifyFixtureMeaning }), { valid: false, reason: "stale_confirmation" });
        }
        snapshot = apply(snapshot, { type: "business_confirmation", evidenceMessageIds,
          ...(scenario.variant === "unverified" ? {} : { verifyMeaning: verifyFixtureMeaning }) }, now, playback.receipt).snapshot;
      }
      checkOutcome(snapshot, scenario.expected);
      // Late Stop and duplicate callbacks must not regress any terminal result.
      assert.deepEqual(apply(snapshot, { type: "call_finished", reason: "user_stopped" }).snapshot.outcome, snapshot.outcome);
      break;
    }
    case "pending_model": {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      snapshot = readback(snapshot, trace);
      const input = buildDialogueInput(snapshot);
      const raw = buildProposal(input, ref(snapshot, "accept_offer"), {
        translations: [{ messageId: input.triggerMessageId, translationEn: scenario.english }],
      });
      let release, providerSignal, emitted = 0;
      // Intentionally ignore abort to evaluate the port's own stale-result protection.
      const model = { generate: (_input, signal) => {
        providerSignal = signal;
        return new Promise((resolve) => { release = resolve; });
      } };
      const controller = new AbortController();
      const { dialogue } = createDialogueServices(model, { timeoutMs: 100 });
      const result = dialogue.propose(input, controller.signal).then((proposal) => { emitted++; return proposal; });
      const rejected = assert.rejects(result, (error) => error instanceof DialogueError && error.code === scenario.expected.error);
      if (scenario.variant === "timeout") t.mock.timers.tick(100);
      else controller.abort();
      await rejected;
      assert.equal(providerSignal.aborted, true);
      release(raw);
      await Promise.resolve();
      assert.equal(emitted, 0);
      assert.equal(snapshot.outcome.status, "pending");
      break;
    }
    case "invalid_output": {
      const input = buildDialogueInput(snapshot);
      const raw = buildProposal(input, { action: "clarify", missing: ["time"] }, {
        translations: [{ messageId: input.triggerMessageId, translationEn: scenario.english }],
      });
      raw.turnVersion++;
      const model = new FakeModel([{ kind: "response", value: raw }]);
      const { dialogue } = createDialogueServices(model);
      await assert.rejects(dialogue.propose(input, new AbortController().signal),
        (error) => error instanceof DialogueError && error.code === scenario.expected.error);
      assert.equal(trace.decisions.length, 0);
      break;
    }
    default: assert.fail(`Unsupported evaluation mode: ${scenario.mode}`);
  }
  if (scenario.expected.decision && scenario.expected.decision !== "allow") {
    for (const decision of trace.decisions) {
      assert.doesNotMatch(decision.approvedSpanishText ?? "", /^Acepto/, "Blocked scenarios must never render acceptance");
    }
  }
  const total = trace.latencies.reduce((sum, latency) => sum + latency, 0);
  assert.ok(trace.latencies.every((latency) => Number.isFinite(latency) && latency >= 0));
  t.diagnostic(`model=scripted; dialogueTurns=${trace.latencies.length}; localProposeMs=${total.toFixed(2)}; policyDecisions=${trace.decisions.length}; liveAudio=false`);
});
