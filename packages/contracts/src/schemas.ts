import { z } from "zod";

export const CONTRACT_VERSION = 1 as const;
export const IdSchema = z.uuid();
export const VersionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const SequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const InstantSchema = z.iso.datetime({ offset: true });
export const E164Schema = z.string().regex(/^\+[1-9]\d{7,14}$/);
export const TextSchema = z.string().trim().min(1).max(4000);
export const TimeZoneSchema = z.string().max(100).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}, "Expected an IANA time zone");
export const MoneySchema = z.strictObject({
  amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  currency: z.enum(["EUR", "USD"]),
});
export const ServiceMoneySchema = MoneySchema.extend({ currency: z.literal("EUR") });
export const CallMoneySchema = MoneySchema.extend({ currency: z.literal("USD") });

// Keep the displayed business time and the resolved instant consistent, including DST.
export const ZonedTimeSchema = z.strictObject({
  localDate: z.iso.date(),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timeZone: TimeZoneSchema,
  instant: InstantSchema,
}).refine((value) => {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: value.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(value.instant));
    const part = (type: string) => parts.find((item) => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}` === value.localDate
      && `${part("hour")}:${part("minute")}` === value.localTime
      && part("second") === "00" && new Date(value.instant).getUTCMilliseconds() === 0;
  } catch { return false; }
}, "Local date/time must match the instant in the business time zone, at minute precision");
export const AvailabilitySchema = z.strictObject({
  start: ZonedTimeSchema,
  end: ZonedTimeSchema,
}).refine((value) => value.start.timeZone === value.end.timeZone
  && Date.parse(value.start.instant) < Date.parse(value.end.instant),
"Availability must have one time zone and an end after its start");

export const CallLimitsSchema = z.strictObject({
  maxDurationSeconds: z.number().int().min(30).max(600),
  maxEstimatedCost: CallMoneySchema,
});
export const RequestDraftSchema = z.strictObject({
  business: z.strictObject({ name: TextSchema, phone: E164Schema }),
  service: TextSchema,
  bookingName: z.string().trim().min(1).max(200),
  availability: z.array(AvailabilitySchema).min(1).max(20),
  pricePolicy: z.strictObject({ maximum: ServiceMoneySchema.nullable(), allowUnknownPrice: z.boolean() }),
  bookingAuthority: z.enum(["within_constraints", "ask_before_accepting"]),
  shareableContact: z.strictObject({ phone: E164Schema.nullable(), email: z.email().nullable() }),
  callLimits: CallLimitsSchema,
}).refine((value) => new Set(value.availability.map((window) => window.start.timeZone)).size === 1,
"All windows must use the same business time zone");
export const ReviewPlanSchema = z.strictObject({
  id: IdSchema, version: VersionSchema, createdAt: InstantSchema, request: RequestDraftSchema,
});
export const ApprovedPlanSchema = ReviewPlanSchema.extend({ approvedAt: InstantSchema });
export const PlanRefSchema = z.strictObject({ planId: IdSchema, planVersion: VersionSchema });
export const StartCallRequestSchema = PlanRefSchema.extend({ mode: z.enum(["simulator", "live"]) });

export const OfferSchema = z.strictObject({
  id: IdSchema,
  version: VersionSchema,
  service: TextSchema,
  bookingName: z.string().trim().min(1).max(200),
  appointment: ZonedTimeSchema,
  durationMinutes: z.number().int().min(1).max(480).nullable(),
  price: ServiceMoneySchema.nullable(),
  conditions: z.strictObject({
    deposit: z.enum(["none", "required", "unknown"]),
    cancellationFee: z.enum(["none", "required", "unknown"]),
    paidAddOn: z.enum(["none", "required", "unknown"]),
  }),
  evidenceMessageIds: z.array(IdSchema).min(1).max(50),
});
export const OfferRefSchema = z.strictObject({ offerId: IdSchema, offerVersion: VersionSchema });
export const ApprovalRequestSchema = z.strictObject({
  id: IdSchema, attemptId: IdSchema, plan: PlanRefSchema, offer: OfferSchema,
  reason: z.enum(["outside_availability", "above_price_limit", "unknown_price", "user_confirmation_required"]),
  createdAt: InstantSchema, expiresAt: InstantSchema,
}).refine((value) => Date.parse(value.createdAt) < Date.parse(value.expiresAt),
"Approval expiry must follow its creation");
export const ApprovalDecisionSchema = z.strictObject({
  approvalId: IdSchema, plan: PlanRefSchema, offer: OfferRefSchema,
  decision: z.enum(["approve", "reject"]),
});

export const CallStateSchema = z.enum([
  "creating", "dialing", "ringing", "connected", "ending", "ended", "busy", "no_answer", "failed", "reconciliation_required",
]);
export const BookingStateSchema = z.enum([
  "pending", "offer_received", "awaiting_approval", "reading_back", "awaiting_business_confirmation", "confirmed", "not_booked", "uncertain",
]);
export const OutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({ status: z.literal("confirmed"), offer: OfferSchema,
    confirmedAt: InstantSchema, confirmationMessageIds: z.array(IdSchema).min(1).max(50), summaryEn: TextSchema }),
  z.strictObject({ status: z.literal("not_booked"), reason: z.enum([
    "no_availability", "business_declined", "busy", "no_answer", "user_stopped", "policy_declined", "technical_failure",
  ]), summaryEn: TextSchema }),
  z.strictObject({ status: z.literal("uncertain"), reason: z.enum([
    "disconnected_near_confirmation", "ambiguous_confirmation", "creation_unknown", "provider_state_unknown",
  ]), summaryEn: TextSchema }),
]);
export const CandidateActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("clarify"), missing: z.array(z.enum([
    "service", "name", "date", "time", "price", "conditions",
  ])).min(1).max(6) }),
  z.strictObject({ action: z.literal("ask_availability") }),
  z.strictObject({ action: z.literal("evaluate_offer"), offer: OfferSchema }),
  z.strictObject({ action: z.literal("read_back"), offerId: IdSchema, offerVersion: VersionSchema }),
  z.strictObject({ action: z.literal("accept_offer"), offerId: IdSchema, offerVersion: VersionSchema }),
  z.strictObject({ action: z.literal("record_business_confirmation"), offerId: IdSchema,
    offerVersion: VersionSchema, evidenceMessageIds: z.array(IdSchema).min(1).max(50) }),
  z.strictObject({ action: z.literal("end_call"), reason: z.enum(["business_declined", "unresolved", "no_availability"]) }),
]);
export const TranscriptMessageSchema = z.strictObject({
  id: IdSchema, turnId: IdSchema, speaker: z.enum(["business", "assistant"]),
  originalText: TextSchema, language: z.literal("es-ES"), translationEn: TextSchema.nullable(),
  final: z.boolean(),
  playback: z.enum(["not_applicable", "generated", "playing", "played", "interrupted", "withheld"]),
  createdAt: InstantSchema,
}).refine((value) => (value.speaker === "business") === (value.playback === "not_applicable"),
"Business speech has no assistant playback state");
export const UsageSchema = z.strictObject({
  estimate: CallMoneySchema.nullable(),
  settledTotal: CallMoneySchema.nullable(),
  status: z.enum(["unavailable", "estimated", "partial", "settled"]),
  measuredAt: InstantSchema,
}).refine((value) => value.status !== "settled" || value.settledTotal !== null,
"Settled usage must include a total");

export const CallSnapshotSchema = z.strictObject({
  id: IdSchema, revision: VersionSchema, lastEventSequence: SequenceSchema,
  mode: z.enum(["simulator", "live"]), plan: ApprovedPlanSchema,
  callState: CallStateSchema, bookingState: BookingStateSchema, outcome: OutcomeSchema,
  activeOffer: OfferSchema.nullable(), pendingApproval: ApprovalRequestSchema.nullable(),
  conversationData: z.enum(["retained", "deleted"]),
  messages: z.array(TranscriptMessageSchema).max(2000), usage: UsageSchema,
  createdAt: InstantSchema, updatedAt: InstantSchema,
}).superRefine((value, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const terminalCall = ["ended", "busy", "no_answer", "failed"].includes(value.callState);
  if (value.conversationData === "deleted" && (!terminalCall || value.messages.length > 0))
    issue("Deleted conversation data requires a terminal call and an empty transcript");
  if (terminalCall && (value.outcome.status === "pending" || value.pendingApproval))
    issue("Terminal calls require an outcome and cannot have a pending approval");
  const terminalBooking = ["confirmed", "not_booked", "uncertain"].includes(value.bookingState);
  if ((terminalBooking && value.bookingState !== value.outcome.status)
    || (!terminalBooking && value.outcome.status !== "pending")) issue("Booking state and outcome disagree");
  if ((value.bookingState === "awaiting_approval") !== (value.pendingApproval !== null))
    issue("Awaiting approval requires exactly one pending approval");
  if (value.pendingApproval) {
    const approval = value.pendingApproval;
    if (approval.attemptId !== value.id || approval.plan.planId !== value.plan.id
      || approval.plan.planVersion !== value.plan.version || !value.activeOffer
      || approval.offer.id !== value.activeOffer.id || approval.offer.version !== value.activeOffer.version)
      issue("Pending approval must match this attempt, approved plan, and active offer");
  }
  if (value.outcome.status === "confirmed" && value.conversationData === "retained") {
    const messageIds = new Set(value.messages.filter((message) => message.final && message.speaker === "business")
      .map((message) => message.id));
    if (!value.outcome.confirmationMessageIds.every((id) => messageIds.has(id)))
      issue("Confirmation evidence must reference finalized business messages in this attempt");
  }
});

export const DialogueInputSchema = z.strictObject({
  attemptId: IdSchema, turnId: IdSchema, turnVersion: VersionSchema, plan: ApprovedPlanSchema,
  bookingState: BookingStateSchema, offer: OfferSchema.nullable(),
  triggerMessageId: IdSchema, messages: z.array(TranscriptMessageSchema).min(1).max(2000),
}).refine((value) => value.messages.some((message) => message.id === value.triggerMessageId
  && message.final && message.speaker === "business"), "Dialogue trigger must be finalized business speech");
export const DialogueProposalSchema = z.strictObject({
  turnId: IdSchema, turnVersion: VersionSchema, candidate: CandidateActionSchema,
  translations: z.array(z.strictObject({ messageId: IdSchema, translationEn: TextSchema })).max(2000),
});
export const PlaybackPermitSchema = z.strictObject({
  id: IdSchema, attemptId: IdSchema, planId: IdSchema, planVersion: VersionSchema,
  turnId: IdSchema, turnVersion: VersionSchema, outputId: IdSchema,
  offer: z.strictObject({ id: IdSchema, version: VersionSchema }).nullable(),
  approvedSpanishText: TextSchema, expiresAt: InstantSchema,
});

export const ErrorCodeSchema = z.enum([
  "INVALID_REQUEST", "NOT_FOUND", "PLAN_VERSION_MISMATCH", "CALL_ALREADY_ACTIVE", "IDEMPOTENCY_CONFLICT",
  "APPROVAL_STALE", "APPROVAL_EXPIRED", "CALL_NOT_ACTIVE", "PROVIDER_NOT_READY", "MODE_MISMATCH",
  "EVENT_CURSOR_INVALID", "DATA_NOT_DELETABLE", "PROVIDER_UNAVAILABLE", "INTERNAL_ERROR",
]);
export const ApiErrorSchema = z.strictObject({ error: z.strictObject({
  code: ErrorCodeSchema, message: TextSchema, requestId: IdSchema,
  details: z.array(z.strictObject({ path: z.string().max(200), message: TextSchema })),
}) });
export const ApprovalResolutionSchema = z.strictObject({
  approvalId: IdSchema, offer: OfferRefSchema, status: z.enum(["approved", "rejected", "expired", "invalidated"]),
});
const envelope = {
  contractVersion: z.literal(CONTRACT_VERSION), id: IdSchema, attemptId: IdSchema,
  sequence: VersionSchema, snapshotRevision: VersionSchema, occurredAt: InstantSchema,
};
function event<T extends string, S extends z.ZodType>(type: T, payload: S) {
  return z.strictObject({ ...envelope, type: z.literal(type), payload });
}
export const DomainEventSchema = z.discriminatedUnion("type", [
  event("call.status", z.strictObject({ callState: CallStateSchema })),
  event("transcript.updated", TranscriptMessageSchema),
  event("offer.updated", OfferSchema),
  event("approval.requested", ApprovalRequestSchema),
  event("approval.resolved", ApprovalResolutionSchema),
  event("booking.updated", z.strictObject({ bookingState: BookingStateSchema, outcome: OutcomeSchema })),
  event("usage.updated", UsageSchema),
  event("conversation.deleted", z.strictObject({ conversationData: z.literal("deleted") })),
  event("call.error", z.strictObject({ code: ErrorCodeSchema, message: TextSchema, recoverable: z.boolean() })),
]);

export const ReadinessSchema = z.strictObject({
  mode: z.enum(["simulator", "live"]), ready: z.boolean(),
  voiceEngine: z.enum(["conversation_relay", "openai_realtime"]).nullable(),
  checks: z.array(z.strictObject({ name: z.enum(["storage", "telephony", "voice", "dialogue", "tunnel"]),
    status: z.enum(["ready", "missing", "failed", "not_required"]), message: TextSchema })),
});
export const SettingsSchema = z.strictObject({
  defaultCallLimits: CallLimitsSchema, transcriptRetentionDays: z.number().int().min(1).max(365),
});
export const HistoryEntrySchema = z.strictObject({
  id: IdSchema, mode: z.enum(["simulator", "live"]), businessName: TextSchema,
  callState: CallStateSchema, outcome: OutcomeSchema, createdAt: InstantSchema, usage: UsageSchema,
});

export type ApprovedPlan = z.infer<typeof ApprovedPlanSchema>;
export type ReviewPlan = z.infer<typeof ReviewPlanSchema>;
export type Offer = z.infer<typeof OfferSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export type CallSnapshot = z.infer<typeof CallSnapshotSchema>;
export type DomainEvent = z.infer<typeof DomainEventSchema>;
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;
export type Outcome = z.infer<typeof OutcomeSchema>;
export type CandidateAction = z.infer<typeof CandidateActionSchema>;
export type DialogueInput = z.infer<typeof DialogueInputSchema>;
export type DialogueProposal = z.infer<typeof DialogueProposalSchema>;
export type PlaybackPermit = z.infer<typeof PlaybackPermitSchema>;
