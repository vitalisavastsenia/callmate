import type { Offer, Outcome } from "@callmate/contracts";
import { serviceKey } from "./spanish.js";

export const notBookedSummaries: Record<Extract<Outcome, { status: "not_booked" }>["reason"], string> = {
  no_availability: "No appointment was booked because no suitable slot was available.",
  business_declined: "The business declined the request. Contact it directly to arrange an appointment.",
  busy: "The business line was busy. No appointment was booked.",
  no_answer: "The business did not answer. No appointment was booked.",
  user_stopped: "The call was stopped before acceptance. No appointment was booked.",
  policy_declined: "The offer was not accepted under the approved instructions. No appointment was booked.",
  technical_failure: "The call could not complete before acceptance. No appointment was booked.",
};
export const uncertainSummaries: Record<Extract<Outcome, { status: "uncertain" }>["reason"], string> = {
  disconnected_near_confirmation: "The call ended near acceptance. Check with the business before trying again.",
  ambiguous_confirmation: "The appointment could not be confirmed reliably. Check with the business before trying again.",
  creation_unknown: "It is unknown whether the call was created. Reconcile the existing attempt before trying again.",
  provider_state_unknown: "The call state is unknown. Check the existing attempt and business before trying again.",
};

/** Only called after evidence validation; never lets model-authored prose claim success. */
export function confirmedSummaryEn(offer: Offer, businessName: string, additionalDetails = ""): string {
  // Format integer cents directly, preserving precision at the schema's maximum amount.
  const cents = offer.price === null ? null : String(offer.price.amountMinor).padStart(3, "0");
  const price = cents === null ? "an explicitly authorized unknown price" : `€${cents.slice(0, -2)}.${cents.slice(-2)}`;
  const service = serviceKey(offer.service) === "haircut" ? "Haircut" : "Appointment";
  const prefix = `${service} confirmed with `;
  const staff = offer.staffName ? `, with ${offer.staffName}` : "";
  const suffix = ` for ${offer.appointment.localDate} at ${offer.appointment.localTime} in ${offer.appointment.timeZone}, under ${offer.bookingName}${staff}, for ${price}. ${offer.durationMinutes === null ? "Duration is unknown." : `Duration: ${offer.durationMinutes} minutes.`}${additionalDetails}`;
  const nameBudget = 4000 - prefix.length - suffix.length;
  const summaryName = businessName.length <= nameBudget
    ? businessName
    : `${businessName.slice(0, nameBudget - 1)}…`;
  return `${prefix}${summaryName}${suffix}`;
}
