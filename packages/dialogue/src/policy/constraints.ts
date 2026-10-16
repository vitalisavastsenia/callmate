import { templateForRequest } from "@callmate/contracts";
import type { CallSnapshot, Offer, PolicyDecision } from "@callmate/contracts";
import { checkOfferEvidence } from "../booking/evidence.js";
import { namesMatch, serviceKey } from "../language/spanish.js";

/** Hard constraints cannot be overridden by an exact-offer grant. */
export function checkHardConstraints(snapshot: CallSnapshot, offer: Offer, now: string): PolicyDecision | null {
  const request = snapshot.plan.request;
  if (!checkOfferEvidence(offer, snapshot.messages).valid) return { decision: "deny", reason: "invalid_offer_evidence" };
  if (snapshot.messages.some((message) => offer.evidenceMessageIds.includes(message.id)
    && Date.parse(message.createdAt) > Date.parse(now))) return { decision: "deny", reason: "future_offer_evidence" };
  if (Object.values(offer.conditions).some((condition) => condition === "required")) {
    return { decision: "deny", reason: "prohibited_conditions" };
  }
  if (templateForRequest(request)?.id !== "haircut" && Object.values(offer.conditions).some((condition) => condition === "unknown")) {
    return { decision: "clarify", field: "conditions" };
  }
  const profile = templateForRequest(request);
  if (profile) {
    if (Object.entries(offer.templateDetails ?? {}).some(([key, value]) => value != null && !profile.fields.some(field => field.key === key))) return { decision: "deny", reason: "unexpected_domain_detail" };
    for (const field of profile.fields) {
      if (offer.templateDetails?.[field.key] == null) return { decision: "clarify", field: "details" };
      if (offer.templateDetails[field.key] !== request.templateDetails?.[field.key]) return { decision: "deny", reason: "domain_details_mismatch" };
    }
  }
  const planService = serviceKey(request.service);
  if (!planService) return { decision: "clarify", field: "service" };
  if (serviceKey(offer.service) !== planService) return { decision: "deny", reason: "service_mismatch" };
  if (!namesMatch(offer.bookingName, request.bookingName)) return { decision: "clarify", field: "name" };
  if (offer.appointment.timeZone !== request.availability[0]!.start.timeZone) {
    return { decision: "deny", reason: "timezone_mismatch" };
  }
  if (Date.parse(offer.appointment.instant) <= Date.parse(now)) return { decision: "deny", reason: "appointment_not_future" };
  return null;
}

/** Stable priority when several exceptions apply; the approval card still contains the entire offer. */
export function offerException(snapshot: CallSnapshot, offer: Offer): Extract<PolicyDecision, { decision: "ask_user" }>["reason"] | null {
  const request = snapshot.plan.request;
  const start = Date.parse(offer.appointment.instant);
  const end = start + (offer.durationMinutes ?? 0) * 60000;
  const withinAvailability = request.availability.some((window) => start >= Date.parse(window.start.instant)
    && start < Date.parse(window.end.instant) && end <= Date.parse(window.end.instant));
  if (!withinAvailability) return "outside_availability";
  if (offer.price && request.pricePolicy.maximum && offer.price.amountMinor > request.pricePolicy.maximum.amountMinor) {
    return "above_price_limit";
  }
  if (offer.price === null && !request.pricePolicy.allowUnknownPrice) return "unknown_price";
  if (request.bookingAuthority === "ask_before_accepting") return "user_confirmation_required";
  return null;
}
