import {
  ApprovalRequestSchema, CallSnapshotSchema, InstantSchema, OfferRefSchema, OfferSchema,
  type CallSnapshot, type Offer,
} from "@callmate/contracts";
import { checkAcceptancePlayback, checkOfferEvidence, offersEqual, type AcceptancePlayback, type ConfirmationVerifier } from "./evidence.js";
import { deriveOutcome, type NotBookedReason, type UncertainReason } from "./outcome.js";

export type BookingUpdate = Pick<CallSnapshot, "bookingState" | "activeOffer" | "pendingApproval" | "outcome"> & {
  acceptance: AcceptancePlayback | null;
} & Pick<CallSnapshot, "conversation">;
/** Controller events, not candidate actions. Policy/playback authority stays in the controller. */
export type BookingEvent =
  | { type: "offer_received"; offer: Offer }
  | { type: "approval_requested"; approval: NonNullable<CallSnapshot["pendingApproval"]> }
  | { type: "approval_resolved"; approvalId: string; status: "approved" | "rejected" | "expired" | "invalidated" }
  | { type: "readback_started"; offerId: string; offerVersion: number }
  | { type: "acceptance_played"; receipt: AcceptancePlayback }
  | { type: "business_confirmation"; evidenceMessageIds: string[]; verifyMeaning?: ConfirmationVerifier }
  | { type: "call_finished"; reason: NotBookedReason }
  | { type: "uncertainty"; reason: UncertainReason };

export class BookingTransitionError extends Error {
  constructor(message: string) { super(message); this.name = "BookingTransitionError"; }
}
const requireCondition: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new BookingTransitionError(message);
};

/** Returns booking fields only; the controller atomically persists them with its own revisions/events. */
export function reduceBooking(
  snapshot: CallSnapshot, event: BookingEvent, now: string, acceptance: AcceptancePlayback | null = null,
): BookingUpdate {
  const current = CallSnapshotSchema.parse(snapshot);
  InstantSchema.parse(now);
  const update: BookingUpdate = {
    bookingState: current.bookingState, activeOffer: current.activeOffer,
    pendingApproval: current.pendingApproval, outcome: current.outcome,
    acceptance: acceptance ? structuredClone(acceptance) : null,
    ...(current.conversation ? { conversation: current.conversation } : {}),
  };
  const invalidateConsent = () => {
    const conversation = update.conversation;
    if (!conversation?.pending) return;
    conversation.decisions.push({ request: conversation.pending, status: "invalidated", answer: null, resolvedAt: now });
    conversation.pending = null;
  };
  const finish = (): BookingUpdate => {
    const { acceptance: receipt, ...fields } = update;
    CallSnapshotSchema.parse({ ...current, ...fields });
    return structuredClone({ ...fields, acceptance: receipt });
  };
  const applyOutcome = (outcome: ReturnType<typeof deriveOutcome>) => {
    requireCondition(outcome.status !== "pending", "An outcome event must resolve booking state");
    update.outcome = outcome;
    update.bookingState = outcome.status;
    update.pendingApproval = null;
    if (outcome.status !== "confirmed") invalidateConsent();
  };
  // Stop must also clear post-booking contact/add-on consent without undoing a confirmed appointment.
  if (event.type === "call_finished" || event.type === "uncertainty") invalidateConsent();
  // Terminal booking outcomes never regress, including after Stop or late callbacks.
  if (current.outcome.status !== "pending") return finish();
  if (event.type === "call_finished" || event.type === "uncertainty") {
    applyOutcome(deriveOutcome(current, event, now, acceptance));
    return finish();
  }
  const recordingEvidence = event.type === "business_confirmation" || event.type === "acceptance_played";
  requireCondition(current.callState === "connected"
    || (recordingEvidence && (current.callState === "ending" || current.callState === "reconciliation_required")),
  "Booking progress requires a connected call; only existing playback/confirmation evidence may be reconciled");
  switch (event.type) {
    case "offer_received": {
      const offer = OfferSchema.parse(event.offer);
      requireCondition(checkOfferEvidence(offer, current.messages).valid, "Offer evidence is invalid");
      if (current.activeOffer?.id === offer.id) {
        requireCondition(offer.version >= current.activeOffer.version, "Offer version is stale");
        if (offer.version === current.activeOffer.version) {
          requireCondition(offersEqual(offer, current.activeOffer), "Offer identity cannot change without a new version");
          return finish();
        }
      }
      if (acceptance || current.bookingState === "reading_back" || current.bookingState === "awaiting_business_confirmation") {
        applyOutcome(deriveOutcome(current, { type: "uncertainty", reason: "ambiguous_confirmation" }, now, acceptance));
      } else {
        invalidateConsent();
        update.activeOffer = offer;
        update.bookingState = "offer_received";
        update.pendingApproval = null;
        update.acceptance = null;
      }
      break;
    }
    case "approval_requested": {
      requireCondition(current.bookingState === "offer_received" || current.bookingState === "awaiting_approval",
        "Approval requires an unaccepted offer");
      requireCondition(!acceptance, "Approval cannot follow a possible acceptance");
      const approval = ApprovalRequestSchema.parse(event.approval);
      requireCondition(approval.attemptId === current.id && approval.plan.planId === current.plan.id
        && approval.plan.planVersion === current.plan.version && current.activeOffer
        && offersEqual(approval.offer, current.activeOffer), "Approval must match this attempt, plan, and exact offer");
      requireCondition(Date.parse(approval.createdAt) <= Date.parse(now) && Date.parse(now) < Date.parse(approval.expiresAt),
        "Approval request is not current");
      requireCondition(!current.pendingApproval || JSON.stringify(current.pendingApproval) === JSON.stringify(approval),
        "Resolve the current approval before replacing it");
      update.pendingApproval = approval;
      update.bookingState = "awaiting_approval";
      break;
    }
    case "approval_resolved": {
      requireCondition(current.pendingApproval && current.pendingApproval.id === event.approvalId, "Approval resolution is stale");
      if (event.status === "approved") {
        requireCondition(Date.parse(now) < Date.parse(current.pendingApproval.expiresAt), "Approval has expired");
      } else if (event.status === "expired") {
        requireCondition(Date.parse(now) >= Date.parse(current.pendingApproval.expiresAt), "Approval has not expired");
      } else requireCondition(event.status === "rejected" || event.status === "invalidated", "Unsupported approval resolution");
      update.pendingApproval = null;
      update.bookingState = "offer_received";
      if (event.status === "rejected" || event.status === "expired") {
        applyOutcome(deriveOutcome(current, { type: "call_finished", reason: "policy_declined" }, now, acceptance));
      }
      break;
    }
    case "readback_started": {
      const ref = OfferRefSchema.parse({ offerId: event.offerId, offerVersion: event.offerVersion });
      requireCondition(current.bookingState === "offer_received" && !current.pendingApproval && !acceptance,
        "Readback requires a current offer and no pending approval or acceptance");
      requireCondition(current.activeOffer?.id === ref.offerId && current.activeOffer.version === ref.offerVersion,
        "Readback offer is stale");
      requireCondition(checkOfferEvidence(current.activeOffer, current.messages).valid, "Offer evidence is invalid");
      update.bookingState = "reading_back";
      break;
    }
    case "acceptance_played": {
      requireCondition(current.bookingState === "reading_back" || current.bookingState === "awaiting_business_confirmation",
        "Acceptance must follow readback");
      requireCondition(checkAcceptancePlayback(current, event.receipt, now).valid, "Authorized, complete acceptance playback is required");
      requireCondition(!acceptance || JSON.stringify(acceptance) === JSON.stringify(event.receipt), "Acceptance receipt cannot be replaced");
      update.acceptance = structuredClone(event.receipt);
      update.bookingState = "awaiting_business_confirmation";
      break;
    }
    case "business_confirmation": {
      requireCondition(current.bookingState === "awaiting_business_confirmation", "Business confirmation must follow acceptance playback");
      applyOutcome(deriveOutcome(current, event, now, acceptance));
      break;
    }
    default: throw new BookingTransitionError("Unsupported booking event");
  }
  return finish();
}
