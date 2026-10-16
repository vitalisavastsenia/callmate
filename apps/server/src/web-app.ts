import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

/** The built UI and private API share one listener, session cookie and process. */
export function mountWebApp(app: FastifyInstance, root = fileURLToPath(new URL("../../web/dist/", import.meta.url))) {
  app.register(fastifyStatic, {
    root: join(root, "assets"), prefix: "/assets/", index: false, dotfiles: "deny",
    setHeaders: (reply, path) => {
      reply.header("Cache-Control", path === join(root, "index.html") ? "no-store" : "public, max-age=31536000, immutable");
    },
  });
  app.get("/", async (_request, reply) => {
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'")
      .header("Referrer-Policy", "no-referrer").header("Cache-Control", "no-store");
    return reply.sendFile("index.html", root, { cacheControl: false });
  });
}
