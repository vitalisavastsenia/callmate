import type { Simulator } from "./simulator.js";
import type { DevelopmentConversations } from "./development-conversations.js";
import type { Store } from "./storage.js";
import { isMockAttempt } from "./call-store.js";
import { CommandError } from "./errors.js";

/** One public lifecycle API over scripted booking and manual mock transports. */
export class CallController {
  constructor(private store: Store, private simulator: Simulator, private manual: DevelopmentConversations) {}
  private require(id: string) {
    const a = this.store.calls.get(id);
    if (!a) throw new CommandError(404, "NOT_FOUND", "Call attempt not found");
    return a;
  }
  createPlan: Simulator["createPlan"] = (request) => this.simulator.createPlan(request);
  start = async (request: Parameters<Simulator["start"]>[0], key: string) => {
    const command = this.store.calls.command(key);
    // Replay the original transport; a new mock call must never become scripted success.
    if (command?.endpoint === "start" || (!this.manual.mockTransportEnabled && command?.endpoint !== "dialogue-start")) return this.simulator.start(request, key);
    return this.manual.startDialogue(request, key, plan => this.simulator.validatePlan(plan));
  };
  get(id: string) { return this.require(id).call; }
  async stop(id: string) {
    if (isMockAttempt(this.require(id))) { await this.manual.stop(id); return this.manual.snapshot(id); }
    return this.simulator.stop(id);
  }
  decide: Simulator["decide"] = (id, decision, key) => {
    if (isMockAttempt(this.require(id))) return this.manual.decide(id, decision, key);
    return this.simulator.decide(id, decision, key);
  };
  history: Simulator["history"] = (limit, cursor) => this.simulator.history(limit, cursor);
  deleteConversation(id: string) {
    return isMockAttempt(this.require(id)) ? this.manual.deleteConversation(id) : this.simulator.deleteConversation(id);
  }
  deleteAgreement(id: string) {
    return isMockAttempt(this.require(id)) ? this.manual.deleteAgreement(id) : this.simulator.deleteAgreement(id);
  }
  replayEvents(id: string, after: number) {
    const a = this.require(id);
    return after < a.replayFloor || after > a.call.lastEventSequence ? null : this.store.calls.events(id, after);
  }
  observe(id: string, listener: () => void) {
    return isMockAttempt(this.require(id)) ? this.manual.observe(id, listener) : this.simulator.observe(id, listener);
  }
}
