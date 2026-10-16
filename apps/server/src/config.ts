import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { SimulatorScenarioSchema } from "@callmate/contracts";

const port = z.coerce.number().int().min(1).max(65535);
const localUrl = (transport: "http" | "ws", path: string) => z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === `${transport}:` && ["localhost", "127.0.0.1", "host.docker.internal", "mock-relay", "server", "zeus-llama"].includes(url.hostname)
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
  mockAuthToken: z.string().min(1).max(200).default("mock-auth-token-local-only"),
  silenceTimeoutSeconds: z.coerce.number().int().min(5).max(600).default(60),
  testRateMinorPerMinute: z.coerce.number().int().min(1).max(60000).optional(),
  dialogueProvider: z.enum(["disabled", "openai", "codex", "anthropic"]).default("disabled"),
  dialogueModel: z.string().trim().min(1).max(200).regex(/^\S+$/).optional(),
  openaiApiKey: z.string().trim().min(1).regex(/^\S+$/).optional(),
  anthropicApiKey: z.string().trim().min(1).regex(/^\S+$/).optional(),
  llmSecretsDir: z.string().refine(isAbsolute).optional(),
  llmMasterKeyFile: z.string().refine(isAbsolute).optional(),
  dialogueTimeoutMs: z.coerce.number().int().min(1).max(60000).default(10000),
  logLevel: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
  simulatorScenario: SimulatorScenarioSchema.default("within_plan"),
  simulatorStepMs: z.coerce.number().int().min(50).max(5000).default(750),
  simulatorApprovalSeconds: z.coerce.number().int().min(1).max(120).default(30),
}).refine((config) => config.dialogueProvider === "disabled" || (
  (config.dialogueProvider === "codex" || (!!config.dialogueModel && !!(config.dialogueProvider === "anthropic" ? config.anthropicApiKey : config.openaiApiKey)))
  && config.mode === "simulator" && config.telephonyProvider === "mock" && config.nodeEnv !== "production"), {
  path: ["dialogueProvider"], message: "Dialogue needs a configured engine and development mock mode",
}).refine((config) => config.apiPort !== config.callbackPort
  || (config.nodeEnv === "test" && config.apiPort === 0 && config.callbackPort === 0), {
  path: ["callbackPort"], message: "Listeners need separate ports",
});

export type Config = z.infer<typeof schema>;

/** In-process tests may bind ephemeral ports; environment-loaded ports still require 1–65535. */
export function configurationValid(config: Config): boolean {
  return schema.safeExtend({ apiPort: port.or(z.literal(0)), callbackPort: port.or(z.literal(0)) })
    .refine((value) => value.nodeEnv === "test" || (value.apiPort !== 0 && value.callbackPort !== 0))
    .safeParse(config).success;
}

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
    mockAuthToken: env.MOCK_AUTH_TOKEN,
    silenceTimeoutSeconds: env.CALLMATE_SILENCE_TIMEOUT_SECONDS,
    testRateMinorPerMinute: env.CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE === "" ? undefined : env.CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE,
    dialogueProvider: env.CALLMATE_DIALOGUE_PROVIDER,
    dialogueModel: env.CALLMATE_DIALOGUE_MODEL || undefined,
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    llmSecretsDir: env.CALLMATE_LLM_SECRETS_DIR || undefined,
    llmMasterKeyFile: env.CALLMATE_LLM_MASTER_KEY_FILE || undefined,
    dialogueTimeoutMs: env.CALLMATE_DIALOGUE_TIMEOUT_MS,
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
