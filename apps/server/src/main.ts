import { loadConfig } from "./config.js";
import { createRuntime } from "./server.js";

process.umask(0o077);
let runtime: ReturnType<typeof createRuntime> | undefined;
try {
  runtime = createRuntime(loadConfig(process.env));
  const shutdown = () => {
    void runtime?.close().catch(() => {
      console.error("Server shutdown failed");
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await runtime.start();
} catch {
  // Errors from native modules/filesystem/config may include private values or paths.
  console.error("Server startup failed; check configuration, data-volume permissions, migrations, and listener ports");
  await runtime?.close().catch(() => {
    console.error("Server cleanup failed");
  });
  process.exitCode = 1;
}
