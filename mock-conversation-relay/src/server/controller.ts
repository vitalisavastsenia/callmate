import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { Config } from "./config.js";
import { backendUrl, MockError } from "./config.js";
import { createSession, dtmf, interruption, relayMessage, utterance } from "../protocol/schemas.js";
import type { CreateSession } from "../protocol/schemas.js";
import type { Diagnostic, LogEvent, SessionView, Status, Transcript } from "../shared/types.js";
import { mockRequest, parseContinuation, parseTwiml } from "./twiml.js";
import { requestSignature } from "./signature.js";
import type { RelaySettings } from "./twiml.js";

export const terminal = new Set<Status>(["completed", "busy", "canceled", "no-answer", "failed"]);
type Call = {
  view: SessionView; input: CreateSession; socket?: WebSocket; settings?: RelaySettings;
  abort: AbortController; deadline: number; ringDeadline: number; invalid: number;
  output: Transcript | null; callbackSequence: number; work: Promise<void>; endedByBackend: boolean;
  dialAt: number; resumeAt?: number; actionStarted: boolean;
};
type Options = { now?: () => number; makeId?: (prefix: "CA" | "VX") => string;
  log?: (event: { type: string; callSid: string; at: string; mockGenerated: true }) => void };

function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth limit]";
  if (typeof value === "string") return value.slice(0, 8000);
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, val]) =>
    [key, /password|secret|authorization|credential|api.?key|auth.?token|access.?token/i.test(key) ? "[redacted]" : redact(val, depth + 1)]));
  return value;
}

export class Controller extends EventEmitter {
  private calls = new Map<string, Call>();
  private closed = false;
  readonly now: () => number;
  private makeId: (prefix: "CA" | "VX") => string;
  constructor(readonly config: Config, private options: Options = {}) {
    super(); this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? ((prefix) => prefix + randomBytes(16).toString("hex"));
  }
  private timestamp() { return new Date(this.now()).toISOString(); }
  private get(id: string) {
    const call = this.calls.get(id);
    if (!call) throw new MockError("CALL_NOT_FOUND", "Mock call not found", 404);
    return call;
  }
  view(id: string) { return structuredClone(this.get(id).view); }
  list() { return [...this.calls.values()].map((call) => structuredClone(call.view)).reverse(); }
  private changed(call: Call) {
    if (this.calls.get(call.view.id) !== call) return;
    call.view.updatedAt = this.timestamp(); this.emit("session", structuredClone(call.view));
  }
  private event(call: Call, direction: LogEvent["direction"], type: string, payload: unknown) {
    const events = call.view.events;
    events.push({ sequence: (events.at(-1)?.sequence ?? call.view.droppedEvents) + 1, at: this.timestamp(),
      mockGenerated: true, direction, type, sessionId: call.view.sessionId, payload: redact(payload) });
    if (events.length > 200) { events.shift(); call.view.droppedEvents++; }
    this.options.log?.({ type, callSid: call.view.id, at: this.timestamp(), mockGenerated: true });
    this.emit("log", { type, callSid: call.view.id, at: this.timestamp(), mockGenerated: true });
    this.changed(call);
  }
  private diagnostic(call: Call, code: string, message: string) {
    call.view.lastError = { code, message, at: this.timestamp() };
    this.event(call, "lifecycle", code, { message });
  }
  private fields(call: Call): Record<string, string> {
    return { AccountSid: this.config.MOCK_ACCOUNT_SID, CallSid: call.view.id, From: call.view.from,
      To: call.view.to, Direction: "outbound-api", CallStatus: call.view.status, ApiVersion: "2010-04-01" };
  }
  private scheduleCallback(call: Call, event: string) {
    if (!call.input.statusCallback || !(call.input.statusCallbackEvents ?? ["completed"]).includes(event as "completed")) return;
    const sequence = call.callbackSequence++;
    const fields = { ...this.fields(call), ...(event === "initiated" ? { CallStatus: "initiated" } : {}), Timestamp: new Date(this.now()).toUTCString(), CallbackSource: "call-progress-events",
      SequenceNumber: String(sequence), ...(terminal.has(call.view.status) ? { CallDuration: this.duration(call) } : {}) };
    // Each call has its own delivery chain. Failures surface in diagnostics without blocking controls.
    call.work = call.work.then(async () => {
      let status: number | null = null; let error: string | null = null;
      try {
        const result = await mockRequest(call.input.statusCallback!, call.input.statusCallbackMethod ?? "POST", fields, this.config);
        status = result.status;
        if (!result.ok) error = `Mock callback returned HTTP ${status}`;
      } catch { error = "Mock callback delivery failed or timed out"; }
      call.view.callbacks.push({ event, at: this.timestamp(), status, error });
      if (call.view.callbacks.length > 50) call.view.callbacks.shift();
      this.event(call, "callback", "status.delivery", { event, status, error });
      if (error) this.diagnostic(call, "CALLBACK_DELIVERY_FAILED", error);
    }).catch(() => {});
  }
  private transition(call: Call, status: Status) {
    if (terminal.has(call.view.status)) return;
    const canceledInQueue = call.view.status === "queued" && status === "canceled";
    call.view.status = status;
    if (status === "in-progress") call.view.startedAt = this.timestamp();
    if (terminal.has(status)) call.view.endedAt = this.timestamp();
    call.view.transitions.push({ status, at: this.timestamp() });
    this.event(call, "lifecycle", "call.status", { status });
    if (!canceledInQueue) this.scheduleCallback(call, status === "in-progress" ? "answered" : terminal.has(status) ? "completed" : status);
  }
  create(raw: unknown) {
    if (this.closed) throw new MockError("SHUTTING_DOWN", "Mock service is shutting down", 503);
    const input = createSession.parse(raw);
    this.sweep();
    if ([...this.calls.values()].filter((call) => !terminal.has(call.view.status)).length >= this.config.MAX_ACTIVE_CALLS) {
      throw new MockError("ACTIVE_CALL_LIMIT", "Maximum active mock calls reached", 409);
    }
    if (this.calls.size >= 200) throw new MockError("SESSION_LIMIT", "Delete terminal sessions or wait for retention cleanup", 409);
    if (input.relayWsUrl) backendUrl(input.relayWsUrl, this.config, "ws");
    if (input.url) backendUrl(input.url, this.config, "http");
    if (input.statusCallback) backendUrl(input.statusCallback, this.config, "http");
    if (input.timeout && input.timeout > this.config.CALL_TIMEOUT_SECONDS) throw new MockError("INVALID_REQUEST", "Timeout exceeds configured call limit");
    const id = this.makeId("CA");
    if (!/^CA[0-9a-f]{32}$/i.test(id) || this.calls.has(id)) throw new Error("ID factory returned an invalid or duplicate call ID");
    const at = this.timestamp();
    const view: SessionView = { id, callSid: id, accountSid: this.config.MOCK_ACCOUNT_SID, sessionId: null,
      from: input.from ?? this.config.DEFAULT_FROM, to: input.to ?? this.config.DEFAULT_TO,
      status: "queued", connection: "waiting", createdAt: at, updatedAt: at, startedAt: null, endedAt: null,
      relayWsUrl: null, language: input.language ?? this.config.DEFAULT_LANGUAGE, ttsLanguage: input.language ?? this.config.DEFAULT_LANGUAGE,
      customParameters: input.customParameters ?? {}, lastError: null, lastClose: null, handoffData: null,
      transitions: [{ status: "queued", at }], transcript: [], events: [], droppedEvents: 0, callbacks: [], operatorId: null };
    const call: Call = { view, input, abort: new AbortController(), deadline: this.now() + this.config.CALL_TIMEOUT_SECONDS * 1000,
      ringDeadline: this.now() + (input.timeout ?? Math.min(30, this.config.CALL_TIMEOUT_SECONDS)) * 1000,
      invalid: 0, output: null, callbackSequence: 0, work: Promise.resolve(), endedByBackend: false,
      dialAt: this.now() + this.config.MOCK_DIAL_DELAY_MS, actionStarted: false };
    this.calls.set(id, call);
    this.event(call, "lifecycle", "call.created", { from: view.from, to: view.to });
    if (this.config.MOCK_DIAL_DELAY_MS === 0) this.startDialing(call);
    return this.view(id);
  }
  private startDialing(call: Call) {
    if (call.view.status !== "queued" || this.closed) return;
    call.ringDeadline = this.now() + (call.input.timeout ?? Math.min(30, this.config.CALL_TIMEOUT_SECONDS)) * 1000;
    // initiated fires when a call leaves the queue, never at queued creation.
    const input = call.input;
    if (input.statusCallback && input.statusCallbackEvents?.includes("initiated")) {
      // The callback chain captures fields at scheduling time.
      this.scheduleCallback(call, "initiated");
    }
    this.transition(call, "ringing");
    if (input.autoAnswer ?? this.config.AUTO_ANSWER) setImmediate(() => { void this.answer(call.view.id).catch(() => {}); });
  }
  assertOperator(id: string, operatorId?: string) {
    const owner = this.get(id).view.operatorId;
    if (owner && owner !== operatorId) throw new MockError("OPERATOR_LOCKED", "Another browser controls this call; release it there first", 409);
  }
  claim(id: string, operatorId: string) {
    const call = this.get(id); this.assertOperator(id, operatorId);
    call.view.operatorId = operatorId; this.changed(call);
  }
  release(id: string, operatorId: string) {
    const call = this.get(id); this.assertOperator(id, operatorId);
    call.view.operatorId = null; this.changed(call);
  }
  releaseOperator(operatorId: string) {
    for (const call of this.calls.values()) if (call.view.operatorId === operatorId) {
      call.view.operatorId = null; this.event(call, "operator", "operator.disconnected", { callContinuesUntilHangupOrTimeout: true });
    }
  }
  private ensureActive(call: Call) {
    if (call.view.status !== "in-progress" || call.view.connection !== "connected" || call.socket?.readyState !== WebSocket.OPEN) {
      throw new MockError("INVALID_CALL_STATE", "The relay must be connected before sending caller input", 409);
    }
  }
  private send(call: Call, message: unknown) {
    this.ensureActive(call);
    if (call.socket!.bufferedAmount > 262_144) throw new MockError("BACKEND_BACKPRESSURE", "Backend input buffer is full; retry after it drains", 409);
    call.socket!.send(JSON.stringify(message));
    this.event(call, "to-backend", String((message as { type: string }).type), message);
  }
  private appendTranscript(call: Call, entry: Transcript) {
    call.view.transcript.push(entry);
    if (call.view.transcript.length > 100) call.view.transcript.shift();
  }
  async answer(id: string) {
    const call = this.get(id);
    if (call.view.status !== "ringing") throw new MockError("INVALID_CALL_STATE", "Only ringing calls can be answered", 409);
    if (this.now() >= call.ringDeadline) { this.end(call, "no-answer", "CALL_TIMEOUT", "The ringing timeout expired"); throw new MockError("INVALID_CALL_STATE", "The ringing timeout expired", 409); }
    call.view.connection = "connecting";
    this.transition(call, "in-progress"); this.event(call, "operator", "operator.answer", {});
    try {
      let settings: RelaySettings;
      // Calls REST gives Url precedence over inline Twiml, matching Twilio's documented rule.
      if (call.input.url || call.input.twiml) {
        let xml = call.input.twiml!;
        if (call.input.url) {
          this.event(call, "lifecycle", "twiml.fetch", { target: call.input.url });
          try {
            const result = await mockRequest(call.input.url, call.input.method ?? "POST", this.fields(call), this.config, call.abort.signal);
            if (!result.ok) throw new Error("Fetch rejected");
            xml = result.text;
          } catch { throw new MockError("TWIML_FETCH_FAILED", "Cannot fetch bounded TwiML from the configured backend"); }
        }
        settings = parseTwiml(xml, this.config, call.view.language);
      } else settings = { url: call.input.relayWsUrl ?? this.config.CALLMATE_WS_URL,
        language: call.view.language, ttsLanguage: call.view.ttsLanguage, greeting: "", interruptible: true,
        customParameters: call.view.customParameters, actionMethod: "POST" };
      if (terminal.has(call.view.status)) return this.view(id);
      call.settings = settings;
      call.view.relayWsUrl = settings.url; call.view.language = settings.language;
      call.view.ttsLanguage = settings.ttsLanguage; call.view.customParameters = settings.customParameters;
      call.view.sessionId = this.makeId("VX");
      if (!/^VX[0-9a-f]{32}$/i.test(call.view.sessionId)
        || [...this.calls.values()].some((other) => other !== call && other.view.sessionId === call.view.sessionId)) throw new Error("Invalid or duplicate session ID");
      this.event(call, "lifecycle", "relay.connecting", { target: settings.url });
      const ws = new WebSocket(settings.url, { headers: { "X-CallMate-Mock": "true",
        "X-Twilio-Signature": requestSignature(this.config.MOCK_AUTH_TOKEN, settings.url) }, followRedirects: false,
        handshakeTimeout: this.config.BACKEND_TIMEOUT_MS, maxPayload: 32_768 });
      call.socket = ws;
      ws.once("unexpected-response", (_request, response) => {
        const hint = response.statusCode === 404
          ? "The configured relay path does not exist. Start a backend with a ConversationRelay WebSocket handler or correct the relay URL."
          : "Check the relay URL and that the backend accepts WebSocket upgrades and development mock traffic.";
        this.end(call, "failed", "BACKEND_WS_CONNECT_FAILED", `Backend rejected the WebSocket upgrade with HTTP ${response.statusCode}. ${hint}`);
        response.destroy();
      });
      ws.on("error", () => {
        const connecting = call.view.connection === "connecting";
        if (!terminal.has(call.view.status) && !call.endedByBackend) this.end(call, "failed", connecting
          ? "BACKEND_WS_CONNECT_FAILED" : "BACKEND_WS_DISCONNECTED", connecting
          ? "Cannot connect to the backend relay. Start its ConversationRelay WebSocket handler and check the relay URL, Docker networking and firewall."
          : "Mock relay WebSocket transport failed");
      });
      ws.on("close", (code, reason) => {
        call.view.lastClose = { code, reason: reason.toString().slice(0, 300) };
        this.event(call, "lifecycle", "relay.close", call.view.lastClose);
        if (!terminal.has(call.view.status) && !call.endedByBackend) this.end(call, "failed", "BACKEND_WS_DISCONNECTED", "Backend closed the relay without an end control message");
      });
      ws.on("message", (data, binary) => {
        if (terminal.has(call.view.status) || call.endedByBackend) return;
        try { this.receive(call, data.toString(), binary); }
        catch { this.end(call, "failed", "BACKEND_WS_DISCONNECTED", "Cannot exchange relay messages with the backend"); }
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => {
          if (terminal.has(call.view.status)) { ws.terminate(); resolve(); return; }
          try {
            call.view.connection = "connected";
            this.send(call, { type: "setup", sessionId: call.view.sessionId, accountSid: this.config.MOCK_ACCOUNT_SID,
              parentCallSid: "", callSid: id, from: call.view.from, to: call.view.to, forwardedFrom: "", callType: "PSTN",
              callerName: "", direction: "outbound-api", callStatus: "IN_PROGRESS", customParameters: call.view.customParameters });
            if (settings.greeting) {
              this.appendTranscript(call, { id: randomUUID(), at: this.timestamp(), speaker: "platform", text: settings.greeting,
                lang: settings.ttsLanguage, final: true, interruptible: settings.interruptible, preemptible: false });
              this.event(call, "lifecycle", "platform.greeting", { text: settings.greeting });
            }
            resolve();
          } catch (error) { reject(error); }
        }); ws.once("error", reject);
        ws.once("close", () => reject(new MockError("BACKEND_WS_CONNECT_FAILED", "Relay closed during connection")));
      });
    } catch (error) {
      if (!terminal.has(call.view.status)) this.end(call, "failed", error instanceof MockError ? error.code : "BACKEND_WS_CONNECT_FAILED",
        error instanceof MockError ? error.message : "Cannot establish the mock relay connection");
    }
    return this.view(id);
  }
  private receive(call: Call, raw: string, binary: boolean) {
    let parsed; let decoded: unknown;
    try { if (binary) throw new Error("Binary frame"); decoded = JSON.parse(raw); parsed = relayMessage.safeParse(decoded); } catch { /* Invalid JSON */ }
    if (!parsed?.success) {
      this.event(call, "from-backend", "invalid", decoded ?? { format: binary ? "binary" : "non-JSON", bytes: Buffer.byteLength(raw) });
      this.diagnostic(call, "INVALID_RELAY_MESSAGE", "Backend sent an unsupported or malformed ConversationRelay message");
      this.send(call, { type: "error", description: "Invalid message received: unsupported type or invalid fields" });
      if (++call.invalid >= 10) this.end(call, "failed", "INVALID_RELAY_MESSAGE", "Ten consecutive malformed messages", 1007);
      return;
    }
    call.invalid = 0;
    const message = parsed.data;
    this.event(call, "from-backend", message.type, message);
    if (message.type === "text") {
      if (!call.output) {
        call.output = { id: randomUUID(), at: this.timestamp(), speaker: "assistant", text: "", final: false,
          lang: message.lang ?? call.view.ttsLanguage, interruptible: message.interruptible ?? call.settings?.interruptible ?? true,
          preemptible: message.preemptible ?? false };
        this.appendTranscript(call, call.output);
      }
      if (call.output.text.length + message.token.length > 32_768) {
        this.end(call, "failed", "INVALID_RELAY_MESSAGE", "Streamed turn exceeds the mock text limit", 1007); return;
      }
      call.output.text += message.token;
      if (message.lang) call.output.lang = message.lang;
      if (message.interruptible !== undefined) call.output.interruptible = message.interruptible;
      if (message.preemptible !== undefined) call.output.preemptible = message.preemptible;
      call.output.final = message.last;
      if (message.last) call.output = null;
    } else if (message.type === "end") {
      call.view.handoffData = message.handoffData ?? null;
      this.finishRelay(call);
    } else if (message.type === "language") {
      if (message.ttsLanguage) call.view.ttsLanguage = message.ttsLanguage;
      if (message.transcriptionLanguage) call.view.language = message.transcriptionLanguage;
    } else if (message.type === "play") this.diagnostic(call, "UNSUPPORTED_MEDIA_PLAYBACK", "Media request recorded; this emulator does not play media URLs");
    this.changed(call);
  }
  injectUtterance(id: string, raw: unknown) {
    const input = utterance.parse(raw); const call = this.get(id);
    this.send(call, { type: "prompt", voicePrompt: input.text, lang: input.lang ?? call.view.language, last: input.last });
    this.appendTranscript(call, { id: randomUUID(), at: this.timestamp(), speaker: "operator", text: input.text,
      lang: input.lang ?? call.view.language, final: input.last, interruptible: false, preemptible: false });
    this.changed(call); return this.view(id);
  }
  interrupt(id: string, raw: unknown) { const input = interruption.parse(raw); const call = this.get(id);
    this.send(call, { type: "interrupt", ...input }); this.event(call, "operator", "playback.cancel", {}); return this.view(id); }
  digits(id: string, raw: unknown) { const input = dtmf.parse(raw); const call = this.get(id);
    this.send(call, { type: "dtmf", ...input }); return this.view(id); }
  setLanguage(id: string, language: string) { const call = this.get(id); this.ensureActive(call);
    call.view.language = language; call.view.ttsLanguage = language; this.event(call, "operator", "language.changed", { language }); return this.view(id); }
  reportSpeech(id: string, code: string, message: string) { this.diagnostic(this.get(id), code, message); }
  reject(id: string) {
    const call = this.get(id);
    if (call.view.status !== "ringing") throw new MockError("INVALID_CALL_STATE", "Only ringing calls can be rejected", 409);
    this.event(call, "operator", "operator.reject", {}); this.end(call, "busy"); return this.view(id);
  }
  hangup(id: string) {
    const call = this.get(id);
    if (!terminal.has(call.view.status)) { this.event(call, "operator", "operator.hangup", {}); this.end(call, "completed"); }
    return this.view(id);
  }
  cancel(id: string) {
    const call = this.get(id);
    if (terminal.has(call.view.status)) return this.view(id);
    if (!["queued", "ringing"].includes(call.view.status)) throw new MockError("INVALID_CALL_STATE", "Only queued or ringing calls can be canceled");
    this.event(call, "operator", "call.cancel", {}); this.end(call, "canceled");
    return this.view(id);
  }
  private closeRelay(call: Call, closeCode = 1000) {
    if (call.socket?.readyState === WebSocket.CONNECTING) call.socket.terminate();
    else if (call.socket?.readyState === WebSocket.OPEN) {
      call.socket.close(closeCode, closeCode === 1007 ? "Too many consecutive malformed messages." : "Mock relay ended");
      const socket = call.socket;
      const timer = setTimeout(() => socket.terminate(), 500); timer.unref(); socket.once("close", () => clearTimeout(timer));
    }
  }
  private finishRelay(call: Call) {
    call.endedByBackend = true; call.output = null; call.view.connection = "disconnected";
    this.closeRelay(call);
    if (!call.settings?.action) { this.end(call, "completed"); return; }
    call.actionStarted = true;
    const fields = { ...this.fields(call), SessionId: call.view.sessionId!, SessionStatus: "ended",
      SessionDuration: this.duration(call), ...(call.view.handoffData === null ? {} : { HandoffData: call.view.handoffData }) };
    this.event(call, "lifecycle", "relay.ended", { callContinues: true });
    call.work = call.work.then(async () => {
      if (terminal.has(call.view.status)) return;
      try {
        const response = await mockRequest(call.settings!.action!, call.settings!.actionMethod, fields, this.config, call.abort.signal);
        if (terminal.has(call.view.status)) return;
        this.event(call, "callback", "connect.action", { status: response.status });
        if (!response.ok) throw new MockError("CALLBACK_DELIVERY_FAILED", "Connect action callback returned an error");
        const continuation = parseContinuation(response.text);
        if (continuation.pauseSeconds) {
          call.resumeAt = this.now() + continuation.pauseSeconds * 1000;
          this.event(call, "lifecycle", "twiml.pause", { seconds: continuation.pauseSeconds });
        } else this.end(call, "completed");
      } catch (error) {
        if (!terminal.has(call.view.status)) this.end(call, "failed", error instanceof MockError ? error.code : "CALLBACK_DELIVERY_FAILED",
          error instanceof MockError ? error.message : "Connect action callback failed or timed out");
      }
    }).catch(() => {});
  }
  private end(call: Call, status: Status, code?: string, message?: string, closeCode = 1000) {
    if (terminal.has(call.view.status)) return;
    call.abort.abort();
    if (code) this.diagnostic(call, code, message!);
    call.view.connection = status === "failed" ? "failed" : "disconnected";
    this.closeRelay(call, closeCode);
    this.transition(call, status);
    if (call.settings?.action && call.view.sessionId && !call.actionStarted) {
      call.actionStarted = true;
      const fields = { ...this.fields(call), ...(call.endedByBackend ? { CallStatus: "in-progress" } : {}), SessionId: call.view.sessionId,
        SessionStatus: status === "failed" ? "failed" : call.endedByBackend ? "ended" : "completed",
        SessionDuration: this.duration(call), ...(call.view.handoffData === null ? {} : { HandoffData: call.view.handoffData }) };
      call.work = call.work.then(async () => {
        try {
          const response = await mockRequest(call.settings!.action!, call.settings!.actionMethod, fields, this.config);
          this.event(call, "callback", "connect.action", { status: response.status });
          if (!response.ok) this.diagnostic(call, "CALLBACK_DELIVERY_FAILED", "Connect action callback returned an error");
        } catch { this.diagnostic(call, "CALLBACK_DELIVERY_FAILED", "Connect action callback failed or timed out"); }
      }).catch(() => {});
    }
  }
  private duration(call: Call) { return String(call.view.startedAt ? Math.max(0, Math.floor(((call.view.endedAt ? Date.parse(call.view.endedAt) : this.now()) - Date.parse(call.view.startedAt)) / 1000)) : 0); }
  resource(id: string) {
    const call = this.get(id); const view = call.view;
    const date = (value: string | null) => value ? new Date(value).toUTCString() : null;
    return { sid: id, account_sid: view.accountSid, from: view.from, to: view.to, direction: "outbound-api",
      status: view.status, date_created: date(view.createdAt), date_updated: date(view.updatedAt), start_time: date(view.startedAt),
      end_time: date(view.status === "completed" ? view.endedAt : null), duration: view.status === "completed" ? this.duration(call) : null,
      uri: `/2010-04-01/Accounts/${view.accountSid}/Calls/${id}.json`, api_version: "2010-04-01", price: null, price_unit: null };
  }
  delete(id: string) {
    const call = this.get(id);
    if (!terminal.has(call.view.status)) throw new MockError("INVALID_CALL_STATE", "Only terminal mock records can be deleted", 409);
    this.calls.delete(id); this.emit("deleted", id);
  }
  sweep() {
    for (const call of this.calls.values()) {
      if (terminal.has(call.view.status)) {
        if (this.now() - Date.parse(call.view.endedAt!) >= this.config.SESSION_RETENTION_MINUTES * 60_000) this.delete(call.view.id);
      } else if (call.view.status === "ringing" && this.now() >= call.ringDeadline) this.end(call, "no-answer", "CALL_TIMEOUT", "No operator answered before the ringing deadline");
      else if (this.now() >= call.deadline) this.end(call, "failed", "CALL_TIMEOUT", "Maximum mock call duration reached");
      else if (call.view.status === "queued" && this.now() >= call.dialAt) this.startDialing(call);
      else if (call.resumeAt !== undefined && this.now() >= call.resumeAt) this.end(call, "completed");
    }
  }
  async drain(id: string) {
    const call = this.get(id);
    for (;;) { const work = call.work; await work; if (call.work === work) return; }
  }
  async shutdown() {
    this.closed = true;
    for (const call of this.calls.values()) if (!terminal.has(call.view.status)) this.end(call, "failed", "SERVICE_SHUTDOWN", "Mock service stopped; session will not resume");
    // Deliveries are serialized per call, each with a bounded 2.5s timeout. Do not block shutdown indefinitely.
    await Promise.race([Promise.all([...this.calls.values()].map((call) => call.work)), new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
    for (const call of this.calls.values()) call.socket?.terminate();
  }
}
