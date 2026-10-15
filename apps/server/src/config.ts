import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { SimulatorScenarioSchema } from "@callmate/contracts";

const port = z.coerce.number().int().min(1).max(65535);
const schema = z.object({
  apiPort: port.default(3000),
  callbackPort: port.default(3001),
  dataDir: z.string().trim().min(1).refine((path) => isAbsolute(path) && resolve(path) !== "/").default("/data"),
  mode: z.enum(["simulator", "live"]).default("simulator"),
  nodeEnv: z.enum(["development", "test", "production"]).default("production"),
  telephonyProvider: z.enum(["fake", "mock"]).default("fake"),
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
