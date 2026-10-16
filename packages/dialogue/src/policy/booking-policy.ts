import {
  templateForRequest, CallSnapshotSchema, CandidateActionSchema, InstantSchema, TextSchema,
  type BookingPolicyPort, type CallSnapshot, type Offer, type PolicyDecision,
} from "@callmate/contracts";
import { checkOfferEvidence, offersEqual } from "../booking/evidence.js";
import {
  renderAvailability, renderClarification, renderClosing, serviceKey,
} from "../language/spanish.js";
import { renderAction, renderAcceptance, renderReadback } from "../language/catalog.js";
import { checkHardConstraints, offerException } from "./constraints.js";
import { checkExactOfferGrant, type PolicyInput } from "./grants.js";
import { evaluateConversationAction, isConversationAction } from "../planner/conversation.js";

const deny = (reason: string): PolicyDecision => ({ decision: "deny", reason });
const allow = (text: string): PolicyDecision => {
  const parsed = TextSchema.safeParse(text);
  return parsed.success ? { decision: "allow", approvedSpanishText: parsed.data } : deny("unrenderable_response");
};
const progressStates = new Set<CallSnapshot["bookingState"]>(["pending", "offer_received", "awaiting_approval"]);

/** Synchronous policy with no provider calls, database access, grant creation, or playback side effects. */
export class BookingPolicy implements BookingPolicyPort {
  evaluate(input: PolicyInput): PolicyDecision {
    try {
      const decision = this.evaluateControlled(input);
      if (decision.decision !== "allow") return decision;
      const legacy = templateForRequest(input.snapshot.plan.request)?.id === "haircut";
      if (legacy && (!input.snapshot.plan.request.language || input.snapshot.plan.request.language === "es-ES") && input.candidate.action !== "ask_requirements"
        && !(input.candidate.action === "clarify" && input.candidate.missing.includes("details"))) return decision;
      const snapshot = CallSnapshotSchema.parse(input.snapshot);
      const candidate = CandidateActionSchema.parse(input.candidate);
      const plan = { ...snapshot.plan, request: { ...snapshot.plan.request,
        availability: snapshot.plan.request.availability.filter(w => Date.parse(w.end.instant) > Date.parse(input.now)) } };
      return allow(renderAction(candidate, plan, snapshot.activeOffer, undefined, snapshot.outcome.status === "confirmed").text);
    } catch { return deny("unrenderable_response"); }
  }

  private evaluateControlled(input: PolicyInput): PolicyDecision {
    const snapshotResult = CallSnapshotSchema.safeParse(input?.snapshot);
    const candidateResult = CandidateActionSchema.safeParse(input?.candidate);
    const timeResult = InstantSchema.safeParse(input?.now);
    if (!snapshotResult.success || !candidateResult.success || !timeResult.success || input.grant === undefined) {
      return deny("invalid_input");
    }
    const snapshot = snapshotResult.data;
    const candidate = candidateResult.data;
    const now = timeResult.data;
    if (snapshot.callState !== "connected") return deny("call_not_active");
    if (Date.parse(snapshot.plan.approvedAt) > Date.parse(now) || Date.parse(snapshot.updatedAt) > Date.parse(now)) {
      return deny("invalid_authority_time");
    }
    if (templateForRequest(snapshot.plan.request)?.id !== "haircut" && ["request_add_on", "record_note"].includes(candidate.action)) return deny("haircut_action_in_other_domain");
    if (isConversationAction(candidate)) {
      try { return evaluateConversationAction(snapshot, candidate, now); }
      catch { return deny("unrenderable_response"); }
    }
    if (snapshot.outcome.status === "confirmed" && candidate.action === "end_call") return allow("Perfecto, muchas gracias. Hasta luego.");
    if (snapshot.outcome.status !== "pending") return deny("booking_terminal");
    if (snapshot.conversation?.pending && ["read_back", "accept_offer", "evaluate_offer"].includes(candidate.action)) {
      return deny("conversation_decision_pending");
    }
    switch (candidate.action) {
      case "clarify": return allow(renderClarification(candidate.missing, snapshot.plan.request.tone));
      case "end_call": return allow(renderClosing(candidate.reason));
      case "ask_requirements":
        if (!progressStates.has(snapshot.bookingState)) return deny("commitment_in_progress");
        if (!templateForRequest(snapshot.plan.request)) return { decision: "clarify", field: "service" };
        return this.render(snapshot, () => renderAction(candidate, snapshot.plan, snapshot.activeOffer).text);
      case "ask_availability": {
        if (!progressStates.has(snapshot.bookingState)) return deny("commitment_in_progress");
        if (!serviceKey(snapshot.plan.request.service)) return { decision: "clarify", field: "service" };
        const availability = snapshot.plan.request.availability.filter((window) => Date.parse(window.end.instant) > Date.parse(now));
        if (!availability.length) return deny("no_future_availability");
        return this.render(snapshot, () => renderAvailability({ ...snapshot.plan,
          request: { ...snapshot.plan.request, availability } }));
      }
      case "record_business_confirmation": {
        // This authorizes only a neutral acknowledgement. Outcome/evidence verification is separate.
        if (snapshot.bookingState !== "awaiting_business_confirmation") return deny("confirmation_not_expected");
        if (!this.matchesReference(snapshot, candidate.offerId, candidate.offerVersion)) return deny("stale_offer");
        const ids = candidate.evidenceMessageIds;
        const latest = snapshot.messages.findLast((message) => message.speaker === "business");
        if (!snapshot.activeOffer || !checkOfferEvidence({ ...snapshot.activeOffer, evidenceMessageIds: ids }, snapshot.messages).valid
          || !latest?.final || !ids.includes(latest.id)
          || snapshot.messages.some((message) => ids.includes(message.id) && Date.parse(message.createdAt) > Date.parse(now))) {
          return deny("invalid_confirmation_evidence");
        }
        return allow("Gracias por la información.");
      }
      case "evaluate_offer": {
        if (!progressStates.has(snapshot.bookingState)) return deny("commitment_in_progress");
        const active = snapshot.activeOffer;
        if (active?.id === candidate.offer.id && (candidate.offer.version < active.version
          || (candidate.offer.version === active.version && !offersEqual(active, candidate.offer)))) return deny("stale_offer");
        if (snapshot.pendingApproval && !offersEqual(snapshot.pendingApproval.offer, candidate.offer)) return deny("offer_update_required");
        const decision = this.evaluateOffer(snapshot, candidate.offer, now, input.grant);
        return decision ?? allow("Gracias. Voy a comprobar la propuesta antes de aceptar nada.");
      }
      case "read_back":
      case "accept_offer": {
        if (snapshot.bookingState === "awaiting_business_confirmation") return deny("commitment_in_progress");
        if (!this.matchesReference(snapshot, candidate.offerId, candidate.offerVersion)) return deny("stale_offer");
        const offer = snapshot.activeOffer!;
        const decision = this.evaluateOffer(snapshot, offer, now, input.grant);
        if (decision) return decision;
        if (candidate.action === "read_back") {
          if (snapshot.bookingState !== "offer_received" && snapshot.bookingState !== "reading_back") return deny("readback_not_expected");
          return this.render(snapshot, () => renderReadback(snapshot.plan, offer));
        }
        if (snapshot.bookingState !== "reading_back") return deny("acceptance_not_expected");
        const text = renderAcceptance(snapshot.plan, offer);
        const lastOfferEvidence = Math.max(...offer.evidenceMessageIds.map((id) => snapshot.messages.findIndex((message) => message.id === id)));
        const latestOfferTime = Math.max(...snapshot.messages.filter((message) => offer.evidenceMessageIds.includes(message.id))
          .map((message) => Date.parse(message.createdAt)));
        const readbackText = renderReadback(snapshot.plan, offer);
        const readbackIndex = snapshot.messages.findLastIndex((message, index) => index > lastOfferEvidence
          && message.speaker === "assistant" && message.originalText === readbackText);
        const readback = snapshot.messages[readbackIndex];
        if (!readback || !readback.final || readback.playback !== "played"
          || Date.parse(readback.createdAt) > Date.parse(now)
          || Date.parse(readback.createdAt) < latestOfferTime) {
          return { decision: "clarify", field: "readback" };
        }
        if (snapshot.messages.some((message) => message.speaker === "assistant" && message.originalText === text
          && ["playing", "played", "interrupted"].includes(message.playback))) return deny("acceptance_already_started");
        return this.render(snapshot, () => text);
      }
    }
  }

  private matchesReference(snapshot: CallSnapshot, id: string, version: number): boolean {
    return snapshot.activeOffer?.id === id && snapshot.activeOffer.version === version;
  }

  private render(snapshot: CallSnapshot, render: () => string): PolicyDecision {
    // Do not allow control characters or markup in the reviewed name to become spoken instructions.
    if (/[\p{Cc}\p{Cf}<>]/u.test(snapshot.plan.request.bookingName)) return deny("unrenderable_booking_name");
    return allow(render());
  }

  private evaluateOffer(snapshot: CallSnapshot, offer: Offer, now: string, grant: PolicyInput["grant"]): PolicyDecision | null {
    const hardConstraint = checkHardConstraints(snapshot, offer, now);
    if (hardConstraint) return hardConstraint;
    if (snapshot.messages.some((message) => message.speaker === "business" && !message.final)) return deny("unresolved_business_speech");
    const authority = checkExactOfferGrant(snapshot, offer, now, grant);
    if (authority.status === "invalid") return deny(authority.reason);
    // A pending request is unresolved authority, even if a grant-shaped value was also supplied.
    if (snapshot.pendingApproval) return { decision: "ask_user", reason: snapshot.pendingApproval.reason };
    const exception = offerException(snapshot, offer);
    if (exception && authority.status !== "valid") return { decision: "ask_user", reason: exception };
    return null;
  }
}

export function createBookingPolicy(): BookingPolicyPort { return new BookingPolicy(); }
