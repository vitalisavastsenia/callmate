import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import { AttemptParamsSchema, EventCursorSchema, IdSchema, api } from "@callmate/contracts";
import { CommandError, parseRequest } from "./errors.js";
import type { CallController } from "./call-controller.js";

export function callRoutes(app: FastifyInstance, controller: CallController) {
  const streams = new Set<PassThrough>();
  // Fastify otherwise waits for indefinitely open SSE responses during shutdown.
  app.addHook("preClose", async () => {
    for (const stream of streams) {
      stream.end();
      const forceClose = setTimeout(() => stream.destroy(), 1000);
      forceClose.unref();
      stream.once("close", () => clearTimeout(forceClose));
    }
  });
  const attemptId = (params: unknown) => parseRequest(AttemptParamsSchema, params).attemptId;
  const key = (headers: Record<string, unknown>) => parseRequest(IdSchema, headers["idempotency-key"]);
  app.post(api.createPlan.path, async (request, reply) => reply.code(201).send(api.createPlan.response.parse({
    plan: controller.createPlan(parseRequest(api.createPlan.request, request.body)),
  })));
  app.post(api.startCall.path, async (request, reply) => reply.code(202).send(api.startCall.response.parse({
    call: await controller.start(parseRequest(api.startCall.request, request.body), key(request.headers)),
  })));
  app.get(api.getCall.path, async (request) => api.getCall.response.parse({ call: controller.get(attemptId(request.params)) }));
  app.post(api.stopCall.path, async (request, reply) => {
    parseRequest(api.stopCall.request, request.body);
    return reply.code(202).send(api.stopCall.response.parse({ call: await controller.stop(attemptId(request.params)) }));
  });
  app.post(api.decideApproval.path, async (request) => api.decideApproval.response.parse({
    call: controller.decide(attemptId(request.params), parseRequest(api.decideApproval.request, request.body), key(request.headers)),
  }));
  app.get(api.history.path, async (request) => {
    const query = parseRequest(api.history.query, request.query);
    return api.history.response.parse(controller.history(query.limit, query.cursor));
  });
  app.delete(api.deleteConversation.path, async (request) =>
    api.deleteConversation.response.parse(controller.deleteConversation(attemptId(request.params))));
  app.delete(api.deleteAgreement.path, async (request) =>
    api.deleteAgreement.response.parse({ call: controller.deleteAgreement(attemptId(request.params)) }));
  app.get(api.events.path, async (request, reply) => {
    const id = attemptId(request.params);
    controller.get(id); // Return structured errors before opening the stream.
    const parsed = EventCursorSchema.safeParse(request.headers["last-event-id"] ?? "0");
    if (!parsed.success) throw new CommandError(400, "EVENT_CURSOR_INVALID", "Event cursor must be a nonnegative integer");
    let cursor = parsed.data;
    const stream = new PassThrough();
    streams.add(stream);
    const write = (text: string) => {
      if (stream.destroyed || stream.writableEnded) return false;
      // Bound memory for a disconnected/slow consumer; it can reconnect using persisted events.
      if (stream.writableLength + stream.readableLength > 256 * 1024) { stream.destroy(); return false; }
      return !stream.destroyed && stream.write(text);
    };
    const drain = () => {
      if (stream.destroyed || stream.writableEnded) return;
      const events = controller.replayEvents(id, cursor);
      if (events === null) {
        write('event: reset\ndata: {"reason":"snapshot_required"}\n\n');
        stream.end();
        return;
      }
      for (const event of events) {
        write(`id: ${event.sequence}\nevent: callmate\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = event.sequence;
      }
    };
    // There are no awaits between subscription, replay and tail setup, so no transition can slip through.
    const unsubscribe = controller.observe(id, drain);
    const heartbeat = setInterval(() => { write(": heartbeat\n\n"); }, 15_000);
    heartbeat.unref();
    const cleanup = () => { clearInterval(heartbeat); unsubscribe(); streams.delete(stream); };
    stream.once("close", cleanup);
    request.raw.once("aborted", () => stream.destroy());
    reply.raw.once("close", () => stream.destroy());
    write(": connected\n\n");
    drain();
    return reply.header("Content-Type", "text/event-stream; charset=utf-8")
      .header("X-Accel-Buffering", "no").send(stream);
  });
}
