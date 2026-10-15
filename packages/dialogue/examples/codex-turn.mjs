import { randomUUID } from "node:crypto";
import { DialogueInputSchema } from "@callmate/contracts";
import { createDialogue, createCodexModelClient, DialogueError, CodexModelError } from "../dist/index.js";

// One text-only turn using saved ChatGPT login. Never dials or books anything.
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
let modelFailure = null;
try {
  const model = createCodexModelClient({
    ...(process.env.CODEX_PATH ? { executable: process.env.CODEX_PATH } : {}),
    ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
  });
  const diagnosticModel = { async generate(input, signal) {
    try { return await model.generate(input, signal); }
    catch (error) {
      if (error instanceof CodexModelError) modelFailure = error.code;
      throw error;
    }
  } };
  process.stdin.setEncoding("utf8");
  let source = "";
  for await (const chunk of process.stdin) source += chunk;
  const input = DialogueInputSchema.parse(JSON.parse(source));
  const reserved = input.offer
    ? { offerId: input.offer.id, offerVersion: input.offer.version + 1 }
    : { offerId: randomUUID(), offerVersion: 1 };
  const dialogue = createDialogue(diagnosticModel, { timeoutMs: 60_000, offerIdentitySource: () => reserved });
  const proposal = await dialogue.propose(input, controller.signal);
  process.stdout.write(`${JSON.stringify(proposal, null, 2)}\n`);
} catch (error) {
  process.stderr.write(error instanceof DialogueError
    ? `Dialogue failed: ${error.code}\n`
    : "Invalid input or configuration. Supply DialogueInput JSON on stdin.\n");
  if (modelFailure) {
    process.stderr.write(`Codex: ${modelFailure}\n`);
    const hints = {
      cli_unavailable: "Install Codex CLI and put codex on PATH, or set CODEX_PATH to its executable.",
      cli_failed: "Check codex --version and codex login status. Sign in with ChatGPT using codex login. Check subscription limits and network access; API-key fallback is disabled.",
      invalid_response: "Codex did not return a valid dialogue proposal; no response was accepted.",
      timeout: "Codex exceeded the 60-second deadline.",
    };
    if (hints[modelFailure]) process.stderr.write(`${hints[modelFailure]}\n`);
  } else if (error instanceof DialogueError && error.code === "timeout") {
    process.stderr.write("Codex exceeded the 60-second dialogue deadline.\n");
  }
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
}
