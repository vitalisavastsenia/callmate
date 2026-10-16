import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ApprovalDecision, CallSnapshot, DomainEvent, ReviewPlan, CandidateAction, PlaybackPermit } from "@callmate/contracts";
import { PlaybackPermitSchema, templateForRequest, templateForService, RequestDraftSchema } from "@callmate/contracts";
import { createDialogueServices, createOpenAIModelClient, createCodexModelClient, reduceBooking, renderReply, renderAction, dialogueLanguage } from "@callmate/dialogue";
import type { ModelClient, BookingEvent, ExactOfferGrant, RenderedReply } from "@callmate/dialogue";
import type { Config } from "./config.js";
import type { Store } from "./storage.js";
import { isMockAttempt } from "./call-store.js";
import type { MockAttempt } from "./call-store.js";
import type { RelayOutbound } from "./twilio/protocol.js";
import type { RelaySend } from "./mock-relay.js";
import { CommandError } from "./errors.js";
import { mockRelayEnabled } from "./mock-relay.js";
import { MockCallsClient } from "./mock-calls-client.js";
import { verifyMockConfirmation } from "./mock-confirmation.js";

type Attempt = MockAttempt & { call: CallSnapshot };
type Emit = (type: DomainEvent["type"], payload: unknown) => void;
type QueuedOutput = { frame: RelayOutbound; permit: PlaybackPermit | null };
type Queue = (frame: RelayOutbound, permit: PlaybackPermit | null) => void;
type Change = (id: string, work: (a: Attempt, emit: Emit) => void) => unknown;

/** Controller-owned dialogue. Only authenticated mock receipts simulate completed playback. */
export class RelayDialogue {
  private services: ReturnType<typeof createDialogueServices> | undefined;
  private jobs = new Map<string, AbortController>();
  private senders = new Map<string, RelaySend>();
  private closed = false;
  private playbackJobs = new Map<string, Promise<void>>();
  private speechPending = new Set<string>();
  get enabled() { return !!this.services; }
  constructor(private config: Config, private store: Store, private change: Change,
    private stopped: (id: string) => boolean, model?: ModelClient) {
    if (model || config.dialogueProvider !== "disabled") {
      const client = model ?? (config.dialogueProvider === "codex"
        ? createCodexModelClient({ ...(config.dialogueModel ? { model: config.dialogueModel } : {}), timeoutMs: config.dialogueTimeoutMs })
        : createOpenAIModelClient({ apiKey: config.openaiApiKey!, model: config.dialogueModel!, timeoutMs: config.dialogueTimeoutMs }));
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
    if ((plan.request.requestType ?? "book") !== "book" || !templateForRequest(plan.request) || templateForService(plan.request.service)?.id !== templateForRequest(plan.request)?.id) {
      throw new CommandError(400, "INVALID_REQUEST", "Select a supported appointment template and matching service");
    }
    const profile = templateForRequest(plan.request)!;
    if (!RequestDraftSchema.safeParse({ ...plan.request, templateId: profile.id }).success) throw new CommandError(400, "INVALID_REQUEST", "Complete the required template details before starting");
    if (/[\p{Cc}\p{Cf}<>]/u.test(plan.request.bookingName)) throw new CommandError(400, "INVALID_REQUEST", "Booking name cannot be spoken safely");
    // Full availability and goal remain in every model input; disclosure precedes the first business turn.
    return this.opening(plan).text;
  }
  opening(plan: ReviewPlan) { return renderReply("greeting", plan, {}, this.store.phrases.lookup); }
  speech(id: string) {
    if (!this.enabled || !this.store.calls.get(id)?.call.plan) return;
    this.speechPending.add(id); this.cancel(id);
  }
  cancel(id: string) { this.jobs.get(id)?.abort(); this.jobs.delete(id); }
  close() { this.closed = true; for (const id of this.jobs.keys()) this.cancel(id); this.senders.clear(); this.speechPending.clear(); }
  private update(a: Attempt, emit: Emit, event: BookingEvent) {
    const previous = a.call.pendingApproval;
    const { acceptance, ...fields } = reduceBooking(a.call, event, this.now(), a.internal.dialoguePlayback?.acceptance ?? null);
    if (a.internal.dialoguePlayback) a.internal.dialoguePlayback.acceptance = acceptance;
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
  interrupt(id: string) {
    this.speech(id);
    this.change(id, (a, emit) => {
      const playback = a.internal.dialoguePlayback;
      if (!playback || a.call.callState !== "connected") return;
      for (const pending of playback.pending) {
        const message = a.call.messages.find(m => m.id === pending.permit.outputId);
        if (message?.playback === "playing") { message.playback = "interrupted"; emit("transcript.updated", message); }
      }
      playback.pending = [];
    });
  }
  async syncPlayback(id: string): Promise<void> {
    if (!mockRelayEnabled(this.config) || this.closed) return;
    const existing = this.playbackJobs.get(id); if (existing) return existing;
    const job = this.reconcilePlayback(id).finally(() => { if (this.playbackJobs.get(id) === job) this.playbackJobs.delete(id); });
    this.playbackJobs.set(id, job); return job;
  }
  private async reconcilePlayback(id: string) {
    const client = new MockCallsClient(this.config);
    while (!this.closed && !this.stopped(id)) {
      const a = this.get(id), pending = a.internal.dialoguePlayback?.pending[0];
      const sessionId = a.internal.correlation?.sessionId;
      if (!pending || !sessionId || !a.internal.callSid || a.internal.stopRequested
        || a.internal.correlation?.recoveryRequired || a.call.callState !== "connected") return;
      let receipt;
      for (let retry = 0; retry < 3; retry++) {
        try { receipt = await client.outputReceipt(a.internal.callSid, sessionId, pending.sequence); break; }
        catch { if (retry < 2) await delay(50); }
      }
      if (!receipt || receipt.textSha256 !== createHash("sha256").update(pending.permit.approvedSpanishText).digest("hex")
        || receipt.language !== dialogueLanguage(a.call.plan) || Date.parse(receipt.completedAt) < Date.parse(pending.startedAt)
        || Date.parse(receipt.completedAt) > Date.now()) return;
      if (this.closed || this.stopped(id)) return;
      this.change(id, (a, emit) => {
        const playback = a.internal.dialoguePlayback;
        const current = playback?.pending[0];
        const message = a.call.messages.find(m => m.id === pending.permit.outputId);
        if (!playback || current?.permit.id !== pending.permit.id || message?.playback !== "playing"
          || a.internal.stopRequested || a.internal.correlation?.recoveryRequired || a.call.callState !== "connected") return;
        message.playback = "played"; emit("transcript.updated", message);
        playback.pending.shift();
        if (message.phrase?.id.endsWith(".acceptance") && pending.readbackMessageId && a.call.activeOffer) {
          this.update(a, emit, { type: "acceptance_played", receipt: { permit: pending.permit,
            offer: a.call.activeOffer, readbackMessageId: pending.readbackMessageId,
            acceptanceMessageId: message.id, startedAt: pending.startedAt, observedAt: receipt!.completedAt } });
        }
      });
      // An interruption/Stop can consume or invalidate a pending output during the HTTP request.
      if (this.get(id).internal.dialoguePlayback?.pending[0]?.permit.id === pending.permit.id) return;
    }
  }
  prompt(id: string, send: RelaySend) {
    if (!this.model || this.closed) return;
    this.cancel(id); this.speechPending.delete(id); this.senders.set(id, send);
    const triggerId = this.get(id).call.messages.findLast(m => m.speaker === "business")?.id;
    const job = new AbortController(); this.jobs.set(id, job);
    void this.syncPlayback(id).then(() => {
      if (this.closed || job.signal.aborted || this.jobs.get(id) !== job || this.stopped(id)
        || this.get(id).call.messages.findLast(m => m.speaker === "business")?.id !== triggerId) return;
      this.generate(id, send, job);
    }).catch(() => { if (!job.signal.aborted) this.fail(id); });
  }
  private generate(id: string, send: RelaySend, job: AbortController) {
    if (!this.model || this.closed) return;
    const a = this.get(id); const call = structuredClone(a.call);
    const trigger = call.messages.findLast(m => m.speaker === "business");
    if (!trigger || call.callState !== "connected" || call.outcome.status !== "pending" || a.internal.stopRequested) return;
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
      this.speak(a, emit, renderReply("waiting", a.call.plan, {}, this.store.phrases.lookup), send); return;
    }
    if (decision.decision === "allow" && candidate.action === "evaluate_offer") {
      this.respond(a, emit, { action: "read_back", offerId: candidate.offer.id, offerVersion: candidate.offer.version }, send); return;
    }
    if (decision.decision === "allow" && candidate.action === "record_business_confirmation") {
      const evidence = a.call.messages.filter(m => candidate.evidenceMessageIds.includes(m.id));
      if (!mockRelayEnabled(this.config) || verifyMockConfirmation({ offer: a.call.activeOffer!, evidence,
        businessMessagesAfterAcceptance: evidence }) !== "affirmed") {
        this.speak(a, emit, renderReply("confirm_booking", a.call.plan, {}, this.store.phrases.lookup), send); return;
      }
      this.update(a, emit, { type: "business_confirmation", evidenceMessageIds: candidate.evidenceMessageIds, verifyMeaning: verifyMockConfirmation });
      if (a.call.outcome.status === "confirmed") {
        this.speak(a, emit, renderReply("closing_confirmed", a.call.plan, {}, this.store.phrases.lookup), send);
        send({ type: "end", handoffData: JSON.stringify({ reasonCode: "dialogue_complete", bookingStatus: "confirmed", simulation: true }) }, null);
      }
      return;
    }
    if (decision.decision === "allow" && (candidate.action !== "accept_offer" || mockRelayEnabled(this.config))) {
      if (candidate.action === "accept_offer" && verifyMockConfirmation({ offer: a.call.activeOffer!,
        evidence: a.call.messages.filter(m => m.id === a.call.messages.findLast(m => m.speaker === "business")?.id),
        businessMessagesAfterAcceptance: [] }) !== "affirmed") {
        this.speak(a, emit, renderReply("confirm_details", a.call.plan, {}, this.store.phrases.lookup), send); return;
      }
      if (candidate.action === "read_back") this.update(a, emit, { type: "readback_started", offerId: candidate.offerId, offerVersion: candidate.offerVersion });
      // Acceptance requires the authenticated mock receipt for the complete readback.
      this.speakDecision(a, emit, candidate, decision.approvedSpanishText, send);
      if (candidate.action === "end_call") {
        this.update(a, emit, { type: "call_finished", reason: candidate.reason === "unresolved" ? "technical_failure" : candidate.reason });
        send({ type: "end", handoffData: JSON.stringify({ reasonCode: "dialogue_complete", bookingStatus: "not_booked" }) }, null);
      }
      return;
    }
    if (decision.decision === "clarify" && ["service", "name", "date", "time", "price", "conditions", "details"].includes(decision.field)) {
      const clarify = this.services!.bookingPolicy.evaluate({ snapshot: a.call,
        candidate: { action: "clarify", missing: [decision.field as "price"] }, now, grant: null });
      if (clarify.decision === "allow") { this.speakDecision(a, emit, { action: "clarify", missing: [decision.field as "price"] }, clarify.approvedSpanishText, send); return; }
    }
    if (candidate.action === "accept_offer" && decision.decision === "clarify" && decision.field === "readback") {
      emit("call.error", { code: "PROVIDER_NOT_READY", message: "Readback delivery is not confirmed by the mock. Let the phrase finish, or check/update the mock service before trying again. No acceptance was sent.", recoverable: true });
      return;
    }
    emit("call.error", { code: "PROVIDER_NOT_READY", message: "The proposed reply was withheld by policy or requires playback/consent support. No acceptance was sent.", recoverable: true });
    this.speak(a, emit, renderReply("blocked", a.call.plan, {}, this.store.phrases.lookup), send);
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
      if (permit && frame.type === "text") {
        const message = a.call.messages.find(m => m.id === permit.outputId)!;
        if (message.phrase?.id.endsWith(".acceptance") && this.services!.bookingPolicy.evaluate({ snapshot: a.call,
          candidate: { action: "accept_offer", offerId: a.call.activeOffer!.id, offerVersion: a.call.activeOffer!.version },
          now: this.now(), grant: a.internal.grant ?? null }).decision !== "allow") return;
        this.change(id, (a, emit) => {
          const playback = a.internal.dialoguePlayback ??= { sequence: 1, pending: [], acceptance: null };
          const sequence = ++playback.sequence;
          const message = a.call.messages.find(m => m.id === permit.outputId)!;
          if (message.phrase?.id.endsWith(".readback") || message.phrase?.id.endsWith(".acceptance")) {
            message.playback = "playing"; emit("transcript.updated", message);
            playback.pending.push({ sequence, permit, startedAt: this.now(),
              readbackMessageId: message.phrase.id.endsWith(".acceptance")
                ? a.call.messages.findLast(m => m.phrase?.id.endsWith(".readback") && m.playback === "played")?.id ?? null : null });
          }
        });
        // Persistence/event subscribers can request Stop synchronously.
        if (this.closed || this.speechPending.has(id) || this.stopped(id)) return;
        const latest = this.get(id);
        if (latest.internal.stopRequested || latest.call.callState !== "connected"
          || latest.call.messages.findLast(m => m.speaker === "business")?.id !== triggerId) return;
      }
      send(frame);
    }
    void this.syncPlayback(id).catch(() => { /* Retain pending delivery for reconciliation; no guessed playback. */ });
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
  private speakDecision(a: Attempt, emit: Emit, candidate: CandidateAction, approved: string, send: Queue) {
    const plan = { ...a.call.plan, request: { ...a.call.plan.request,
      availability: a.call.plan.request.availability.filter(w => Date.parse(w.end.instant) > Date.now()) } };
    const reply = renderAction(candidate, plan, a.call.activeOffer, this.store.phrases.lookup, a.call.outcome.status === "confirmed");
    if (reply.text !== approved) throw new Error("Localized phrase does not match policy-approved text");
    this.speak(a, emit, reply, send);
  }
  private speak(a: Attempt, emit: Emit, reply: RenderedReply, send: Queue) {
    const text = reply.text;
    if (this.closed || this.speechPending.has(a.call.id) || a.internal.stopRequested || a.internal.correlation?.recoveryRequired || a.call.callState !== "connected" || a.call.messages.length >= 1999) return;
    const trigger = a.call.messages.findLast(m => m.speaker === "business");
    if (!trigger) return;
    // One-use, current-state permit, consumed synchronously at the voice boundary.
    const permit = PlaybackPermitSchema.parse({ id: randomUUID(), attemptId: a.call.id, planId: a.call.plan.id,
      planVersion: a.call.plan.version, turnId: trigger.turnId, turnVersion: 1, outputId: randomUUID(),
      offer: a.call.activeOffer ? { id: a.call.activeOffer.id, version: a.call.activeOffer.version } : null,
      approvedSpanishText: text, expiresAt: new Date(Date.now() + 1000).toISOString() });
    const message = { id: permit.outputId, turnId: trigger.turnId, speaker: "assistant" as const,
      originalText: permit.approvedSpanishText, language: dialogueLanguage(a.call.plan), translationEn: reply.translationEn, phrase: reply.phrase,
      final: true, playback: "generated" as const, createdAt: a.call.updatedAt };
    a.call.messages.push(message); emit("transcript.updated", message);
    send({ type: "text", token: permit.approvedSpanishText, lang: dialogueLanguage(a.call.plan), last: true, interruptible: true, preemptible: true }, permit);
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
