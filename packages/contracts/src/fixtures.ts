import { ApprovalRequestSchema, ApprovedPlanSchema, CallSnapshotSchema, DomainEventSchema, OfferSchema, ReviewPlanSchema } from "./schemas.js";

// Synthetic, non-dialable examples. Never use fixture data as live-call configuration.
export const ids = {
  plan: "10000000-0000-4000-8000-000000000001",
  attempt: "10000000-0000-4000-8000-000000000002",
  offer: "10000000-0000-4000-8000-000000000003",
  businessMessage: "10000000-0000-4000-8000-000000000004",
  turn: "10000000-0000-4000-8000-000000000005",
  event: "10000000-0000-4000-8000-000000000006",
  approval: "10000000-0000-4000-8000-000000000007",
  confirmation: "10000000-0000-4000-8000-000000000008",
} as const;
const zoned = (hour: string) => ({
  localDate: "2026-10-20", localTime: `${hour}:00`, timeZone: "Europe/Madrid",
  instant: `2026-10-20T${String(Number(hour) - 2).padStart(2, "0")}:00:00Z`,
});
export const reviewPlanFixture = ReviewPlanSchema.parse({
  id: ids.plan, version: 1, createdAt: "2026-10-15T10:00:00Z",
  request: {
    business: { name: "Example barbershop", phone: "+12025550123" },
    service: "Haircut", bookingName: "Alex Example",
    availability: [{ start: zoned("17"), end: zoned("19") }],
    pricePolicy: { maximum: { amountMinor: 3000, currency: "EUR" }, allowUnknownPrice: false },
    bookingAuthority: "within_constraints", shareableContact: { phone: null, email: null },
    callLimits: { maxDurationSeconds: 300, maxEstimatedCost: { amountMinor: 200, currency: "USD" } },
  },
});
export const approvedPlanFixture = ApprovedPlanSchema.parse({ ...reviewPlanFixture, approvedAt: "2026-10-15T10:00:30Z" });
export const offerFixture = OfferSchema.parse({
  id: ids.offer, version: 1, service: "Haircut", bookingName: "Alex Example",
  appointment: zoned("18"), durationMinutes: null, price: { amountMinor: 2500, currency: "EUR" },
  conditions: { deposit: "none", cancellationFee: "none", paidAddOn: "none" },
  evidenceMessageIds: [ids.businessMessage],
});
export const connectedCallFixture = CallSnapshotSchema.parse({
  id: ids.attempt, revision: 1, lastEventSequence: 0, mode: "simulator", plan: approvedPlanFixture,
  callState: "connected", bookingState: "offer_received", outcome: { status: "pending" },
  activeOffer: offerFixture, pendingApproval: null,
  conversationData: "retained",
  messages: [{ id: ids.businessMessage, turnId: ids.turn, speaker: "business",
    originalText: "Podemos reservar el martes 20 de octubre a las seis de la tarde por 25 euros.",
    language: "es-ES", translationEn: "We can book Tuesday 20 October at 6 pm for 25 euros.",
    final: true, playback: "not_applicable", createdAt: "2026-10-15T10:01:00Z" }],
  usage: { estimate: { amountMinor: 100, currency: "USD" }, settledTotal: null,
    status: "estimated", measuredAt: "2026-10-15T10:01:00Z" },
  createdAt: "2026-10-15T10:00:30Z", updatedAt: "2026-10-15T10:01:00Z",
});
export const transcriptEventFixture = DomainEventSchema.parse({
  contractVersion: 1, id: ids.event, attemptId: ids.attempt, sequence: 1, snapshotRevision: 2,
  occurredAt: "2026-10-15T10:01:00Z", type: "transcript.updated", payload: connectedCallFixture.messages[0],
});
export const approvalFixture = ApprovalRequestSchema.parse({
  id: ids.approval, attemptId: ids.attempt, plan: { planId: ids.plan, planVersion: 1 },
  offer: { ...offerFixture, version: 2, price: { amountMinor: 3500, currency: "EUR" } },
  reason: "above_price_limit", createdAt: "2026-10-15T10:01:00Z", expiresAt: "2026-10-15T10:01:30Z",
});
export const awaitingApprovalFixture = CallSnapshotSchema.parse({
  ...connectedCallFixture, revision: 2, lastEventSequence: 2, bookingState: "awaiting_approval",
  activeOffer: approvalFixture.offer, pendingApproval: approvalFixture,
});
export const confirmedCallFixture = CallSnapshotSchema.parse({
  ...connectedCallFixture, revision: 3, lastEventSequence: 3, callState: "ended", bookingState: "confirmed",
  messages: [...connectedCallFixture.messages, {
    id: ids.confirmation, turnId: ids.turn, speaker: "business", originalText: "Sí, queda reservado a nombre de Alex.",
    language: "es-ES", translationEn: "Yes, it is booked under Alex's name.", final: true,
    playback: "not_applicable", createdAt: "2026-10-15T10:02:00Z",
  }],
  outcome: { status: "confirmed", offer: offerFixture, confirmedAt: "2026-10-15T10:02:00Z",
    confirmationMessageIds: [ids.confirmation], summaryEn: "Haircut booked for 20 October at 18:00 in Europe/Madrid, under Alex Example, for €25." },
  updatedAt: "2026-10-15T10:02:00Z",
});
export const uncertainCallFixture = CallSnapshotSchema.parse({
  ...connectedCallFixture, revision: 3, lastEventSequence: 3, callState: "ended", bookingState: "uncertain",
  outcome: { status: "uncertain", reason: "disconnected_near_confirmation",
    summaryEn: "The call disconnected near acceptance. Check with the business before trying again." },
});
