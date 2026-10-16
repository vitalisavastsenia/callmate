import {
  CallSnapshotSchema, IdSchema, InstantSchema, OfferRefSchema, OfferSchema, OutcomeSchema,
  PlaybackPermitSchema, TextSchema,
  type CallSnapshot, type ConversationRequest, type Offer, type Outcome, type PlaybackPermit, type TranscriptMessage,
} from "@callmate/contracts";
import { checkOfferEvidence, offersEqual } from "./evidence.js";
import { confirmedSummaryEn } from "../language/results.js";
import { offerDetails } from "../language/spanish.js";
import { friendly, speechSlot } from "../language/conversation.js";

type AddOnRequest = Extract<ConversationRequest, { kind: "add_on" }>;
export type AddOnAcceptance = {
  decisionId: string;
  baseOffer: Offer;
  offer: Offer;
  approvedSpanishText: string;
  expiresAt: string;
};
/** Controller-attested playback, subject to the same permit/cancellation controls as base acceptance. */
export type AddOnPlayback = {
  acceptance: AddOnAcceptance;
  permit: PlaybackPermit;
  acceptanceMessageId: string;
  startedAt: string;
  observedAt: string;
};
export type AddOnConfirmationVerifier = (input: {
  offer: Offer; supplement: AddOnRequest["supplement"];
  evidence: TranscriptMessage[]; businessMessagesAfterAcceptance: TranscriptMessage[];
}) => "affirmed" | "ambiguous" | "contradicted";
export type AddOnBookingUpdate = Pick<CallSnapshot,
  "activeOffer" | "bookingState" | "outcome" | "pendingApproval" | "conversation">;

const requireState: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};
const money = (minor: number): string => {
  const digits = String(minor).padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

function terms(snapshot: CallSnapshot, decisionId: string, identity: { offerId: string; offerVersion: number }, startedAt: string): AddOnAcceptance {
  IdSchema.parse(decisionId);
  OfferRefSchema.parse(identity);
  InstantSchema.parse(startedAt);
  const decision = snapshot.conversation?.decisions.find(item => item.request.id === decisionId);
  requireState(decision?.status === "approved" && decision.request.kind === "add_on", "Approved add-on consent is required");
  const request = decision.request;
  const base = snapshot.activeOffer;
  requireState(snapshot.outcome.status === "confirmed" && base && offersEqual(snapshot.outcome.offer, base),
    "Confirm the base appointment before accepting an add-on");
  requireState(!snapshot.pendingApproval && !snapshot.conversation?.pending, "Resolve pending consent before accepting an add-on");
  requireState(request.attemptId === snapshot.id && request.plan.planId === snapshot.plan.id
    && request.plan.planVersion === snapshot.plan.version && request.offer.offerId === base.id
    && request.offer.offerVersion === base.version, "Add-on consent is stale");
  requireState(Date.parse(request.createdAt) <= Date.parse(decision.resolvedAt)
    && Date.parse(decision.resolvedAt) <= Date.parse(startedAt) && Date.parse(snapshot.outcome.confirmedAt) <= Date.parse(startedAt)
    && Date.parse(snapshot.plan.approvedAt) <= Date.parse(startedAt)
    && Date.parse(startedAt) < Date.parse(request.expiresAt), "Add-on consent has expired or is not current");
  requireState(identity.offerId !== base.id || identity.offerVersion > base.version, "An amended offer needs a fresh controller identity");
  requireState(base.price && request.totalPrice.amountMinor === base.price.amountMinor + request.supplement.additionalPrice.amountMinor
    && Object.values(base.conditions).every(value => value === "none")
    && Object.values(request.supplement.conditions).every(value => value === "none"), "Add-on terms are invalid or prohibited");
  const evidenceMessageIds = [...new Set([...base.evidenceMessageIds, ...request.evidenceMessageIds])];
  // A supplement has no known duration in v1. Never reuse the haircut duration as the combined duration.
  const offer = OfferSchema.parse({ ...base, id: identity.offerId, version: identity.offerVersion,
    price: request.totalPrice, durationMinutes: null, evidenceMessageIds });
  requireState(checkOfferEvidence(offer, snapshot.messages).valid
    && snapshot.messages.filter(message => evidenceMessageIds.includes(message.id))
      .every(message => Date.parse(message.createdAt) <= Date.parse(request.createdAt)), "Add-on evidence is invalid");
  const text = `Acepto añadir ${speechSlot(request.supplement.serviceEs)} a la cita para ${offerDetails(snapshot.plan, base)}, con un suplemento de ${money(request.supplement.additionalPrice.amountMinor)} euros y un precio total de ${money(request.totalPrice.amountMinor)} euros. ¿${friendly(snapshot.plan.request.tone ?? "formal") ? "Puedes" : "Puede"} confirmar que la cita incluye el servicio adicional con esos datos?`;
  speechSlot(snapshot.plan.request.bookingName);
  return { decisionId, baseOffer: base, offer, approvedSpanishText: TextSchema.parse(text), expiresAt: request.expiresAt };
}

/** Pure preparation only. The controller reserves identity, persists these terms, and authorizes actual playback. */
export function prepareAddOnAcceptance(snapshot: CallSnapshot, decisionId: string,
  identity: { offerId: string; offerVersion: number }, now: string): AddOnAcceptance {
  const current = CallSnapshotSchema.parse(snapshot);
  InstantSchema.parse(now);
  requireState(current.callState === "connected" && Date.parse(current.updatedAt) <= Date.parse(now), "Call is not current and connected");
  const acceptance = terms(current, decisionId, identity, now);
  const latest = current.messages.findLast(message => message.speaker === "business");
  const request = current.conversation!.decisions.find(item => item.request.id === decisionId)!.request;
  requireState(latest?.final && request.evidenceMessageIds.includes(latest.id)
    && Date.parse(latest.createdAt) <= Date.parse(now)
    && !current.messages.some(message => message.speaker === "business" && !message.final), "Add-on evidence has been superseded");
  requireState(!current.messages.some(message => message.speaker === "assistant"
    && message.originalText === acceptance.approvedSpanishText
    && ["playing", "played", "interrupted"].includes(message.playback)), "Add-on acceptance has already started");
  return structuredClone(acceptance);
}

/** Reconcile an already played amendment; consent alone never revises the confirmed booking. */
export function reconcileAddOn(snapshot: CallSnapshot, receipt: AddOnPlayback, evidenceMessageIds: string[], now: string,
  verifyMeaning?: AddOnConfirmationVerifier): AddOnBookingUpdate {
  const current = CallSnapshotSchema.parse(snapshot);
  InstantSchema.parse(now);
  const conversation = current.conversation;
  if (conversation?.pending) {
    conversation.decisions.push({ request: conversation.pending, status: "invalidated", answer: null, resolvedAt: now });
    conversation.pending = null;
  }
  const permit = PlaybackPermitSchema.parse(receipt.permit);
  InstantSchema.parse(receipt.startedAt);
  InstantSchema.parse(receipt.observedAt);
  IdSchema.parse(receipt.acceptanceMessageId);
  const expected = terms(current, receipt.acceptance.decisionId,
    { offerId: receipt.acceptance.offer.id, offerVersion: receipt.acceptance.offer.version }, receipt.startedAt);
  requireState(offersEqual(expected.baseOffer, receipt.acceptance.baseOffer) && offersEqual(expected.offer, receipt.acceptance.offer)
    && expected.approvedSpanishText === receipt.acceptance.approvedSpanishText
    && expected.expiresAt === receipt.acceptance.expiresAt, "Amended acceptance terms do not match consent");
  requireState(permit.attemptId === current.id && permit.planId === current.plan.id && permit.planVersion === current.plan.version
    && permit.offer?.id === expected.offer.id && permit.offer.version === expected.offer.version
    && permit.approvedSpanishText === expected.approvedSpanishText, "Amended playback permit does not match");
  requireState(Date.parse(receipt.startedAt) < Date.parse(permit.expiresAt)
    && Date.parse(receipt.startedAt) <= Date.parse(receipt.observedAt)
    && Date.parse(receipt.observedAt) <= Date.parse(now), "Amended playback time is invalid");
  const acceptanceIndex = current.messages.findIndex(message => message.id === receipt.acceptanceMessageId);
  const played = current.messages[acceptanceIndex];
  const after = current.messages.slice(acceptanceIndex + 1).filter(message => message.speaker === "business");
  const ids = IdSchema.array().min(1).max(50).safeParse(evidenceMessageIds);
  const evidence = ids.success ? current.messages.filter(message => ids.data.includes(message.id)) : [];
  const before = current.messages.slice(0, acceptanceIndex).filter(message => message.speaker === "business");
  const request = current.conversation!.decisions.find(item => item.request.id === expected.decisionId)!.request as AddOnRequest;
  let affirmed = false;
  if (new Set(current.messages.map(message => message.id)).size === current.messages.length
    && played?.speaker === "assistant" && played.final && played.playback === "played" && played.turnId === permit.turnId
    && played.originalText === expected.approvedSpanishText
    && Date.parse(played.createdAt) >= Date.parse(receipt.startedAt) && Date.parse(played.createdAt) <= Date.parse(receipt.observedAt)
    && expected.offer.evidenceMessageIds.every(id => current.messages.findIndex(message => message.id === id) < acceptanceIndex)
    && before.at(-1)?.final && request.evidenceMessageIds.includes(before.at(-1)!.id)
    && ids.success && new Set(ids.data).size === ids.data.length && evidence.length === ids.data.length
    && after.length > 0 && after.every(message => message.final && Date.parse(message.createdAt) <= Date.parse(now))
    && ids.data.includes(after.at(-1)!.id)
    && evidence.every(message => after.includes(message) && Date.parse(message.createdAt) >= Date.parse(receipt.observedAt))
    && verifyMeaning) {
    try {
      const verdict: unknown = verifyMeaning(structuredClone({ offer: expected.offer, supplement: request.supplement,
        evidence, businessMessagesAfterAcceptance: after }));
      if (verdict !== null && typeof verdict === "object" && "then" in verdict) void Promise.resolve(verdict).catch(() => undefined);
      affirmed = verdict === "affirmed";
    } catch { /* Unverified amendments remain uncertain. */ }
  }
  const summary = confirmedSummaryEn(expected.offer, current.plan.request.business.name, ` Includes ${request.supplement.serviceEn}.`);
  const outcome: Outcome = affirmed ? OutcomeSchema.parse({ status: "confirmed", offer: expected.offer,
    confirmedAt: evidence.reduce((latest, message) => Date.parse(message.createdAt) > Date.parse(latest) ? message.createdAt : latest, evidence[0]!.createdAt),
    confirmationMessageIds: evidenceMessageIds, summaryEn: summary }) : {
    status: "uncertain", reason: "ambiguous_confirmation",
    summaryEn: "The original appointment was confirmed, but the additional service could not be confirmed reliably. Check with the business before trying again.",
  };
  const update: AddOnBookingUpdate = { activeOffer: affirmed ? expected.offer : current.activeOffer,
    bookingState: outcome.status, outcome, pendingApproval: null, conversation: current.conversation! };
  CallSnapshotSchema.parse({ ...current, ...update });
  return structuredClone(update);
}
