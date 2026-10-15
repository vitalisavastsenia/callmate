import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { Config } from "./config.js";
import { relayInbound, relayOutbound } from "./twilio/protocol.js";
import type { RelayInbound, RelayOutbound } from "./twilio/protocol.js";
import { scriptedRelayReply } from "./simulator-adapters.js";

export function mockRelayEnabled(config: Config) {
  return config.mode === "simulator" && config.telephonyProvider === "mock"
    && ["development", "test"].includes(config.nodeEnv);
}
export type RelaySend = (message: RelayOutbound) => void;
export type RelayConsumer = { prompt(text: string, language: string): void; close(): void };
type AttachRelay = (setup: Extract<RelayInbound, { type: "setup" }>, send: RelaySend, disconnect: () => void) => RelayConsumer | undefined;

/** Development transport in the existing backend. It cannot invoke booking or live providers. */
export function mountMockRelay(app: FastifyInstance, config: Config, maxDurationSeconds: () => number, attach?: AttachRelay) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 32_768 });
  const recent = new Set<string>();
  const active = new Set<string>();
  let closing = false;
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const enabled = mockRelayEnabled(config);
    const reject = (code: number, reason: string) => {
      socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (closing || !enabled || request.url !== "/ws/voice") { reject(404, "Not Found"); return; }
    // A browser cannot access this unsigned provider endpoint. Never trust this marker in live mode.
    if (request.headers["x-callmate-mock"] !== "true" || request.headers.origin !== undefined
      || request.headers["sec-fetch-site"] !== undefined) { reject(403, "Forbidden"); return; }
    if (server.clients.size >= 5) { reject(503, "Service Unavailable"); return; }
    server.handleUpgrade(request, socket, head, (ws) => {
      let setup = false;
      let ended = false;
      let partial = "";
      let language = "en-US";
      let identities: string[] = [];
      let consumer: RelayConsumer | undefined;
      const deadline = setTimeout(() => stop(1008, "Development relay duration limit"), maxDurationSeconds() * 1000);
      const setupDeadline = setTimeout(() => stop(1008, "Expected setup first"), 5000);
      deadline.unref(); setupDeadline.unref();
      const stop = (code: number, reason: string) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.close(code, reason);
        const force = setTimeout(() => ws.terminate(), 500); force.unref();
        ws.once("close", () => clearTimeout(force));
      };
      const send = (message: RelayOutbound) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 262_144) { stop(1013, "Development relay output buffer full"); return; }
        ws.send(JSON.stringify(relayOutbound.parse(message)));
      };
      ws.on("error", () => {}); // Do not log provider frames or exception values.
      ws.once("close", () => { clearTimeout(deadline); clearTimeout(setupDeadline); partial = ""; identities.forEach((key) => active.delete(key)); try { consumer?.close(); } catch { /* Keep unresolved calls reserved after storage failure. */ } });
      ws.on("message", (raw, binary) => {
        if (closing || ended || ws.readyState !== WebSocket.OPEN) return;
        let parsed;
        try { if (binary) throw new Error(); parsed = relayInbound.safeParse(JSON.parse(raw.toString())); }
        catch { /* Malformed input is never logged or echoed. */ }
        if (!parsed?.success) { stop(1007, "Invalid ConversationRelay message"); return; }
        const message = parsed.data;
        if (message.type === "setup") {
          const keys = [message.callSid, message.sessionId].map((key) => key.toLowerCase());
          if (setup || !/^AC[0-9a-f]{32}$/i.test(message.accountSid) || !/^CA[0-9a-f]{32}$/i.test(message.callSid)
            || Object.keys(message.customParameters).length > 30
            || Object.entries(message.customParameters).some(([key, value]) => key.length > 100 || value.length > 1000)
            || keys.some((key) => recent.has(key) || active.has(key))) { stop(1008, "Duplicate or invalid relay setup"); return; }
          try { consumer = attach?.(message, send, () => stop(1000, "Development conversation stopped")); }
          catch { stop(1008, "Uncorrelated development conversation"); return; }
          // Register identities only after correlation succeeds; invalid tokens cannot poison a valid call.
          identities = keys; keys.forEach((key) => { recent.add(key); active.add(key); });
          while (recent.size > 400) recent.delete(recent.values().next().value!);
          setup = true; clearTimeout(setupDeadline);
          if (consumer) return;
          send({ type: "text", token: "Development relay connected. Scripted echo only; no appointment will be booked.",
            lang: "en-US", last: true, interruptible: true, preemptible: true });
          return;
        }
        if (!setup) { stop(1008, "Expected setup first"); return; }
        if (message.type === "prompt") {
          if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(message.lang) || message.lang.length > 35
            || partial.length + message.voicePrompt.length > 8000) { stop(1007, "Invalid prompt or language"); return; }
          if (partial && message.lang !== language) { stop(1007, "Partial prompt language changed"); return; }
          partial += message.voicePrompt; language = message.lang;
          if (!message.last) return;
          const text = partial; partial = "";
          if (consumer) {
            try { if (text.trim()) consumer.prompt(text, language); }
            catch { stop(1011, "Cannot persist development conversation"); }
            return;
          }
          if (text === "/end") {
            ended = true;
            send({ type: "end", handoffData: JSON.stringify({ reasonCode: "development_complete", bookingStatus: "not_booked" }) });
            return; // The provider processes end and closes the relay.
          }
          if (!text.trim()) return;
          const characters = Array.from(scriptedRelayReply(text, language));
          const middle = Math.ceil(characters.length / 2);
          send({ type: "text", token: characters.slice(0, middle).join(""), lang: language, last: false, interruptible: true, preemptible: true });
          send({ type: "text", token: characters.slice(middle).join(""), lang: language, last: true, interruptible: true, preemptible: true });
        } else if (message.type === "interrupt") {
          partial = ""; // No asynchronous output is queued by the scripted adapter.
        } else if (message.type === "error") {
          stop(1011, "Provider reported a relay error");
        } // DTMF is validated and accepted without inventing booking actions or replies.
      });
    });
  };
  app.server.on("upgrade", upgrade);
  app.addHook("preClose", async () => {
    closing = true;
    // Release upgrades before Fastify waits for the HTTP server to drain.
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.server.off("upgrade", upgrade);
    recent.clear();
    active.clear();
  });
}
