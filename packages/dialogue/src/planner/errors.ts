export type DialogueErrorCode =
  | "invalid_input" | "invalid_model_output" | "model_failed"
  | "cancelled" | "timeout" | "offer_identity_required" | "invalid_offer_identity";

const messages: Record<DialogueErrorCode, string> = {
  invalid_input: "Dialogue requires a current finalized business turn and valid context.",
  invalid_model_output: "The model returned an invalid dialogue proposal.",
  model_failed: "The dialogue model could not complete the turn.",
  cancelled: "The dialogue turn was cancelled.",
  timeout: "The dialogue turn timed out.",
  offer_identity_required: "A new or changed offer requires a controller-reserved identity.",
  invalid_offer_identity: "The controller supplied an invalid offer identity.",
};

/** Stable, transcript-free failures. Provider errors and abort reasons are not exposed. */
export class DialogueError extends Error {
  constructor(public readonly code: DialogueErrorCode) {
    super(messages[code]);
    this.name = "DialogueError";
  }
}
