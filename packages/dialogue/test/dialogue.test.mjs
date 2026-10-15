import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { DialogueProposalSchema } from "@callmate/contracts";
import { createDialogue, Dialogue, DialogueError, reduceBooking } from "../dist/index.js";
import { loadConversations } from "./support/conversations.mjs";
import { FakeModel } from "./support/fake-model.mjs";

const id = (n) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const turn = (name = "ambiguous-time", index = 0) =>
  loadConversations().find((item) => item.id === `dialogue-${name}`).turns[index];
const aborter = () => new AbortController();
const failure = (code) => (error) => error instanceof DialogueError && error.code === code;
const modelFor = (value) => new FakeModel([{ kind: "response", value }]);
const ref = (offer) => ({ offerId: offer.id, offerVersion: offer.version });

test("all five Spanish conversations replay through DialoguePort with bound English translations", async () => {
  for (const fixture of loadConversations()) {
    const model = new FakeModel(fixture.turns.map(({ proposal }) => ({ kind: "response", value: proposal })));
    for (const { input, proposal } of fixture.turns) {
      const original = structuredClone(input);
      const dialogue = createDialogue(model, {
        // Fixture-only lookup stands in for a controller-reserved identity.
        offerIdentitySource: () => ref(proposal.candidate.offer),
      });
      const actual = await dialogue.propose(input, aborter().signal);
      assert.deepEqual(actual, proposal, fixture.id);
      assert.deepEqual(DialogueProposalSchema.parse(actual), actual);
      assert.deepEqual(input, original);
      if (fixture.id === "dialogue-ambiguous-time") {
        assert.deepEqual(actual.candidate, { action: "clarify", missing: ["time"] });
        assert.match(actual.translations[0].translationEn, /at six\./);
        assert.doesNotMatch(actual.translations[0].translationEn, /18:00|06:00/);
      }
    }
    assert.equal(model.remaining, 0);
  }
});

test("invalid context is rejected before consuming a model step", async () => {
  const { input, proposal } = turn();
  const model = modelFor(proposal);
  for (const mutate of [
    (value) => { value.turnId = id(1); },
    (value) => { value.messages.push(value.messages[0]); },
    (value) => { value.messages.at(-1).final = false; },
    (value) => { value.messages.push({ ...value.messages.at(-1), id: id(2), final: false }); },
    (value) => { value.messages[0].createdAt = "2026-10-15T11:00:00Z"; },
    (value) => { value.bookingState = "confirmed"; },
    (value) => { value.bookingState = "offer_received"; },
    (value) => { value.plan.version = 0; },
    (value) => { value.extra = "unknown field"; },
  ]) {
    const changed = structuredClone(input);
    mutate(changed);
    await assert.rejects(createDialogue(model).propose(changed, aborter().signal), failure("invalid_input"));
  }
  assert.equal(model.requests.length, 0);
});

test("untrusted output must match schema, turn, translation references, and completeness", async () => {
  const { input, proposal } = turn();
  const invalid = [null, "```json\n{}\n```", JSON.stringify(proposal), {},
    { ...proposal, grant: { approved: true } },
    { ...proposal, turnVersion: input.turnVersion + 1 },
    { ...proposal, turnId: id(1) },
    { ...proposal, translations: [] },
    { ...proposal, translations: [...proposal.translations, ...proposal.translations] },
    { ...proposal, translations: [{ messageId: id(2), translationEn: "Invented" }] },
    { ...proposal, translations: [{ messageId: input.triggerMessageId, translationEn: " " }] },
    { ...proposal, candidate: { action: "clarify", missing: ["time", "time"] } },
    { ...proposal, candidate: { action: "accept_offer", offerId: id(2), offerVersion: 1 } },
  ];
  for (const raw of invalid) {
    const model = modelFor(raw);
    await assert.rejects(createDialogue(model).propose(input, aborter().signal), failure("invalid_model_output"));
    assert.equal(model.requests.length, 1, "No hidden retries");
  }
});

test("translations cannot revise existing English or reference provisional speech", async () => {
  const { input, proposal } = turn();
  const existing = structuredClone(input);
  existing.messages.at(-1).translationEn = "An existing translation.";
  await assert.rejects(createDialogue(modelFor(proposal)).propose(existing, aborter().signal), failure("invalid_model_output"));
  const provisional = structuredClone(input);
  provisional.messages[0].final = false;
  const response = { ...proposal, translations: [...proposal.translations,
    { messageId: provisional.messages[0].id, translationEn: "An unfinished sentence." }] };
  await assert.rejects(createDialogue(modelFor(response)).propose(provisional, aborter().signal), failure("invalid_model_output"));
  existing.messages.at(-1).translationEn = proposal.translations[0].translationEn;
  assert.deepEqual(await createDialogue(modelFor(proposal)).propose(existing, aborter().signal), proposal);
});

test("offer facts require finalized business evidence including the current trigger", async () => {
  const { input, proposal } = turn("within-plan-confirmation");
  let allocated = 0;
  for (const evidenceMessageIds of [[id(1)], [input.messages[0].id],
    [input.triggerMessageId, input.triggerMessageId]]) {
    const raw = structuredClone(proposal);
    raw.candidate.offer.evidenceMessageIds = evidenceMessageIds;
    await assert.rejects(createDialogue(modelFor(raw), {
      offerIdentitySource: () => { allocated++; return ref(raw.candidate.offer); },
    }).propose(input, aborter().signal), failure("invalid_model_output"));
  }
  assert.equal(allocated, 0);
  const raw = structuredClone(proposal);
  raw.candidate.offer.price.currency = "USD";
  await assert.rejects(createDialogue(modelFor(raw)).propose(input, aborter().signal), failure("invalid_model_output"));
});

test("new and changed offers use controller identities, never model-selected authority", async () => {
  const { input, proposal } = turn("within-plan-confirmation");
  await assert.rejects(createDialogue(modelFor(proposal)).propose(input, aborter().signal), failure("offer_identity_required"));
  const original = structuredClone({ input, proposal });
  let context;
  const actual = await createDialogue(modelFor(proposal), { offerIdentitySource: (value) => {
    context = structuredClone(value);
    value.proposedOffer.price.amountMinor = 9999;
    return { offerId: id(10), offerVersion: 3 };
  } }).propose(input, aborter().signal);
  assert.equal(context.proposedOffer.id, undefined);
  assert.equal(context.currentOffer, null);
  assert.equal(context.attemptId, input.attemptId);
  assert.equal(actual.candidate.offer.id, id(10));
  assert.equal(actual.candidate.offer.version, 3);
  assert.equal(actual.candidate.offer.price.amountMinor, 2500);
  assert.deepEqual({ input, proposal }, original);

  const current = { ...input, bookingState: "offer_received", offer: proposal.candidate.offer };
  const repeat = structuredClone(proposal);
  repeat.candidate.offer.id = id(11);
  repeat.candidate.offer.version = 999;
  const repeated = await createDialogue(modelFor(repeat)).propose(current, aborter().signal);
  assert.deepEqual(repeated.candidate.offer, current.offer);
  const changed = structuredClone(proposal);
  changed.candidate.offer.price.amountMinor++;
  for (const identity of [ref(current.offer), { offerId: "malformed", offerVersion: 2 },
    { ...ref(current.offer), offerVersion: 0 }]) {
    await assert.rejects(createDialogue(modelFor(changed), { offerIdentitySource: () => identity })
      .propose(current, aborter().signal), failure("invalid_offer_identity"));
  }
  const next = await createDialogue(modelFor(changed), {
    offerIdentitySource: () => ({ offerId: current.offer.id, offerVersion: 2 }),
  }).propose(current, aborter().signal);
  assert.equal(next.candidate.offer.version, 2);
});

test("readback and acceptance candidates match the exact current offer and booking state", async () => {
  const fixture = turn("within-plan-confirmation");
  const offer = fixture.proposal.candidate.offer;
  for (const [action, requiredState] of [["read_back", "offer_received"], ["accept_offer", "reading_back"]]) {
    for (const bookingState of ["pending", "offer_received", "awaiting_approval", "reading_back", "awaiting_business_confirmation"]) {
      const input = { ...fixture.input, offer, bookingState };
      const raw = { ...fixture.proposal, candidate: { action, ...ref(offer) } };
      const reply = createDialogue(modelFor(raw)).propose(input, aborter().signal);
      if (bookingState === requiredState) assert.deepEqual((await reply).candidate, raw.candidate);
      else await assert.rejects(reply, failure("invalid_model_output"));
    }
    for (const stale of [{ offerId: id(9), offerVersion: 1 }, { ...ref(offer), offerVersion: 2 }]) {
      await assert.rejects(createDialogue(modelFor({ ...fixture.proposal, candidate: { action, ...stale } }))
        .propose({ ...fixture.input, offer, bookingState: requiredState }, aborter().signal), failure("invalid_model_output"));
    }
  }
});

test("changed offer facts during acceptance remain visible to the reducer as uncertainty", async () => {
  const fixture = turn("within-plan-confirmation", 1);
  for (const context of [fixture.input, fixture.snapshot]) {
    context.messages.at(-1).originalText = "Perdón, el precio de esa cita es 35 euros.";
  }
  const offer = { ...fixture.input.offer, price: { amountMinor: 3500, currency: "EUR" },
    evidenceMessageIds: [fixture.input.triggerMessageId] };
  const raw = { ...fixture.proposal, candidate: { action: "evaluate_offer", offer } };
  const dialogue = createDialogue(modelFor(raw), {
    offerIdentitySource: () => ({ offerId: offer.id, offerVersion: 2 }),
  });
  const proposal = await dialogue.propose(fixture.input, aborter().signal);
  const update = reduceBooking(fixture.snapshot, { type: "offer_received", offer: proposal.candidate.offer },
    "2026-10-15T10:01:20Z");
  assert.equal(update.outcome.status, "uncertain");
  assert.equal(update.activeOffer.version, 1);
});

test("throwing or asynchronous identity lookups cannot produce an offer", async () => {
  const { input, proposal } = turn("within-plan-confirmation");
  for (const offerIdentitySource of [() => { throw new Error("private backend error"); },
    async () => { throw new Error("private async backend error"); }]) {
    await assert.rejects(createDialogue(modelFor(proposal), { offerIdentitySource })
      .propose(input, aborter().signal), failure("invalid_offer_identity"));
  }
});

test("confirmation proposals require current evidence after played speech and never return an outcome", async () => {
  const { input, proposal } = turn("within-plan-confirmation", 1);
  const result = await createDialogue(modelFor(proposal)).propose(input, aborter().signal);
  assert.equal(result.outcome, undefined);
  for (const evidenceMessageIds of [[input.offer.evidenceMessageIds[0]], [id(1)],
    [input.triggerMessageId, input.triggerMessageId], [input.messages[2].id]]) {
    const raw = { ...proposal, candidate: { ...proposal.candidate, evidenceMessageIds } };
    await assert.rejects(createDialogue(modelFor(raw)).propose(input, aborter().signal), failure("invalid_model_output"));
  }
  const unplayed = structuredClone(input);
  for (const message of unplayed.messages) if (message.speaker === "assistant") message.playback = "withheld";
  await assert.rejects(createDialogue(modelFor(proposal)).propose(unplayed, aborter().signal), failure("invalid_model_output"));
  await assert.rejects(createDialogue(modelFor(proposal)).propose({ ...input, bookingState: "reading_back" }, aborter().signal),
    failure("invalid_model_output"));
});

test("pre-cancelled requests consume no model work and do not expose abort reasons", async () => {
  const { input, proposal } = turn();
  const model = modelFor(proposal);
  const controller = aborter();
  controller.abort(new Error("private reason"));
  await assert.rejects(createDialogue(model).propose(input, controller.signal), failure("cancelled"));
  assert.equal(model.remaining, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("Stop cancels a pending model request and removes caller listeners", async () => {
  const { input, proposal } = turn();
  const model = new FakeModel([{ kind: "pending", value: proposal }]);
  const controller = aborter();
  const reply = createDialogue(model).propose(input, controller.signal);
  assert.equal(model.pendingCount, 1);
  controller.abort();
  await assert.rejects(reply, failure("cancelled"));
  assert.equal(model.pendingCount, 0);
  assert.equal(model.releaseNext(), false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("timeout aborts pending provider work deterministically", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { input, proposal } = turn();
  const model = new FakeModel([{ kind: "pending", value: proposal }]);
  const controller = aborter();
  const reply = createDialogue(model, { timeoutMs: 100 }).propose(input, controller.signal);
  const rejected = assert.rejects(reply, failure("timeout"));
  t.mock.timers.tick(100);
  await rejected;
  assert.equal(model.pendingCount, 0);
  assert.equal(controller.signal.aborted, false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("providers ignoring abort cannot emit late success, allocate an offer, or leak late rejection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { input, proposal } = turn("within-plan-confirmation");
  for (const stop of ["cancelled", "timeout"]) for (const late of ["resolve", "reject"]) {
    let complete, fail, childSignal, allocations = 0;
    const model = { generate: (_input, signal) => {
      childSignal = signal;
      return new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    } };
    const controller = aborter();
    const reply = createDialogue(model, { timeoutMs: 100,
      offerIdentitySource: () => { allocations++; return ref(proposal.candidate.offer); },
    }).propose(input, controller.signal);
    const rejected = assert.rejects(reply, failure(stop));
    if (stop === "timeout") t.mock.timers.tick(100);
    else controller.abort();
    await rejected;
    assert.equal(childSignal.aborted, true);
    if (late === "resolve") complete(proposal);
    else fail(new Error("late private provider error"));
    await Promise.resolve();
    assert.equal(allocations, 0);
  }
});

test("model failures are sanitized, without retry, and success/failure clean up listeners and timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { input, proposal } = turn();
  for (const generate of [() => { throw new Error("private provider details"); },
    async () => { throw new Error("private provider details"); }]) {
    const controller = aborter();
    let calls = 0;
    const model = { generate: (...args) => { calls++; return generate(...args); } };
    await assert.rejects(createDialogue(model).propose(input, controller.signal), (error) => {
      assert.equal(error.code, "model_failed");
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
  let childSignal;
  const controller = aborter();
  await createDialogue({ generate: async (_input, signal) => { childSignal = signal; return proposal; } })
    .propose(input, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  t.mock.timers.tick(60_000);
  controller.abort();
  assert.equal(childSignal.aborted, false, "Settled turns retain no timers or parent listeners");
});

test("concurrent calls stay isolated and provider mutations cannot alter validation context", async () => {
  const { input, proposal } = turn();
  const model = new FakeModel([{ kind: "pending", value: proposal }, { kind: "pending", value: proposal }]);
  const dialogue = createDialogue(model);
  const first = aborter(), second = aborter();
  const reply1 = dialogue.propose(input, first.signal);
  const reply2 = dialogue.propose(input, second.signal);
  first.abort();
  await assert.rejects(reply1, failure("cancelled"));
  model.releaseNext();
  assert.deepEqual(await reply2, proposal);
  const original = structuredClone(input);
  const mutator = { generate: async (value) => { value.turnId = id(1); value.messages.length = 0; return proposal; } };
  assert.deepEqual(await createDialogue(mutator).propose(input, second.signal), proposal);
  assert.deepEqual(input, original);
});

test("construction validates bounded non-secret configuration without starting model work", () => {
  const model = modelFor(turn().proposal);
  assert.ok(new Dialogue(model));
  for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, 60_001]) {
    assert.throws(() => createDialogue(model, { timeoutMs }), RangeError);
  }
  assert.throws(() => createDialogue(null), TypeError);
  assert.throws(() => createDialogue(model, { offerIdentitySource: true }), TypeError);
  assert.equal(model.requests.length, 0);
});
