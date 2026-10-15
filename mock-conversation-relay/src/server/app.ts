import { timingSafeEqual, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify, { LogController } from "fastify";
import type { FastifyRequest } from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import { z, ZodError } from "zod";
import { Controller, terminal } from "./controller.js";
import { MockError } from "./config.js";
import type { Config } from "./config.js";
import { createSession, dtmf, interruption, operatorMessage, utterance } from "../protocol/schemas.js";
import type { PublicConfig, SessionView } from "../shared/types.js";

function localRequest(host: string | undefined, origin: string | undefined, site?: string) {
  try {
    const target = new URL(`http://${host}`);
    if (!["localhost", "127.0.0.1", "[::1]", "mock-relay"].includes(target.hostname) || target.username || target.password) return false;
    if (site === "cross-site") return false;
    return !origin || new URL(origin).origin === target.origin;
  } catch { return false; }
}
const safeError = (error: unknown) => error instanceof MockError ? error
  : error instanceof ZodError ? new MockError("INVALID_REQUEST", "Invalid request fields")
  : new MockError("INVALID_REQUEST", "Malformed or unsupported request");

export function createApp(config: Config, controller = new Controller(config)) {
  const app = Fastify({ bodyLimit: 32_768, logger: config.LOG_LEVEL === "silent" ? false : {
    level: config.LOG_LEVEL, redact: ["req.headers.authorization"], serializers: { req: (req) => ({ method: req.method }) },
  }, logController: new LogController({ disableRequestLogging: true }), requestTimeout: 10_000 });
  const operator = new WebSocketServer({ noServer: true, maxPayload: 32_768 });
  const peers = new Map<string, WebSocket>();
  const publicConfig: PublicConfig = { language: config.DEFAULT_LANGUAGE, from: config.DEFAULT_FROM, to: config.DEFAULT_TO,
    relayWsUrl: config.CALLMATE_WS_URL, twimlUrl: config.CALLMATE_TWIML_URL,
    browserSpeech: config.ENABLE_BROWSER_SPEECH, maxActiveCalls: config.MAX_ACTIVE_CALLS };
  const send = (ws: WebSocket, value: unknown) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 2_000_000) { ws.close(1013, "Operator is too slow; reconnect for a snapshot"); return; }
    ws.send(JSON.stringify(value));
  };
  const broadcast = (value: unknown) => { for (const ws of peers.values()) send(ws, value); };
  const onSession = (session: SessionView) => broadcast({ type: "session", session });
  const onDeleted = (id: string) => broadcast({ type: "deleted", id });
  const onLog = (event: object) => app.log.info(event, "mock event");
  controller.on("session", onSession); controller.on("deleted", onDeleted);
  controller.on("log", onLog);
  app.addHook("onRequest", async (req, reply) => {
    if (!localRequest(req.headers.host, req.headers.origin, req.headers["sec-fetch-site"] as string | undefined)) {
      return reply.code(403).send({ error: { code: "LOCAL_ACCESS_ONLY", message: "Use the locally served origin" } });
    }
    reply.header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer").header("Cache-Control", "no-store");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    app.log.info({ method: req.method, route: req.routeOptions.url ?? "unmatched", mockGenerated: true }, "mock request");
    if (req.url.startsWith("/2010-04-01/")) {
      const actual = Buffer.from(req.headers.authorization ?? "");
      const credentials = [`${config.MOCK_API_USERNAME}:${config.MOCK_API_PASSWORD}`, `${config.MOCK_ACCOUNT_SID}:${config.MOCK_AUTH_TOKEN}`];
      const authenticated = credentials.map((value) => Buffer.from(`Basic ${Buffer.from(value).toString("base64")}`))
        .some((expected) => actual.length === expected.length && timingSafeEqual(actual, expected));
      if (!authenticated) {
        return reply.code(401).header("WWW-Authenticate", 'Basic realm="Local mock Calls API"').send({
          code: 20003, message: "UNAUTHORIZED_MOCK_API: use configured local mock credentials", more_info: "https://www.twilio.com/docs/errors/20003", status: 401 });
      }
    }
  });
  app.setErrorHandler((error, req, reply) => {
    const known = safeError(error);
    if (req.url.startsWith("/2010-04-01/")) {
      const code = known.status === 404 ? 20404 : 20001;
      reply.code(known.status).send({ code, message: `${known.code}: ${known.message}`, more_info: `https://www.twilio.com/docs/errors/${code}`, status: known.status });
    } else reply.code(known.status).send({ error: { code: known.code, message: known.message } });
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, value, done) => {
    const fields: Record<string, string[]> = Object.create(null);
    for (const [key, text] of new URLSearchParams(value as string)) (fields[key] ??= []).push(text);
    done(null, fields);
  });
  app.get("/healthz", async () => ({ ok: true, service: "CallMate Mock ConversationRelay", mock: true }));
  app.get("/api/config", async () => publicConfig);
  app.get("/api/sessions", async () => ({ sessions: controller.list() }));
  app.post("/api/sessions", async (req, reply) => {
    const session = controller.create(req.body);
    return reply.code(201).send({ ...session, operatorUrl: `http://${req.headers.host}/?callId=${session.id}` });
  });
  const idOf = (req: FastifyRequest) => z.object({ id: z.string().regex(/^CA[0-9a-f]{32}$/i) }).parse(req.params).id;
  app.get("/api/sessions/:id", async (req) => controller.view(idOf(req)));
  app.get("/api/sessions/:id/events", async (req) => {
    const session = controller.view(idOf(req)); return { mockGenerated: true, events: session.events, droppedEvents: session.droppedEvents };
  });
  app.delete("/api/sessions/:id", async (req, reply) => {
    const id = idOf(req); controller.assertOperator(id, req.headers["x-operator-id"] as string | undefined);
    controller.delete(id); return reply.code(204).send();
  });
  for (const action of ["answer", "reject", "hangup", "utterances", "interrupt", "dtmf"] as const) {
    app.post(`/api/sessions/:id/${action}`, async (req) => {
      const id = idOf(req); controller.assertOperator(id, req.headers["x-operator-id"] as string | undefined);
      if (action === "answer") return controller.answer(id);
      if (action === "reject") return controller.reject(id);
      if (action === "hangup") return controller.hangup(id);
      if (action === "utterances") return controller.injectUtterance(id, utterance.parse(req.body));
      if (action === "interrupt") return controller.interrupt(id, interruption.parse(req.body ?? {}));
      return controller.digits(id, dtmf.parse(req.body));
    });
  }
  const account = (req: FastifyRequest) => {
    const params = z.object({ accountSid: z.string(), callSid: z.string().optional() }).parse(req.params);
    if (params.accountSid !== config.MOCK_ACCOUNT_SID) throw new MockError("CALL_NOT_FOUND", "Mock account not found", 404);
    return params.callSid;
  };
  const formFields = (body: unknown) => z.record(z.string(), z.array(z.string())).parse(body);
  app.post("/2010-04-01/Accounts/:accountSid/Calls.json", async (req, reply) => {
    account(req);
    const fields = formFields(req.body);
    const supported = new Set(["To", "From", "Url", "Twiml", "Method", "StatusCallback", "StatusCallbackMethod", "StatusCallbackEvent", "Timeout"]);
    if (Object.keys(fields).some((key) => !supported.has(key))
      || Object.entries(fields).some(([key, values]) => key !== "StatusCallbackEvent" && values.length !== 1)) throw new MockError("INVALID_REQUEST", "Unsupported or repeated Calls field");
    const one = (key: string) => fields[key]?.[0];
    if (!one("To") || !one("From") || (!one("Url") && !one("Twiml"))) throw new MockError("INVALID_REQUEST", "To, From, and either Url or Twiml are required");
    const input = createSession.parse({ to: one("To"), from: one("From"), url: one("Url"), twiml: one("Twiml"),
      method: one("Method"), statusCallback: one("StatusCallback"), statusCallbackMethod: one("StatusCallbackMethod"),
      statusCallbackEvents: fields.StatusCallbackEvent?.flatMap((value) => value.split(/\s+/).filter(Boolean)),
      timeout: one("Timeout") === undefined ? undefined : Number(one("Timeout")) });
    const session = controller.create(input);
    return reply.code(201).send(controller.resource(session.id));
  });
  app.get("/2010-04-01/Accounts/:accountSid/Calls/:callSid.json", async (req) => controller.resource(account(req)!));
  app.post("/2010-04-01/Accounts/:accountSid/Calls/:callSid.json", async (req) => {
    const id = account(req)!; const fields = formFields(req.body);
    if (Object.keys(fields).length !== 1 || fields.Status?.length !== 1 || !["completed", "canceled"].includes(fields.Status[0]!)) {
      throw new MockError("INVALID_REQUEST", "This mock supports Status=completed or canceled updates");
    }
    // Backend hangup takes priority over an operator lock, like a real provider command.
    if (fields.Status[0] === "canceled") controller.cancel(id); else controller.hangup(id);
    return controller.resource(id);
  });

  app.server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/operator" || !localRequest(req.headers.host, req.headers.origin, req.headers["sec-fetch-site"] as string | undefined) || peers.size >= 20) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    operator.handleUpgrade(req, socket, head, (ws) => {
      const operatorId = randomUUID(); peers.set(operatorId, ws);
      send(ws, { type: "snapshot", operatorId, config: publicConfig, sessions: controller.list() });
      ws.on("error", () => {});
      ws.on("close", () => { peers.delete(operatorId); controller.releaseOperator(operatorId); });
      ws.on("message", (raw, binary) => {
        void (async () => {
          let requestId: string | null = null;
          try {
            if (binary) throw new MockError("INVALID_REQUEST", "Expected operator JSON");
            const command = operatorMessage.parse(JSON.parse(raw.toString())); requestId = command.requestId;
            controller.assertOperator(command.callSid, operatorId);
            if (command.type === "claim") controller.claim(command.callSid, operatorId);
            else if (command.type === "release") controller.release(command.callSid, operatorId);
            else {
              if (controller.view(command.callSid).operatorId !== operatorId) throw new MockError("OPERATOR_LOCKED", "Claim this call before controlling it", 409);
              if (command.type === "answer") await controller.answer(command.callSid);
              else if (command.type === "reject") controller.reject(command.callSid);
              else if (command.type === "hangup") controller.hangup(command.callSid);
              else if (command.type === "utterance") controller.injectUtterance(command.callSid, command.payload);
              else if (command.type === "interrupt") controller.interrupt(command.callSid, command.payload);
              else if (command.type === "dtmf") controller.digits(command.callSid, command.payload);
              else if (command.type === "language") controller.setLanguage(command.callSid, command.language);
              else if (command.type === "speech-status") controller.reportSpeech(command.callSid, command.code, command.message);
            }
            send(ws, { type: "ack", requestId, callSid: command.callSid });
          } catch (error) { const known = safeError(error); send(ws, { type: "error", requestId, code: known.code, message: known.message }); }
        })();
      });
    });
  });
  const assets: Record<string, [string, string]> = {
    "/": ["../../src/web/index.html", "text/html"], "/assets/styles.css": ["../../src/web/styles.css", "text/css"],
    "/assets/app.js": ["../web/app.js", "text/javascript"], "/assets/operator.js": ["../web/operator.js", "text/javascript"],
    "/assets/speech.js": ["../web/speech.js", "text/javascript"],
  };
  for (const [path, [file, mime]] of Object.entries(assets)) app.get(path, async (_req, reply) => reply.type(mime).send(await readFile(new URL(file, import.meta.url), "utf8")));
  const sweepTimer = setInterval(() => controller.sweep(), 500); sweepTimer.unref();
  app.addHook("preClose", async () => {
    clearInterval(sweepTimer); await controller.shutdown();
    for (const ws of peers.values()) ws.terminate();
    await new Promise<void>((resolve) => operator.close(() => resolve()));
    controller.off("session", onSession); controller.off("deleted", onDeleted); controller.off("log", onLog);
  });
  return { app, controller, publicConfig };
}
