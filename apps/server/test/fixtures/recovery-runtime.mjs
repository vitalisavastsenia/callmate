// Separate process so recovery checks can SIGKILL without running graceful shutdown.
import { createRuntime } from "../../dist/server.js";

const runtime = createRuntime(JSON.parse(process.env.CALLMATE_TEST_CONFIG));
await runtime.start();
process.send({ api: `http://127.0.0.1:${runtime.privateApi.server.address().port}`,
  relay: `ws://127.0.0.1:${runtime.callbacks.server.address().port}/ws/voice` });
