import type { DialogueInput } from "@callmate/contracts";

/**
 * The injected adapter owns credentials, provider setup, and provider teardown.
 * Return an object matching DialogueProposalSchema (not JSON text or markdown).
 * Translate Spanish source faithfully into English, preserving uncertainty and
 * negation. Extract only evidenced facts; clarify missing/ambiguous details.
 * Raw output stays untrusted until the dialogue planner validates it. IDs in a
 * proposed new offer are placeholders; the controller supplies real identities.
 * Honour the signal, including transport/stream cancellation where supported.
 */
export interface ModelClient {
  generate(input: DialogueInput, signal: AbortSignal): Promise<unknown>;
}
