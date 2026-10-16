import { DialogueProposalSchema, LlmEffortSchema, type DialogueInput, type DialogueProposal, type LlmEffort } from "@callmate/contracts";
import { parseInput } from "../planner/validation.js";
import type { ModelClient } from "./client.js";
import { instructionsFor } from "./instructions.js";

// Claude accepts optional fields. Keep them optional to stay within its union
// complexity limit; unlike OpenAI, do not add a nullable union to every property.
function apiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(apiSchema);
  if (!value || typeof value !== "object") return value;
  const constraints = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "pattern", "format"];
  const entries = Object.entries(value);
  const result = Object.fromEntries(entries.filter(([key]) => key !== "$schema" && !constraints.includes(key))
    .map(([key, child]) => [key === "oneOf" ? "anyOf" : key, apiSchema(child)]));
  const removed = entries.filter(([key]) => constraints.includes(key));
  if (removed.length) result.description = `${result.description ?? ""} Constraints validated by the application: ${JSON.stringify(Object.fromEntries(removed))}`.trim();
  return result;
}
const dialogueResponseSchema = apiSchema(DialogueProposalSchema.toJSONSchema({ io: "input" }));

export type AnthropicModelOptions = {
  apiKey: string; model: string; effort?: Exclude<LlmEffort, "default">;
  timeoutMs?: number; maxOutputTokens?: number; fetch?: typeof globalThis.fetch;
};
export class AnthropicModelError extends Error {
  constructor(public readonly code: "request_failed" | "http_error" | "invalid_response" | "refused" | "incomplete" | "cancelled" | "timeout",
    public readonly status: number | null = null) {
    super(`Claude dialogue request failed (${code}).`); this.name = "AnthropicModelError";
  }
}
const invalid = (): never => { throw new AnthropicModelError("invalid_response"); };
function parseResponse(raw: unknown): DialogueProposal {
  if (!raw || typeof raw !== "object") return invalid();
  const value = raw as Record<string, unknown>;
  if (value.stop_reason === "refusal") throw new AnthropicModelError("refused");
  if (value.stop_reason === "max_tokens") throw new AnthropicModelError("incomplete");
  if (value.type !== "message" || value.role !== "assistant" || value.stop_reason !== "end_turn" || !Array.isArray(value.content)) return invalid();
  const texts: string[] = [];
  for (const block of value.content) {
    if (!block || typeof block !== "object") return invalid();
    if (block.type === "thinking" || block.type === "redacted_thinking") continue;
    if (block.type !== "text" || typeof block.text !== "string") return invalid();
    texts.push(block.text);
  }
  if (texts.length !== 1) return invalid();
  let proposal: unknown;
  try { proposal = JSON.parse(texts[0]!); } catch { return invalid(); }
  const result = DialogueProposalSchema.safeParse(proposal);
  return result.success ? result.data : invalid();
}

/** Fixed HTTPS endpoint, no redirects, tools, retries or provider fallback. */
export class AnthropicModelClient implements ModelClient {
  #options: AnthropicModelOptions;
  constructor(options: AnthropicModelOptions) {
    if (!options?.apiKey?.trim() || /\s/u.test(options.apiKey.trim())) throw new TypeError("A Claude API key is required.");
    if (!options.model?.trim() || /\s/u.test(options.model.trim())) throw new TypeError("An explicit Claude model ID is required.");
    if (options.effort !== undefined && (!LlmEffortSchema.safeParse(options.effort).success || options.effort as string === "default")) throw new TypeError("Invalid effort.");
    const timeoutMs = options.timeoutMs ?? 10_000, maxOutputTokens = options.maxOutputTokens ?? 4096;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new RangeError("Invalid Claude timeout.");
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 128_000) throw new RangeError("Invalid Claude output limit.");
    this.#options = { ...options, apiKey: options.apiKey.trim(), model: options.model.trim(), timeoutMs, maxOutputTokens };
  }
  async generate(raw: DialogueInput, signal: AbortSignal): Promise<DialogueProposal> {
    if (signal.aborted) throw new AnthropicModelError("cancelled");
    const input = parseInput(raw); const options = this.#options;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), options.timeoutMs);
    const checkAbort = () => {
      if (signal.aborted) throw new AnthropicModelError("cancelled");
      if (deadline.signal.aborted) throw new AnthropicModelError("timeout");
    };
    try {
      const response = await (options.fetch ?? globalThis.fetch)("https://api.anthropic.com/v1/messages", {
        method: "POST", redirect: "error", signal: AbortSignal.any([signal, deadline.signal]),
        headers: { "x-api-key": options.apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model: options.model, max_tokens: options.maxOutputTokens, stream: false,
          system: instructionsFor(input), messages: [{ role: "user", content: JSON.stringify(input) }],
          thinking: { type: "adaptive" },
          output_config: { ...(options.effort ? { effort: options.effort } : {}), format: { type: "json_schema", schema: dialogueResponseSchema } } }),
      });
      checkAbort();
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new AnthropicModelError("http_error", response.status); }
      const reader = response.body?.getReader(); if (!reader) return invalid();
      let text = "", bytes = 0; const decoder = new TextDecoder();
      try {
        while (true) {
          const part = await reader.read(); checkAbort();
          if (part.done) { text += decoder.decode(); break; }
          bytes += part.value.byteLength; if (bytes > 1_048_576) return invalid();
          text += decoder.decode(part.value, { stream: true });
        }
      } finally { try { await reader.cancel(); } catch { /* Preserve failure. */ } reader.releaseLock(); }
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { return invalid(); }
      return parseResponse(payload);
    } catch (error) {
      checkAbort();
      if (error instanceof AnthropicModelError) throw error;
      throw new AnthropicModelError("request_failed");
    } finally { clearTimeout(timer); }
  }
}
export function createAnthropicModelClient(options: AnthropicModelOptions): ModelClient { return new AnthropicModelClient(options); }
