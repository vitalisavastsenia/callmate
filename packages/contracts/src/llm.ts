import { z } from "zod";

export const LlmProviderSchema = z.enum(["disabled", "codex", "openai", "anthropic"]);
export const LlmEffortSchema = z.enum(["default", "low", "medium", "high", "xhigh", "max"]);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;
export type LlmEffort = z.infer<typeof LlmEffortSchema>;

// Suggestions, not an account entitlement list. Custom IDs use provider-default effort.
export const llmModels = {
  disabled: [],
  codex: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"],
  openai: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.3-codex"],
  anthropic: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-sonnet-4-6", "claude-opus-4-6"],
} satisfies Record<LlmProvider, string[]>;
export function llmEfforts(provider: LlmProvider, model: string | null): LlmEffort[] {
  if (provider === "disabled") return ["default"];
  if (model !== null && !(llmModels[provider] as string[]).includes(model)) return ["default"];
  if (provider === "codex" || model === "gpt-5.3-codex") return ["default", "low", "medium", "high", "xhigh"];
  if (provider === "anthropic" && model?.endsWith("4-6")) return ["default", "low", "medium", "high", "max"];
  return ["default", "low", "medium", "high", "xhigh", "max"];
}
export const LlmSelectionSchema = z.strictObject({
  provider: LlmProviderSchema,
  model: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/).nullable(),
  effort: LlmEffortSchema,
}).superRefine((value, ctx) => {
  if (["openai", "anthropic"].includes(value.provider) && !value.model)
    ctx.addIssue({ code: "custom", path: ["model"], message: "Select an API model" });
  if (!llmEfforts(value.provider, value.model).includes(value.effort))
    ctx.addIssue({ code: "custom", path: ["effort"], message: "Effort is unsupported for this model" });
});
const apiKey = z.string().trim().min(1).max(512).regex(/^[!-~]+$/);
export const UpdateLlmSettingsSchema = LlmSelectionSchema.safeExtend({
  // Omitted preserves a secret; null deletes the stored secret. Never a response field.
  apiKeys: z.strictObject({ openai: apiKey.nullable().optional(), anthropic: apiKey.nullable().optional() }).optional(),
});
const credential = z.strictObject({ configured: z.boolean(), usable: z.boolean(), source: z.enum(["stored", "environment"]).nullable() });
export const LlmSettingsSchema = LlmSelectionSchema.safeExtend({
  credentials: z.strictObject({ openai: credential, anthropic: credential }),
  editable: z.boolean(),
});
export type LlmSelection = z.infer<typeof LlmSelectionSchema>;
export type LlmSettings = z.infer<typeof LlmSettingsSchema>;
export type UpdateLlmSettings = z.infer<typeof UpdateLlmSettingsSchema>;
