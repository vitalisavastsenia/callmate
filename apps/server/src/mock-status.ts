import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import type { DevelopmentConversations } from "./development-conversations.js";
import { CommandError } from "./errors.js";
import { mockRelayEnabled } from "./mock-relay.js";

/** Official form-encoded progress events, restricted to the signed local mock path. */
export function mountMockStatus(app: FastifyInstance, config: Config, conversations: DevelopmentConversations) {
  app.register(async (routes) => {
    routes.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
      try {
        const form = new URLSearchParams(body as string);
        const fields: Record<string, string> = Object.create(null);
        for (const [key, value] of form) {
          if (Object.hasOwn(fields, key) || Object.keys(fields).length >= 50) throw new Error();
          fields[key] = value;
        }
        done(null, fields);
      } catch { done(new CommandError(400, "INVALID_REQUEST", "Invalid callback form")); }
    });
    routes.post("/callbacks/mock/status/:id", { bodyLimit: 16_384, onRequest: async (request, reply) => {
      if (!mockRelayEnabled(config)) return reply.code(404).send();
      if (request.headers["x-callmate-mock"] !== "true" || request.headers.origin !== undefined
        || request.headers["sec-fetch-site"] !== undefined) return reply.code(403).send();
    } }, async (request, reply) => {
      if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") {
        throw new CommandError(400, "INVALID_REQUEST", "Mock callbacks require form encoding");
      }
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const signature = request.headers["x-twilio-signature"];
      conversations.receiveStatus(id, request.body as Record<string, string>, typeof signature === "string" ? signature : "",
        { path: request.raw.url ?? "", host: request.headers.host ?? "" });
      return reply.code(204).send();
    });
  });
}
