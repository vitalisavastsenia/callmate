import {
  DialogueInputSchema, DialogueProposalSchema, OfferRefSchema,
  type DialogueInput, type DialogueProposal, type Offer,
} from "@callmate/contracts";
import { checkOfferEvidence, offersEqual } from "../booking/evidence.js";
import { checkTranslations } from "../language/translations.js";
import { DialogueError } from "./errors.js";
import { isConversationAction, validConversationEvidence } from "./conversation.js";

/** Pure lookup of a controller-reserved identity; never persist or grant authority here. */
export type OfferIdentitySource = (context: {
  attemptId: string; turnId: string; turnVersion: number;
  currentOffer: Offer | null;
  proposedOffer: Omit<Offer, "id" | "version">;
}) => { offerId: string; offerVersion: number };

export function parseInput(raw: DialogueInput): DialogueInput {
  const parsed = DialogueInputSchema.safeParse(raw);
  if (!parsed.success) throw new DialogueError("invalid_input");
  const input = parsed.data;
  const trigger = input.messages.find((message) => message.id === input.triggerMessageId)!;
  const lastBusiness = input.messages.findLast((message) => message.speaker === "business");
  if (new Set(input.messages.map((message) => message.id)).size !== input.messages.length
    || trigger.turnId !== input.turnId || lastBusiness?.id !== trigger.id
    || input.messages.some((message, index) => index > 0
      && Date.parse(message.createdAt) < Date.parse(input.messages[index - 1]!.createdAt))
    || ["not_booked", "uncertain"].includes(input.bookingState)
    || (input.callState !== undefined && input.callState !== "connected")
    || (input.bookingState === "confirmed" && input.callState !== "connected")
    || (input.bookingState !== "pending" && input.offer === null)
    || (input.offer !== null && !checkOfferEvidence(input.offer, input.messages).valid)) {
    throw new DialogueError("invalid_input");
  }
  const pending = input.conversation?.pending;
  if (pending && (pending.attemptId !== input.attemptId || pending.plan.planId !== input.plan.id
    || pending.plan.planVersion !== input.plan.version || pending.offer.offerId !== input.offer?.id
    || pending.offer.offerVersion !== input.offer?.version)) throw new DialogueError("invalid_input");
  return input;
}

export function parseProposal(
  input: DialogueInput, raw: unknown, identitySource?: OfferIdentitySource,
): DialogueProposal {
  const parsed = DialogueProposalSchema.safeParse(raw);
  if (!parsed.success) throw new DialogueError("invalid_model_output");
  const proposal = parsed.data;
  const reject = (): never => { throw new DialogueError("invalid_model_output"); };
  if (proposal.turnId !== input.turnId || proposal.turnVersion !== input.turnVersion) reject();
  checkTranslations(input, proposal.translations);
  const action = proposal.candidate;
  if (input.bookingState === "confirmed" && !isConversationAction(action) && action.action !== "end_call") reject();
  if (isConversationAction(action) && "evidenceMessageIds" in action) {
    const latestTime = input.messages.at(-1)!.createdAt;
    if (!validConversationEvidence(input, action.evidenceMessageIds, latestTime)) reject();
  }
  if (input.conversation?.pending && (action.action === "request_add_on" || action.action === "request_contact")) reject();
  if (input.conversation?.pending && ["read_back", "accept_offer"].includes(action.action)) reject();
  if ((action.action === "request_add_on" || action.action === "request_contact") && input.conversation?.decisions.some(item =>
    item.request.kind === (action.action === "request_add_on" ? "add_on" : "contact")
    && item.request.plan.planId === input.plan.id && item.request.plan.planVersion === input.plan.version
    && item.request.offer.offerId === input.offer?.id && item.request.offer.offerVersion === input.offer?.version
    && item.request.evidenceMessageIds.includes(input.triggerMessageId))) reject();
  if (action.action === "clarify" && new Set(action.missing).size !== action.missing.length) reject();
  if ("offerId" in action && (!input.offer || action.offerId !== input.offer.id
    || action.offerVersion !== input.offer.version)) reject();
  if (action.action === "read_back" && input.bookingState !== "offer_received") reject();
  if (action.action === "accept_offer" && input.bookingState !== "reading_back") reject();
  if (action.action === "record_business_confirmation") {
    if (input.bookingState !== "awaiting_business_confirmation"
      || new Set(action.evidenceMessageIds).size !== action.evidenceMessageIds.length
      || !action.evidenceMessageIds.includes(input.triggerMessageId)) reject();
    const lastPlayed = input.messages.findLastIndex((message) => message.speaker === "assistant"
      && message.final && message.playback === "played");
    if (lastPlayed < 0 || action.evidenceMessageIds.some((id) => {
      const index = input.messages.findIndex((message) => message.id === id);
      const message = input.messages[index];
      return index <= lastPlayed || !message?.final || message.speaker !== "business";
    })) reject();
    // This is only a candidate. Authorized playback receipts and semantic verification
    // are deliberately required separately by the booking outcome layer.
  }
  if (action.action === "evaluate_offer") {
    if (!checkOfferEvidence(action.offer, input.messages).valid
      || !action.offer.evidenceMessageIds.includes(input.triggerMessageId)) reject();
    const { id: _id, version: _version, ...facts } = action.offer;
    // Repeated facts reuse backend identity, regardless of model-supplied IDs.
    if (input.offer && offersEqual({ ...action.offer, id: input.offer.id, version: input.offer.version }, input.offer)) {
      action.offer = structuredClone(input.offer);
    } else {
      if (!identitySource) throw new DialogueError("offer_identity_required");
      try {
        const rawIdentity: unknown = identitySource(structuredClone({
          attemptId: input.attemptId, turnId: input.turnId, turnVersion: input.turnVersion,
          currentOffer: input.offer, proposedOffer: facts,
        }));
        // A JS consumer may accidentally supply an async lookup. Never leave its
        // eventual rejection unobserved, and never accept it as an identity.
        if (rawIdentity !== null && typeof rawIdentity === "object" && "then" in rawIdentity) {
          void Promise.resolve(rawIdentity).catch(() => undefined);
          throw new Error("Offer identity lookup must be synchronous");
        }
        const identity = OfferRefSchema.parse(rawIdentity);
        if (input.offer?.id === identity.offerId && identity.offerVersion <= input.offer.version) {
          throw new Error("Offer version must advance");
        }
        action.offer = { ...action.offer, id: identity.offerId, version: identity.offerVersion };
      } catch {
        throw new DialogueError("invalid_offer_identity");
      }
    }
  }
  return proposal;
}
