import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { api } from "@callmate/contracts";
import { CommandError } from "./errors.js";
import type { Store } from "./storage.js";

const derive = promisify(scrypt);
const cookieName = "callmate_session";
const lifetimeSeconds = 12 * 60 * 60;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const cookie = (value: string, maxAge: number) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
function sessionHash(request: FastifyRequest): string {
  const tokens = (request.headers.cookie ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(cookieName + "="));
  const token = tokens.length === 1 ? tokens[0]!.slice(cookieName.length + 1) : "";
  return /^[a-f0-9]{64}$/.test(token) ? digest(token) : "";
}

export function mountAuth(app: FastifyInstance, store: Store) {
  const publicPaths = new Set<string>([api.authSession.path, api.authSetup.path, api.authLogin.path, api.authLogout.path]);
  const streams = new Map<string, Set<() => void>>();
  const valid = (hash: string) => (store.auth.session(hash) ?? 0) > Date.now();
  const state = (request: FastifyRequest) => {
    const owner = store.auth.owner(); const expiresAt = store.auth.session(sessionHash(request));
    const authenticated = !!owner && (expiresAt ?? 0) > Date.now();
    return api.authSession.response.parse({ setupRequired: !owner, authenticated,
      username: authenticated ? owner!.username : null, expiresAt: authenticated ? new Date(expiresAt!).toISOString() : null });
  };
  app.addHook("onRequest", async request => {
    const path = request.routeOptions.url ?? request.url.split("?")[0]!;
    if ((path === "/api" || path.startsWith("/api/")) && !publicPaths.has(path) && !valid(sessionHash(request))) {
      throw new CommandError(401, "UNAUTHENTICATED", "Please sign in to continue");
    }
  });
  // Revoke already-open event streams on logout and absolute session expiry.
  app.addHook("onSend", async (request, reply, payload) => {
    if (String(reply.getHeader("content-type")).startsWith("text/event-stream")) {
      const hash = sessionHash(request);
      const close = () => reply.raw.destroy();
      const listeners = streams.get(hash) ?? new Set<() => void>(); listeners.add(close); streams.set(hash, listeners);
      const timer = setInterval(() => { if (!valid(hash)) close(); }, 1000); timer.unref();
      reply.raw.once("close", () => { clearInterval(timer); listeners.delete(close); if (!listeners.size) streams.delete(hash); });
    }
    return payload;
  });
  app.get(api.authSession.path, async request => state(request));
  for (const [route, setup] of [[api.authSetup, true], [api.authLogin, false]] as const) {
    app.post(route.path, async (request, reply) => {
      if (!store.auth.consumeAttempt(Date.now())) {
        reply.header("Retry-After", "300");
        throw new CommandError(429, "AUTH_RATE_LIMITED", "Too many sign-in attempts. Try again in five minutes.");
      }
      const body = route.request.parse(request.body);
      let owner = store.auth.owner();
      if (setup && owner) throw new CommandError(409, "AUTH_ALREADY_CONFIGURED", "An owner account already exists. Sign in instead.");
      const salt = setup ? randomBytes(16).toString("hex") : owner?.salt ?? "0".repeat(32);
      const passwordHash = (await derive(body.password, salt, 64)) as Buffer;
      if (setup) {
        if (!store.auth.createOwner({ username: body.username, salt, password_hash: passwordHash.toString("hex") })) {
          throw new CommandError(409, "AUTH_ALREADY_CONFIGURED", "An owner account already exists. Sign in instead.");
        }
        owner = store.auth.owner();
      } else if (!owner || owner.username !== body.username || !timingSafeEqual(passwordHash, Buffer.from(owner.password_hash, "hex"))) {
        throw new CommandError(401, "INVALID_CREDENTIALS", "Username or password is incorrect");
      }
      const token = randomBytes(32).toString("hex"); const expiresAt = Date.now() + lifetimeSeconds * 1000;
      if (!owner || !store.auth.addSession(digest(token), expiresAt, owner)) {
        throw new CommandError(401, "INVALID_CREDENTIALS", "Account changed during sign-in. Please sign in again.");
      }
      reply.header("Set-Cookie", cookie(token, lifetimeSeconds));
      return route.response.parse({ setupRequired: false, authenticated: true, username: owner!.username, expiresAt: new Date(expiresAt).toISOString() });
    });
  }
  app.post(api.authLogout.path, async (request, reply) => {
    api.authLogout.request.parse(request.body);
    const hash = sessionHash(request); store.auth.removeSession(hash);
    for (const close of streams.get(hash) ?? []) close();
    reply.header("Set-Cookie", cookie("", 0));
    return api.authLogout.response.parse({ loggedOut: true });
  });
}
