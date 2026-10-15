import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

const port = z.coerce.number().int().min(1).max(65535);
const schema = z.object({
  apiPort: port.default(3000),
  callbackPort: port.default(3001),
  dataDir: z.string().trim().min(1).refine((path) => isAbsolute(path) && resolve(path) !== "/").default("/data"),
  mode: z.enum(["simulator", "live"]).default("simulator"),
  logLevel: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
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
    logLevel: env.CALLMATE_LOG_LEVEL,
  });
  if (!result.success) {
    // Never include supplied environment values in diagnostics.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid server configuration fields: ${fields.join(", ")}`);
  }
  return result.data;
}
