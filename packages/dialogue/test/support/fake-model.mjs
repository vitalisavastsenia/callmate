/** @implements {import("../../dist/model/client.js").ModelClient} */
export class FakeModel {
  #steps;
  #cursor = 0;
  #requests = [];
  #pending = new Set();

  /** Steps are { kind: "response" | "pending", value: unknown } or { kind: "error", error: Error }. */
  constructor(steps) {
    this.#steps = steps.map((step) => {
      if (step.kind === "error" && step.error instanceof Error) return { ...step };
      if (step.kind === "response" || step.kind === "pending") {
        return { kind: step.kind, value: structuredClone(step.value) };
      }
      throw new TypeError("Unsupported fake model step");
    });
  }

  get requests() { return structuredClone(this.#requests); }
  get remaining() { return this.#steps.length - this.#cursor; }
  get pendingCount() { return this.#pending.size; }

  async generate(input, signal) {
    signal.throwIfAborted();
    this.#requests.push(structuredClone(input));
    const step = this.#steps[this.#cursor];
    if (!step) throw new Error("Fake model script exhausted");
    this.#cursor += 1;
    if (step.kind === "error") throw step.error;
    if (step.kind === "response") return structuredClone(step.value);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        this.#pending.delete(release);
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const release = () => {
        cleanup();
        resolve(structuredClone(step.value));
      };
      this.#pending.add(release);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  /** Resolve one waiting request, in request order, without timers or network calls. */
  releaseNext() {
    const release = this.#pending.values().next().value;
    if (!release) return false;
    release();
    return true;
  }
}
