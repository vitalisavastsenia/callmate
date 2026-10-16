import { LlmSelectionSchema, LlmSettingsSchema, UpdateLlmSettingsSchema, type LlmSelection, type UpdateLlmSettings } from "@callmate/contracts";
import { createCodexModelClient, createOpenAIModelClient, createAnthropicModelClient, type ModelClient } from "@callmate/dialogue";
import type { Config } from "./config.js";
import type { Store } from "./storage.js";
import { CommandError } from "./errors.js";
import { LlmSecrets } from "./llm-secrets.js";
import { mockRelayEnabled } from "./mock-relay.js";
import { codexLoginReady } from "./codex-ready.js";
import { createHash } from "node:crypto";

export class LlmAgent implements ModelClient {
  private secrets: LlmSecrets;
  constructor(private config: Config, private store: Store) { this.secrets = new LlmSecrets(config, () => store.llm.hasCredentials()); }
  selection(): LlmSelection {
    return LlmSelectionSchema.parse(this.store.llm.selection() ?? {
      provider: this.config.dialogueProvider, model: this.config.dialogueModel ?? null, effort: "default",
    });
  }
  get enabled() { return mockRelayEnabled(this.config) && this.selection().provider !== "disabled"; }
  version() {
    return createHash("sha256").update(JSON.stringify([this.selection(),
      this.store.llm.credential("openai"), this.store.llm.credential("anthropic")])).digest("hex");
  }
  private environment(provider: "openai" | "anthropic") { return provider === "openai" ? this.config.openaiApiKey : this.config.anthropicApiKey; }
  private key(provider: "openai" | "anthropic") {
    const stored = this.store.llm.credential(provider);
    return stored === undefined ? this.environment(provider) : this.secrets.decrypt(provider, stored);
  }
  settings() {
    const credential = (provider: "openai" | "anthropic") => {
      const source = this.store.llm.credential(provider) !== undefined ? "stored" : this.environment(provider) ? "environment" : null;
      let usable = false;
      try { usable = !!this.key(provider); } catch { /* Missing master key/tampering fails closed. */ }
      return { configured: source !== null, usable, source };
    };
    return LlmSettingsSchema.parse({ ...this.selection(), credentials: { openai: credential("openai"), anthropic: credential("anthropic") }, editable: !this.store.calls.active() });
  }
  update(raw: UpdateLlmSettings) {
    const input = UpdateLlmSettingsSchema.parse(raw);
    if (this.store.calls.active()) throw new CommandError(409, "CALL_ALREADY_ACTIVE", "Finish the active call before changing the LLM agent or its keys");
    const selection = LlmSelectionSchema.parse({ provider: input.provider, model: input.model, effort: input.effort });
    const encrypted: Partial<Record<"openai" | "anthropic", string | null>> = {};
    try {
      for (const provider of ["openai", "anthropic"] as const) {
        const value = input.apiKeys?.[provider];
        if (value !== undefined) encrypted[provider] = value === null ? null : this.secrets.encrypt(provider, value);
      }
    } catch { throw new CommandError(503, "PROVIDER_NOT_READY", "Secret storage is unavailable. Restore the master key and its private file permissions before saving API keys"); }
    this.store.llm.save(selection, encrypted);
    return this.settings();
  }
  async ready() {
    if (!this.enabled) return false;
    const { provider } = this.selection();
    if (provider === "codex") return codexLoginReady();
    try { return provider !== "disabled" && !!this.key(provider); } catch { return false; }
  }
  async generate(input: Parameters<ModelClient["generate"]>[0], signal: AbortSignal) {
    if (!this.enabled || signal.aborted) throw new Error("LLM agent is unavailable");
    const { provider, model, effort } = this.selection();
    const common = { timeoutMs: this.config.dialogueTimeoutMs, ...(effort !== "default" ? { effort } : {}) };
    let client: ModelClient;
    if (provider === "codex") client = createCodexModelClient({ ...common, ...(model ? { model } : {}) });
    else if (provider === "openai" || provider === "anthropic") {
      let apiKey: string | undefined;
      try { apiKey = this.key(provider); } catch { /* Do not expose filesystem/crypto errors. */ }
      if (!apiKey || !model) throw new Error("LLM credentials are unavailable");
      client = provider === "openai" ? createOpenAIModelClient({ ...common, apiKey, model })
        : createAnthropicModelClient({ ...common, apiKey, model });
    } else throw new Error("LLM agent is disabled");
    return client.generate(input, signal);
  }
}
