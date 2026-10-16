import { DialogueProposalSchema, LlmEffortSchema, type LlmEffort, type DialogueInput, type DialogueProposal } from "@callmate/contracts";
import { parseInput } from "../planner/validation.js";
import type { ModelClient } from "./client.js";
import { instructionsFor } from "./instructions.js";
import { dialogueResponseSchema } from "./response-schema.js";

export type OpenAIModelOptions = {
  apiKey: string;
  /** Explicit API model ID, e.g. a Codex model with Responses/Structured Outputs support. */
  model: string;
  effort?: Exclude<LlmEffort, "default">;
  timeoutMs?: number;
  maxOutputTokens?: number;
  /** Server-owned transport injection for offline tests; must honor AbortSignal. */
  fetch?: typeof globalThis.fetch;
};

export type OpenAIModelErrorCode =
  | "request_failed" | "http_error" | "invalid_response" | "refused" | "incomplete" | "cancelled" | "timeout";

const providerCodes = [
  "invalid_api_key", "model_not_found", "invalid_json_schema", "unsupported_parameter", "unsupported_value",
  "context_length_exceeded", "insufficient_quota", "credit_balance_exhausted", "billing_hard_limit_reached",
  "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded",
  "usage_limit_exceeded", "rate_limit_exceeded", "slow_down", "server_is_overloaded",
] as const;
export type OpenAIProviderErrorCode = typeof providerCodes[number];

const safeProviderCode = (value: unknown): OpenAIProviderErrorCode | null =>
  typeof value === "string" && providerCodes.includes(value as OpenAIProviderErrorCode)
    ? value as OpenAIProviderErrorCode : null;

/** Fixed messages only: provider bodies, credentials, and abort reasons stay private. */
export class OpenAIModelError extends Error {
  readonly providerCode: OpenAIProviderErrorCode | null;
  constructor(public readonly code: OpenAIModelErrorCode, public readonly status: number | null = null,
    providerCode: unknown = null) {
    super(`OpenAI dialogue request failed (${code}).`);
    this.name = "OpenAIModelError";
    this.providerCode = safeProviderCode(providerCode);
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (): never => { throw new OpenAIModelError("invalid_response"); };

async function httpFailure(response: Response): Promise<OpenAIModelError> {
  let providerCode: unknown = null;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      const decoder = new TextDecoder();
      let text = "", bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          const payload: unknown = JSON.parse(text + decoder.decode());
          if (object(payload) && object(payload.error)) providerCode = payload.error.code;
          break;
        }
        bytes += value.byteLength;
        if (bytes > 16_384) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      // Non-JSON, oversized, interrupted, or unreadable errors still retain HTTP status.
    } finally {
      try { await reader.cancel(); } catch { /* Preserve the sanitized HTTP error. */ }
      reader.releaseLock();
    }
  }
  // Only recognized literal codes leave this function. Never retain raw messages/bodies.
  return new OpenAIModelError("http_error", response.status, providerCode);
}

function parseResponse(raw: unknown): DialogueProposal {
  if (!object(raw)) return invalid();
  if (raw.status === "incomplete") throw new OpenAIModelError("incomplete");
  if (raw.status !== "completed" || raw.error != null || !Array.isArray(raw.output)) return invalid();
  const messages: string[] = [];
  for (const item of raw.output) {
    if (!object(item)) return invalid();
    if (item.type === "reasoning") continue;
    // Never execute or accept tool calls. Only a completed assistant answer is usable.
    if (item.type !== "message" || item.role !== "assistant" || item.status !== "completed"
      || !Array.isArray(item.content)) return invalid();
    let text = "";
    for (const part of item.content) {
      if (!object(part)) return invalid();
      if (part.type === "refusal") throw new OpenAIModelError("refused");
      if (part.type !== "output_text" || typeof part.text !== "string") return invalid();
      text += part.text;
    }
    if (item.phase === "commentary") continue;
    if (item.phase != null && item.phase !== "final_answer") return invalid();
    messages.push(text);
  }
  if (messages.length !== 1) return invalid();
  let proposal: unknown;
  try { proposal = JSON.parse(messages[0]!); } catch { return invalid(); }
  const parsed = DialogueProposalSchema.safeParse(proposal);
  if (!parsed.success) return invalid();
  return parsed.data;
}

/** Stateless server adapter. Construction/import performs no I/O; one POST per turn. */
export class OpenAIModelClient implements ModelClient {
  #apiKey: string;
  #model: string;
  #fetch: typeof globalThis.fetch;
  #timeoutMs: number;
  #maxOutputTokens: number;
  #effort: OpenAIModelOptions["effort"];

  constructor(options: OpenAIModelOptions) {
    if (typeof options?.apiKey !== "string" || !options.apiKey.trim() || /\s/u.test(options.apiKey.trim())) {
      throw new TypeError("An OpenAI API key is required in server configuration.");
    }
    if (typeof options.model !== "string" || !options.model.trim() || /\s/u.test(options.model.trim())) {
      throw new TypeError("An explicit OpenAI API model ID is required.");
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    const maxOutputTokens = options.maxOutputTokens ?? 4096;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new RangeError("OpenAI timeoutMs must be an integer from 1 to 60000.");
    }
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 128_000) {
      throw new RangeError("OpenAI maxOutputTokens must be an integer from 1 to 128000.");
    }
    if (typeof (options.fetch ?? globalThis.fetch) !== "function") throw new TypeError("A fetch transport is required.");
    this.#apiKey = options.apiKey.trim();
    if (options.effort !== undefined && (!LlmEffortSchema.safeParse(options.effort).success || options.effort as string === "default")) throw new TypeError("Invalid reasoning effort.");
    this.#effort = options.effort;
    this.#model = options.model.trim();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = timeoutMs;
    this.#maxOutputTokens = maxOutputTokens;
  }

  async generate(raw: DialogueInput, signal: AbortSignal): Promise<DialogueProposal> {
    if (signal.aborted) throw new OpenAIModelError("cancelled");
    const input = parseInput(raw);
    const deadline = new AbortController();
    const transportSignal = AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), this.#timeoutMs);
    const checkAbort = () => {
      if (signal.aborted) throw new OpenAIModelError("cancelled");
      if (deadline.signal.aborted) throw new OpenAIModelError("timeout");
    };
    try {
      const response = await this.#fetch("https://api.openai.com/v1/responses", {
        method: "POST", redirect: "error", signal: transportSignal,
        headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.#model, store: false, stream: false, max_output_tokens: this.#maxOutputTokens,
          ...(this.#effort ? { reasoning: { effort: this.#effort } } : {}),
          instructions: instructionsFor(input),
          input: [{ role: "user", content: JSON.stringify(input) }],
          text: { format: { type: "json_schema", name: "callmate_dialogue_proposal",
            strict: true, schema: dialogueResponseSchema } },
        }),
      });
      checkAbort();
      if (!response.ok) {
        throw await httpFailure(response);
      }
      let payload: unknown;
      try { payload = await response.json(); } catch { checkAbort(); return invalid(); }
      checkAbort();
      return parseResponse(payload);
    } catch (error) {
      checkAbort();
      if (error instanceof OpenAIModelError) throw error;
      throw new OpenAIModelError("request_failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createOpenAIModelClient(options: OpenAIModelOptions): ModelClient {
  return new OpenAIModelClient(options);
}
