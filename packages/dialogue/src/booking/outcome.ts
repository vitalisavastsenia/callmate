import {
  CallSnapshotSchema, InstantSchema, OutcomeSchema, type CallSnapshot, type Outcome,
} from "@callmate/contracts";
import { checkConfirmationEvidence, type AcceptancePlayback, type ConfirmationVerifier } from "./evidence.js";
import { confirmedSummaryEn, notBookedSummaries, uncertainSummaries } from "../language/results.js";

export type NotBookedReason = Extract<Outcome, { status: "not_booked" }>["reason"];
export type UncertainReason = Extract<Outcome, { status: "uncertain" }>["reason"];
export type OutcomeEvent =
  | { type: "business_confirmation"; evidenceMessageIds: string[]; verifyMeaning?: ConfirmationVerifier }
  | { type: "call_finished"; reason: NotBookedReason }
  | { type: "uncertainty"; reason: UncertainReason };

/** Pure outcome derivation. The caller supplies time and any controller-owned playback receipt. */
export function deriveOutcome(
  snapshot: CallSnapshot, event: OutcomeEvent, now: string, receipt: AcceptancePlayback | null = null,
): Outcome {
  const current = CallSnapshotSchema.parse(snapshot);
  InstantSchema.parse(now);
  if (current.outcome.status !== "pending") return current.outcome;
  if (event.type === "business_confirmation") {
    const check = checkConfirmationEvidence({
      snapshot: current, receipt, evidenceMessageIds: event.evidenceMessageIds, now,
      ...(event.verifyMeaning ? { verifyMeaning: event.verifyMeaning } : {}),
    });
    if (!check.valid) return {
      status: "uncertain", reason: "ambiguous_confirmation", summaryEn: uncertainSummaries.ambiguous_confirmation,
    };
    const offer = current.activeOffer!;
    const confirmedAt = event.evidenceMessageIds.map((id) => current.messages.find((message) => message.id === id)!.createdAt)
      .reduce((latest, instant) => Date.parse(instant) > Date.parse(latest) ? instant : latest);
    return OutcomeSchema.parse({
      status: "confirmed", offer, confirmedAt, confirmationMessageIds: event.evidenceMessageIds,
      summaryEn: confirmedSummaryEn(offer, current.plan.request.business.name),
    });
  }
  if (event.type === "uncertainty") return OutcomeSchema.parse({
    status: "uncertain", reason: event.reason, summaryEn: uncertainSummaries[event.reason],
  });
  if (event.type !== "call_finished") throw new Error("Unsupported booking outcome event");
  // A readback may include acceptance. Neither Stop nor transport completion cancels a possible booking.
  if (receipt || current.bookingState === "reading_back" || current.bookingState === "awaiting_business_confirmation") {
    return { status: "uncertain", reason: "disconnected_near_confirmation", summaryEn: uncertainSummaries.disconnected_near_confirmation };
  }
  return OutcomeSchema.parse({ status: "not_booked", reason: event.reason, summaryEn: notBookedSummaries[event.reason] });
}
