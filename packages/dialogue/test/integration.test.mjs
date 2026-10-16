import assert from "node:assert/strict";
import test from "node:test";
import { BookingPolicy, Dialogue, DialogueError, createDialogueServices } from "@callmate/dialogue";
import { buildDialogueInput, buildProposal, buildSnapshot } from "./support/builders.mjs";
import { loadConversations } from "./support/conversations.mjs";
import { FakeModel } from "./support/fake-model.mjs";

test("public composition constructor supplies both shared ports without starting provider work", async () => {
  const snapshot = buildSnapshot();
  const input = buildDialogueInput(snapshot);
  const candidate = { action: "evaluate_offer", offer: snapshot.activeOffer };
  const raw = buildProposal(input, candidate, {
    translations: [{ messageId: input.triggerMessageId, translationEn: snapshot.messages.at(-1).translationEn }],
  });
  const model = new FakeModel([{ kind: "response", value: raw }]);
  const services = createDialogueServices(model);
  assert.ok(services.dialogue instanceof Dialogue);
  assert.ok(services.bookingPolicy instanceof BookingPolicy);
  assert.equal(model.requests.length, 0, "Constructing services is inert");
  const proposal = await services.dialogue.propose(input, new AbortController().signal);
  const decision = services.bookingPolicy.evaluate({ snapshot, candidate: proposal.candidate,
    now: "2026-10-15T10:01:20Z", grant: null });
  assert.deepEqual(decision, { decision: "allow", approvedSpanishText: "Gracias. Voy a comprobar la propuesta antes de aceptar nada." });
  assert.equal(snapshot.outcome.status, "pending", "A proposal/decision does not mutate or confirm controller state");
});

test("composition forwards controller identity configuration and never supplies missing authority", async () => {
  const fixture = loadConversations().find((item) => item.id === "dialogue-within-plan-confirmation").turns[0];
  const model = new FakeModel([{ kind: "response", value: fixture.proposal }]);
  const reserved = { offerId: "70000000-0000-4000-8000-000000000001", offerVersion: 4 };
  const { dialogue } = createDialogueServices(model, { offerIdentitySource: () => reserved });
  const result = await dialogue.propose(fixture.input, new AbortController().signal);
  assert.equal(result.candidate.offer.id, reserved.offerId);
  assert.equal(result.candidate.offer.version, reserved.offerVersion);
  const missing = createDialogueServices(new FakeModel([{ kind: "response", value: fixture.proposal }]));
  await assert.rejects(missing.dialogue.propose(fixture.input, new AbortController().signal),
    (error) => error instanceof DialogueError && error.code === "offer_identity_required");
});

test("composition forwards timeout options and shutdown cancellation to the provider", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const code of ["timeout", "cancelled"]) {
    const model = new FakeModel([{ kind: "pending", value: null }]);
    const { dialogue } = createDialogueServices(model, { timeoutMs: 25 });
    const controller = new AbortController();
    const pending = dialogue.propose(buildDialogueInput(), controller.signal);
    const failure = assert.rejects(pending, (error) => error instanceof DialogueError && error.code === code);
    if (code === "timeout") t.mock.timers.tick(25);
    else controller.abort();
    await failure;
    assert.equal(model.pendingCount, 0);
  }
});
