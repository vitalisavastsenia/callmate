import {
  CallSnapshotSchema, IdSchema, InstantSchema, OfferSchema, PlaybackPermitSchema, TranscriptMessageSchema,
  type CallSnapshot, type Offer, type PlaybackPermit, type TranscriptMessage,
} from "@callmate/contracts";
import { renderAcceptance } from "../language/spanish.js";

/** Controller-owned evidence of authorized output, never a model-supplied grant. */
export type AcceptancePlayback = {
  permit: PlaybackPermit;
  offer: Offer;
  readbackMessageId: string;
  acceptanceMessageId: string;
  startedAt: string;
  observedAt: string;
};

/** The application must verify meaning against Spanish source text, not a confidence score. */
export type ConfirmationVerifier = (input: {
  offer: Offer;
  evidence: TranscriptMessage[];
  businessMessagesAfterAcceptance: TranscriptMessage[];
}) => "affirmed" | "ambiguous" | "contradicted";

export type EvidenceFailure =
  | "invalid_input" | "duplicate_message_ids" | "missing_business_evidence"
  | "offer_mismatch" | "permit_mismatch" | "invalid_playback_time"
  | "missing_readback" | "acceptance_not_played" | "acceptance_text_mismatch"
  | "evidence_out_of_order" | "unresolved_conditions" | "missing_confirmation"
  | "stale_confirmation" | "provisional_business_speech" | "meaning_unverified";
export type EvidenceCheck = { valid: true } | { valid: false; reason: EvidenceFailure };
const invalid = (reason: EvidenceFailure): EvidenceCheck => ({ valid: false, reason });

/** IDs/versions are immutable: even an evidence-only change requires a new version. */
export function offersEqual(left: Offer, right: Offer): boolean {
  const canonical = (offer: Offer) => {
    const { staffName, ...facts } = OfferSchema.parse(offer);
    return { ...facts, staffName: staffName ?? null };
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function checkOfferEvidence(offer: Offer, messages: TranscriptMessage[]): EvidenceCheck {
  const parsedOffer = OfferSchema.safeParse(offer);
  const parsedMessages = TranscriptMessageSchema.array().safeParse(messages);
  if (!parsedOffer.success || !parsedMessages.success) return invalid("invalid_input");
  if (new Set(messages.map((message) => message.id)).size !== messages.length) return invalid("duplicate_message_ids");
  const ids = parsedOffer.data.evidenceMessageIds;
  const business = new Set(messages.filter((message) => message.final && message.speaker === "business")
    .map((message) => message.id));
  if (new Set(ids).size !== ids.length || !ids.every((id) => business.has(id))) return invalid("missing_business_evidence");
  return { valid: true };
}

export function checkAcceptancePlayback(snapshot: CallSnapshot, receipt: AcceptancePlayback, now: string): EvidenceCheck {
  const parsedSnapshot = CallSnapshotSchema.safeParse(snapshot);
  const parsedPermit = PlaybackPermitSchema.safeParse(receipt?.permit);
  const parsedOffer = OfferSchema.safeParse(receipt?.offer);
  if (!parsedSnapshot.success || !parsedPermit.success || !parsedOffer.success
    || !IdSchema.safeParse(receipt?.readbackMessageId).success
    || !IdSchema.safeParse(receipt?.acceptanceMessageId).success
    || !InstantSchema.safeParse(receipt?.startedAt).success
    || !InstantSchema.safeParse(receipt?.observedAt).success || !InstantSchema.safeParse(now).success) {
    return invalid("invalid_input");
  }
  const current = parsedSnapshot.data;
  const offer = current.activeOffer;
  const permit = parsedPermit.data;
  if (!offer || !offersEqual(offer, parsedOffer.data)) return invalid("offer_mismatch");
  if (permit.attemptId !== current.id || permit.planId !== current.plan.id
    || permit.planVersion !== current.plan.version || permit.offer?.id !== offer.id
    || permit.offer.version !== offer.version) return invalid("permit_mismatch");
  const start = Date.parse(receipt.startedAt);
  const observed = Date.parse(receipt.observedAt);
  // Approval/permit expiry after authorized playback starts does not undo a booking.
  if (start < Date.parse(current.plan.approvedAt) || start >= Date.parse(permit.expiresAt)
    || observed < start || observed > Date.parse(now)) return invalid("invalid_playback_time");
  const offerEvidence = checkOfferEvidence(offer, current.messages);
  if (!offerEvidence.valid) return offerEvidence;
  if (Object.values(offer.conditions).some((condition) => condition !== "none")) return invalid("unresolved_conditions");
  const readbackIndex = current.messages.findIndex((message) => message.id === receipt.readbackMessageId);
  const acceptanceIndex = current.messages.findIndex((message) => message.id === receipt.acceptanceMessageId);
  const readback = current.messages[readbackIndex];
  const acceptance = current.messages[acceptanceIndex];
  if (!readback || readback.speaker !== "assistant" || !readback.final || readback.playback !== "played") {
    return invalid("missing_readback");
  }
  if (!acceptance || acceptance.speaker !== "assistant" || !acceptance.final || acceptance.playback !== "played") {
    return invalid("acceptance_not_played");
  }
  if (acceptance.turnId !== permit.turnId
    || acceptance.originalText !== permit.approvedSpanishText
    || acceptance.originalText !== renderAcceptance(current.plan, offer)) {
    return invalid("acceptance_text_mismatch");
  }
  if (readbackIndex > acceptanceIndex || Date.parse(readback.createdAt) > Date.parse(acceptance.createdAt)
    || Date.parse(readback.createdAt) > observed
    || Date.parse(acceptance.createdAt) > observed
    || offer.evidenceMessageIds.some((id) => {
      const index = current.messages.findIndex((message) => message.id === id);
      return index >= readbackIndex || Date.parse(current.messages[index]!.createdAt) > start
        || Date.parse(current.messages[index]!.createdAt) > Date.parse(readback.createdAt);
    })) return invalid("evidence_out_of_order");
  return { valid: true };
}

export function checkConfirmationEvidence(input: {
  snapshot: CallSnapshot;
  receipt: AcceptancePlayback | null;
  evidenceMessageIds: string[];
  now: string;
  verifyMeaning?: ConfirmationVerifier;
}): EvidenceCheck {
  if (!input.receipt) return invalid("acceptance_not_played");
  const playback = checkAcceptancePlayback(input.snapshot, input.receipt, input.now);
  if (!playback.valid) return playback;
  const snapshot = CallSnapshotSchema.parse(input.snapshot);
  if (snapshot.bookingState !== "awaiting_business_confirmation") return invalid("evidence_out_of_order");
  const ids = IdSchema.array().min(1).max(50).safeParse(input.evidenceMessageIds);
  if (!ids.success || new Set(ids.data).size !== ids.data.length) return invalid("missing_confirmation");
  const acceptanceIndex = snapshot.messages.findIndex((message) => message.id === input.receipt!.acceptanceMessageId);
  const subsequent = snapshot.messages.slice(acceptanceIndex + 1).filter((message) => message.speaker === "business");
  if (subsequent.some((message) => !message.final)) return invalid("provisional_business_speech");
  const evidence = ids.data.map((id) => snapshot.messages.find((message) => message.id === id));
  if (evidence.some((message) => !message || message.speaker !== "business" || !message.final)) {
    return invalid("missing_confirmation");
  }
  if (evidence.some((message) => snapshot.messages.indexOf(message!) <= acceptanceIndex
    || Date.parse(message!.createdAt) < Date.parse(input.receipt!.observedAt)
    || Date.parse(message!.createdAt) > Date.parse(input.now))) return invalid("evidence_out_of_order");
  const latest = subsequent.at(-1);
  if (!latest || !ids.data.includes(latest.id)) return invalid("stale_confirmation");
  if (!input.verifyMeaning) return invalid("meaning_unverified");
  try {
    const verdict: unknown = input.verifyMeaning(structuredClone({
      offer: snapshot.activeOffer!, evidence: evidence as TranscriptMessage[],
      businessMessagesAfterAcceptance: subsequent,
    }));
    // Unsupported async reviewers cannot confirm; observe rejection to avoid an unhandled promise.
    if (verdict !== null && typeof verdict === "object" && "then" in verdict) {
      void Promise.resolve(verdict).catch(() => undefined);
    }
    if (verdict !== "affirmed") return invalid("meaning_unverified");
  } catch {
    return invalid("meaning_unverified");
  }
  return { valid: true };
}
