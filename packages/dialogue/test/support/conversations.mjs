import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { OutcomeSchema, TranscriptMessageSchema } from "@callmate/contracts";
import { buildDialogueInput, buildPlan, buildProposal, buildSnapshot } from "./builders.mjs";

const directory = new URL("../../../../tests/dialogue-fixtures/", import.meta.url);

/** Validate fixture structure/references; this does not establish conversation meaning or authority. */
export function parseConversation(raw) {
  assert.equal(raw.formatVersion, 1, "Unsupported dialogue fixture format");
  assert.match(raw.id, /^dialogue-[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(typeof raw.description === "string" && raw.description.length > 0);
  assert.ok(Array.isArray(raw.turns) && raw.turns.length > 0);
  const plan = buildPlan();
  const messages = raw.messages.map((message) => TranscriptMessageSchema.parse(message));
  assert.ok(messages.every((message, index) => index === 0
    || Date.parse(message.createdAt) >= Date.parse(messages[index - 1].createdAt)),
  "Transcript timestamps must follow transcript order");
  const seenTriggers = new Set();
  let previousTriggerIndex = -1;
  const turns = raw.turns.map((turn, index) => {
    const triggerIndex = messages.findIndex((message) => message.id === turn.triggerMessageId);
    assert.ok(triggerIndex > previousTriggerIndex, "Turn triggers must follow transcript order");
    previousTriggerIndex = triggerIndex;
    assert.ok(!seenTriggers.has(turn.triggerMessageId), "Each fixture trigger must be unique");
    seenTriggers.add(turn.triggerMessageId);
    const snapshot = buildSnapshot({
      plan, messages: messages.slice(0, triggerIndex + 1), bookingState: turn.bookingState,
      activeOffer: turn.activeOffer, pendingApproval: null, updatedAt: messages[triggerIndex].createdAt,
    });
    const input = buildDialogueInput(snapshot, { triggerMessageId: turn.triggerMessageId, turnVersion: index + 1 });
    const proposal = buildProposal(input, turn.candidate, {
      translations: [{ messageId: turn.triggerMessageId, translationEn: turn.translationEn }],
    });
    return { snapshot, input, proposal };
  });
  const expectedOutcome = OutcomeSchema.parse(raw.expectedOutcome);
  const last = turns.at(-1).snapshot;
  // Also validate the expected result against the full transcript, never exposing future evidence to a turn.
  const outcomeSnapshot = buildSnapshot({
    ...last, messages, outcome: expectedOutcome,
    bookingState: expectedOutcome.status === "pending" ? last.bookingState : expectedOutcome.status,
    callState: expectedOutcome.status === "pending" ? "connected" : "ended",
    activeOffer: expectedOutcome.status === "confirmed" ? expectedOutcome.offer : last.activeOffer,
    updatedAt: messages.at(-1).createdAt,
  });
  return { id: raw.id, description: raw.description, plan, messages, turns, expectedOutcome, outcomeSnapshot };
}

export function loadConversations() {
  const fixtures = readdirSync(directory).filter((name) => name.endsWith(".json")).sort()
    .map((name) => parseConversation(JSON.parse(readFileSync(new URL(name, directory), "utf8"))));
  assert.ok(fixtures.length > 0, "Expected at least one conversation fixture");
  assert.equal(new Set(fixtures.map((fixture) => fixture.id)).size, fixtures.length, "Fixture IDs must be unique");
  return fixtures;
}
