import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import Fastify, { LogController } from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiErrorSchema, ReadinessSchema, SettingsSchema, api } from "@callmate/contracts";
import { z } from "zod";
import type { Config } from "./config.js";
import { openStore } from "./storage.js";
import type { Store } from "./storage.js";
import { CommandError } from "./errors.js";
import { CallController } from "./call-controller.js";
import { callRoutes } from "./call-routes.js";
import { Simulator } from "./simulator.js";
import type { SimulatorOptions } from "./simulator.js";
import { mockRelayEnabled, mountMockRelay } from "./mock-relay.js";
import { DevelopmentConversations, mountDevelopmentConsole } from "./development-conversations.js";
import { mountMockStatus } from "./mock-status.js";

type ErrorCode = z.infer<typeof ApiErrorSchema>["error"]["code"];
function fail(reply: FastifyReply, request: FastifyRequest, status: number, code: ErrorCode, message: string,
  details: { path: string; message: string }[] = []) {
  return reply.code(status).send(ApiErrorSchema.parse({ error: { code, message, requestId: request.id, details } }));
}

function createListener(config: Config, stream?: Writable) {
  const app = Fastify({
    bodyLimit: 64 * 1024,
    requestTimeout: 10_000,
    trustProxy: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: config.logLevel,
      ...(stream ? { stream } : {}),
      redact: { paths: ["req.headers", "req.body", "req.query", "body", "headers", "config", "*.password", "*.token"], censor: "[REDACTED]" },
      serializers: {
        req: (request) => ({ method: request.method }),
        res: (reply) => ({ statusCode: reply.statusCode }),
        err: () => ({ type: "Error", message: "[REDACTED]", stack: "[REDACTED]" }),
      },
    },
  });
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
  });
  app.addHook("onResponse", async (request, reply) => {
    // Allowlist metadata: never log URLs, headers, body, transcript, config or exception values.
    request.log.info({ method: request.method, statusCode: reply.statusCode }, "Request completed");
  });
  app.setNotFoundHandler((request, reply) => fail(reply, request, 404, "NOT_FOUND", "Route not found"));
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof CommandError) return fail(reply, request, error.status, error.code, error.message);
    if (error instanceof z.ZodError) {
      return fail(reply, request, 400, "INVALID_REQUEST", "Request validation failed",
        error.issues.map((issue) => ({ path: issue.path.join("."), message: "Invalid value" })));
    }
    if (typeof error === "object" && error !== null && "statusCode" in error
      && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      return fail(reply, request, 400, "INVALID_REQUEST", "Invalid request format");
    }
    request.log.error({ code: "INTERNAL_ERROR" }, "Request failed");
    return fail(reply, request, 500, "INTERNAL_ERROR", "The server could not complete this request");
  });
  return app;
}

function privateRoutes(app: FastifyInstance, config: Config, store: Store, controller: CallController) {
  app.addHook("onRequest", async (request, reply) => {
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : config.apiPort;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origins = hosts.map((host) => `http://${host}`);
    if (!hosts.includes(request.headers.host ?? "")
      || (request.headers.origin !== undefined && !origins.includes(request.headers.origin))
      || request.headers["sec-fetch-site"] === "cross-site") {
      return fail(reply, request, 400, "INVALID_REQUEST", "Private API requires a local request origin");
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)
      && request.method !== "DELETE"
      && request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return fail(reply, request, 400, "INVALID_REQUEST", "Commands require application/json");
    }
  });

  app.get("/health", async () => { store.check(); return { status: "ok" }; });
  app.get(api.readiness.path, async () => {
    store.check();
    return ReadinessSchema.parse({
      mode: config.mode, ready: config.mode === "simulator", voiceEngine: null,
      checks: [
        { name: "storage", status: "ready", message: "SQLite migrations applied and storage available" },
        { name: "telephony", status: config.mode === "simulator" ? "ready" : "missing",
          message: config.mode === "simulator" ? "Fake telephony only; cannot dial" : "Live telephony is not implemented" },
        { name: "voice", status: config.mode === "simulator" ? "not_required" : "missing",
          message: mockRelayEnabled(config) ? "Development mock relay available at /ws/voice; scripted echo only"
            : config.mode === "simulator" ? "Simulated text playback; no audio provider" : "Live voice is not implemented" },
        { name: "dialogue", status: config.mode === "simulator" ? "ready" : "missing",
          message: config.mode === "simulator" ? "Deterministic scripted dialogue; no model requests" : "Live dialogue is not implemented" },
        { name: "tunnel", status: config.mode === "simulator" ? "not_required" : "missing",
          message: config.mode === "simulator" ? "Simulator mode needs no public tunnel" : "Live tunnel connectivity has not been verified" },
      ],
    });
  });
  app.get(api.getSettings.path, async () => SettingsSchema.parse(store.getSettings()));
  app.put(api.updateSettings.path, async (request) => store.setSettings(SettingsSchema.parse(request.body)));
  callRoutes(app, controller);
}

export function createRuntime(config: Config, logStream?: Writable, simulatorOptions?: SimulatorOptions) {
  const store = openStore(config.dataDir);
  const privateApi = createListener(config, logStream);
  const callbacks = createListener(config, logStream);
  const simulator = new Simulator(config, store, simulatorOptions);
  const development = new DevelopmentConversations(config, store);
  const controller = new CallController(store, simulator, development);
  mountMockStatus(callbacks, config, development);
  mountMockRelay(callbacks, config, () => store.getSettings().defaultCallLimits.maxDurationSeconds,
    (setup, send, disconnect) => development.attach(setup, send, disconnect));
  privateRoutes(privateApi, config, store, controller);
  mountDevelopmentConsole(privateApi, development);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try { await development.close(); await simulator.close(); await Promise.all([privateApi.close(), callbacks.close()]); }
    finally { store.close(); }
  })();
  return {
    privateApi, callbacks, simulator, controller, close,
    async start() {
      try {
        await privateApi.listen({ host: "0.0.0.0", port: config.apiPort });
        await callbacks.listen({ host: "0.0.0.0", port: config.callbackPort });
        await development.recover();
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
}
