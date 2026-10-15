import { z } from "zod";

const flag = z.enum(["true", "false"]).transform((value) => value === "true");
const language = z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  MOCK_ACCOUNT_SID: z.string().regex(/^AC[0-9a-f]{32}$/i).default(`AC${"0".repeat(32)}`),
  MOCK_API_USERNAME: z.string().min(1).max(100).default("mock"),
  MOCK_API_PASSWORD: z.string().min(1).max(200).default("mock-local-only"),
  CALLMATE_WS_URL: z.string().default("ws://host.docker.internal:3001/ws/voice"),
  CALLMATE_TWIML_URL: z.string().default("http://host.docker.internal:3001/twiml"),
  DEFAULT_LANGUAGE: language.default("pl-PL"), DEFAULT_FROM: z.string().min(1).max(100).default("+48000000000"),
  DEFAULT_TO: z.string().min(1).max(100).default("+48111111111"),
  AUTO_ANSWER: flag.default(false), ENABLE_BROWSER_SPEECH: flag.default(true),
  MAX_ACTIVE_CALLS: z.coerce.number().int().min(1).max(20).default(5),
  CALL_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(3600).default(300),
  BACKEND_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2500),
  SESSION_RETENTION_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  LOG_LEVEL: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
  ALLOWED_BACKEND_HOSTS: z.string().default("host.docker.internal,localhost,127.0.0.1"),
});
export type Config = z.infer<typeof envSchema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) throw new Error(`Invalid mock configuration: ${result.error.issues.map((item) => item.path.join(".")).join(", ")}`);
  const config = result.data;
  backendUrl(config.CALLMATE_WS_URL, config, "ws"); backendUrl(config.CALLMATE_TWIML_URL, config, "http");
  return config;
}
export class MockError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export function backendUrl(value: string, config: Config, transport: "ws" | "http"): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new MockError("INVALID_REQUEST", "Invalid backend URL"); }
  const allowed = config.ALLOWED_BACKEND_HOSTS.split(",").map((host) => host.trim().toLowerCase());
  if (!(transport === "ws" ? ["ws:", "wss:"] : ["http:", "https:"]).includes(url.protocol)
    || !allowed.includes(url.hostname.toLowerCase()) || url.username || url.password || url.hash
    || [...url.searchParams.keys()].some((key) => /token|secret|pass|api.?key|credential|auth/i.test(key))) {
    throw new MockError("INVALID_REQUEST", "Backend URL violates the configured host/transport allowlist");
  }
  return url;
}
export { language };
