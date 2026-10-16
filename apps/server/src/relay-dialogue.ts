import { randomUUID } from "node:crypto";
import type { ApprovalDecision, CallSnapshot, DomainEvent, ReviewPlan, CandidateAction, PlaybackPermit } from "@callmate/contracts";
import { PlaybackPermitSchema } from "@callmate/contracts";
import { createDialogueServices, createOpenAIModelClient, reduceBooking, spanishWaitingForApproval } from "@callmate/dialogue";
import type { ModelClient, BookingEvent, ExactOfferGrant } from "@callmate/dialogue";
import type { Config } from "./config.js";
import type { Store } from "./storage.js";
import { isMockAttempt } from "./call-store.js";
import type { MockAttempt } from "./call-store.js";
import type { RelayOutbound } from "./twilio/protocol.js";
import type { RelaySend } from "./mock-relay.js";
import { CommandError } from "./errors.js";

type Attempt = MockAttempt & { call: CallSnapshot };
type Emit = (type: DomainEvent["type"], payload: unknown) => void;
type QueuedOutput = { frame: RelayOutbound; permit: PlaybackPermit | null };
type Queue = (frame: RelayOutbound, permit: PlaybackPermit | null) => void;
type Change = (id: string, work: (a: Attempt, emit: Emit) => void) => unknown;

/** Controller-owned dialogue over local ConversationRelay. Never treats socket writes as playback. */
export class RelayDialogue {
  private services: ReturnType<typeof createDialogueServices> | undefined;
  private jobs = new Map<string, AbortController>();
  private senders = new Map<string, RelaySend>();
  private closed = false;
  private speechPending = new Set<string>();
  get enabled() { return !!this.services; }
  constructor(private config: Config, private store: Store, private change: Change,
    private stopped: (id: string) => boolean, model?: ModelClient) {
    if (model || config.dialogueProvider === "openai") {
      const client = model ?? createOpenAIModelClient({ apiKey: config.openaiApiKey!, model: config.dialogueModel!, timeoutMs: config.dialogueTimeoutMs });
      this.services = createDialogueServices(client, { timeoutMs: config.dialogueTimeoutMs,
        offerIdentitySource: () => { throw new Error("Turn-specific reservation required"); } });
      this.model = client;
    }
  }
  private model: ModelClient | undefined;
  private get(id: string): Attempt {
    const a = this.store.calls.get(id);
    if (!a || !isMockAttempt(a) || !a.call.plan) throw new CommandError(409, "CALL_NOT_ACTIVE", "Call has no reviewed dialogue plan");
    return a as Attempt;
  }
  private now() { return new Date().toISOString(); }
  greeting(plan: ReviewPlan) {
    if ((plan.request.requestType ?? "book") !== "book" || !["haircut", "corte de pelo", "corte de cabello"].includes(plan.request.service.trim().toLowerCase())) {
      throw new CommandError(400, "INVALID_REQUEST", "Dialogue mock currently supports Spanish haircut appointments only");
    }
    if (/[\p{Cc}\p{Cf}<>]/u.test(plan.request.bookingName)) throw new CommandError(400, "INVALID_REQUEST", "Booking name cannot be spoken safely");
    // Full availability and goal remain in every model input; disclosure precedes the first business turn.
    return "Hola, soy un asistente de inteligencia artificial. Llamo para consultar una cita para un corte de pelo. ¿Puede ayudarme?";
  }
  speech(id: string) {
    if (!this.enabled || !this.store.calls.get(id)?.call.plan) return;
    this.speechPending.add(id); this.cancel(id);
  }
  cancel(id: string) { this.jobs.get(id)?.abort(); this.jobs.delete(id); }
  close() { this.closed = true; for (const id of this.jobs.keys()) this.cancel(id); this.senders.clear(); this.speechPending.clear(); }
  private update(a: Attempt, emit: Emit, event: BookingEvent) {
    const previous = a.call.pendingApproval;
    const { acceptance: _receipt, ...fields } = reduceBooking(a.call, event, this.now());
    Object.assign(a.call, fields);
    if (previous && !a.call.pendingApproval) emit("approval.resolved", { approvalId: previous.id,
      offer: { offerId: previous.offer.id, offerVersion: previous.offer.version },
      status: event.type === "approval_resolved" ? event.status : "invalidated" });
    emit("booking.updated", { bookingState: a.call.bookingState, outcome: a.call.outcome });
    if (a.call.activeOffer) emit("offer.updated", a.call.activeOffer);
  }
  finish(a: Attempt, emit: Emit, reason: "user_stopped" | "busy" | "no_answer" | "technical_failure") {
    this.cancel(a.call.id); this.senders.delete(a.call.id); this.speechPending.delete(a.call.id); a.internal.grant = null;
    this.update(a, emit, { type: "call_finished", reason });
  }
  fail(id: string) {
    this.cancel(id);
    this.change(id, (a, emit) => {
      if (a.call.callState !== "connected" || a.internal.stopRequested) return;
      emit("call.error", { code: "PROVIDER_UNAVAILABLE", message: "Dialogue could not produce a valid response. No acceptance was sent; stop or clarify the call.", recoverable: true });
    });
  }
  prompt(id: string, send: RelaySend) {
    if (!this.model || this.closed) return;
    this.cancel(id); this.speechPending.delete(id); this.senders.set(id, send);
    const a = this.get(id); const call = structuredClone(a.call);
    const trigger = call.messages.findLast(m => m.speaker === "business");
    if (!trigger || call.callState !== "connected" || call.outcome.status !== "pending" || a.internal.stopRequested) return;
    const job = new AbortController(); this.jobs.set(id, job);
    // Reserve before generation. Validation is a pure lookup; only the current job may persist it.
    const offerId = call.activeOffer?.id ?? randomUUID();
    const offerVersion = (call.activeOffer?.version ?? 0) + 1;
    const { dialogue } = createDialogueServices(this.model, { timeoutMs: this.config.dialogueTimeoutMs,
      offerIdentitySource: () => ({ offerId, offerVersion }) });
    const current = () => {
      if (this.closed || job.signal.aborted || this.jobs.get(id) !== job || this.stopped(id)) return false;
      const latest = this.get(id);
      return latest.call.callState === "connected" && !latest.internal.stopRequested && !latest.internal.correlation?.recoveryRequired
        && latest.call.plan.id === call.plan.id && latest.call.plan.version === call.plan.version
        && latest.call.activeOffer?.id === call.activeOffer?.id && latest.call.activeOffer?.version === call.activeOffer?.version
        && latest.call.messages.findLast(m => m.speaker === "business")?.id === trigger.id;
    };
    void dialogue.propose({ attemptId: id, turnId: trigger.turnId, turnVersion: 1, plan: call.plan,
      bookingState: call.bookingState, callState: call.callState, offer: call.activeOffer,
      ...(call.conversation ? { conversation: call.conversation } : {}), triggerMessageId: trigger.id, messages: call.messages }, job.signal)
      .then(proposal => {
        if (!current()) return;
        const output: QueuedOutput[] = [];
        this.change(id, (a, emit) => {
          for (const translation of proposal.translations) {
            const message = a.call.messages.find(m => m.id === translation.messageId)!;
            message.translationEn = translation.translationEn; emit("transcript.updated", message);
          }
          if (proposal.candidate.action === "evaluate_offer") {
            const previous = a.call.activeOffer;
            const offer = proposal.candidate.offer;
            if (previous?.id !== offer.id || previous.version !== offer.version) a.internal.grant = null;
            this.update(a, emit, { type: "offer_received", offer });
          }
          this.respond(a, emit, proposal.candidate, (frame, permit) => output.push({ frame, permit }));
        });
        this.deliver(id, trigger.id, output, send);
      }).catch(() => { try { if (current()) this.fail(id); } catch { /* No output is safe without current durable state. */ } })
      .finally(() => { if (this.jobs.get(id) === job) this.jobs.delete(id); });
  }
  private respond(a: Attempt, emit: Emit, candidate: CandidateAction, send: Queue) {
    const now = this.now();
    const decision = this.services!.bookingPolicy.evaluate({ snapshot: a.call, candidate, now, grant: a.internal.grant ?? null });
    if (decision.decision === "ask_user" && decision.reason !== "add_on" && decision.reason !== "share_contact" && a.call.activeOffer) {
      if (!a.call.pendingApproval) {
        const approval = { id: randomUUID(), attemptId: a.call.id,
          plan: { planId: a.call.plan.id, planVersion: a.call.plan.version }, offer: a.call.activeOffer,
          reason: decision.reason, createdAt: now, expiresAt: new Date(Date.now() + this.config.simulatorApprovalSeconds * 1000).toISOString() };
        this.update(a, emit, { type: "approval_requested", approval });
        emit("approval.requested", approval);
      }
      this.speak(a, emit, spanishWaitingForApproval(), send); return;
    }
    if (decision.decision === "allow" && candidate.action === "evaluate_offer") {
      this.respond(a, emit, { action: "read_back", offerId: candidate.offer.id, offerVersion: candidate.offer.version }, send); return;
    }
    if (decision.decision === "allow" && candidate.action !== "accept_offer" && candidate.action !== "record_business_confirmation") {
      if (candidate.action === "read_back") this.update(a, emit, { type: "readback_started", offerId: candidate.offerId, offerVersion: candidate.offerVersion });
      // There is deliberately no route to acceptance without attested full readback playback.
      this.speak(a, emit, decision.approvedSpanishText, send);
      if (candidate.action === "end_call") {
        this.update(a, emit, { type: "call_finished", reason: candidate.reason === "unresolved" ? "technical_failure" : candidate.reason });
        send({ type: "end", handoffData: JSON.stringify({ reasonCode: "dialogue_complete", bookingStatus: "not_booked" }) }, null);
      }
      return;
    }
    if (decision.decision === "clarify" && ["service", "name", "date", "time", "price", "conditions"].includes(decision.field)) {
      const clarify = this.services!.bookingPolicy.evaluate({ snapshot: a.call,
        candidate: { action: "clarify", missing: [decision.field as "price"] }, now, grant: null });
      if (clarify.decision === "allow") { this.speak(a, emit, clarify.approvedSpanishText, send); return; }
    }
    emit("call.error", { code: "PROVIDER_NOT_READY", message: "The proposed reply was withheld by policy or requires playback/consent support. No acceptance was sent.", recoverable: true });
    this.speak(a, emit, "Un momento, por favor. No puedo aceptar ni confirmar una reserva todavía.", send);
  }
  private deliver(id: string, triggerId: string, output: QueuedOutput[], send: RelaySend) {
    // Commit transcript/events first; Stop from a synchronous subscriber must still prevent delivery.
    for (const { frame, permit } of output.splice(0)) {
      if (this.closed || this.speechPending.has(id) || this.stopped(id)) return;
      const a = this.get(id);
      if (a.internal.stopRequested || a.internal.correlation?.recoveryRequired || a.call.callState !== "connected"
        || a.call.messages.findLast(m => m.speaker === "business")?.id !== triggerId) return;
      if (permit && (Date.now() >= Date.parse(permit.expiresAt) || permit.attemptId !== id
        || permit.planId !== a.call.plan.id || permit.planVersion !== a.call.plan.version
        || permit.offer?.id !== a.call.activeOffer?.id || permit.offer?.version !== a.call.activeOffer?.version
        || a.call.messages.findLast(m => m.speaker === "assistant")?.id !== permit.outputId
        || a.call.messages.find(m => m.id === permit.outputId)?.originalText !== permit.approvedSpanishText)) return;
      send(frame);
    }
  }
  expire(id: string) {
    const a = this.get(id); const approval = a.call.pendingApproval;
    if (!approval || Date.now() < Date.parse(approval.expiresAt)) return false;
    this.cancel(id);
    this.change(id, (a, emit) => { a.internal.grant = null;
      this.update(a, emit, { type: "approval_resolved", approvalId: approval.id, status: "expired" });
    });
    return true;
  }
  private speak(a: Attempt, emit: Emit, text: string, send: Queue) {
    if (this.closed || this.speechPending.has(a.call.id) || a.internal.stopRequested || a.internal.correlation?.recoveryRequired || a.call.callState !== "connected" || a.call.messages.length >= 1999) return;
    const trigger = a.call.messages.findLast(m => m.speaker === "business");
    if (!trigger) return;
    // One-use, current-state permit, consumed synchronously at the voice boundary.
    const permit = PlaybackPermitSchema.parse({ id: randomUUID(), attemptId: a.call.id, planId: a.call.plan.id,
      planVersion: a.call.plan.version, turnId: trigger.turnId, turnVersion: 1, outputId: randomUUID(),
      offer: a.call.activeOffer ? { id: a.call.activeOffer.id, version: a.call.activeOffer.version } : null,
      approvedSpanishText: text, expiresAt: new Date(Date.now() + 1000).toISOString() });
    const message = { id: permit.outputId, turnId: trigger.turnId, speaker: "assistant" as const,
      originalText: permit.approvedSpanishText, language: "es-ES" as const, translationEn: null,
      final: true, playback: "generated" as const, createdAt: a.call.updatedAt };
    a.call.messages.push(message); emit("transcript.updated", message);
    send({ type: "text", token: permit.approvedSpanishText, lang: "es-ES", last: true, interruptible: true, preemptible: true }, permit);
  }
  decide(id: string, decision: ApprovalDecision, key: string) {
    const body = JSON.stringify(decision); const endpoint = `dialogue-approval:${id}`;
    const replay = this.store.calls.command(key);
    if (replay) {
      if (replay.endpoint !== endpoint || replay.body !== body) throw new CommandError(409, "IDEMPOTENCY_CONFLICT", "Command key differs");
      return this.get(id).call;
    }
    if (this.speechPending.has(id)) throw new CommandError(409, "APPROVAL_STALE", "Wait for the contact to finish speaking before approving");
    this.stopped(id);
    const a = this.get(id); const approval = a.call.pendingApproval;
    if (a.call.callState !== "connected" || a.internal.stopRequested) throw new CommandError(409, "CALL_NOT_ACTIVE", "Call is not active");
    if (!approval || approval.id !== decision.approvalId || approval.plan.planId !== decision.plan.planId || approval.plan.planVersion !== decision.plan.planVersion
      || approval.offer.id !== decision.offer.offerId || approval.offer.version !== decision.offer.offerVersion) throw new CommandError(409, "APPROVAL_STALE", "Approval differs from current offer");
    if (Date.now() >= Date.parse(approval.expiresAt)) throw new CommandError(409, "APPROVAL_EXPIRED", "Approval has expired");
    this.cancel(id);
    const output: QueuedOutput[] = [];
    const send = this.senders.get(id);
    this.change(id, (a, emit) => {
      this.update(a, emit, { type: "approval_resolved", approvalId: approval.id, status: decision.decision === "approve" ? "approved" : "rejected" });
      a.internal.grant = decision.decision === "approve" ? { approvalId: approval.id, attemptId: id, planId: a.call.plan.id, planVersion: a.call.plan.version,
        offerId: approval.offer.id, offerVersion: approval.offer.version, expiresAt: approval.expiresAt } satisfies ExactOfferGrant : null;
      this.store.calls.recordCommand(key, endpoint, body, id);
      if (send && decision.decision === "approve") this.respond(a, emit, { action: "read_back", offerId: approval.offer.id, offerVersion: approval.offer.version }, (frame, permit) => output.push({ frame, permit }));
    });
    if (send) this.deliver(id, a.call.messages.findLast(m => m.speaker === "business")!.id, output, send);
    return this.get(id).call;
  }
}
