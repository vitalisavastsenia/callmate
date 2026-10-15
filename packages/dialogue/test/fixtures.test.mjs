import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  CallSnapshotSchema, DialogueInputSchema, DialogueProposalSchema,
} from "@callmate/contracts";
import { connectedCallFixture } from "@callmate/contracts/fixtures";
import {
  buildDialogueInput, buildMessage, buildOffer, buildPlan, buildProposal, buildSnapshot,
} from "./support/builders.mjs";
import { loadConversations, parseConversation } from "./support/conversations.mjs";
import { FakeModel } from "./support/fake-model.mjs";
import { renderAcceptance } from "../dist/language/spanish.js";

const rawSuccess = () => JSON.parse(readFileSync(
  new URL("../../../tests/dialogue-fixtures/within-plan-confirmation.json", import.meta.url), "utf8"));

test("builders return fresh data and preserve explicit null values", () => {
  const plan = buildPlan();
  plan.request.bookingName = "Changed locally";
  assert.equal(buildPlan().request.bookingName, "Alex Example");
  const snapshot = buildSnapshot();
  snapshot.messages[0].originalText = "Changed locally";
  assert.deepEqual(buildSnapshot(), connectedCallFixture);
  assert.equal(buildOffer({ price: null }).price, null);
  assert.equal(buildMessage({ translationEn: null }).translationEn, null);
});

test("builders reject invalid money, incomplete conditions, invalid plans, and live snapshots", () => {
  assert.throws(() => buildOffer({ price: { amountMinor: 1.5, currency: "EUR" } }));
  assert.throws(() => buildOffer({ conditions: { deposit: "none" } }));
  assert.throws(() => buildPlan({ version: 0 }));
  assert.throws(() => buildSnapshot({ mode: "live" }), /simulator/);
  assert.throws(() => buildMessage({ speaker: "assistant" }));
});

test("snapshot builders reject duplicate message IDs and missing offer evidence", () => {
  const snapshot = buildSnapshot();
  assert.throws(() => buildSnapshot({ messages: [...snapshot.messages, snapshot.messages[0]] }), /unique/);
  assert.throws(() => buildSnapshot({ messages: [] }), /Evidence/);
});

test("dialogue builders require a finalized business trigger", () => {
  const snapshot = buildSnapshot();
  assert.throws(() => buildDialogueInput(snapshot, { triggerMessageId: snapshot.id }));
  assert.throws(() => buildDialogueInput(snapshot, {
    messages: snapshot.messages.map((message) => ({ ...message, final: false })),
  }));
});

test("proposal builders reject stale turns, stale offers, invalid translations, and invented evidence", () => {
  const input = buildDialogueInput();
  const action = { action: "ask_availability" };
  assert.throws(() => buildProposal(input, action, { turnVersion: 2 }), /turn version/);
  assert.throws(() => buildProposal(input, { action: "accept_offer", offerId: input.offer.id, offerVersion: 2 }), /offer version/);
  assert.throws(() => buildProposal(input, action, {
    translations: [{ messageId: input.plan.id, translationEn: "An invented translation." }],
  }), /Translations/);
  const translation = { messageId: input.triggerMessageId, translationEn: "A translation." };
  assert.throws(() => buildProposal(input, action, { translations: [translation, translation] }), /unique/);
  assert.throws(() => buildProposal(input, {
    action: "evaluate_offer", offer: buildOffer({ evidenceMessageIds: [input.plan.id] }),
  }), /Evidence/);
});

for (const fixture of loadConversations()) {
  test(`replay synthetic conversation: ${fixture.id}`, async () => {
    const model = new FakeModel(fixture.turns.map((turn) => ({ kind: "response", value: turn.proposal })));
    for (const turn of fixture.turns) {
      assert.deepEqual(DialogueInputSchema.parse(turn.input), turn.input);
      assert.equal(turn.input.messages.at(-1).id, turn.input.triggerMessageId);
      assert.equal(turn.input.messages.at(-1).translationEn, null);
      const output = await model.generate(turn.input, new AbortController().signal);
      assert.deepEqual(DialogueProposalSchema.parse(output), turn.proposal);
      assert.equal(turn.snapshot.mode, "simulator");
    }
    assert.equal(model.remaining, 0);
    assert.equal(model.requests.length, fixture.turns.length);
    assert.deepEqual(CallSnapshotSchema.parse(fixture.outcomeSnapshot).outcome, fixture.expectedOutcome);
  });
}

test("confirmation fixture contains actual played acceptance before final business evidence", () => {
  const fixture = parseConversation(rawSuccess());
  const confirmation = fixture.messages.findIndex((message) =>
    fixture.expectedOutcome.confirmationMessageIds.includes(message.id));
  const acceptance = fixture.messages.findIndex((message) => message.speaker === "assistant"
    && message.playback === "played" && message.originalText.startsWith("Acepto"));
  assert.ok(acceptance > 0 && confirmation > acceptance);
  assert.equal(fixture.messages[acceptance].originalText, renderAcceptance(fixture.plan, fixture.expectedOutcome.offer));
  assert.equal(fixture.turns[0].input.messages.some((message) =>
    fixture.expectedOutcome.confirmationMessageIds.includes(message.id)), false);
  assert.equal(fixture.turns[1].proposal.candidate.action, "record_business_confirmation");
});

test("fixtures preserve ambiguity and missing price instead of producing acceptance", () => {
  const fixtures = loadConversations();
  for (const [id, field] of [["dialogue-missing-price", "price"], ["dialogue-ambiguous-time", "time"]]) {
    const fixture = fixtures.find((item) => item.id === id);
    assert.equal(fixture.expectedOutcome.status, "pending");
    assert.deepEqual(fixture.turns[0].proposal.candidate, { action: "clarify", missing: [field] });
    assert.equal(fixture.turns[0].input.offer, null);
  }
});

test("fixture validation rejects missing fields, future evidence, and nonbusiness confirmation", () => {
  const missing = rawSuccess();
  delete missing.messages[0].playback;
  assert.throws(() => parseConversation(missing));
  const future = rawSuccess();
  future.turns[0].candidate.offer.evidenceMessageIds = [future.messages.at(-1).id];
  assert.throws(() => parseConversation(future), /Evidence/);
  const assistant = rawSuccess();
  assistant.turns[1].candidate.evidenceMessageIds = [assistant.messages[2].id];
  assert.throws(() => parseConversation(assistant), /Evidence/);
});

test("fixture validation rejects out-of-order turns and unsupported fixture versions", () => {
  const outOfOrder = rawSuccess();
  outOfOrder.turns.reverse();
  assert.throws(() => parseConversation(outOfOrder), /transcript order/);
  const unsupported = rawSuccess();
  unsupported.formatVersion = 2;
  assert.throws(() => parseConversation(unsupported), /Unsupported/);
});
