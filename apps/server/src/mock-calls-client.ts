import { request as httpRequest } from "node:http";
import twilio from "twilio";
import { z } from "zod";
import type { Config } from "./config.js";
import { callStatus } from "./twilio/protocol.js";

const resource = z.object({ sid: z.string().regex(/^CA[0-9a-f]{32}$/i), status: callStatus,
  account_sid: z.string(), from: z.string(), to: z.string() });
export class MockCallsError extends Error {
  constructor(readonly ambiguous = false) { super("Local mock Calls request failed"); }
}

/** Synthetic Calls façade only. Never sends credentials or requests to a real provider. */
export class MockCallsClient {
  private readonly origin: URL;
  constructor(private config: Config) { this.origin = new URL(config.mockApiBase); }
  private request(path: string, body?: URLSearchParams): Promise<unknown> {
    const encoded = body?.toString();
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(new URL(path, this.origin), {
        method: body ? "POST" : "GET", signal: AbortSignal.timeout(2500),
        headers: {
          // Native HTTP honors Host; fetch may replace it with the gateway hostname.
          host: this.origin.hostname === "host.docker.internal" ? `localhost:${this.origin.port || "80"}` : this.origin.host,
          authorization: `Basic ${Buffer.from(`${this.config.mockUsername}:${this.config.mockPassword}`).toString("base64")}`,
          ...(encoded === undefined ? {} : { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(encoded) }),
        },
      }, (response) => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume(); reject(new MockCallsError((response.statusCode ?? 500) >= 500)); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65_536) { outgoing.destroy(); reject(new MockCallsError(true)); return; }
          chunks.push(chunk);
        });
        response.on("error", () => reject(new MockCallsError(true)));
        response.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown); }
          catch { reject(new MockCallsError(true)); }
        });
      });
      // Redirects are errors; no request leaves the explicitly configured local origin.
      outgoing.on("error", () => reject(new MockCallsError(true)));
      outgoing.end(encoded);
    });
  }
  async check() {
    const result = z.object({ mock: z.literal(true), service: z.literal("CallMate Mock ConversationRelay") }).safeParse(await this.request("/healthz"));
    if (!result.success) throw new MockCallsError();
  }
  private get root() { return `/2010-04-01/Accounts/${encodeURIComponent(this.config.mockAccountSid)}/Calls`; }
  private parse(raw: unknown) {
    const parsed = resource.safeParse(raw);
    if (!parsed.success || parsed.data.account_sid !== this.config.mockAccountSid
      || parsed.data.from !== "+48000000000" || parsed.data.to !== "+48111111111") throw new MockCallsError(true);
    return parsed.data;
  }
  async create(id: string, token: string, language: string) {
    const response = new twilio.twiml.VoiceResponse();
    const relay = response.connect().conversationRelay({ url: this.config.mockRelayUrl, language });
    relay.parameter({ name: "conversationId", value: id });
    relay.parameter({ name: "authToken", value: token });
    relay.parameter({ name: "taskId", value: `console-${id}` });
    const body = new URLSearchParams({ To: "+48111111111", From: "+48000000000", Twiml: response.toString() });
    return this.parse(await this.request(this.root + ".json", body));
  }
  async get(sid: string) { return this.parse(await this.request(`${this.root}/${encodeURIComponent(sid)}.json`)); }
  async hangup(sid: string) {
    return this.parse(await this.request(`${this.root}/${encodeURIComponent(sid)}.json`, new URLSearchParams({ Status: "completed" })));
  }
}
