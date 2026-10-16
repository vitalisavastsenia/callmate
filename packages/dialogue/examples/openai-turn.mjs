import { randomUUID } from "node:crypto";
import { DialogueInputSchema } from "@callmate/contracts";
import { createDialogue, createOpenAIModelClient, DialogueError, OpenAIModelError } from "../dist/index.js";

// One local text-only turn. This example never dials, plays speech, or books anything.
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
let modelFailure = null;
try {
  const model = createOpenAIModelClient({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL });
  // Keep provider diagnostics local to this command. DialoguePort intentionally
  // exposes only model_failed to callers; never attach a raw provider error there.
  const diagnosticModel = { async generate(input, signal) {
    try { return await model.generate(input, signal); }
    catch (error) {
      if (error instanceof OpenAIModelError) {
        modelFailure = { code: error.code, status: error.status, providerCode: error.providerCode };
      }
      throw error;
    }
  } };
  process.stdin.setEncoding("utf8");
  let source = "";
  for await (const chunk of process.stdin) source += chunk;
  const input = DialogueInputSchema.parse(JSON.parse(source));
  // Stand in for controller reservation before requesting the model, with a pure lookup.
  const reserved = input.offer
    ? { offerId: input.offer.id, offerVersion: input.offer.version + 1 }
    : { offerId: randomUUID(), offerVersion: 1 };
  const dialogue = createDialogue(diagnosticModel, { offerIdentitySource: () => reserved });
  const proposal = await dialogue.propose(input, controller.signal);
  process.stdout.write(`${JSON.stringify(proposal, null, 2)}\n`);
} catch (error) {
  process.stderr.write(error instanceof DialogueError
    ? `Dialogue failed: ${error.code}\n`
    : "Invalid input or configuration. Supply DialogueInput JSON on stdin and OPENAI_API_KEY/OPENAI_MODEL.\n");
  if (error instanceof DialogueError && error.code === "model_failed" && modelFailure) {
    const { code, status, providerCode } = modelFailure;
    process.stderr.write(`OpenAI: ${code}${status === null ? "" : ` (HTTP ${status})`}\n`);
    if (providerCode) process.stderr.write(`API code: ${providerCode}\n`);
    const providerHints = {
      insufficient_quota: "API quota is unavailable. Check API billing credits and usage/spending limits before retrying.",
      credit_balance_exhausted: "API prepaid credits are exhausted. Add credits in API billing before retrying.",
      billing_hard_limit_reached: "The API billing limit has been reached. Check API billing limits before retrying.",
      organization_spend_limit_exceeded: "The organization spending limit has been reached. Check API organization limits before retrying.",
      project_spend_limit_exceeded: "The project spending limit has been reached. Check API project limits before retrying.",
      organization_usage_limit_exceeded: "The organization usage limit has been reached. Check API organization limits before retrying.",
      usage_limit_exceeded: "An API usage limit has been reached. Check API billing and limits before retrying.",
      rate_limit_exceeded: "Temporary API rate limit reached. Wait at least Retry-After when provided, then reduce the request rate.",
      slow_down: "Request rate increased too quickly. Wait at least Retry-After when provided, then reduce the request rate.",
    };
    const httpHints = {
      400: "Check OPENAI_MODEL support for Responses/Structured Outputs and the request settings.",
      401: "Check OPENAI_API_KEY: use an active OpenAI API key, not a Codex CLI login. An exported environment variable overrides .env.",
      403: "Check the API key's project permissions and model access.",
      404: "Check OPENAI_MODEL: the model may be unavailable or inaccessible to this API project.",
      429: "Check API credits, project spending limits, and request rate limits before retrying.",
    };
    const codeHints = {
      request_failed: "Check network access to api.openai.com, proxy settings, and TLS certificates.",
      incomplete: "The model did not finish. Check the output-token limit, including reasoning tokens.",
      refused: "The model refused the request; no dialogue proposal was accepted.",
      invalid_response: "The API response was not a completed, valid dialogue proposal.",
      timeout: "The API request exceeded its deadline.",
    };
    const hint = providerHints[providerCode] ?? httpHints[status]
      ?? (status >= 500 ? "The API returned a server error. Try again later." : codeHints[code]);
    if (hint) process.stderr.write(`${hint}\n`);
  }
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
}
