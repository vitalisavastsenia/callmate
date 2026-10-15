import assert from "node:assert/strict";
import {
  ApprovedPlanSchema, CallSnapshotSchema, DialogueInputSchema, DialogueProposalSchema,
  OfferSchema, TranscriptMessageSchema,
} from "@callmate/contracts";
import {
  approvedPlanFixture, connectedCallFixture, offerFixture,
} from "@callmate/contracts/fixtures";

// Shallow overrides are deliberate: nested objects must remain complete and explicit.
export const buildPlan = (overrides = {}) => ApprovedPlanSchema.parse({
  ...structuredClone(approvedPlanFixture), ...overrides,
});
export const buildMessage = (overrides = {}) => TranscriptMessageSchema.parse({
  ...structuredClone(connectedCallFixture.messages[0]), ...overrides,
});
export const buildOffer = (overrides = {}) => OfferSchema.parse({
  ...structuredClone(offerFixture), ...overrides,
});

export function buildSnapshot(overrides = {}) {
  const snapshot = CallSnapshotSchema.parse({ ...structuredClone(connectedCallFixture), ...overrides });
  assert.equal(snapshot.mode, "simulator", "Test snapshots must remain in simulator mode");
  const messageIds = new Set(snapshot.messages.map((message) => message.id));
  assert.equal(messageIds.size, snapshot.messages.length, "Transcript message IDs must be unique");
  if (snapshot.activeOffer && snapshot.conversationData === "retained") {
    assertBusinessEvidence(snapshot.activeOffer.evidenceMessageIds, snapshot.messages);
  }
  return snapshot;
}

export function buildDialogueInput(snapshot = buildSnapshot(), overrides = {}) {
  const current = buildSnapshot(snapshot);
  const trigger = current.messages.findLast((message) => message.final && message.speaker === "business");
  return DialogueInputSchema.parse({
    attemptId: current.id, turnId: trigger?.turnId, turnVersion: 1,
    plan: current.plan, bookingState: current.bookingState, offer: current.activeOffer,
    triggerMessageId: trigger?.id, messages: current.messages, ...overrides,
  });
}

function assertBusinessEvidence(ids, messages) {
  const finalized = new Set(messages.filter((message) => message.final && message.speaker === "business")
    .map((message) => message.id));
  assert.ok(ids.every((id) => finalized.has(id)), "Evidence must reference finalized business messages");
}

export function buildProposal(input, candidate, overrides = {}) {
  const current = DialogueInputSchema.parse(input);
  const proposal = DialogueProposalSchema.parse({
    turnId: current.turnId, turnVersion: current.turnVersion,
    candidate, translations: [], ...overrides,
  });
  assert.equal(proposal.turnId, current.turnId, "Proposal turn ID must match its input");
  assert.equal(proposal.turnVersion, current.turnVersion, "Proposal turn version must match its input");
  const messageIds = new Set(current.messages.filter((message) => message.final).map((message) => message.id));
  assert.equal(new Set(proposal.translations.map((item) => item.messageId)).size,
    proposal.translations.length, "Translation message IDs must be unique");
  assert.ok(proposal.translations.every((item) => messageIds.has(item.messageId)),
    "Translations must reference finalized messages in this input");
  const action = proposal.candidate;
  if (action.action === "evaluate_offer") assertBusinessEvidence(action.offer.evidenceMessageIds, current.messages);
  if ("offerId" in action) {
    assert.equal(action.offerId, current.offer?.id, "Action must reference the current offer");
    assert.equal(action.offerVersion, current.offer?.version, "Action must reference the current offer version");
  }
  if (action.action === "record_business_confirmation") {
    assertBusinessEvidence(action.evidenceMessageIds, current.messages);
  }
  return proposal;
}
