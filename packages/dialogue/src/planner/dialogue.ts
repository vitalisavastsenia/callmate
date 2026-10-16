import type { DialogueInput, DialoguePort, DialogueProposal } from "@callmate/contracts";
import type { ModelClient } from "../model/client.js";
import { DialogueError } from "./errors.js";
import { parseInput, parseProposal, type OfferIdentitySource } from "./validation.js";

export type DialogueOptions = {
  /** Per-turn deadline, including model generation and validation. Default: 10 seconds. */
  timeoutMs?: number;
  offerIdentitySource?: OfferIdentitySource;
};

/** No I/O on construction. One bounded model request per finalized business turn. */
export class Dialogue implements DialoguePort {
  private readonly timeoutMs: number;
  private readonly identitySource: OfferIdentitySource | undefined;
  constructor(private readonly model: ModelClient, options: DialogueOptions = {}) {
    if (!model || typeof model.generate !== "function") throw new TypeError("A ModelClient is required");
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new RangeError("Dialogue timeoutMs must be an integer from 1 to 60000");
    }
    if (options.offerIdentitySource !== undefined && typeof options.offerIdentitySource !== "function") {
      throw new TypeError("offerIdentitySource must be a function");
    }
    this.timeoutMs = timeoutMs;
    this.identitySource = options.offerIdentitySource;
  }

  async propose(raw: DialogueInput, signal: AbortSignal): Promise<DialogueProposal> {
    if (signal.aborted) throw new DialogueError("cancelled");
    const input = parseInput(raw);
    const controller = new AbortController();
    const deadline = performance.now() + this.timeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: DialogueError | null, proposal?: DialogueProposal) => {
        if (settled) return;
        if (signal.aborted) error = new DialogueError("cancelled");
        else if (performance.now() >= deadline) error = new DialogueError("timeout");
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve(proposal!);
        if (error?.code === "timeout" || error?.code === "cancelled") controller.abort(error);
      };
      const stop = (code: "cancelled" | "timeout") => {
        finish(new DialogueError(code));
      };
      const cancel = () => stop("cancelled");
      const timer = setTimeout(() => stop("timeout"), this.timeoutMs);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      try {
        // Neither provider mutation nor a late response may change validation context.
        Promise.resolve(this.model.generate(structuredClone(input), controller.signal)).then((rawOutput) => {
          if (settled) return;
          if (signal.aborted) { cancel(); return; }
          if (performance.now() >= deadline) { stop("timeout"); return; }
          try {
            const proposal = parseProposal(input, rawOutput, this.identitySource);
            finish(null, proposal);
          } catch (error) {
            finish(error instanceof DialogueError ? error : new DialogueError("invalid_model_output"));
          }
        }, () => finish(new DialogueError("model_failed")));
      } catch {
        finish(new DialogueError("model_failed"));
      }
    });
  }
}

export function createDialogue(model: ModelClient, options: DialogueOptions = {}): DialoguePort {
  return new Dialogue(model, options);
}
