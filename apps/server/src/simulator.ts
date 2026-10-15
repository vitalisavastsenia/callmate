import { randomUUID } from "node:crypto";
import {
  ApprovedPlanSchema, CallSnapshotSchema, DialogueInputSchema, DialogueProposalSchema, DomainEventSchema,
  PlaybackPermitSchema, ReviewPlanSchema,
} from "@callmate/contracts";
import type {
  ApprovalDecision, CallSnapshot, DialoguePort, DomainEvent, Outcome, PlaybackPermit, ReviewPlan,
} from "@callmate/contracts";
import type { z } from "zod";
import type { RequestDraftSchema, StartCallRequestSchema } from "@callmate/contracts";
import { isManualAttempt } from "./call-store.js";
import type { Attempt, CallStore } from "./call-store.js";
import type { Config } from "./config.js";
import type { Store } from "./storage.js";
import { CommandError } from "./errors.js";
import { FakeDialogue, FakeTelephony, FakeVoice, scriptedOffer, simulatorPolicy } from "./simulator-adapters.js";

import { initialUsage, measureUsage, budgetExpired, usageSampleDue, terminalUsage } from "./usage.js";

type Emit = (type: DomainEvent["type"], payload: unknown) => void;
export type SimulatorOptions = { now?: () => number; automatic?: boolean; dialogue?: DialoguePort };

export class Simulator {
  private readonly db: CallStore;
  private readonly now: () => number;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly jobs = new Map<string, AbortController>();
  private readonly permits = new Map<string, { permit: PlaybackPermit; revision: number }>();
  private readonly telephony = new FakeTelephony();
  private readonly voice: FakeVoice;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(private config: Config, private store: Store, private options: SimulatorOptions = {}) {
    this.db = store.calls;
    this.now = options.now ?? Date.now;
    this.voice = new FakeVoice((permit) => {
      const minted = this.permits.get(permit.id);
      this.permits.delete(permit.id);
      const current = this.db.get(permit.attemptId);
      return !this.closed && !this.enforceBudget(permit.attemptId) && !!minted && JSON.stringify(minted.permit) === JSON.stringify(permit)
        && !!current && current.call.revision === minted.revision && current.call.callState === "connected"
        && this.now() < Date.parse(permit.expiresAt);
    });
    // Fake providers have no surviving external call. Never resume an old script or redial on restart.
    const interrupted = this.db.active();
    if (interrupted && !isManualAttempt(interrupted) && interrupted.call.mode === "simulator") this.change(interrupted.call.id, (a, emit) => {
      this.finish(a, emit, a.internal.accepted ? this.uncertain("provider_state_unknown")
        : this.notBooked("technical_failure", "Simulation interrupted by a server restart; no real call was made."));
    });
    if (options.automatic !== false) {
      this.timer = setInterval(() => { void this.tick().catch(() => this.failActive()); }, Math.min(config.simulatorStepMs, 100));
      this.timer.unref();
    }
  }

  private timestamp() { return new Date(this.now()).toISOString(); }
  private require(id: string): Attempt {
    const attempt = this.db.get(id);
    if (!attempt || isManualAttempt(attempt)) throw new CommandError(404, "NOT_FOUND", "Call attempt not found");
    return attempt;
  }
  get(id: string) { return this.require(id).call; }
  observe(id: string, listener: () => void) {
    const listeners = this.listeners.get(id) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  private notify(id: string) { for (const listener of this.listeners.get(id) ?? []) listener(); }

  private edit(a: Attempt, work: (a: Attempt, emit: Emit) => void) {
    const events: DomainEvent[] = [];
    a.call.revision++;
    a.call.updatedAt = this.timestamp();
    const wasTerminal = terminalUsage(a.call);
    const emit: Emit = (type, payload) => events.push(DomainEventSchema.parse({ contractVersion: 1, id: randomUUID(),
      attemptId: a.call.id, sequence: ++a.call.lastEventSequence, snapshotRevision: a.call.revision,
      occurredAt: a.call.updatedAt, type, payload }));
    work(a, emit);
    if (!wasTerminal) measureUsage(a.call, this.now(), emit);
    this.db.save(a, events);
    return a.call;
  }
  private change(id: string, work: (a: Attempt, emit: Emit) => void) {
    const call = this.db.transaction(() => this.edit(this.require(id), work));
    this.notify(id);
    return call;
  }
  private booking(a: Attempt, emit: Emit, state: CallSnapshot["bookingState"], outcome: Outcome = { status: "pending" }) {
    a.call.bookingState = state;
    a.call.outcome = outcome;
    emit("booking.updated", { bookingState: state, outcome });
  }
  private status(a: Attempt, emit: Emit, state: CallSnapshot["callState"]) {
    a.call.callState = state;
    emit("call.status", { callState: state });
    this.telephony.setState(a.call.id, state);
  }
  private resolve(a: Attempt, emit: Emit, status: "approved" | "rejected" | "expired" | "invalidated") {
    const approval = a.call.pendingApproval;
    if (!approval) return;
    emit("approval.resolved", { approvalId: approval.id,
      offer: { offerId: approval.offer.id, offerVersion: approval.offer.version }, status });
    a.call.pendingApproval = null;
  }
  private notBooked(reason: Extract<Outcome, { status: "not_booked" }>["reason"], summaryEn: string): Extract<Outcome, { status: "not_booked" }> {
    return { status: "not_booked", reason, summaryEn };
  }
  private uncertain(reason: Extract<Outcome, { status: "uncertain" }>["reason"]): Extract<Outcome, { status: "uncertain" }> {
    return { status: "uncertain", reason,
      summaryEn: "Simulated booking status is uncertain. A real call in this state would require checking with the business before retrying." };
  }
  private finish(a: Attempt, emit: Emit, outcome: Outcome, state: "ended" | "busy" | "no_answer" | "failed" = "ended") {
    this.resolve(a, emit, "invalidated");
    const finalOutcome = outcome.status === "pending" ? this.uncertain("ambiguous_confirmation") : outcome;
    if (a.call.outcome.status === "pending") this.booking(a, emit, finalOutcome.status, finalOutcome);
    this.status(a, emit, state);
    a.internal.phase = "done";
    a.internal.grant = null;
    this.cancel(a.call.id);
  }
  private cancel(id: string) {
    this.jobs.get(id)?.abort();
    for (const [key, value] of this.permits) if (value.permit.attemptId === id) this.permits.delete(key);
  }
  private failActive() {
    if (this.closed) return;
    const active = this.db.active();
    if (active && !isManualAttempt(active)) this.change(active.call.id, (a, emit) => {
      emit("call.error", { code: "INTERNAL_ERROR", message: "The simulation could not continue", recoverable: false });
      this.finish(a, emit, a.internal.accepted ? this.uncertain("provider_state_unknown")
        : this.notBooked("technical_failure", "The simulation stopped after an internal error."), "failed");
    });
  }

  private future(plan: ReviewPlan) {
    if (plan.request.availability.some((window) => Date.parse(window.start.instant) <= this.now())) {
      throw new CommandError(400, "INVALID_REQUEST", "Availability must start in the future; review a new plan");
    }
    const limits = this.store.getSettings().defaultCallLimits;
    if (plan.request.callLimits.maxDurationSeconds > limits.maxDurationSeconds
      || plan.request.callLimits.maxEstimatedCost.amountMinor > limits.maxEstimatedCost.amountMinor) {
      throw new CommandError(400, "INVALID_REQUEST", "Call limits exceed the current application settings");
    }
  }
  createPlan(request: z.infer<typeof RequestDraftSchema>) {
    const plan = ReviewPlanSchema.parse({ id: randomUUID(), version: 1, createdAt: this.timestamp(), request });
    this.future(plan);
    this.db.putPlan(plan);
    return plan;
  }
  private replay(key: string, endpoint: string, body: string): CallSnapshot | undefined {
    const previous = this.db.command(key);
    if (!previous) return;
    if (previous.endpoint !== endpoint || previous.body !== body) {
      throw new CommandError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different command");
    }
    return this.get(previous.attemptId);
  }
  start(request: z.infer<typeof StartCallRequestSchema>, key: string) {
    const body = JSON.stringify(request);
    return this.db.transaction(() => {
      const previous = this.replay(key, "start", body);
      if (previous) return previous;
      if (request.mode !== this.config.mode) throw new CommandError(409, "MODE_MISMATCH", "Requested mode differs from server configuration");
      if (request.mode !== "simulator") throw new CommandError(503, "PROVIDER_NOT_READY", "Live providers are not implemented");
      const plan = this.db.plan(request.planId);
      if (!plan) throw new CommandError(404, "NOT_FOUND", "Review plan not found");
      if (plan.version !== request.planVersion) throw new CommandError(409, "PLAN_VERSION_MISMATCH", "Review plan version does not match");
      this.future(plan);
      if (this.db.active()) throw new CommandError(409, "CALL_ALREADY_ACTIVE", "Another call is still active");
      const call = CallSnapshotSchema.parse({ id: randomUUID(), revision: 1, lastEventSequence: 1,
        mode: "simulator", plan: ApprovedPlanSchema.parse({ ...plan, approvedAt: this.timestamp() }),
        callState: "creating", bookingState: "pending", outcome: { status: "pending" },
        activeOffer: null, pendingApproval: null, conversationData: "retained", messages: [],
        usage: initialUsage(this.timestamp(), this.config.testRateMinorPerMinute, plan.request.callLimits.maxEstimatedCost),
        createdAt: this.timestamp(), updatedAt: this.timestamp() });
      this.db.save({ call, replayFloor: 0, internal: { scenario: this.config.simulatorScenario, phase: "dial",
        nextAt: this.now() + this.config.simulatorStepMs, accepted: false, grant: null,
        silenceTimeoutSeconds: this.config.silenceTimeoutSeconds } },
      [DomainEventSchema.parse({ contractVersion: 1, id: randomUUID(), attemptId: call.id, sequence: 1,
        snapshotRevision: 1, occurredAt: this.timestamp(), type: "call.status", payload: { callState: "creating" } })]);
      this.db.recordCommand(key, "start", body, call.id);
      return call;
    });
  }
  stop(id: string) {
    const current = this.require(id);
    if (current.internal.phase === "done" || current.call.callState === "ending") return current.call;
    return this.change(id, (a, emit) => {
      this.cancel(id);
      this.resolve(a, emit, "invalidated");
      if (a.call.bookingState === "awaiting_approval") this.booking(a, emit, "pending");
      this.status(a, emit, "ending");
      a.internal.phase = "end";
      a.internal.nextAt = this.now();
      a.internal.grant = null;
    });
  }

  decide(id: string, decision: ApprovalDecision, key: string) {
    this.enforceBudget(id);
    this.expire(id);
    const endpoint = `approval:${id}`, body = JSON.stringify(decision);
    const call = this.db.transaction(() => {
      const replay = this.replay(key, endpoint, body);
      if (replay) return replay;
      const a = this.require(id);
      const approval = a.call.pendingApproval;
      if (!approval) {
        const resolution = this.db.events(id, 0).findLast((event) => event.type === "approval.resolved"
          && event.payload.approvalId === decision.approvalId);
        throw new CommandError(409, resolution?.type === "approval.resolved" && resolution.payload.status === "expired"
          ? "APPROVAL_EXPIRED" : a.internal.phase === "done" ? "CALL_NOT_ACTIVE" : "APPROVAL_STALE", "Approval is no longer available");
      }
      if (approval.id !== decision.approvalId || approval.plan.planId !== decision.plan.planId
        || approval.plan.planVersion !== decision.plan.planVersion || approval.offer.id !== decision.offer.offerId
        || approval.offer.version !== decision.offer.offerVersion) {
        throw new CommandError(409, "APPROVAL_STALE", "Approval does not match the current offer and plan");
      }
      const call = this.edit(a, (a, emit) => {
        this.resolve(a, emit, decision.decision === "approve" ? "approved" : "rejected");
        if (decision.decision === "reject") {
          this.finish(a, emit, this.notBooked("policy_declined", "The simulated offer was rejected; no appointment was booked."));
        } else {
          a.internal.grant = { approvalId: approval.id, expiresAt: approval.expiresAt, offerVersion: approval.offer.version };
          // A queued changed offer still invalidates this grant before any acceptance.
          if (a.internal.phase !== "change") a.internal.phase = "accept";
          a.internal.nextAt = this.now() + this.config.simulatorStepMs;
          this.booking(a, emit, "reading_back");
        }
      });
      this.db.recordCommand(key, endpoint, body, id);
      return call;
    });
    this.notify(id);
    return call;
  }

  private expire(id: string) {
    const a = this.require(id);
    if (!a.call.pendingApproval || this.now() < Date.parse(a.call.pendingApproval.expiresAt)) return;
    this.change(id, (a, emit) => {
      this.resolve(a, emit, "expired");
      this.finish(a, emit, this.notBooked("policy_declined", "The simulated approval expired without acceptance."));
    });
  }
  history(limit: number, cursor?: string) {
    if (cursor && !this.db.get(cursor)) throw new CommandError(404, "NOT_FOUND", "Call attempt not found");
    const calls = this.db.list(limit + 1, cursor);
    return { items: calls.slice(0, limit).map((call) => ({ id: call.id, mode: call.mode,
      businessName: call.plan?.request.business.name ?? "Manual mock call", callState: call.callState, outcome: call.outcome, ...("kind" in call ? { kind: call.kind } : {}),
      createdAt: call.createdAt, usage: call.usage })), nextCursor: calls.length > limit ? calls[limit - 1]!.id : null };
  }
  deleteConversation(id: string) {
    const a = this.require(id);
    if (a.internal.phase !== "done") throw new CommandError(409, "DATA_NOT_DELETABLE", "Conversation deletion requires a terminal call");
    if (a.call.conversationData !== "deleted") this.change(id, (a, emit) => {
      this.db.purgeEvents(id);
      a.replayFloor = a.call.lastEventSequence;
      a.call.messages = [];
      a.call.conversationData = "deleted";
      emit("conversation.deleted", { conversationData: "deleted" });
    });
    return { attemptId: id, deleted: true as const };
  }
  replayEvents(id: string, after: number) {
    const a = this.require(id);
    return after < a.replayFloor || after > a.call.lastEventSequence ? null : this.db.events(id, after);
  }

  private message(a: Attempt, emit: Emit, speaker: "business" | "assistant", text: string, english: string, turnId: string = randomUUID()) {
    const message = { id: randomUUID(), turnId, speaker, originalText: text, language: "es-ES" as const,
      translationEn: english, final: true, playback: speaker === "business" ? "not_applicable" as const : "played" as const,
      createdAt: this.timestamp() };
    this.activity(a);
    a.call.messages.push(message);
    emit("transcript.updated", message);
    return message;
  }
  private offerDecision(a: Attempt, emit: Emit) {
    const offer = a.call.activeOffer!;
    const policy = simulatorPolicy.evaluate({ snapshot: a.call,
      candidate: { action: "accept_offer", offerId: offer.id, offerVersion: offer.version }, now: this.timestamp(), grant: null });
    if (policy.decision === "deny" || policy.decision === "clarify") {
      this.finish(a, emit, this.notBooked("policy_declined", "The scripted offer did not meet the approved constraints."));
    } else if (policy.decision === "ask_user") {
      const deadline = Math.min(this.now() + this.config.simulatorApprovalSeconds * 1000,
        Date.parse(a.call.createdAt) + a.call.plan.request.callLimits.maxDurationSeconds * 1000);
      a.call.pendingApproval = { id: randomUUID(), attemptId: a.call.id,
        plan: { planId: a.call.plan.id, planVersion: a.call.plan.version }, offer,
        reason: policy.reason, createdAt: this.timestamp(), expiresAt: new Date(deadline).toISOString() };
      emit("approval.requested", a.call.pendingApproval);
      this.booking(a, emit, "awaiting_approval");
      a.internal.phase = "wait";
    } else {
      this.booking(a, emit, "reading_back");
      a.internal.phase = "accept";
    }
    a.internal.nextAt = this.now() + this.config.simulatorStepMs;
  }

  private enforceBudget(id: string) {
    const current = this.require(id);
    if (terminalUsage(current.call) || current.call.callState === "ending" || !budgetExpired(current.call, this.now())) return false;
    this.change(id, (a, emit) => {
      emit("call.error", { code: "BUDGET_EXCEEDED", message: "Simulation reached its test-rate budget", recoverable: false });
      this.finish(a, emit, a.internal.accepted ? this.uncertain("disconnected_near_confirmation")
        : this.notBooked("technical_failure", "Simulation ended at its test-rate budget."));
    });
    return true;
  }

  async tick() {
    if (this.closed) return;
    let a = this.db.active();
    if (!a || isManualAttempt(a) || a.call.mode !== "simulator") return;
    const id = a.call.id;
    if (this.enforceBudget(id)) return;
    // Do not invalidate an in-flight dialogue result solely for a usage sample.
    if (!this.jobs.has(id) && usageSampleDue(a.call, this.now())) {
      this.change(id, () => {}); a = this.require(id);
    }
    if (a.call.callState === "ending") {
      await this.telephony.requestHangup(`simulator:${id}`);
      if (this.closed || this.require(id).call.callState !== "ending") return;
      this.change(id, (a, emit) => this.finish(a, emit, a.internal.accepted
        ? this.uncertain("disconnected_near_confirmation") : this.notBooked("user_stopped", "Simulation stopped by the user; no appointment was booked.")));
      return;
    }
    this.expire(id);
    if (this.db.active()?.call.id !== id) return;
    if (this.now() >= Date.parse(a.call.createdAt) + a.call.plan.request.callLimits.maxDurationSeconds * 1000) {
      this.change(id, (a, emit) => {
        emit("call.error", { code: "PROVIDER_UNAVAILABLE", message: "Simulation reached the approved duration limit", recoverable: false });
        this.finish(a, emit, a.internal.accepted ? this.uncertain("disconnected_near_confirmation")
          : this.notBooked("technical_failure", "Simulation ended at the approved duration limit."));
      });
      return;
    }
    if (a.internal.silenceDeadlineAt !== undefined && this.now() >= a.internal.silenceDeadlineAt) {
      this.change(id, (a, emit) => {
        emit("call.error", { code: "PROVIDER_UNAVAILABLE", message: "Simulation reached its silence deadline", recoverable: false });
        this.finish(a, emit, a.internal.accepted ? this.uncertain("disconnected_near_confirmation")
          : this.notBooked("technical_failure", "Simulation ended at its silence deadline."));
      });
      return;
    }
    if (this.jobs.has(id) || this.now() < a.internal.nextAt || a.internal.phase === "wait") return;
    const job = new AbortController();
    this.jobs.set(id, job);
    try {
      if (a.internal.phase === "dial") {
        await this.telephony.startCall({ attemptId: id, plan: a.call.plan });
        if (this.stale(a, job)) return;
        this.change(id, (a, emit) => { this.status(a, emit, "dialing"); a.internal.phase = "ring"; this.next(a); });
      } else if (a.internal.phase === "ring") {
        this.change(id, (a, emit) => { this.status(a, emit, "ringing"); a.internal.phase = "connect"; this.next(a); });
      } else if (a.internal.phase === "connect") {
        this.change(id, (a, emit) => {
          if (a.internal.scenario === "busy" || a.internal.scenario === "no_answer") {
            this.finish(a, emit, this.notBooked(a.internal.scenario, "The simulated business did not answer."), a.internal.scenario);
          } else if (a.internal.scenario === "provider_failure") {
            emit("call.error", { code: "PROVIDER_UNAVAILABLE", message: "Scripted provider failure", recoverable: false });
            this.finish(a, emit, this.notBooked("technical_failure", "The simulated provider failed before connection."), "failed");
          } else { this.status(a, emit, "connected"); this.activity(a); a.internal.phase = "offer"; this.next(a); }
        });
      } else if (a.internal.phase === "offer" || a.internal.phase === "change") {
        if (a.internal.scenario === "no_availability") {
          this.change(id, (a, emit) => {
            this.message(a, emit, "business", "No tenemos citas disponibles.", "We have no appointments available.");
            this.finish(a, emit, this.notBooked("no_availability", "No simulated appointment was available."));
          });
          return;
        }
        const trigger = { id: randomUUID(), turnId: randomUUID(), speaker: "business" as const,
          originalText: "Tenemos una cita disponible.", translationEn: "We have an appointment available.",
          language: "es-ES" as const, final: true, playback: "not_applicable" as const, createdAt: this.timestamp() };
        const input = DialogueInputSchema.parse({ attemptId: id, turnId: trigger.turnId, turnVersion: 1,
          plan: a.call.plan, bookingState: a.call.bookingState, offer: a.call.activeOffer,
          triggerMessageId: trigger.id, messages: [...a.call.messages, trigger] });
        const offer = scriptedOffer(input, a.internal.scenario, a.internal.phase === "change" ? 2 : 1);
        const description = `${offer.appointment.localDate}, ${offer.appointment.localTime}, ${offer.price!.amountMinor / 100} EUR`;
        trigger.originalText = `Tenemos una cita: ${description}. Sin depósito, cargos de cancelación ni extras.`;
        trigger.translationEn = `An appointment is available: ${description}. No deposit, cancellation fees or add-ons.`;
        input.offer = offer;
        input.messages[input.messages.length - 1] = trigger;
        this.change(id, (a, emit) => {
          if (a.internal.phase === "change") {
            this.resolve(a, emit, "invalidated");
            if (a.internal.grant && a.call.activeOffer) emit("approval.resolved", {
              approvalId: a.internal.grant.approvalId,
              offer: { offerId: a.call.activeOffer.id, offerVersion: a.call.activeOffer.version }, status: "invalidated",
            });
            a.internal.grant = null;
            a.call.activeOffer = null;
            this.booking(a, emit, "pending");
          }
          this.activity(a);
          a.call.messages.push(trigger);
          emit("transcript.updated", trigger);
        });
        const working = this.require(id);
        const proposed = await (this.options.dialogue ?? new FakeDialogue(a.internal.scenario)).propose(input, job.signal);
        if (this.stale(working, job)) return;
        const proposal = DialogueProposalSchema.parse(proposed);
        if (proposal.turnId !== input.turnId || proposal.turnVersion !== input.turnVersion
          || proposal.candidate.action !== "evaluate_offer" || JSON.stringify(proposal.candidate.offer) !== JSON.stringify(offer)) {
          throw new Error("Invalid scripted dialogue response");
        }
        this.change(id, (a, emit) => {
          this.resolve(a, emit, "invalidated");
          // A changed offer also invalidates an approval that has already been granted but not spoken.
          a.internal.grant = null;
          a.call.activeOffer = offer;
          emit("offer.updated", offer);
          this.booking(a, emit, "offer_received");
          this.offerDecision(a, emit);
          if (a.internal.scenario === "changed_offer" && offer.version === 1 && a.internal.phase !== "done") {
            a.internal.phase = "change";
          }
        });
      } else if (a.internal.phase === "accept") {
        const offer = a.call.activeOffer!;
        const grant = a.internal.grant;
        const policy = simulatorPolicy.evaluate({ snapshot: a.call,
          candidate: { action: "accept_offer", offerId: offer.id, offerVersion: offer.version }, now: this.timestamp(),
          grant: grant ? { approvalId: grant.approvalId, attemptId: id, planId: a.call.plan.id,
            planVersion: a.call.plan.version, offerId: offer.id, offerVersion: grant.offerVersion, expiresAt: grant.expiresAt } : null });
        if (policy.decision !== "allow") {
          this.change(id, (a, emit) => this.finish(a, emit, this.notBooked("policy_declined", "The simulated playback authorization expired or was not allowed.")));
          return;
        }
        // Persist commitment uncertainty before output; Stop/restart cannot claim non-booking after this point.
        this.change(id, (a) => { a.internal.accepted = true; });
        const current = this.require(id);
        const permit = PlaybackPermitSchema.parse({ id: randomUUID(), attemptId: id, planId: a.call.plan.id,
          planVersion: a.call.plan.version, turnId: randomUUID(), turnVersion: 1, outputId: randomUUID(),
          offer: { id: offer.id, version: offer.version }, approvedSpanishText: policy.approvedSpanishText,
          expiresAt: new Date(Math.min(this.now() + 5000, grant ? Date.parse(grant.expiresAt) : Infinity,
            Date.parse(a.call.createdAt) + a.call.plan.request.callLimits.maxDurationSeconds * 1000)).toISOString() });
        this.permits.set(permit.id, { permit, revision: current.call.revision });
        await this.voice.sendAuthorizedText(permit);
        if (this.stale(current, job)) return;
        this.change(id, (a, emit) => {
          this.message(a, emit, "assistant", permit.approvedSpanishText,
            `Please book ${offer.appointment.localDate} at ${offer.appointment.localTime} under ${offer.bookingName}.`, permit.turnId);
          this.booking(a, emit, "awaiting_business_confirmation");
          a.internal.phase = "confirm";
          a.internal.grant = null;
          this.next(a);
        });
      } else if (a.internal.phase === "confirm") {
        this.change(id, (a, emit) => {
          if (a.internal.scenario === "disconnect") {
            this.finish(a, emit, this.uncertain("disconnected_near_confirmation"));
          } else {
            const offer = a.call.activeOffer!;
            const confirmation = this.message(a, emit, "business",
              `Sí, queda reservada la cita del ${offer.appointment.localDate} a las ${offer.appointment.localTime}, a nombre de ${offer.bookingName}, por ${offer.price!.amountMinor / 100} euros.`,
              `Confirmed for ${offer.appointment.localDate} at ${offer.appointment.localTime} under ${offer.bookingName}, for EUR ${offer.price!.amountMinor / 100}.`);
            this.booking(a, emit, "confirmed", { status: "confirmed", offer, confirmedAt: this.timestamp(),
              confirmationMessageIds: [confirmation.id],
              summaryEn: `Simulated appointment confirmed for ${offer.appointment.localDate} at ${offer.appointment.localTime} (${offer.appointment.timeZone}) under ${offer.bookingName}, EUR ${offer.price!.amountMinor / 100}. No real booking was made.` });
            a.internal.phase = "end";
            this.next(a);
          }
        });
      } else if (a.internal.phase === "end") {
        await this.telephony.requestHangup(`simulator:${id}`);
        if (!this.stale(a, job)) this.change(id, (a, emit) => this.finish(a, emit, a.call.outcome));
      }
    } catch {
      if (!job.signal.aborted && !this.closed) this.failActive();
    } finally {
      if (this.jobs.get(id) === job) this.jobs.delete(id);
    }
  }
  private activity(a: Attempt) {
    a.internal.silenceDeadlineAt = this.now() + (a.internal.silenceTimeoutSeconds ?? this.config.silenceTimeoutSeconds) * 1000;
  }
  private next(a: Attempt) { a.internal.nextAt = this.now() + this.config.simulatorStepMs; }
  private stale(a: Attempt, job: AbortController) {
    return this.closed || job.signal.aborted || this.enforceBudget(a.call.id) || this.require(a.call.id).call.revision !== a.call.revision;
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const job of this.jobs.values()) job.abort();
    this.permits.clear();
    this.listeners.clear();
    await this.voice.close();
  }
}
