import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { SimulatorScenarioSchema } from "@callmate/contracts";

const port = z.coerce.number().int().min(1).max(65535);
const localUrl = (transport: "http" | "ws", path: string) => z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === `${transport}:` && ["localhost", "127.0.0.1", "host.docker.internal", "mock-relay"].includes(url.hostname)
      && url.pathname === path && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
});
const schema = z.object({
  apiPort: port.default(3000),
  callbackPort: port.default(3001),
  dataDir: z.string().trim().min(1).refine((path) => isAbsolute(path) && resolve(path) !== "/").default("/data"),
  mode: z.enum(["simulator", "live"]).default("simulator"),
  nodeEnv: z.enum(["development", "test", "production"]).default("production"),
  telephonyProvider: z.enum(["fake", "mock"]).default("fake"),
  mockApiBase: localUrl("http", "/").default("http://host.docker.internal:8080"),
  mockOperatorOrigin: localUrl("http", "/").default("http://localhost:8080"),
  mockRelayUrl: localUrl("ws", "/ws/voice").default("ws://host.docker.internal:3001/ws/voice"),
  mockAccountSid: z.string().regex(/^AC[0-9a-f]{32}$/i).default(`AC${"0".repeat(32)}`),
  mockUsername: z.string().min(1).max(100).default("mock"),
  mockPassword: z.string().min(1).max(200).default("mock-local-only"),
  logLevel: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
  simulatorScenario: SimulatorScenarioSchema.default("within_plan"),
  simulatorStepMs: z.coerce.number().int().min(50).max(5000).default(750),
  simulatorApprovalSeconds: z.coerce.number().int().min(1).max(120).default(30),
}).refine((config) => config.apiPort !== config.callbackPort, {
  path: ["callbackPort"], message: "Listeners need separate ports",
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const result = schema.safeParse({
    apiPort: env.CALLMATE_API_PORT,
    callbackPort: env.CALLMATE_CALLBACK_PORT,
    dataDir: env.CALLMATE_DATA_DIR,
    mode: env.CALLMATE_MODE,
    nodeEnv: env.NODE_ENV,
    telephonyProvider: env.TELEPHONY_PROVIDER,
    mockApiBase: env.CALLMATE_MOCK_API_BASE,
    mockOperatorOrigin: env.CALLMATE_MOCK_OPERATOR_ORIGIN,
    mockRelayUrl: env.CALLMATE_MOCK_RELAY_URL,
    mockAccountSid: env.MOCK_ACCOUNT_SID,
    mockUsername: env.MOCK_API_USERNAME,
    mockPassword: env.MOCK_API_PASSWORD,
    logLevel: env.CALLMATE_LOG_LEVEL,
    simulatorScenario: env.CALLMATE_SIMULATOR_SCENARIO,
    simulatorStepMs: env.CALLMATE_SIMULATOR_STEP_MS,
    simulatorApprovalSeconds: env.CALLMATE_SIMULATOR_APPROVAL_SECONDS,
  });
  if (!result.success) {
    // Never include supplied environment values in diagnostics.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid server configuration fields: ${fields.join(", ")}`);
  }
  return result.data;
}
