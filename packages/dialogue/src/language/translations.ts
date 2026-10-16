import type { DialogueInput, DialogueProposal } from "@callmate/contracts";
import { DialogueError } from "../planner/errors.js";

/** Validate references, not translation accuracy. Never invent missing English text. */
export function checkTranslations(input: DialogueInput, translations: DialogueProposal["translations"]): void {
  const ids = new Set<string>();
  for (const translation of translations) {
    const message = input.messages.find((item) => item.id === translation.messageId);
    if (ids.has(translation.messageId) || !message?.final
      || (message.translationEn !== null && message.translationEn !== translation.translationEn)) {
      throw new DialogueError("invalid_model_output");
    }
    ids.add(translation.messageId);
  }
  if (!ids.has(input.triggerMessageId)) throw new DialogueError("invalid_model_output");
}
