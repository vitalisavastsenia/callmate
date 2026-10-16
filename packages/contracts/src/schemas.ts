import { z } from "zod";
import { conversationTemplateIds, templateById, templateForService } from "./templates.js";

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
// Call budgets use the application settings currency; service prices remain EUR.
export const CallMoneySchema = MoneySchema;

export const ContactDetailsSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  phone: z.string().max(100).transform(value => value.trim().replace(/^tel:/i, "")
    .replace(/[\s().-]/g, "").replace(/^00/, "+")).pipe(E164Schema),
  timeZone: TimeZoneSchema,
  tone: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
  notes: z.string().trim().max(2000).default(""),
});
export const ContactSchema = ContactDetailsSchema.extend({ id: IdSchema });
export type ContactDetails = z.infer<typeof ContactDetailsSchema>;
export type Contact = z.infer<typeof ContactSchema>;

export const AuthCredentialsSchema = z.strictObject({
  username: z.string().trim().toLowerCase().min(3).max(64).regex(/^[a-z0-9_.-]+$/),
  password: z.string().min(1).max(128),
});
export const AuthSetupSchema = AuthCredentialsSchema.extend({ password: z.string().min(12).max(128) });
export const AuthSessionSchema = z.strictObject({
  setupRequired: z.boolean(), authenticated: z.boolean(), username: z.string().nullable(), expiresAt: z.iso.datetime().nullable(),
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

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
export const RequestTypeSchema = z.enum(["book", "ask", "change", "other"]);
const EditableListSchema = z.array(TextSchema).max(30);
export const DialogueLanguageSchema = z.enum(["es-ES", "ru-RU", "en-US", "pl-PL"]);
export const ConversationTemplateIdSchema = z.enum(conversationTemplateIds);
const DetailTextSchema = z.string().trim().min(1).max(100).regex(/^[^\p{Cc}\p{Cf}<>]+$/u, "Unsafe template detail");
export const TemplateDetailsSchema = z.strictObject({
  purpose: DetailTextSchema.nullish(), partySize: z.number().int().min(1).max(20).nullish(),
  seating: DetailTextSchema.nullish(), species: DetailTextSchema.nullish(), vehicle: DetailTextSchema.nullish(),
  propertyType: DetailTextSchema.nullish(), rooms: z.number().int().min(1).max(15).nullish(), level: DetailTextSchema.nullish(),
});
export const DialoguePhraseRefSchema = z.strictObject({
  id: z.string().regex(/^[a-z_]+\.[a-z0-9_.]+$/).max(100).refine(id => !!templateById(id.split(".")[0]!)), version: VersionSchema, language: DialogueLanguageSchema,
});
export const RequestDraftSchema = z.strictObject({
  business: z.strictObject({ name: TextSchema, phone: E164Schema }),
  // Optional additions keep existing v1 appointment drafts readable without migration.
  requestType: RequestTypeSchema.optional(),
  language: DialogueLanguageSchema.optional(),
  templateId: ConversationTemplateIdSchema.optional(),
  templateDetails: TemplateDetailsSchema.optional(),
  goal: TextSchema.optional(),
  timeZone: TimeZoneSchema.optional(),
  // Legacy dialogue tones normalize to the UI's existing list format.
  tone: z.union([
    z.array(z.string().trim().min(1).max(100)).max(10),
    z.enum(["formal", "very_polite", "friendly"]).transform(tone => [{
      formal: 'Formal "usted"', very_polite: "Very polite", friendly: "Friendly",
    }[tone]]),
  ]).optional(),
  tone_notes: z.string().trim().max(2000).optional(),
  contact_id: IdSchema.optional(),
  boundaries: z.strictObject({ canDecideAlone: EditableListSchema, mustAskMe: EditableListSchema }).optional(),
  questions: EditableListSchema.optional(),
  changeRequest: z.strictObject({ description: TextSchema, bookingReference: z.string().trim().max(200) }).nullable().optional(),
  service: z.string().trim().max(4000).default(""),
  bookingName: z.string().trim().max(200).default(""),
  availability: z.array(AvailabilitySchema).max(20).default([]),
  pricePolicy: z.strictObject({ maximum: ServiceMoneySchema.nullable(), allowUnknownPrice: z.boolean() }).default({ maximum: null, allowUnknownPrice: false }),
  bookingAuthority: z.enum(["within_constraints", "ask_before_accepting"]).default("ask_before_accepting"),
  shareableContact: z.strictObject({ phone: E164Schema.nullable(), email: z.email().nullable() }),
  callLimits: CallLimitsSchema,
}).superRefine((value, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  const kind = value.requestType ?? "book";
  if (value.requestType && !value.goal) issue("goal", "Describe your goal in English");
  if (value.requestType && !value.timeZone) issue("timeZone", "Choose the destination time zone");
  if (kind === "book") {
    if (!value.service) issue("service", "Enter the service to book");
    if (!value.availability.length) issue("availability", "Add at least one availability window");
  }
  if (kind === "ask" && !value.questions?.length) issue("questions", "Add at least one question");
  if (kind === "change" && !value.changeRequest) issue("changeRequest", "Describe what to change or cancel");
  if (value.templateId) {
    const profile = templateById(value.templateId)!;
    if (kind !== "book") issue("templateId", "Appointment templates require a booking request");
    if (templateForService(value.service)?.id !== profile.id) issue("service", "Service must match the selected template");
    const details = value.templateDetails ?? {};
    for (const [key, data] of Object.entries(details)) if (data != null && !profile.fields.some(field => field.key === key)) issue("templateDetails", "Unexpected detail for this template");
    for (const field of profile.fields) {
      const data = details[field.key];
      if (data == null || data === "") issue("templateDetails", `Enter ${field.label.toLowerCase()}`);
      else if (field.kind === "choice" && !field.options?.some(option => option.value === data)) issue("templateDetails", `Choose a valid ${field.label.toLowerCase()}`);
      else if (field.kind === "number" && (typeof data !== "number" || data < field.min! || data > field.max!)) issue("templateDetails", `Check ${field.label.toLowerCase()}`);
    }
  } else if (Object.values(value.templateDetails ?? {}).some(data => data != null)) issue("templateId", "Select a template for its details");
  const zones = new Set(value.availability.map(window => window.start.timeZone));
  if (zones.size > 1 || (value.timeZone && [...zones].some(zone => zone !== value.timeZone)))
    issue("availability", "All windows must use the same business time zone");
});
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
  templateDetails: TemplateDetailsSchema.nullish(),
  staffName: z.string().trim().min(1).max(200)
    .regex(/^[^\p{Cc}\p{Cf}<>]+$/u, "Unsafe staff name")
    .nullable().optional(),
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
export const SupplementSchema = z.strictObject({
  serviceEs: z.literal("el tratamiento de hidratación"),
  serviceEn: z.literal("the hydrating treatment"),
  additionalPrice: ServiceMoneySchema,
  conditions: OfferSchema.shape.conditions,
});
const conversationRequest = {
  id: IdSchema, attemptId: IdSchema, plan: PlanRefSchema, offer: OfferRefSchema,
  createdAt: InstantSchema, expiresAt: InstantSchema,
  evidenceMessageIds: z.array(IdSchema).min(1).max(50),
};
export const ConversationRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...conversationRequest, kind: z.literal("add_on"), supplement: SupplementSchema,
    totalPrice: ServiceMoneySchema }),
  z.strictObject({ ...conversationRequest, kind: z.literal("contact"), field: z.literal("phone") }),
]).refine(value => Date.parse(value.createdAt) < Date.parse(value.expiresAt), "Decision must have a future deadline");
export const ConversationDecisionSchema = z.strictObject({
  decisionId: IdSchema, plan: PlanRefSchema, offer: OfferRefSchema,
  choice: z.enum(["approve", "reject", "custom"]), answer: TextSchema.nullable(),
}).refine(value => (value.choice === "custom") === (value.answer !== null), "Only custom choices carry free text");
export const ConversationStateSchema = z.strictObject({
  pending: ConversationRequestSchema.nullable(),
  decisions: z.array(z.strictObject({ request: ConversationRequestSchema,
    status: z.enum(["approved", "rejected", "custom", "expired", "invalidated"]),
    answer: TextSchema.nullable(), resolvedAt: InstantSchema })).max(100),
  notes: z.array(z.strictObject({ code: z.literal("clean_dry_hair"), textEn: TextSchema,
    evidenceMessageIds: z.array(IdSchema).min(1).max(50) })).max(100),
  tasks: z.array(z.strictObject({ decisionId: IdSchema, kind: z.literal("provide_phone_later"),
    textEn: TextSchema })).max(100),
});
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
  "pending", "offer_received", "awaiting_approval", "reading_back", "awaiting_business_confirmation", "confirmed", "not_booked", "uncertain", "completed",
]);
export const OutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({ status: z.literal("confirmed"), offer: OfferSchema,
    confirmedAt: InstantSchema, confirmationMessageIds: z.array(IdSchema).min(1).max(50), summaryEn: TextSchema }),
  z.strictObject({ status: z.literal("completed"), resolution: z.enum(["resolved", "needs_follow_up"]),
    summaryEn: TextSchema, findings: z.array(z.strictObject({ question: TextSchema, answerEn: TextSchema,
      answered: z.boolean() })).min(1).max(30), nextSteps: EditableListSchema,
    evidenceMessageIds: z.array(IdSchema).min(1).max(50) }).refine(value =>
      value.resolution === "resolved" ? value.findings.every(finding => finding.answered) : value.nextSteps.length > 0,
    "Resolved requests need all questions answered; follow-up results need next steps"),
  z.strictObject({ status: z.literal("not_booked"), reason: z.enum([
    "no_availability", "business_declined", "busy", "no_answer", "user_stopped", "policy_declined", "technical_failure", "development_only",
  ]), summaryEn: TextSchema }),
  z.strictObject({ status: z.literal("uncertain"), reason: z.enum([
    "disconnected_near_confirmation", "ambiguous_confirmation", "creation_unknown", "provider_state_unknown",
  ]), summaryEn: TextSchema }),
]);
export const CandidateActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("clarify"), missing: z.array(z.enum([
    "service", "name", "date", "time", "price", "conditions", "details",
  ])).min(1).max(7) }),
  z.strictObject({ action: z.literal("ask_availability") }),
  z.strictObject({ action: z.literal("ask_requirements") }),
  z.strictObject({ action: z.literal("evaluate_offer"), offer: OfferSchema }),
  z.strictObject({ action: z.literal("read_back"), offerId: IdSchema, offerVersion: VersionSchema }),
  z.strictObject({ action: z.literal("accept_offer"), offerId: IdSchema, offerVersion: VersionSchema }),
  z.strictObject({ action: z.literal("record_business_confirmation"), offerId: IdSchema,
    offerVersion: VersionSchema, evidenceMessageIds: z.array(IdSchema).min(1).max(50) }),
  z.strictObject({ action: z.literal("end_call"), reason: z.enum(["business_declined", "unresolved", "no_availability"]) }),
  z.strictObject({ action: z.literal("request_add_on"), supplement: SupplementSchema,
    evidenceMessageIds: z.array(IdSchema).min(1).max(50) }),
  z.strictObject({ action: z.literal("request_contact"), field: z.literal("phone"),
    evidenceMessageIds: z.array(IdSchema).min(1).max(50) }),
  z.strictObject({ action: z.literal("record_note"), code: z.literal("clean_dry_hair"),
    evidenceMessageIds: z.array(IdSchema).min(1).max(50) }),
  z.strictObject({ action: z.literal("repeat"), reason: z.enum(["not_heard", "not_understood", "slower"]) }),
  z.strictObject({ action: z.literal("echo_detail"), field: z.enum(["date", "time", "price", "name", "staff"]),
    mode: z.enum(["confirm", "clarify"]).nullable().optional(),
    offerId: IdSchema, offerVersion: VersionSchema }),
]);
export const TranscriptMessageSchema = z.strictObject({
  id: IdSchema, turnId: IdSchema, speaker: z.enum(["business", "assistant"]),
  originalText: TextSchema, language: DialogueLanguageSchema, translationEn: TextSchema.nullable(),
  phrase: DialoguePhraseRefSchema.optional(),
  final: z.boolean(),
  playback: z.enum(["not_applicable", "generated", "playing", "played", "interrupted", "withheld"]),
  createdAt: InstantSchema,
}).refine((value) => (value.speaker === "business") === (value.playback === "not_applicable"),
"Business speech has no assistant playback state").refine(value => !value.phrase || (value.speaker === "assistant" && value.phrase.language === value.language),
"Only assistant messages can reference a phrase in the message language");
// Optional development meter; never represents a provider quote or settled charge.
export const TestUsageSchema = z.strictObject({
  source: z.literal("test_rates"), rateVersion: z.literal("elapsed-minute-v1"),
  rateMinorPerMinute: z.number().int().min(1).max(60000), currency: z.literal("USD"),
  rateCapturedAt: InstantSchema, elapsedMs: z.number().int().nonnegative().safe(),
  budget: CallMoneySchema.extend({ currency: z.literal("USD") }),
});
export const UsageSchema = z.strictObject({
  estimate: CallMoneySchema.nullable(),
  settledTotal: CallMoneySchema.nullable(),
  status: z.enum(["unavailable", "estimated", "partial", "settled"]),
  measuredAt: InstantSchema, testUsage: TestUsageSchema.optional(),
}).refine((value) => value.status !== "settled" || value.settledTotal !== null,
"Settled usage must include a total").refine((value) => !value.testUsage || (value.status === "estimated"
  && value.settledTotal === null && value.estimate?.currency === "USD"),
"Test rates must remain estimates with unavailable provider charges");

export const CallSnapshotSchema = z.strictObject({
  id: IdSchema, revision: VersionSchema, lastEventSequence: SequenceSchema,
  mode: z.enum(["simulator", "live"]), plan: ApprovedPlanSchema,
  callState: CallStateSchema, bookingState: BookingStateSchema, outcome: OutcomeSchema,
  activeOffer: OfferSchema.nullable(), pendingApproval: ApprovalRequestSchema.nullable(),
  conversation: ConversationStateSchema.optional(),
  conversationData: z.enum(["retained", "deleted"]),
  messages: z.array(TranscriptMessageSchema).max(2000), usage: UsageSchema,
  createdAt: InstantSchema, updatedAt: InstantSchema,
}).superRefine((value, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const terminalCall = ["ended", "busy", "no_answer", "failed"].includes(value.callState);
  if (value.conversationData === "deleted" && (!terminalCall || value.messages.length > 0))
    issue("Deleted conversation data requires a terminal call and an empty transcript");
  if (value.conversationData === "deleted" && value.conversation?.decisions.some(item => item.answer !== null))
    issue("Deleted conversation data cannot retain free-text decision answers");
  if (terminalCall && (value.outcome.status === "pending" || value.pendingApproval))
    issue("Terminal calls require an outcome and cannot have a pending approval");
  const decision = value.conversation?.pending;
  if (decision && value.outcome.status !== "pending" && value.outcome.status !== "confirmed")
    issue("A failed or uncertain booking cannot have pending conversation consent");
  if (decision && (terminalCall || decision.attemptId !== value.id || decision.plan.planId !== value.plan.id
    || decision.plan.planVersion !== value.plan.version || decision.offer.offerId !== value.activeOffer?.id
    || decision.offer.offerVersion !== value.activeOffer?.version)) issue("Conversation decision must match an active call, plan and offer");
  if (decision?.kind === "add_on" && (!value.activeOffer?.price
    || decision.totalPrice.amountMinor !== value.activeOffer.price.amountMinor + decision.supplement.additionalPrice.amountMinor))
    issue("Supplement total must equal the base price plus its surcharge");
  const terminalBooking = ["confirmed", "not_booked", "uncertain", "completed"].includes(value.bookingState);
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
  const kind = value.plan.request.requestType ?? "book";
  if (kind !== "book" && (value.activeOffer || value.pendingApproval || value.outcome.status === "confirmed"))
    issue("Non-booking tasks cannot carry appointment offers or claim a confirmed booking");
  if (kind === "book" && value.outcome.status === "completed")
    issue("Appointment results require the booking outcome and evidence");
  if ((value.outcome.status === "confirmed" || value.outcome.status === "completed") && value.conversationData === "retained") {
    const messageIds = new Set(value.messages.filter((message) => message.final && message.speaker === "business")
      .map((message) => message.id));
    const evidence = value.outcome.status === "confirmed" ? value.outcome.confirmationMessageIds : value.outcome.evidenceMessageIds;
    if (!evidence.every((id) => messageIds.has(id)))
      issue("Confirmation evidence must reference finalized business messages in this attempt");
  }
});

// Manual mock calls carry no approved booking plan or authority. Booking snapshots stay unchanged.
export const ManualTranscriptMessageSchema = z.strictObject({
  id: IdSchema, turnId: IdSchema, speaker: z.enum(["business", "assistant"]),
  originalText: z.string().min(1).max(8000).refine((text) => text.trim().length > 0),
  language: z.string().max(35).regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
  translationEn: z.null(), final: z.literal(true),
  playback: z.enum(["not_applicable", "withheld", "generated"]), createdAt: InstantSchema,
}).refine((value) => (value.speaker === "business") === (value.playback === "not_applicable"),
"Business speech has no assistant playback state");
export const ManualCallSnapshotSchema = z.strictObject({
  id: IdSchema, revision: VersionSchema, lastEventSequence: SequenceSchema,
  kind: z.literal("manual_mock"), mode: z.literal("simulator"), plan: z.null(),
  language: z.enum(["es-ES", "ru-RU", "pl-PL", "en-US"]),
  callState: CallStateSchema, bookingState: z.enum(["pending", "not_booked"]),
  outcome: z.union([z.strictObject({ status: z.literal("pending") }),
    z.strictObject({ status: z.literal("not_booked"),
      reason: z.enum(["development_only", "user_stopped", "technical_failure", "busy", "no_answer"]), summaryEn: TextSchema })]),
  activeOffer: z.null(), pendingApproval: z.null(), conversationData: z.enum(["retained", "deleted"]),
  messages: z.array(ManualTranscriptMessageSchema).max(2000), usage: UsageSchema,
  createdAt: InstantSchema, updatedAt: InstantSchema,
}).superRefine((value, ctx) => {
  const terminal = ["ended", "busy", "no_answer", "failed"].includes(value.callState);
  if ((value.bookingState === "not_booked") !== (value.outcome.status === "not_booked")
    || (terminal !== (value.outcome.status === "not_booked"))
    || (value.conversationData === "deleted" && (!terminal || value.messages.length))) {
    ctx.addIssue({ code: "custom", message: "Manual call outcome, lifecycle and conversation data disagree" });
  }
});
export const StoredCallSnapshotSchema = z.union([CallSnapshotSchema, ManualCallSnapshotSchema]);
export type ManualCallSnapshot = z.infer<typeof ManualCallSnapshotSchema>;
export type StoredCallSnapshot = z.infer<typeof StoredCallSnapshotSchema>;

export const DialogueInputSchema = z.strictObject({
  attemptId: IdSchema, turnId: IdSchema, turnVersion: VersionSchema, plan: ApprovedPlanSchema,
  bookingState: BookingStateSchema, offer: OfferSchema.nullable(),
  callState: CallStateSchema.optional(), conversation: ConversationStateSchema.optional(),
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
  "BUDGET_EXCEEDED", "EVENT_CURSOR_INVALID", "DATA_NOT_DELETABLE", "PROVIDER_UNAVAILABLE", "INTERNAL_ERROR",
  "CONTACT_ALREADY_EXISTS",
  "UNAUTHENTICATED", "INVALID_CREDENTIALS", "AUTH_ALREADY_CONFIGURED", "AUTH_RATE_LIMITED",
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
  event("transcript.updated", z.union([ManualTranscriptMessageSchema, TranscriptMessageSchema])),
  event("offer.updated", OfferSchema),
  event("approval.requested", ApprovalRequestSchema),
  event("approval.resolved", ApprovalResolutionSchema),
  event("booking.updated", z.strictObject({ bookingState: BookingStateSchema, outcome: OutcomeSchema })),
  event("conversation.updated", ConversationStateSchema),
  event("usage.updated", UsageSchema),
  event("conversation.deleted", z.strictObject({ conversationData: z.literal("deleted") })),
  event("call.error", z.strictObject({ code: ErrorCodeSchema, message: TextSchema, recoverable: z.boolean() })),
]);

export const CapabilitySchema = z.strictObject({
  name: z.enum(["scripted_calls", "manual_mock_calls", "mock_relay", "mock_status_callbacks", "history",
    "approvals", "automatic_retention", "test_rate_budgets", "live_calls", "dialogue_integration", "provider_billing"]),
  enabled: z.boolean(), ready: z.boolean(),
}).refine((value) => !value.ready || value.enabled, "Disabled capabilities cannot be ready");
export const ReadinessSchema = z.strictObject({
  mode: z.enum(["simulator", "live"]), ready: z.boolean(),
  voiceEngine: z.enum(["conversation_relay", "openai_realtime"]).nullable(),
  capabilities: z.array(CapabilitySchema),
  checks: z.array(z.strictObject({ name: z.enum(["configuration", "storage", "mock", "telephony", "voice", "dialogue", "tunnel"]),
    status: z.enum(["ready", "missing", "failed", "not_required"]), message: TextSchema })),
});
export const SettingsSchema = z.strictObject({
  defaultCallLimits: CallLimitsSchema, transcriptRetentionDays: z.number().int().min(1).max(365),
});
export const HistoryEntrySchema = z.strictObject({
  id: IdSchema, mode: z.enum(["simulator", "live"]), kind: z.literal("manual_mock").optional(),
  businessName: TextSchema, requestType: RequestTypeSchema.optional(),
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
export type ConversationState = z.infer<typeof ConversationStateSchema>;
export type ConversationRequest = z.infer<typeof ConversationRequestSchema>;
export type ConversationDecision = z.infer<typeof ConversationDecisionSchema>;
