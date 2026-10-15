import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { ManualCallSnapshotSchema, DomainEventSchema } from "@callmate/contracts";
import type { DomainEvent, ManualCallSnapshot } from "@callmate/contracts";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Store } from "./storage.js";
import { isManualAttempt } from "./call-store.js";
import type { ManualAttempt } from "./call-store.js";
import { CommandError } from "./errors.js";
import { MockCallsClient, MockCallsError } from "./mock-calls-client.js";
import { mockRelayEnabled } from "./mock-relay.js";
import type { RelayConsumer, RelaySend } from "./mock-relay.js";
import type { RelayInbound } from "./twilio/protocol.js";

const startInput = z.strictObject({ requestId: z.uuid(), initialMessage: z.string().min(1).max(8000).refine((text) => text.trim().length > 0),
  language: z.enum(["es-ES", "ru-RU", "pl-PL", "en-US"]) });
const terminal = (call: ManualCallSnapshot) => ["ended", "busy", "no_answer", "failed"].includes(call.callState);
type Emit = (type: DomainEvent["type"], payload: unknown) => void;

/** Manual transport adapter for the shared persisted attempts, event log and active-call slot. */
export class DevelopmentConversations {
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  private refreshing = new Map<string, Promise<void>>();
  private stopping = new Map<string, Promise<void>>();
  private sessions = new Map<string, { token: string; attached: boolean; disconnect?: () => void }>();
  private listeners = new Map<string, Set<() => void>>();
  private client: MockCallsClient;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private config: Config, private store: Store) {
    this.client = new MockCallsClient(config);
    const active = store.calls.active();
    if (active && isManualAttempt(active)) this.change(active.call.id, (a, emit) => {
      a.internal.status = "unknown";
      a.internal.error = "Backend restarted. Check the mock call or Stop it; no call was redialed.";
      this.status(a, emit, "reconciliation_required");
      emit("call.error", { code: "PROVIDER_UNAVAILABLE", message: a.internal.error, recoverable: true });
    });
    if (mockRelayEnabled(config)) {
      this.timer = setInterval(() => {
        const active = store.calls.active();
        if (active && isManualAttempt(active)) void this.refresh(active.call.id).catch(() => {});
      }, 1000);
      this.timer.unref();
    }
  }
  private enabled() {
    if (this.closed || !mockRelayEnabled(this.config)) throw new CommandError(503, "PROVIDER_NOT_READY", "Enable development mock mode to use this console");
  }
  private require(id: string): ManualAttempt {
    const a = this.store.calls.get(id);
    if (!a || !isManualAttempt(a)) throw new CommandError(404, "NOT_FOUND", "Manual mock call not found");
    return a;
  }
  snapshot(id: string) { return this.require(id).call; }
  observe(id: string, listener: () => void) {
    const set = this.listeners.get(id) ?? new Set<() => void>(); set.add(listener); this.listeners.set(id, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(id); };
  }
  private change(id: string, work: (a: ManualAttempt, emit: Emit) => void) {
    const call = this.store.calls.transaction(() => {
      const a = this.require(id); const events: DomainEvent[] = [];
      a.call.revision++; a.call.updatedAt = new Date().toISOString();
      work(a, (type, payload) => events.push(DomainEventSchema.parse({ contractVersion: 1, id: randomUUID(),
        attemptId: id, sequence: ++a.call.lastEventSequence, snapshotRevision: a.call.revision,
        occurredAt: a.call.updatedAt, type, payload })));
      this.store.calls.save(a, events); return a.call;
    });
    for (const listener of this.listeners.get(id) ?? []) listener();
    return call;
  }
  private status(a: ManualAttempt, emit: Emit, state: ManualCallSnapshot["callState"]) {
    if (a.call.callState === state) return;
    a.call.callState = state; emit("call.status", { callState: state });
  }
  private finish(a: ManualAttempt, emit: Emit, state: "ended" | "busy" | "no_answer" | "failed", error: string | null = null) {
    a.internal.status = state === "ended" ? "completed" : "failed"; a.internal.error = error;
    a.call.bookingState = "not_booked";
    a.call.outcome = { status: "not_booked", reason: a.internal.stopRequested ? "user_stopped"
      : state === "failed" ? "technical_failure" : state === "busy" || state === "no_answer" ? state : "development_only",
      summaryEn: "Manual mock call ended. No automated booking was attempted or confirmed." };
    emit("booking.updated", { bookingState: a.call.bookingState, outcome: a.call.outcome });
    this.status(a, emit, state);
  }
  private view(a: ManualAttempt) {
    // This compatibility projection has no separate lifecycle or transcript storage.
    const responses = a.call.messages.filter((m) => m.speaker === "business").slice(-50)
      .map((m) => ({ text: m.originalText, language: m.language, at: m.createdAt }));
    while (responses.reduce((sum, m) => sum + m.text.length, 0) > 32_000) responses.shift();
    return { id: a.call.id, initialMessage: a.call.messages.find((m) => m.speaker === "assistant")?.originalText ?? "",
      language: a.call.language, status: a.internal.status, callSid: a.internal.callSid, error: a.internal.error, responses,
      operatorUrl: a.internal.callSid ? `${new URL(this.config.mockOperatorOrigin).origin}/?callId=${encodeURIComponent(a.internal.callSid)}` : null };
  }
  async latest() {
    this.enabled(); const a = this.store.calls.latestManual();
    return { conversation: a ? await this.get(a.call.id) : null };
  }
  async start(raw: unknown) {
    const pending = this.startInternal(raw); this.pending.add(pending);
    try { return await pending; } finally { this.pending.delete(pending); }
  }
  private async startInternal(raw: unknown) {
    this.enabled(); const input = startInput.parse(raw);
    // Keep idempotency after transcript deletion without retaining the input in command records.
    const body = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const existing = this.store.calls.transaction(() => {
      const command = this.store.calls.command(input.requestId);
      if (command) {
        if (command.endpoint !== "manual-start" || command.body !== body) throw new CommandError(409, "IDEMPOTENCY_CONFLICT", "This request ID was already used for another command");
        return this.require(command.attemptId);
      }
      if (this.store.calls.get(input.requestId)) throw new CommandError(409, "IDEMPOTENCY_CONFLICT", "This ID already identifies another call");
      if (this.store.calls.active()) throw new CommandError(409, "CALL_ALREADY_ACTIVE", "Another call is still active");
      const now = new Date().toISOString();
      const message = { id: randomUUID(), turnId: randomUUID(), speaker: "assistant" as const,
        originalText: input.initialMessage, language: input.language, translationEn: null,
        final: true as const, playback: "withheld" as const, createdAt: now };
      const call = ManualCallSnapshotSchema.parse({ id: input.requestId, kind: "manual_mock", mode: "simulator", plan: null,
        language: input.language, revision: 1, lastEventSequence: 2, callState: "creating", bookingState: "pending", outcome: { status: "pending" },
        activeOffer: null, pendingApproval: null, conversationData: "retained", messages: [message],
        usage: { estimate: null, settledTotal: null, status: "unavailable", measuredAt: now }, createdAt: now, updatedAt: now });
      const events = [{ type: "call.status", payload: { callState: "creating" } }, { type: "transcript.updated", payload: message }]
        .map((event, index) => DomainEventSchema.parse({ contractVersion: 1, id: randomUUID(), attemptId: call.id,
          sequence: index + 1, snapshotRevision: 1, occurredAt: now, ...event }));
      this.store.calls.save({ call, replayFloor: 0, internal: { kind: "manual_mock", callSid: null, status: "creating", error: null, stopRequested: false } }, events);
      this.store.calls.recordCommand(input.requestId, "manual-start", body, call.id);
      return undefined;
    });
    if (existing) return this.view(existing);
    const session = { token: randomBytes(32).toString("hex"), attached: false };
    this.sessions.set(input.requestId, session);
    try { await this.client.check(); }
    catch {
      this.change(input.requestId, (a, emit) => this.finish(a, emit, "failed", "Mock calls service is unavailable. Start its Docker service and try again."));
      this.sessions.delete(input.requestId); return this.view(this.require(input.requestId));
    }
    if (this.closed || this.require(input.requestId).internal.stopRequested) {
      this.change(input.requestId, (a, emit) => this.finish(a, emit, "ended"));
      this.sessions.delete(input.requestId); return this.view(this.require(input.requestId));
    }
    try {
      const call = await this.client.create(input.requestId, session.token, input.language);
      const current = this.require(input.requestId);
      if (current.internal.callSid && current.internal.callSid !== call.sid) throw new MockCallsError(true);
      this.change(input.requestId, (a, emit) => {
        a.internal.callSid = call.sid;
        if (a.internal.status === "creating" && !a.internal.stopRequested) { a.internal.status = "ringing"; this.status(a, emit, call.status === "queued" ? "dialing" : "ringing"); }
      });
      if (this.closed || this.require(input.requestId).internal.stopRequested) await this.stop(input.requestId);
    } catch (error) {
      const ambiguous = !(error instanceof MockCallsError) || error.ambiguous;
      this.change(input.requestId, (a, emit) => {
        if (terminal(a.call)) return;
        if (!ambiguous) this.finish(a, emit, "failed", "The mock service rejected the call. Check its local account configuration.");
        else {
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
    this.enabled(); await this.refresh(id); return this.view(this.require(id));
  }
  private refresh(id: string): Promise<void> {
    const prior = this.refreshing.get(id); if (prior) return prior;
    const job = this.refreshInternal(id).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, job); return job;
  }
  private async refreshInternal(id: string) {
    const before = this.require(id);
    if (!before.internal.callSid || terminal(before.call) || this.closed) return;
    try {
      const call = await this.client.get(before.internal.callSid);
      if (call.sid !== before.internal.callSid) throw new MockCallsError();
      if (this.closed || terminal(this.require(id).call)) return;
      if (["completed", "canceled", "busy", "no-answer", "failed"].includes(call.status)) {
        this.change(id, (a, emit) => this.finish(a, emit, call.status === "busy" ? "busy" : call.status === "no-answer" ? "no_answer"
          : call.status === "failed" ? "failed" : "ended", ["busy", "no-answer", "failed"].includes(call.status)
            ? "The mock call was rejected, unanswered or disconnected. See the operator page for details." : null));
        this.sessions.get(id)?.disconnect?.(); this.sessions.delete(id);
      } else if (["queued", "ringing"].includes(call.status) && this.sessions.has(id)
        && !this.sessions.get(id)!.attached && !this.require(id).internal.stopRequested) {
        const state = call.status === "queued" ? "dialing" : "ringing";
        if (this.require(id).call.callState !== state) this.change(id, (a, emit) => this.status(a, emit, state));
      }
    } catch {
      if (this.closed || terminal(this.require(id).call)) return;
      const error = "Cannot refresh the mock call status. Check that the mock calls service is running.";
      if (this.require(id).internal.error !== error) this.change(id, (a, emit) => {
        a.internal.error = error; emit("call.error", { code: "PROVIDER_UNAVAILABLE", message: error, recoverable: true });
      });
    }
  }
  async stop(id: string) {
    const prior = this.stopping.get(id);
    if (prior) await prior;
    else {
      const job = this.stopInternal(id).finally(() => this.stopping.delete(id));
      this.stopping.set(id, job); await job;
    }
    return this.view(this.require(id));
  }
  private async stopInternal(id: string) {
    const a = this.require(id); if (terminal(a.call)) return;
    this.change(id, (a, emit) => { a.internal.stopRequested = true; this.status(a, emit, "ending"); });
    if (!a.internal.callSid) {
      if (a.internal.status === "unknown") this.change(id, (a, emit) => {
        this.status(a, emit, "reconciliation_required");
        a.internal.error = "The mock call ID is unknown. Inspect and hang up the call on the operator page; the active reservation is retained.";
        emit("call.error", { code: "PROVIDER_UNAVAILABLE", message: a.internal.error, recoverable: true });
      });
      return;
    }
    try {
      const call = await this.client.hangup(a.internal.callSid);
      if (call.sid !== a.internal.callSid || !["completed", "canceled"].includes(call.status)) throw new MockCallsError();
      if (!terminal(this.require(id).call)) this.change(id, (a, emit) => this.finish(a, emit, "ended"));
      this.sessions.get(id)?.disconnect?.(); this.sessions.delete(id);
    } catch {
      if (!terminal(this.require(id).call)) this.change(id, (a, emit) => {
        a.internal.error = "Hangup could not be confirmed. Use Hang up on the operator page, then refresh.";
        emit("call.error", { code: "PROVIDER_UNAVAILABLE", message: a.internal.error, recoverable: true });
      });
    }
  }
  attach(message: Extract<RelayInbound, { type: "setup" }>, send: RelaySend, disconnect: () => void): RelayConsumer | undefined {
    const id = message.customParameters.conversationId; if (!id) return;
    this.enabled(); const a = this.require(id); const session = this.sessions.get(id);
    const supplied = Buffer.from(message.customParameters.authToken ?? ""); const expected = Buffer.from(session?.token ?? "");
    if (!session || supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || session.attached
      || terminal(a.call) || a.internal.stopRequested || (a.internal.callSid && a.internal.callSid !== message.callSid)
      || message.accountSid !== this.config.mockAccountSid || message.from !== "+48000000000" || message.to !== "+48111111111") throw new Error("Uncorrelated relay");
    session.attached = true; session.disconnect = disconnect;
    this.change(id, (a, emit) => {
      a.internal.callSid = message.callSid; a.internal.status = "connected"; a.internal.error = null;
      this.status(a, emit, "connected");
      a.call.messages[0]!.playback = "generated"; emit("transcript.updated", a.call.messages[0]!);
    });
    send({ type: "text", token: a.call.messages[0]!.originalText, lang: a.call.language, last: true, interruptible: true, preemptible: true });
    return {
      prompt: (text, language) => {
        if (this.closed) return;
        const a = this.require(id); if (terminal(a.call) || a.internal.stopRequested) return;
        if (a.call.messages.length >= 2000) { void this.stop(id).catch(() => {}); return; }
        this.change(id, (a, emit) => {
          const message = { id: randomUUID(), turnId: randomUUID(), speaker: "business" as const, originalText: text,
            language, translationEn: null, final: true as const, playback: "not_applicable" as const, createdAt: a.call.updatedAt };
          a.call.messages.push(message); emit("transcript.updated", message);
        });
      },
      close: () => {
        delete session.disconnect;
        if (this.closed) return;
        const a = this.require(id); if (terminal(a.call) || a.internal.stopRequested || this.closed) return;
        this.change(id, (a, emit) => {
          a.internal.status = "disconnected"; a.internal.error = "The relay disconnected. Stop this call or wait for the mock service to confirm it ended.";
          this.status(a, emit, "reconciliation_required");
          emit("call.error", { code: "PROVIDER_UNAVAILABLE", message: a.internal.error, recoverable: true });
        });
      },
    };
  }
  deleteConversation(id: string) {
    const a = this.require(id);
    if (!terminal(a.call)) throw new CommandError(409, "DATA_NOT_DELETABLE", "Conversation deletion requires a terminal call");
    if (a.call.conversationData !== "deleted") this.change(id, (a, emit) => {
      this.store.calls.purgeEvents(id); a.replayFloor = a.call.lastEventSequence;
      a.call.messages = []; a.call.conversationData = "deleted"; emit("conversation.deleted", { conversationData: "deleted" });
    });
    return { attemptId: id, deleted: true as const };
  }
  async close() {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.pending, ...this.refreshing.values(), ...this.stopping.values()]);
    const active = this.store.calls.active();
    if (active && isManualAttempt(active)) await this.stop(active.call.id);
    this.sessions.clear(); this.listeners.clear();
  }
}

export function mountDevelopmentConsole(app: FastifyInstance, conversations: DevelopmentConversations) {
  const files: Record<string, [string, string]> = { "/": ["index.html", "text/html"],
    "/console/app.js": ["app.js", "text/javascript"], "/console/styles.css": ["styles.css", "text/css"] };
  for (const [route, [file, contentType]] of Object.entries(files)) app.get(route, async (_request, reply) => {
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'")
      .header("Referrer-Policy", "no-referrer").type(contentType);
    return readFile(new URL(`../src/web/${file}`, import.meta.url), "utf8");
  });
  const id = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
  app.get("/api/dev/conversations", async () => conversations.latest());
  app.post("/api/dev/conversations", async (request, reply) => reply.code(202).send({ conversation: await conversations.start(request.body) }));
  app.get("/api/dev/conversations/:id", async (request) => ({ conversation: await conversations.get(id(request.params)) }));
  app.post("/api/dev/conversations/:id/stop", async (request) => {
    z.strictObject({}).parse(request.body);
    return { conversation: await conversations.stop(id(request.params)) };
  });
}
