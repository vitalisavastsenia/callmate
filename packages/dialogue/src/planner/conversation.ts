import {
  CallSnapshotSchema, CandidateActionSchema, ConversationDecisionSchema, ConversationRequestSchema,
  ConversationStateSchema, E164Schema, IdSchema, InstantSchema,
  type CallSnapshot, type CandidateAction, type ConversationDecision, type ConversationState, type PolicyDecision,
} from "@callmate/contracts";
import {
  callbackPhrase, cleanHairPhrase, contactFallback, echoPhrase, plainReply, repeatPhrase,
  speechSlot, waitingPhrase, type SpokenPhrase,
} from "../language/conversation.js";

export const emptyConversation = (): ConversationState => ({ pending: null, decisions: [], notes: [], tasks: [] });
export const DEFAULT_CONVERSATION_TIMEOUT_MS = 30_000;
type ExtraAction = Extract<CandidateAction, { action: "request_add_on" | "request_contact" | "record_note" | "repeat" | "echo_detail" }>;
export const isConversationAction = (action: CandidateAction): action is ExtraAction =>
  ["request_add_on", "request_contact", "record_note", "repeat", "echo_detail"].includes(action.action);

/** Checks references, never the semantic truth of model-extracted Spanish facts. */
export function validConversationEvidence(snapshot: Pick<CallSnapshot, "messages">, ids: string[], now: string): boolean {
  const latest = snapshot.messages.findLast(message => message.speaker === "business");
  return !!latest?.final && ids.includes(latest.id) && new Set(ids).size === ids.length
    && !snapshot.messages.some(message => message.speaker === "business" && !message.final)
    && ids.every(id => snapshot.messages.some(message => message.id === id && message.speaker === "business"
      && message.final && Date.parse(message.createdAt) <= Date.parse(now)));
}

export function evaluateConversationAction(snapshot: CallSnapshot, candidate: ExtraAction, now: string): PolicyDecision {
  if (snapshot.outcome.status !== "pending" && snapshot.outcome.status !== "confirmed") return { decision: "deny", reason: "booking_terminal" };
  if (snapshot.conversation?.pending) return { decision: "deny", reason: "conversation_decision_pending" };
  if (candidate.action === "repeat") return { decision: "allow", approvedSpanishText: repeatPhrase(snapshot.plan.request.tone ?? "formal", candidate.reason).es };
  if (candidate.action === "echo_detail") {
    if (!snapshot.activeOffer || candidate.offerId !== snapshot.activeOffer.id || candidate.offerVersion !== snapshot.activeOffer.version) {
      return { decision: "deny", reason: "stale_offer" };
    }
    const phrase = echoPhrase(snapshot.plan, snapshot.activeOffer, candidate.field, candidate.mode === "clarify");
    return phrase ? { decision: "allow", approvedSpanishText: phrase.es } : { decision: "clarify", field: candidate.field };
  }
  if (!validConversationEvidence(snapshot, candidate.evidenceMessageIds, now)) return { decision: "deny", reason: "invalid_conversation_evidence" };
  if (candidate.action === "record_note") return { decision: "allow", approvedSpanishText: cleanHairPhrase().es };
  if (!snapshot.activeOffer || !["offer_received", "confirmed"].includes(snapshot.bookingState)) return { decision: "deny", reason: "conversation_decision_not_expected" };
  if (snapshot.pendingApproval) return { decision: "deny", reason: "booking_approval_pending" };
  const kind = candidate.action === "request_add_on" ? "add_on" : "contact";
  const trigger = snapshot.messages.findLast(message => message.speaker === "business")!;
  if (snapshot.conversation?.decisions.some(item => item.request.kind === kind
    && item.request.plan.planId === snapshot.plan.id && item.request.plan.planVersion === snapshot.plan.version
    && item.request.offer.offerId === snapshot.activeOffer!.id && item.request.offer.offerVersion === snapshot.activeOffer!.version
    && item.request.evidenceMessageIds.includes(trigger.id))) return { decision: "deny", reason: "conversation_decision_already_handled" };
  if (candidate.action === "request_add_on") {
    if (snapshot.bookingState !== "confirmed") {
      return { decision: "deny", reason: "base_confirmation_required" };
    }
    if (snapshot.conversation?.decisions.some(item => item.request.kind === "add_on" && item.status === "approved"
      && item.request.offer.offerId === snapshot.activeOffer!.id && item.request.offer.offerVersion === snapshot.activeOffer!.version)) {
      return { decision: "deny", reason: "supplement_change_requires_reconciliation" };
    }
    if (Object.values(candidate.supplement.conditions).some(value => value === "required")) return { decision: "deny", reason: "prohibited_conditions" };
    if (Object.values(candidate.supplement.conditions).some(value => value === "unknown")) return { decision: "clarify", field: "conditions" };
    if (!snapshot.activeOffer.price) return { decision: "clarify", field: "price" };
    if (!Number.isSafeInteger(snapshot.activeOffer.price.amountMinor + candidate.supplement.additionalPrice.amountMinor)) return { decision: "deny", reason: "invalid_total_price" };
    speechSlot(candidate.supplement.serviceEs);
    return { decision: "ask_user", reason: "add_on" };
  }
  // Even a preapproved phone goes through explicit contact handling, never into a model-written reply.
  return { decision: "ask_user", reason: "share_contact" };
}

export type ConversationEvent =
  | { type: "decision_requested"; id: string; candidate: Extract<ExtraAction, { action: "request_add_on" | "request_contact" }>; expiresAt?: string }
  | { type: "decision_resolved"; decision: ConversationDecision; authorizedPhone?: string }
  | { type: "decision_expired"; decisionId: string }
  | { type: "note_recorded"; candidate: Extract<ExtraAction, { action: "record_note" }> }
  | { type: "invalidate" };
export type ConversationUpdate = { conversation: ConversationState; reply: SpokenPhrase | null };
export class ConversationTransitionError extends Error {
  constructor(message: string) { super(message); this.name = "ConversationTransitionError"; }
}
const requireState: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new ConversationTransitionError(message);
};

/** Pure, controller-only events. Authenticate user decisions before calling; never pass model events here. */
export function reduceConversation(raw: CallSnapshot, event: ConversationEvent, now: string): ConversationUpdate {
  const snapshot = CallSnapshotSchema.parse(raw);
  InstantSchema.parse(now);
  const conversation = structuredClone(snapshot.conversation ?? emptyConversation());
  let reply: SpokenPhrase | null = null;
  const finish = (): ConversationUpdate => {
    ConversationStateSchema.parse(conversation);
    CallSnapshotSchema.parse({ ...snapshot, conversation });
    return { conversation, reply };
  };
  if (event.type === "invalidate") {
    if (conversation.pending) {
      conversation.decisions.push({ request: conversation.pending, status: "invalidated", answer: null, resolvedAt: now });
      conversation.pending = null;
    }
    return finish();
  }
  requireState(snapshot.callState === "connected", "Conversation requires a connected call");
  requireState(snapshot.outcome.status === "pending" || snapshot.outcome.status === "confirmed", "Conversation cannot resume a failed booking");
  requireState(Date.parse(snapshot.updatedAt) <= Date.parse(now) && Date.parse(snapshot.plan.approvedAt) <= Date.parse(now), "Invalid authority time");
  if (event.type === "note_recorded" || event.type === "decision_requested") {
    const candidate = CandidateActionSchema.parse(event.candidate);
    requireState(isConversationAction(candidate), "Expected conversation candidate");
    const decision = evaluateConversationAction(snapshot, candidate, now);
    if (event.type === "note_recorded") {
      requireState(candidate.action === "record_note" && decision.decision === "allow", "Note evidence is invalid");
      if (!conversation.notes.some(note => note.code === candidate.code)) conversation.notes.push({
        code: candidate.code, textEn: "Come with clean, dry hair; the salon does not wash it.", evidenceMessageIds: candidate.evidenceMessageIds,
      });
      reply = cleanHairPhrase();
    } else {
      requireState(decision.decision === "ask_user" && !conversation.pending, "Decision is not permitted");
      requireState(conversation.decisions.length < 100, "Conversation decision limit reached");
      requireState(!conversation.decisions.some(item => item.request.id === event.id), "Decision ID was already used");
      IdSchema.parse(event.id);
      const expiresAt = event.expiresAt ?? new Date(Date.parse(now) + DEFAULT_CONVERSATION_TIMEOUT_MS).toISOString();
      InstantSchema.parse(expiresAt);
      requireState(Date.parse(expiresAt) > Date.parse(now) && Date.parse(expiresAt) - Date.parse(now) <= DEFAULT_CONVERSATION_TIMEOUT_MS,
        "Decision deadline must be within 30 seconds");
      const common = { id: event.id, attemptId: snapshot.id, plan: { planId: snapshot.plan.id, planVersion: snapshot.plan.version },
        offer: { offerId: snapshot.activeOffer!.id, offerVersion: snapshot.activeOffer!.version },
        createdAt: now, expiresAt, evidenceMessageIds: event.candidate.evidenceMessageIds };
      conversation.pending = ConversationRequestSchema.parse(event.candidate.action === "request_contact"
        ? { ...common, kind: "contact", field: "phone" }
        : { ...common, kind: "add_on", supplement: event.candidate.supplement,
          totalPrice: { amountMinor: snapshot.activeOffer!.price!.amountMinor + event.candidate.supplement.additionalPrice.amountMinor, currency: "EUR" } });
      reply = waitingPhrase(snapshot.plan.request.tone ?? "formal", 0);
    }
    return finish();
  }
  const pending = conversation.pending;
  requireState(pending, "There is no pending conversation decision");
  requireState(Date.parse(now) >= Date.parse(pending.createdAt), "Decision cannot resolve before creation");
  let status: ConversationState["decisions"][number]["status"], answer: string | null = null;
  if (event.type === "decision_expired") {
    requireState(event.decisionId === pending.id && Date.parse(now) >= Date.parse(pending.expiresAt), "Decision has not expired or is stale");
    status = "expired";
    reply = pending.kind === "contact" ? contactFallback(snapshot.plan) : callbackPhrase(snapshot.plan.request.tone ?? "formal");
    if (pending.kind === "contact") conversation.tasks.push({ decisionId: pending.id, kind: "provide_phone_later",
      textEn: "Call the salon later to provide a contact number, after obtaining permission." });
  } else {
    const decision = ConversationDecisionSchema.parse(event.decision);
    requireState(decision.decisionId === pending.id && decision.plan.planId === pending.plan.planId
      && decision.plan.planVersion === pending.plan.planVersion && decision.offer.offerId === pending.offer.offerId
      && decision.offer.offerVersion === pending.offer.offerVersion, "Decision binding is stale");
    requireState(Date.parse(now) < Date.parse(pending.expiresAt), "Decision has expired");
    status = decision.choice === "approve" ? "approved" : decision.choice === "reject" ? "rejected" : "custom";
    answer = decision.answer;
    if (status === "custom") {
      // Free text is intent for a subsequent reviewed plan/decision, never permission to speak it.
      reply = plainReply("custom_review", "Tengo que comprobar las nuevas instrucciones antes de aceptar cambios.",
        "I need to check the new instructions before accepting any changes.");
    } else if (pending.kind === "add_on") {
      reply = status === "rejected"
        ? plainReply("decline_add_on", "Muchas gracias, pero de momento solo el corte.", "Thank you very much, but just the haircut for now.")
        : plainReply("review_add_on", "Gracias. Voy a comprobar los detalles del servicio adicional antes de aceptar el cambio.",
          "Thank you. I will check the additional service details before accepting the change.");
    } else if (status === "approved") {
      const phone = E164Schema.parse(event.authorizedPhone);
      // Only controller-resolved, explicitly approved data may reach spoken output; do not persist it in decision history.
      reply = plainReply("share_phone", `El teléfono de contacto es ${phone.split("").join(" ")}.`, `The contact number is ${phone}.`);
    } else reply = plainReply("decline_phone", "No tengo autorización para facilitar un teléfono. ¿Podemos dejar la cita solo a nombre de la persona interesada?",
      "I am not authorized to share a phone number. Can we keep the appointment under the person's name only?");
  }
  conversation.decisions.push({ request: pending, status, answer, resolvedAt: now });
  conversation.pending = null;
  return finish();
}
