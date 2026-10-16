import { DialogueLanguageSchema } from "@callmate/contracts";
import { LlmAgent } from "./llm-agent.js";
import { dialogueLanguage } from "@callmate/dialogue";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { ManualCallSnapshotSchema, CallSnapshotSchema, ApprovedPlanSchema, DomainEventSchema, TranscriptMessageSchema, ManualTranscriptMessageSchema } from "@callmate/contracts";
import type { DomainEvent, ManualCallSnapshot, CallSnapshot, ApprovalDecision, ReviewPlan } from "@callmate/contracts";
import { z } from "zod";
import twilio from "twilio";
import type { Config } from "./config.js";
import type { Store } from "./storage.js";
import { isMockAttempt } from "./call-store.js";
import type { MockAttempt } from "./call-store.js";
import { CommandError, parseRequest } from "./errors.js";
import { assertDeletableAgreement } from "./agreements.js";
import { MockCallsClient, MockCallsError } from "./mock-calls-client.js";
import { mockRelayEnabled } from "./mock-relay.js";
import type { RelayConsumer, RelaySend } from "./mock-relay.js";
import type { RelayInbound } from "./twilio/protocol.js";
import { normalizeStatus, statusCallback, terminal as providerTerminal } from "./twilio/protocol.js";
import type { CallStatus } from "./twilio/protocol.js";

import { RelayDialogue } from "./relay-dialogue.js";
import type { ModelClient } from "@callmate/dialogue";

import { initialUsage, measureUsage, budgetExpired, usageSampleDue } from "./usage.js";

const startInput = z.strictObject({ requestId: z.uuid(), initialMessage: z.string().min(1).max(8000).refine((text) => text.trim().length > 0),
  language: z.enum(["es-ES", "ru-RU", "pl-PL", "en-US"]) });
const terminal = (call: ManualCallSnapshot | CallSnapshot) => ["ended", "busy", "no_answer", "failed"].includes(call.callState);
type Emit = (type: DomainEvent["type"], payload: unknown) => void;
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const progress = (status: CallStatus) => status === "queued" ? 0 : status === "ringing" ? 1 : status === "in-progress" ? 2 : 3;

/** Local mock transport for manual conversations and reviewed dialogue attempts. */
export type DevelopmentOptions = { now?: () => number; automatic?: boolean; model?: ModelClient };
export class DevelopmentConversations {
  private readonly dialogue: RelayDialogue;
  get dialogueEnabled() { return this.dialogue.enabled; }
  get mockTransportEnabled() { return this.config.telephonyProvider === "mock"; }
  private readonly now: () => number;
  private readonly injectedModel: boolean;
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  private refreshing = new Map<string, Promise<void>>();
  private stopping = new Map<string, Promise<void>>();
  private sessions = new Map<string, { attached: boolean; disconnect?: () => void }>();
  private listeners = new Map<string, Set<() => void>>();
  private client: MockCallsClient;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private config: Config, private store: Store, options: DevelopmentOptions = {}, readonly agent = new LlmAgent(config, store)) {
    this.now = options.now ?? Date.now;
    this.injectedModel = !!options.model;
    this.client = new MockCallsClient(config);
    this.dialogue = new RelayDialogue(config, store, (id, work) => this.change(id, (a, emit) => {
      if (!a.call.plan) return false;
      work(a as MockAttempt & { call: CallSnapshot }, emit);
    }), (id) => this.enforceLimits(id), options.model, agent);
    const active = store.calls.active();
    if (active && isMockAttempt(active)) this.change(active.call.id, (a, emit) => {
      if (a.internal.correlation?.creation === "prepared" && !a.internal.callSid) {
        this.finish(a, emit, "failed", "Backend restarted before the call was submitted. No call was redialed."); return;
      }
      if (a.internal.correlation) a.internal.correlation.recoveryRequired = true;
      a.internal.status = "unknown";
      a.internal.error = "Backend restarted. Reconciling the mock call and ending any orphan; no call was redialed.";
      this.status(a, emit, "reconciliation_required");
      emit("call.error", { code: "PROVIDER_UNAVAILABLE", message: a.internal.error, recoverable: true });
    });
    if (mockRelayEnabled(config) && options.automatic !== false) {
      this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 1000);
      this.timer.unref();
    }
  }
  /** Deadlines are checked even while a previous provider request is still in flight. */
  async tick() {
    if (this.closed || !mockRelayEnabled(this.config)) return;
    const active = this.store.calls.active();
    if (!active || !isMockAttempt(active)) return;
    if (active.call.plan && this.dialogue.expire(active.call.id)) this.requestStop(active.call.id, "user_stopped");
    this.enforceLimits(active.call.id);
    if (active.call.plan) await this.dialogue.syncPlayback(active.call.id);
    await this.refresh(active.call.id);
  }
  private timestamp() { return new Date(this.now()).toISOString(); }
  private requestStop(id: string, reason: "user_stopped" | "duration_limit" | "silence_timeout" | "budget_limit") {
    this.change(id, (a, emit) => {
      if (terminal(a.call) || a.internal.stopRequested) return false;
      this.dialogue.cancel(id);
      a.internal.stopRequested = true;
      if (a.internal.controls) a.internal.controls.stopReason = reason;
      if (reason !== "user_stopped") {
        a.internal.error = reason === "budget_limit" ? "The call reached its test-rate budget." : reason === "duration_limit" ? "The call reached its duration limit." : "The call reached its silence deadline.";
        emit("call.error", { code: reason === "budget_limit" ? "BUDGET_EXCEEDED" : "PROVIDER_UNAVAILABLE", message: a.internal.error, recoverable: false });
      }
      this.status(a, emit, "ending");
      // A preflight request cannot have created a provider call. It is safe to release this slot.
      if (a.internal.correlation?.creation === "prepared" && !a.internal.callSid) this.finish(a, emit, "ended");
    });
  }
  private enforceLimits(id: string) {
    let a = this.require(id);
    if (!terminal(a.call) && !a.internal.stopRequested && budgetExpired(a.call, this.now())) this.requestStop(id, "budget_limit");
    else if (usageSampleDue(a.call, this.now())) this.change(id, () => {}, true);
    a = this.require(id); const controls = a.internal.controls;
    if (!terminal(a.call) && !a.internal.stopRequested && controls) {
      if (this.now() >= Date.parse(controls.durationDeadlineAt)) this.requestStop(id, "duration_limit");
      else if (controls.silenceDeadlineAt && this.now() >= Date.parse(controls.silenceDeadlineAt)) this.requestStop(id, "silence_timeout");
    }
    return terminal(this.require(id).call) || this.require(id).internal.stopRequested;
  }
  private beginSilence(a: MockAttempt) {
    const controls = a.internal.controls;
    if (controls && !controls.silenceDeadlineAt) controls.silenceDeadlineAt = new Date(this.now() + controls.silenceTimeoutSeconds * 1000).toISOString();
  }
  private activity(id: string) {
    if (this.closed || this.enforceLimits(id)) return false;
    const a = this.require(id);
    if (a.internal.correlation?.recoveryRequired) return false;
    if (a.internal.controls) this.change(id, (a) => {
      a.internal.controls!.silenceDeadlineAt = new Date(this.now() + a.internal.controls!.silenceTimeoutSeconds * 1000).toISOString();
    });
    return true;
  }
  async recover() {
    if (!mockRelayEnabled(this.config) || this.closed) return;
    const active = this.store.calls.active();
    if (active && isMockAttempt(active)) await this.refresh(active.call.id);
  }
  private sameProvider(a: MockAttempt) {
    const correlation = a.internal.correlation;
    return !!correlation && correlation.apiOrigin === new URL(this.config.mockApiBase).origin
      && correlation.accountSid === this.config.mockAccountSid;
  }
  private unresolved(id: string, message: string) {
    if (terminal(this.require(id).call) || this.require(id).internal.error === message) return;
    this.change(id, (a, emit) => {
      a.internal.error = message;
      emit("call.error", { code: "PROVIDER_UNAVAILABLE", message, recoverable: true });
    });
  }
  private enabled() {
    if (this.closed || !mockRelayEnabled(this.config)) throw new CommandError(503, "PROVIDER_NOT_READY", "Enable development mock mode to use this console");
  }
  private require(id: string): MockAttempt {
    const a = this.store.calls.get(id);
    if (!a || !isMockAttempt(a)) throw new CommandError(404, "NOT_FOUND", "Mock call not found");
    return a;
  }
  snapshot(id: string) { return this.require(id).call; }
  observe(id: string, listener: () => void) {
    const set = this.listeners.get(id) ?? new Set<() => void>(); set.add(listener); this.listeners.set(id, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(id); };
  }
  private change(id: string, work: (a: MockAttempt, emit: Emit) => void | boolean, sampleUsage = false) {
    const result = this.store.calls.transaction(() => {
      const a = this.require(id); const events: DomainEvent[] = [];
      const previousUpdatedAt = a.call.updatedAt;
      const wasTerminal = terminal(a.call);
      a.call.revision++; a.call.updatedAt = this.timestamp();
      const emit: Emit = (type, payload) => events.push(DomainEventSchema.parse({ contractVersion: 1, id: randomUUID(),
        attemptId: id, sequence: ++a.call.lastEventSequence, snapshotRevision: a.call.revision,
        occurredAt: a.call.updatedAt, type, payload }));
      const changed = work(a, emit);
      if (changed === false) return { call: this.require(id).call, publish: false };
      if (!wasTerminal && (events.length || sampleUsage)) measureUsage(a.call, this.now(), emit);
      // Internal sequence/correlation updates do not fabricate a public revision or SSE event.
      if (!events.length) { a.call.revision--; a.call.updatedAt = previousUpdatedAt; }
      this.store.calls.save(a, events); return { call: a.call, publish: events.length > 0 };
    });
    if (result.publish) for (const listener of this.listeners.get(id) ?? []) listener();
    return result.call;
  }
  private status(a: MockAttempt, emit: Emit, state: ManualCallSnapshot["callState"]) {
    if (a.call.callState === state) return;
    a.call.callState = state; emit("call.status", { callState: state });
  }
  private finish(a: MockAttempt, emit: Emit, state: "ended" | "busy" | "no_answer" | "failed", error: string | null = null, interrupted = false) {
    if (terminal(a.call)) return;
    const stopReason = a.internal.controls?.stopReason ?? (a.internal.stopRequested ? "user_stopped" : null);
    const limit = stopReason === "duration_limit" || stopReason === "silence_timeout" || stopReason === "budget_limit";
    a.internal.status = state === "ended" ? "completed" : "failed";
    a.internal.error = limit ? (stopReason === "budget_limit" ? "The call reached its test-rate budget." : stopReason === "duration_limit" ? "The call reached its duration limit." : "The call reached its silence deadline.") : error;
    this.dialogue.cancel(a.call.id);
    if (a.call.plan) {
      this.dialogue.finish(a as MockAttempt & { call: CallSnapshot }, emit,
        stopReason === "user_stopped" ? "user_stopped" : state === "busy" ? "busy" : state === "no_answer" ? "no_answer" : "technical_failure");
      this.status(a, emit, state); return;
    }
    a.call.bookingState = "not_booked";
    a.call.outcome = { status: "not_booked", reason: stopReason === "user_stopped" ? "user_stopped"
      : limit || state === "failed" || interrupted ? "technical_failure"
      : state === "busy" || state === "no_answer" ? state : "development_only",
      summaryEn: limit ? `${a.internal.error} No automated booking was attempted or confirmed.`
        : "Manual mock call ended. No automated booking was attempted or confirmed." };
    emit("booking.updated", { bookingState: a.call.bookingState, outcome: a.call.outcome });
    this.status(a, emit, state);
  }
  private providerStatus(a: MockAttempt, emit: Emit, status: CallStatus): boolean {
    if (terminal(a.call)) return false;
    const correlation = a.internal.correlation!;
    const prior = correlation.providerStatus ?? (correlation.sessionId || a.call.callState === "connected" ? "in-progress"
      : a.call.callState === "ringing" ? "ringing" : "queued");
    if (progress(status) < progress(prior)) return false;
    const changed = correlation.providerStatus !== status;
    correlation.providerStatus = status;
    if (providerTerminal.has(status)) {
      this.finish(a, emit, status === "busy" ? "busy" : status === "no-answer" ? "no_answer" : status === "failed" ? "failed" : "ended", null,
        !!correlation.hangupRequested && correlation.recoveryRequired && ["completed", "canceled"].includes(status));
      return true;
    }
    // Provider progress never cancels Stop, recovery, or a lost relay reservation.
    if (a.internal.stopRequested || correlation.recoveryRequired || ["ending", "reconciliation_required"].includes(a.call.callState)) return changed;
    if (status === "in-progress") this.beginSilence(a);
    const state = normalizeStatus(status);
    const internalStatus = status === "in-progress" ? "connected" : "ringing";
    const visibleChanged = a.call.callState !== state || a.internal.status !== internalStatus;
    a.internal.status = internalStatus; this.status(a, emit, state);
    return changed || visibleChanged;
  }
  /** Signed local mock callback; persist cursor, snapshot and events before acknowledging delivery. */
  receiveStatus(id: string, fields: Record<string, string>, signature: string, target: { path: string; host: string }) {
    // Keep acknowledging in-flight deliveries during graceful hangup, while SQLite/listeners are open.
    if (!mockRelayEnabled(this.config)) throw new CommandError(503, "PROVIDER_NOT_READY", "Mock callbacks are disabled");
    const stored = this.store.calls.get(id);
    const deny = () => { throw new CommandError(403, "INVALID_REQUEST", "Invalid or uncorrelated mock callback"); };
    if (!stored || !isMockAttempt(stored)) return deny();
    const correlation = stored.internal.correlation;
    if (!correlation?.statusCallbackUrl || correlation.creation !== "submitted" || !this.sameProvider(stored)) return deny();
    const url = new URL(correlation.statusCallbackUrl);
    if (target.path !== url.pathname || target.host !== url.host
      || !twilio.validateRequest(this.config.mockAuthToken, signature, url.href, fields)) return deny();
    const event = parseRequest(statusCallback, fields);
    if (event.AccountSid !== correlation.accountSid || event.From !== "+48000000000" || event.To !== "+48111111111"
      || (stored.internal.callSid && event.CallSid !== stored.internal.callSid)) return deny();
    if (terminal(stored.call) || event.SequenceNumber <= (correlation.callbackSequence ?? -1)) return;
    this.enforceLimits(id);
    let accepted = false;
    this.change(id, (a, emit) => {
      if (terminal(a.call) || event.SequenceNumber <= (a.internal.correlation!.callbackSequence ?? -1)) return false;
      accepted = true;
      a.internal.correlation!.callbackSequence = event.SequenceNumber;
      a.internal.callSid = event.CallSid;
      this.providerStatus(a, emit, event.CallStatus === "initiated" ? "queued" : event.CallStatus);
    });
    if (!accepted) return;
    if (terminal(this.require(id).call)) {
      this.sessions.get(id)?.disconnect?.(); this.sessions.delete(id);
    } else if (this.require(id).internal.stopRequested || this.require(id).internal.correlation?.recoveryRequired) {
      void this.refresh(id).catch(() => {});
    }
  }
  private view(a: MockAttempt) {
    // This compatibility projection has no separate lifecycle or transcript storage.
    const responses = a.call.messages.filter((m) => m.speaker === "business").slice(-50)
      .map((m) => ({ text: m.originalText, language: m.language, at: m.createdAt }));
    while (responses.reduce((sum, m) => sum + m.text.length, 0) > 32_000) responses.shift();
    return { id: a.call.id, initialMessage: a.call.messages.find((m) => m.speaker === "assistant")?.originalText ?? "",
      language: "language" in a.call ? a.call.language : dialogueLanguage(a.call.plan), conversationData: a.call.conversationData, usage: a.call.usage, status: a.internal.status, callSid: a.internal.callSid,
      sessionId: a.internal.correlation?.sessionId ?? null, error: a.internal.error, responses,
      operatorUrl: a.internal.callSid ? `${new URL(this.config.mockOperatorOrigin).origin}/?callId=${encodeURIComponent(a.internal.callSid)}` : null };
  }
  async latest() {
    this.enabled(); const a = this.store.calls.latestManual();
    return { conversation: a ? await this.get(a.call.id) : null };
  }
  private replayDialogueStart(request: z.infer<typeof import("@callmate/contracts").StartCallRequestSchema>, key: string) {
    const command = this.store.calls.command(key);
    if (command) {
      const body = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      if (command.endpoint !== "dialogue-start" || command.body !== body) throw new CommandError(409, "IDEMPOTENCY_CONFLICT", "Start command differs");
      return this.snapshot(command.attemptId) as CallSnapshot;
    }
  }
  async startDialogue(request: z.infer<typeof import("@callmate/contracts").StartCallRequestSchema>, key: string, validate: (plan: ReviewPlan) => void) {
    const replay = this.replayDialogueStart(request, key);
    if (replay) return replay;
    this.enabled();
    if (!this.dialogueEnabled) throw new CommandError(503, "PROVIDER_NOT_READY", "Configure a dialogue engine before starting reviewed mock calls");
    const selection = this.agent.version();
    const loginReady = (this.injectedModel && this.agent.selection().provider !== "codex") || await this.agent.ready();
    // Another Start may reserve the same command while the external probe awaits.
    // Its durable result wins even if this probe failed or the configuration changed.
    const afterProbe = this.replayDialogueStart(request, key);
    if (afterProbe) return afterProbe;
    if (!loginReady || selection !== this.agent.version()) throw new CommandError(503, "PROVIDER_NOT_READY", "LLM agent is not ready or changed during preflight. Check Settings and retry with the original command key");
    const plan = this.store.calls.plan(request.planId);
    if (!plan) throw new CommandError(404, "NOT_FOUND", "Review plan not found");
    if (request.mode !== "simulator") throw new CommandError(409, "MODE_MISMATCH", "Dialogue supports local mock calls only");
    if (request.planVersion !== plan.version) throw new CommandError(409, "PLAN_VERSION_MISMATCH", "Plan version differs");
    validate(plan);
    await this.start({ requestId: key, initialMessage: this.dialogue.greeting(plan), language: dialogueLanguage(plan) }, plan, JSON.stringify(request));
    return this.snapshot(key) as CallSnapshot;
  }
  decide(id: string, decision: ApprovalDecision, key: string) {
    const call = this.dialogue.decide(id, decision, key);
    if (decision.decision === "reject" && !terminal(call)) {
      // The persisted rejection cannot leave a connected but silent call behind.
      // Request hangup even if the provider ignores the relay end frame. Replays retry
      // hangup without repeating closing speech or releasing an unconfirmed call.
      this.requestStop(id, "user_stopped");
      void this.end(id).catch(() => {});
    }
    return CallSnapshotSchema.parse(this.snapshot(id));
  }
  async start(raw: unknown, plan?: ReviewPlan, commandBody?: string) {
    const pending = this.startInternal(raw, plan, commandBody); this.pending.add(pending);
    try { return await pending; } finally { this.pending.delete(pending); }
  }
  private async startInternal(raw: unknown, plan?: ReviewPlan, commandBody?: string) {
    this.enabled(); const input = startInput.parse(raw);
    // Keep idempotency after transcript deletion without retaining the input in command records.
    const body = createHash("sha256").update(commandBody ?? JSON.stringify(input)).digest("hex");
    const token = randomBytes(32).toString("hex");
    const existing = this.store.calls.transaction(() => {
      const command = this.store.calls.command(input.requestId);
      if (command) {
        if (command.endpoint !== (plan ? "dialogue-start" : "manual-start") || command.body !== body) throw new CommandError(409, "IDEMPOTENCY_CONFLICT", "This request ID was already used for another command");
        return this.require(command.attemptId);
      }
      if (this.store.calls.get(input.requestId)) throw new CommandError(409, "IDEMPOTENCY_CONFLICT", "This ID already identifies another call");
      if (this.store.calls.active()) throw new CommandError(409, "CALL_ALREADY_ACTIVE", "Another call is still active");
      const now = this.timestamp();
      const limits = this.store.getSettings().defaultCallLimits;
      const maxDurationSeconds = plan?.request.callLimits.maxDurationSeconds ?? limits.maxDurationSeconds;
      const message = { id: randomUUID(), turnId: randomUUID(), speaker: "assistant" as const,
        originalText: input.initialMessage, language: input.language, translationEn: plan ? this.dialogue.opening(plan).translationEn : null,
        ...(plan ? { phrase: this.dialogue.opening(plan).phrase } : {}),
        final: true as const, playback: "withheld" as const, createdAt: now };
      const { phrase: _phrase, ...manualMessage } = message;
      const manual = ManualCallSnapshotSchema.parse({ id: input.requestId, kind: "manual_mock", mode: "simulator", plan: null,
        language: input.language, revision: 1, lastEventSequence: 2, callState: "creating", bookingState: "pending", outcome: { status: "pending" },
        activeOffer: null, pendingApproval: null, conversationData: "retained", messages: [{ ...manualMessage, translationEn: null }],
        usage: initialUsage(now, this.config.testRateMinorPerMinute, (plan?.request.callLimits.maxEstimatedCost ?? limits.maxEstimatedCost)), createdAt: now, updatedAt: now });
      const { kind: _kind, language: _language, ...base } = manual;
      const call = plan ? CallSnapshotSchema.parse({ ...base, messages: [message],
        plan: ApprovedPlanSchema.parse({ ...plan, approvedAt: now }) }) : manual;
      const events = [{ type: "call.status", payload: { callState: "creating" } }, { type: "transcript.updated", payload: message }]
        .map((event, index) => DomainEventSchema.parse({ contractVersion: 1, id: randomUUID(), attemptId: call.id,
          sequence: index + 1, snapshotRevision: 1, occurredAt: now, ...event }));
      this.store.calls.save({ call, replayFloor: 0, internal: { kind: "manual_mock", callSid: null, status: "creating", error: null, stopRequested: false,
        controls: { maxDurationSeconds, silenceTimeoutSeconds: this.config.silenceTimeoutSeconds,
          durationDeadlineAt: new Date(this.now() + maxDurationSeconds * 1000).toISOString(), silenceDeadlineAt: null, stopReason: null },
        correlation: { apiOrigin: new URL(this.config.mockApiBase).origin, accountSid: this.config.mockAccountSid,
          tokenHash: tokenHash(token), sessionId: null, creation: "prepared", recoveryRequired: false,
          statusCallbackUrl: this.client.callbackUrl(call.id) } } }, events);
      this.store.calls.recordCommand(input.requestId, plan ? "dialogue-start" : "manual-start", body, call.id);
      return undefined;
    });
    if (existing) return this.view(existing);
    const session = { attached: false };
    this.sessions.set(input.requestId, session);
    try { await this.client.check(); }
    catch {
      this.enforceLimits(input.requestId);
      this.change(input.requestId, (a, emit) => { if (terminal(a.call)) return false;
        this.finish(a, emit, "failed", "Mock calls service is unavailable. Start its Docker service and try again."); });
      this.sessions.delete(input.requestId); return this.view(this.require(input.requestId));
    }
    this.enforceLimits(input.requestId);
    if (terminal(this.require(input.requestId).call) || this.closed || this.require(input.requestId).internal.stopRequested) {
      this.change(input.requestId, (a, emit) => this.finish(a, emit, "ended"));
      this.sessions.delete(input.requestId); return this.view(this.require(input.requestId));
    }
    try {
      // Commit the intent before the only create request. A crash after this point is ambiguous.
      this.change(input.requestId, (a) => { a.internal.correlation!.creation = "submitted"; });
      const call = await this.client.create(input.requestId, token, input.language);
      this.enforceLimits(input.requestId);
      const current = this.require(input.requestId);
      if (current.internal.callSid && current.internal.callSid !== call.sid) throw new MockCallsError(true);
      this.change(input.requestId, (a, emit) => {
        if (terminal(a.call)) return false;
        a.internal.callSid = call.sid;
        this.providerStatus(a, emit, call.status);
      });
      if (this.closed || this.require(input.requestId).internal.stopRequested) await this.stop(input.requestId);
    } catch (error) {
      const ambiguous = !(error instanceof MockCallsError) || error.ambiguous;
      this.change(input.requestId, (a, emit) => {
        if (terminal(a.call)) return false;
        if (!ambiguous && !a.internal.callSid) this.finish(a, emit, "failed", "The mock service rejected the call. Check its local account configuration.");
        else {
          a.internal.correlation!.recoveryRequired = true;
          a.internal.status = "unknown";
          a.internal.error = "Call creation could not be confirmed. Check the operator page before retrying; no automatic retry was made.";
          this.status(a, emit, "reconciliation_required");
          emit("call.error", { code: "PROVIDER_UNAVAILABLE", message: a.internal.error, recoverable: true });
        }
      });
    }
    if (terminal(this.require(input.requestId).call)) this.sessions.delete(input.requestId);
    return this.view(this.require(input.requestId));
  }
  async get(id: string) {
    this.enabled(); this.enforceLimits(id); await this.refresh(id); return this.view(this.require(id));
  }
  private refresh(id: string): Promise<void> {
    const prior = this.refreshing.get(id); if (prior) return prior;
    const job = this.refreshInternal(id).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, job); return job;
  }
  private async refreshInternal(id: string) {
    const before = this.require(id);
    if (terminal(before.call) || this.closed) return;
    if (!this.sameProvider(before)) {
      this.unresolved(id, "Stored provider identity is missing or differs from this configuration. Inspect the original mock service; the active reservation is retained."); return;
    }
    if (!before.internal.callSid) {
      if (before.internal.status === "unknown") this.unresolved(id,
        "Call creation is unconfirmed and the call ID is unknown. Await a correlated relay setup or inspect the original operator page; the active reservation is retained.");
      return;
    }
    try {
      const call = await this.client.get(before.internal.callSid);
      if (call.sid !== before.internal.callSid) throw new MockCallsError();
      if (this.closed || terminal(this.require(id).call)) return;
      this.enforceLimits(id);
      if (providerTerminal.has(call.status)) {
        this.change(id, (a, emit) => this.providerStatus(a, emit, call.status));
        this.sessions.get(id)?.disconnect?.(); this.sessions.delete(id);
      } else if (this.require(id).internal.correlation?.recoveryRequired || this.require(id).internal.stopRequested) {
        // A provider call cannot continue without its original relay. Never reconnect or replay text.
        await this.end(id);
      } else {
        this.change(id, (a, emit) => this.providerStatus(a, emit, call.status));
      }
    } catch {
      if (this.closed || terminal(this.require(id).call)) return;
      this.unresolved(id, "Cannot refresh the mock call status. A missing call or unavailable service is not proof of completion; the active reservation is retained.");
    }
  }
  async stop(id: string) {
    this.enforceLimits(id);
    this.requestStop(id, "user_stopped");
    await this.end(id);
    return this.view(this.require(id));
  }
  private async end(id: string) {
    const prior = this.stopping.get(id);
    if (prior) await prior;
    else {
      const job = this.endInternal(id).finally(() => this.stopping.delete(id));
      this.stopping.set(id, job); await job;
    }
  }
  private async endInternal(id: string) {
    const a = this.require(id); if (terminal(a.call)) return;
    if (!mockRelayEnabled(this.config) || !this.sameProvider(a)) {
      this.unresolved(id, "Recovery requires the original mock provider configuration. No provider request was sent; the active reservation is retained."); return;
    }
    if (!a.internal.callSid) {
      if (a.internal.status === "unknown") {
        if (a.call.callState !== "reconciliation_required") this.change(id, (a, emit) => this.status(a, emit, "reconciliation_required"));
        this.unresolved(id, "The mock call ID is unknown. Inspect and hang up the call on the operator page; the active reservation is retained.");
      }
      return;
    }
    try {
      // Verify the resource before changing it, including when recovering after a configuration change.
      const current = await this.client.get(a.internal.callSid);
      if (current.sid !== a.internal.callSid) throw new MockCallsError();
      if (terminal(this.require(id).call)) return;
      const alreadyEnded = ["completed", "canceled", "busy", "no-answer", "failed"].includes(current.status);
      if (!alreadyEnded) this.change(id, (a) => { a.internal.correlation!.hangupRequested = true; });
      const call = alreadyEnded ? current : await this.client.hangup(a.internal.callSid, ["queued", "ringing"].includes(current.status) ? "canceled" : "completed");
      if (call.sid !== a.internal.callSid || !["completed", "canceled", "busy", "no-answer", "failed"].includes(call.status)) throw new MockCallsError();
      if (!terminal(this.require(id).call)) this.change(id, (a, emit) => this.finish(a, emit,
        call.status === "busy" ? "busy" : call.status === "no-answer" ? "no_answer" : call.status === "failed" ? "failed" : "ended",
        null, !alreadyEnded && !!a.internal.correlation?.recoveryRequired));
      this.sessions.get(id)?.disconnect?.(); this.sessions.delete(id);
    } catch {
      this.unresolved(id, "Hangup could not be confirmed. Recovery will retry status/hangup without redial; the active reservation is retained.");
    }
  }
  attach(message: Extract<RelayInbound, { type: "setup" }>, send: RelaySend, disconnect: () => void): RelayConsumer | undefined {
    const id = message.customParameters.conversationId; if (!id) return;
    this.enabled(); let a = this.require(id); const correlation = a.internal.correlation;
    const session = this.sessions.get(id);
    const supplied = Buffer.from(tokenHash(message.customParameters.authToken ?? ""));
    const expected = Buffer.from(correlation?.tokenHash ?? "");
    if (!correlation || correlation.creation !== "submitted" || !this.sameProvider(a)
      || supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || session?.attached
      || terminal(a.call) || (a.internal.callSid && a.internal.callSid !== message.callSid)
      || (correlation.sessionId && correlation.sessionId !== message.sessionId)
      || message.accountSid !== this.config.mockAccountSid || message.from !== "+48000000000" || message.to !== "+48111111111") throw new Error("Uncorrelated relay");
    this.enforceLimits(id); a = this.require(id);
    if (!session || correlation.recoveryRequired || a.internal.stopRequested) {
      // Late setup can resolve a lost create response using the durable hash. It cannot resume speech.
      this.sessions.set(id, { attached: true, disconnect });
      this.change(id, (a, emit) => {
        a.internal.callSid = message.callSid; a.internal.correlation!.sessionId = message.sessionId;
        a.internal.correlation!.recoveryRequired = true; a.internal.status = "unknown";
        this.status(a, emit, "reconciliation_required");
      });
      void this.refresh(id).catch(() => {});
      return { prompt() {}, close() {} };
    }
    session.attached = true; session.disconnect = disconnect;
    this.change(id, (a, emit) => {
      a.internal.callSid = message.callSid; a.internal.status = "connected"; a.internal.error = null;
      a.internal.correlation!.sessionId = message.sessionId;
      a.internal.correlation!.providerStatus = "in-progress";
      this.beginSilence(a);
      this.status(a, emit, "connected");
      if (a.call.plan) a.internal.dialoguePlayback = { sequence: 1, pending: [], acceptance: null };
      a.call.messages[0]!.playback = "generated"; emit("transcript.updated", a.call.messages[0]!);
    });
    send({ type: "text", token: a.call.messages[0]!.originalText, lang: "language" in a.call ? a.call.language : dialogueLanguage(a.call.plan), last: true, interruptible: true, preemptible: true });
    return {
      maxPromptLength: a.call.plan ? TranscriptMessageSchema.shape.originalText.maxLength! : ManualTranscriptMessageSchema.shape.originalText.maxLength!,
      activity: () => this.activity(id),
      speech: () => this.dialogue.speech(id),
      interrupt: () => this.dialogue.interrupt(id),
      prompt: (text, language) => {
        if (this.closed || this.enforceLimits(id)) return;
        const a = this.require(id); if (a.internal.correlation?.recoveryRequired) return;
        if (a.call.messages.length >= 2000) { void this.stop(id).catch(() => {}); return; }
        // Recognition language describes received speech, not authority to change agent output.
        if (a.call.plan && !DialogueLanguageSchema.safeParse(language).success) {
          this.change(id, (_a, emit) => emit("call.error", { code: "PROVIDER_NOT_READY",
            message: "Reply received in an unsupported language. Choose Spanish, Russian, English or Polish in the mock operator and resend.", recoverable: true }));
          return;
        }
        this.change(id, (a, emit) => {
          const message = { id: randomUUID(), turnId: randomUUID(), speaker: "business" as const, originalText: text,
            language, translationEn: null, final: true as const, playback: "not_applicable" as const, createdAt: a.call.updatedAt };
          if (a.call.plan) a.call.messages.push(TranscriptMessageSchema.parse(message));
          else a.call.messages.push(message);
          emit("transcript.updated", message);
        });
        if (a.call.plan) this.dialogue.prompt(id, send);
      },
      close: () => {
        this.dialogue.cancel(id);
        delete session.disconnect;
        if (this.closed) return;
        const a = this.require(id); if (terminal(a.call) || a.internal.stopRequested || this.closed) return;
        this.change(id, (a, emit) => {
          a.internal.correlation!.recoveryRequired = true;
          a.internal.status = "disconnected"; a.internal.error = "The relay disconnected. Reconciling and ending the orphaned mock call without redial.";
          this.status(a, emit, "reconciliation_required");
          emit("call.error", { code: "PROVIDER_UNAVAILABLE", message: a.internal.error, recoverable: true });
        });
      },
    };
  }
  deleteAgreement(id: string) {
    const a = this.require(id);
    assertDeletableAgreement(a.call);
    if (!a.call.agreementDeletedAt) this.change(id, (a, emit) => {
      assertDeletableAgreement(a.call);
      a.call.agreementDeletedAt = this.timestamp();
      emit("agreement.deleted", { agreementDeletedAt: a.call.agreementDeletedAt });
    });
    return this.snapshot(id);
  }
  deleteConversation(id: string) {
    const a = this.require(id);
    if (!terminal(a.call)) throw new CommandError(409, "DATA_NOT_DELETABLE", "Conversation deletion requires a terminal call");
    if (a.call.conversationData !== "deleted") this.change(id, (a, emit) => {
      this.store.calls.purgeEvents(id); a.replayFloor = a.call.lastEventSequence;
      delete a.internal.dialoguePlayback;
      a.call.messages = []; a.call.conversationData = "deleted"; emit("conversation.deleted", { conversationData: "deleted" });
    });
    return { attemptId: id, deleted: true as const };
  }
  async close() {
    this.dialogue.close();
    this.closed = true; if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.pending, ...this.refreshing.values(), ...this.stopping.values()]);
    const active = this.store.calls.active();
    if (active && isMockAttempt(active) && mockRelayEnabled(this.config)) {
      if (active.internal.correlation) this.change(active.call.id, (a) => { a.internal.correlation!.recoveryRequired = true; });
      await this.end(active.call.id);
    }
    this.sessions.clear(); this.listeners.clear();
  }
}

export function mountDevelopmentConsole(app: FastifyInstance, conversations: DevelopmentConversations) {
  const files: Record<string, [string, string]> = { "/console/": ["index.html", "text/html"],
    "/console/app.js": ["app.js", "text/javascript"], "/console/auth.js": ["auth.js", "text/javascript"], "/console/styles.css": ["styles.css", "text/css"] };
  for (const [route, [file, contentType]] of Object.entries(files)) app.get(route, async (_request, reply) => {
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'")
      .header("Referrer-Policy", "no-referrer").type(contentType);
    return readFile(new URL(`../src/web/${file}`, import.meta.url), "utf8");
  });
  app.get("/console", async (_request, reply) => reply.redirect("/console/"));
  const id = (params: unknown) => parseRequest(z.object({ id: z.uuid() }), params).id;
  app.get("/api/dev/conversations", async () => conversations.latest());
  app.post("/api/dev/conversations", async (request, reply) => reply.code(202).send({ conversation: await conversations.start(parseRequest(startInput, request.body)) }));
  app.get("/api/dev/conversations/:id", async (request) => ({ conversation: await conversations.get(id(request.params)) }));
  app.post("/api/dev/conversations/:id/stop", async (request) => {
    parseRequest(z.strictObject({}), request.body);
    return { conversation: await conversations.stop(id(request.params)) };
  });
}
