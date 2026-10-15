import type { IncomingMessage, ServerResponse } from "node:http";
import twilio from "twilio";
import RequestClient from "twilio/lib/base/RequestClient.js";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { PlaybackPermitSchema } from "@callmate/contracts";
import type { AttemptContext, CallStartResult, PlaybackPermit, ProviderCallStatus, TelephonyPort } from "@callmate/contracts";
import { callStatus, normalizeStatus, relayInbound, relayOutbound, statusCallback, terminal } from "./protocol.js";
import type { RelayInbound, RelayOutbound } from "./protocol.js";
import { createServer, listen, mockAccountSid, mockAuthToken, mockFrom, readForm, requireLoopback, stop, validSignature } from "./local-http.js";

/** Use the real SDK serializer, but make routing to any real Twilio host impossible. */
export class LoopbackTwilioClient extends RequestClient {
  private origin: string;
  constructor(baseUrl: string) {
    super({ autoRetry: false, timeout: 3000 });
    const url = requireLoopback(baseUrl);
    if (url.pathname !== "/" || url.search) throw new Error("Expected mock origin");
    this.origin = url.origin;
    this.axios.defaults.proxy = false;
  }
  override request<TData>(options: RequestClient.RequestOptions<TData>) {
    const url = new URL(options.uri);
    if (url.origin !== "https://api.twilio.com"
      || !new RegExp(`^/2010-04-01/Accounts/${mockAccountSid}/Calls(?:/CA[0-9a-f]{32})?\\.json$`).test(url.pathname)
      || url.search || !["GET", "POST"].includes(options.method.toUpperCase())) throw new Error("Unsupported mock SDK request");
    return super.request({ ...options, uri: this.origin + url.pathname, allowRedirects: false });
  }
}

type Attempt = {
  context: AttemptContext; callSid?: string; sequence: number; status: string;
  ws?: WebSocket; sessionId?: string; upgraded: boolean; sessionEnded: boolean;
};
export type MockObservation =
  | { type: "call.status"; attemptId: string; callState: ReturnType<typeof normalizeStatus>; sequence: number }
  | { type: "relay.message"; attemptId: string; message: RelayInbound }
  | { type: "business.utterance"; attemptId: string; text: string; language: string }
  | { type: "relay.closed"; attemptId: string; code: number }
  | { type: "relay.ended"; attemptId: string; sessionStatus: string; handoffData?: string };

/**
 * Isolated adapter probe. It never mounts routes on the application's callback listener
 * or starts the booking controller. A live adapter still needs durable correlation/recovery.
 */
export class MockTwilioAdapter implements TelephonyPort {
  baseUrl = "";
  readonly observations: MockObservation[] = [];
  readonly client: ReturnType<typeof twilio>;
  private attempts = new Map<string, Attempt>();
  private consumed = new Set<string>();
  private sessions = new Set<string>();
  private sockets = new WebSocketServer({ noServer: true, maxPayload: 32768 });
  private server = createServer((req, res) => { void this.handle(req, res).catch(() => res.writeHead(400).end()); });

  constructor(mockUrl: string, private consumePermit: (permit: PlaybackPermit) => boolean = () => false) {
    this.client = twilio(mockAccountSid, mockAuthToken, { httpClient: new LoopbackTwilioClient(mockUrl), autoRetry: false });
    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url!, this.baseUrl);
      const attempt = this.attempts.get(url.searchParams.get("attemptId") ?? "");
      const signatureUrl = this.baseUrl.replace("http:", "ws:") + req.url;
      if (url.pathname !== "/twilio/relay" || !validSignature(req, signatureUrl, {}) || !attempt?.callSid
        || attempt.status !== "in-progress" || attempt.upgraded) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
      }
      attempt.upgraded = true;
      this.sockets.handleUpgrade(req, socket, head, (ws) => {
        attempt.ws = ws;
        ws.on("error", () => { /* Close observation handles transport loss; no automatic redial. */ });
        ws.on("close", (code) => {
          attempt.sessionEnded = true;
          this.observations.push({ type: "relay.closed", attemptId: attempt.context.attemptId, code });
        });
        ws.on("message", (data, binary) => {
          try {
            if (binary) throw new Error("Expected text JSON");
            const message = relayInbound.parse(JSON.parse(data.toString()));
            if (message.type === "setup") {
              if (attempt.sessionId || this.sessions.has(message.sessionId) || message.accountSid !== mockAccountSid
                || message.callSid !== attempt.callSid || message.from !== mockFrom
                || message.to !== attempt.context.plan.request.business.phone
                || message.customParameters.attemptId !== attempt.context.attemptId) throw new Error("Uncorrelated session");
              attempt.sessionId = message.sessionId; this.sessions.add(message.sessionId);
            } else if (!attempt.sessionId || attempt.sessionEnded || terminal.has(attempt.status)) throw new Error("Inactive session");
            this.observations.push({ type: "relay.message", attemptId: attempt.context.attemptId, message });
            if (message.type === "prompt" && message.last) this.observations.push({ type: "business.utterance",
              attemptId: attempt.context.attemptId, text: message.voicePrompt, language: message.lang });
          } catch { ws.close(1008, "Invalid or uncorrelated relay message"); }
        });
      });
    });
  }
  async start() { this.baseUrl = await listen(this.server); return this; }
  async close() {
    for (const ws of this.sockets.clients) ws.terminate();
    await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
    await stop(this.server);
  }
  callbackUrl(kind: "voice" | "status" | "action", attemptId: string) {
    return `${this.baseUrl}/twilio/${kind}?attemptId=${encodeURIComponent(attemptId)}`;
  }
  relayUrl(attemptId: string) {
    return `${this.baseUrl.replace("http:", "ws:")}/twilio/relay?attemptId=${encodeURIComponent(attemptId)}`;
  }
  async startCall(context: AttemptContext): Promise<CallStartResult> {
    if (!this.baseUrl) throw new Error("Start callback listener first");
    // Unknown creation is not safe to retry. The real controller owns idempotency.
    const prior = this.attempts.get(context.attemptId);
    if (prior) return prior.callSid ? { status: "accepted", providerCallId: prior.callSid }
      : { status: "unknown", correlationId: context.attemptId };
    const attempt: Attempt = { context: structuredClone(context), sequence: -1, status: "queued", upgraded: false, sessionEnded: false };
    this.attempts.set(context.attemptId, attempt);
    try {
      const call = await this.client.calls.create({ to: context.plan.request.business.phone, from: mockFrom,
        url: this.callbackUrl("voice", context.attemptId), method: "POST",
        statusCallback: this.callbackUrl("status", context.attemptId), statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        timeLimit: context.plan.request.callLimits.maxDurationSeconds, timeout: 30, record: false });
      attempt.callSid = call.sid;
      return { status: "accepted", providerCallId: call.sid };
    } catch { return { status: "unknown", correlationId: context.attemptId }; }
  }
  async queryCall(providerCallId: string): Promise<ProviderCallStatus> {
    try {
      const call = await this.client.calls(providerCallId).fetch();
      return { status: "found", providerCallId: call.sid, callState: normalizeStatus(callStatus.parse(call.status)) };
    } catch { return { status: "unknown" }; }
  }
  async requestHangup(providerCallId: string) {
    const attempt = [...this.attempts.values()].find((item) => item.callSid === providerCallId);
    if (attempt) attempt.sessionEnded = true; // Block output immediately, even if provider outcome is ambiguous.
    try {
      const call = await this.client.calls(providerCallId).fetch();
      if (!terminal.has(call.status)) await this.client.calls(providerCallId).update({
        status: ["queued", "ringing"].includes(call.status) ? "canceled" : "completed" });
      return { status: "acknowledged" as const };
    } catch { return { status: "unknown" as const }; }
  }
  async sendAuthorizedText(input: PlaybackPermit) {
    const permit = PlaybackPermitSchema.parse(input);
    const attempt = this.attempts.get(permit.attemptId);
    if (!attempt?.sessionId || attempt.ws?.readyState !== WebSocket.OPEN || attempt.sessionEnded
      || attempt.status !== "in-progress" || permit.planId !== attempt.context.plan.id
      || permit.planVersion !== attempt.context.plan.version || Date.parse(permit.expiresAt) <= Date.now()
      || this.consumed.has(permit.id) || !this.consumePermit(permit)) throw new Error("Playback permit is not current");
    this.consumed.add(permit.id);
    await this.write(attempt, { type: "text", token: permit.approvedSpanishText, last: true, lang: "es-ES",
      interruptible: true, preemptible: true });
    // Successful socket submission is not a playback-completed acknowledgment.
  }
  async endSession(attemptId: string, handoffData?: string) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt?.sessionId || attempt.sessionEnded) throw new Error("No active relay session");
    attempt.sessionEnded = true;
    await this.write(attempt, { type: "end", ...(handoffData === undefined ? {} : { handoffData }) });
  }
  private async write(attempt: Attempt, message: RelayOutbound) {
    if (attempt.ws?.readyState !== WebSocket.OPEN) throw new Error("Relay closed");
    const frame = relayOutbound.parse(message);
    await new Promise<void>((resolve, reject) => attempt.ws!.send(JSON.stringify(frame), (err) => err ? reject(err) : resolve()));
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, this.baseUrl);
    if (req.method !== "POST" || !["/twilio/voice", "/twilio/status", "/twilio/action"].includes(url.pathname)) {
      res.writeHead(404).end(); return;
    }
    const fields = await readForm(req);
    // Validate the full form before schema parsing strips unknown fields.
    if (!validSignature(req, this.baseUrl + req.url, fields)) { res.writeHead(403).end(); return; }
    const attempt = this.attempts.get(url.searchParams.get("attemptId") ?? "");
    if (!attempt?.callSid || fields.AccountSid !== mockAccountSid || fields.CallSid !== attempt.callSid
      || fields.From !== mockFrom || fields.To !== attempt.context.plan.request.business.phone) {
      res.writeHead(403).end(); return;
    }
    if (url.pathname === "/twilio/status") {
      const event = statusCallback.parse(fields);
      if (event.SequenceNumber > attempt.sequence && !terminal.has(attempt.status)) {
        attempt.sequence = event.SequenceNumber; attempt.status = event.CallStatus;
        if (terminal.has(event.CallStatus)) attempt.sessionEnded = true;
        this.observations.push({ type: "call.status", attemptId: attempt.context.attemptId,
          callState: normalizeStatus(event.CallStatus), sequence: event.SequenceNumber });
      }
      res.writeHead(204).end(); return;
    }
    const response = new twilio.twiml.VoiceResponse();
    if (url.pathname === "/twilio/voice") {
      if (fields.CallStatus !== "in-progress" || attempt.sessionEnded || terminal.has(attempt.status)) { res.writeHead(409).end(); return; }
      const relay = response.connect({ action: this.callbackUrl("action", attempt.context.attemptId), method: "POST" })
        .conversationRelay({ url: this.relayUrl(attempt.context.attemptId), language: "es-ES", dtmfDetection: true, partialPrompts: true });
      relay.parameter({ name: "attemptId", value: attempt.context.attemptId });
    } else {
      const action = z.object({ SessionId: z.string(), SessionStatus: z.enum(["ended", "failed", "completed"]),
        SessionDuration: z.string().regex(/^\d+$/), HandoffData: z.string().optional() }).parse(fields);
      if (!attempt.sessionId || action.SessionId !== attempt.sessionId) { res.writeHead(403).end(); return; }
      if (!this.observations.some((item) => item.type === "relay.ended" && item.attemptId === attempt.context.attemptId)) {
        attempt.sessionEnded = true;
        this.observations.push({ type: "relay.ended", attemptId: attempt.context.attemptId, sessionStatus: action.SessionStatus,
          ...(action.HandoffData === undefined ? {} : { handoffData: action.HandoffData }) });
      }
      response.hangup();
    }
    res.writeHead(200, { "content-type": "text/xml" }).end(response.toString());
  }
}
