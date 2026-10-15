import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import { CommandError } from "./errors.js";
import { MockCallsClient, MockCallsError } from "./mock-calls-client.js";
import { mockRelayEnabled } from "./mock-relay.js";
import type { RelayConsumer, RelaySend } from "./mock-relay.js";
import type { RelayInbound } from "./twilio/protocol.js";

const startInput = z.strictObject({ requestId: z.uuid(), initialMessage: z.string().min(1).max(8000).refine((text) => text.trim().length > 0),
  language: z.enum(["es-ES", "ru-RU", "pl-PL", "en-US"]) });
type StartInput = z.infer<typeof startInput>;
type Status = "creating" | "ringing" | "connected" | "disconnected" | "completed" | "failed" | "unknown";
type Conversation = StartInput & { status: Status; callSid: string | null; error: string | null;
  responses: { text: string; language: string; at: string }[]; token: string; attached: boolean;
  stopRequested: boolean; disconnect?: () => void };
const terminal = (status: Status) => status === "completed" || status === "failed";

/** Small, process-local manual console. It has no authority over persisted booking attempts. */
export class DevelopmentConversations {
  private records = new Map<string, Conversation>();
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  private client: MockCallsClient;
  constructor(private config: Config) { this.client = new MockCallsClient(config); }
  private enabled() {
    if (this.closed || !mockRelayEnabled(this.config)) throw new CommandError(503, "PROVIDER_NOT_READY", "Enable development mock mode to use this console");
  }
  private require(id: string) {
    const record = this.records.get(id);
    if (!record) throw new CommandError(404, "NOT_FOUND", "Development conversation not found; it may have ended during a backend restart");
    return record;
  }
  private view(record: Conversation) {
    return { id: record.requestId, initialMessage: record.initialMessage, language: record.language, status: record.status,
      callSid: record.callSid, responses: record.responses.map((response) => ({ ...response })), error: record.error,
      operatorUrl: record.callSid ? `${new URL(this.config.mockOperatorOrigin).origin}/?callId=${encodeURIComponent(record.callSid)}` : null };
  }
  async latest() {
    this.enabled(); const record = [...this.records.values()].at(-1);
    return { conversation: record ? await this.get(record.requestId) : null };
  }
  async start(raw: unknown) {
    const pending = this.startInternal(raw); this.pending.add(pending);
    try { return await pending; } finally { this.pending.delete(pending); }
  }
  private async startInternal(raw: unknown) {
    this.enabled(); const input = startInput.parse(raw);
    const previous = this.records.get(input.requestId);
    if (previous) {
      if (previous.initialMessage !== input.initialMessage || previous.language !== input.language) {
        throw new CommandError(409, "IDEMPOTENCY_CONFLICT", "This start request already has a different message or language");
      }
      return this.view(previous);
    }
    if ([...this.records.values()].some((record) => !terminal(record.status))) {
      throw new CommandError(409, "CALL_ALREADY_ACTIVE", "Stop the current development conversation before starting another");
    }
    while (this.records.size >= 20) this.records.delete(this.records.keys().next().value!);
    const record: Conversation = { ...input, status: "creating", callSid: null, error: null, responses: [],
      token: randomBytes(32).toString("hex"), attached: false, stopRequested: false };
    this.records.set(input.requestId, record);
    try { await this.client.check(); }
    catch {
      record.status = "failed"; record.error = "Mock calls service is unavailable. Start its Docker service and try again.";
      return this.view(record);
    }
    if (this.closed || record.stopRequested) { record.status = "completed"; return this.view(record); }
    try {
      const call = await this.client.create(record.requestId, record.token, record.language);
      if (record.callSid && record.callSid !== call.sid) throw new MockCallsError(true);
      record.callSid = call.sid;
      if (record.status === "creating") record.status = "ringing";
      if (record.stopRequested || this.closed) await this.stop(record.requestId);
    } catch (error) {
      // A failed/ambiguous create is never automatically retried.
      record.status = error instanceof MockCallsError && !error.ambiguous ? "failed" : "unknown";
      record.error = record.status === "unknown"
        ? "Call creation could not be confirmed. Check the operator page before retrying; no automatic retry was made."
        : "The mock service rejected the call. Check its local account configuration.";
    }
    return this.view(record);
  }
  async get(id: string) {
    this.enabled(); const record = this.require(id);
    if (record.callSid && !terminal(record.status)) {
      try {
        const call = await this.client.get(record.callSid);
        if (call.sid !== record.callSid) throw new MockCallsError();
        if (["completed", "canceled"].includes(call.status)) { record.status = "completed"; record.error = null; }
        else if (["busy", "no-answer", "failed"].includes(call.status)) {
          record.status = "failed"; record.error = "The mock call was rejected, unanswered or disconnected. See the operator page for details.";
        } else if (record.status === "disconnected") {
          record.error = "The relay disconnected. Stop this call or wait for the mock service to confirm it ended.";
        } else record.error = null;
      } catch {
        record.error = "Cannot refresh the mock call status. Check that the mock calls service is running.";
      }
    }
    return this.view(record);
  }
  async stop(id: string) {
    const record = this.require(id);
    if (terminal(record.status)) return this.view(record);
    record.stopRequested = true;
    if (record.callSid) {
      try {
        const call = await this.client.hangup(record.callSid);
        if (call.sid !== record.callSid || !["completed", "canceled"].includes(call.status)) throw new MockCallsError();
        record.status = "completed"; record.error = null; record.disconnect?.();
      } catch {
        record.error = "Hangup could not be confirmed. Use Hang up on the operator page, then refresh.";
      }
    } else if (record.status === "unknown") {
      record.error = "The mock call ID is unknown. Inspect and hang up the call on the operator page before restarting the backend.";
    }
    return this.view(record);
  }
  attach(message: Extract<RelayInbound, { type: "setup" }>, send: RelaySend, disconnect: () => void): RelayConsumer | undefined {
    const id = message.customParameters.conversationId;
    if (!id) return;
    this.enabled(); const record = this.require(id);
    const supplied = Buffer.from(message.customParameters.authToken ?? "");
    const expected = Buffer.from(record.token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || record.attached
      || terminal(record.status) || record.stopRequested || (record.callSid && record.callSid !== message.callSid)) throw new Error("Uncorrelated relay");
    record.attached = true; record.callSid = message.callSid; record.status = "connected"; record.error = null;
    record.disconnect = disconnect;
    send({ type: "text", token: record.initialMessage, lang: record.language, last: true, interruptible: true, preemptible: true });
    return {
      prompt: (text, language) => {
        if (terminal(record.status) || record.stopRequested) return;
        record.responses.push({ text, language, at: new Date().toISOString() });
        while (record.responses.length > 50 || record.responses.reduce((sum, response) => sum + response.text.length, 0) > 32_000) record.responses.shift();
      },
      close: () => { delete record.disconnect; if (!terminal(record.status)) record.status = "disconnected"; },
    };
  }
  async close() {
    this.closed = true;
    for (const record of this.records.values()) record.stopRequested = true;
    await Promise.allSettled([...this.pending]);
    await Promise.all([...this.records.values()].filter((record) => !terminal(record.status)).map((record) => this.stop(record.requestId)));
    this.records.clear();
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
