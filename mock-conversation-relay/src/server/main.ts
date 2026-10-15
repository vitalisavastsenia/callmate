import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
try {
  const config = loadConfig();
  const { app } = createApp(config);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    await app.close();
  };
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (error) { process.stderr.write(error instanceof Error ? error.message + "\n" : "Mock service failed\n"); process.exitCode = 1; }
