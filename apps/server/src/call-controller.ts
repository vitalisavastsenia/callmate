import type { Simulator } from "./simulator.js";
import type { DevelopmentConversations } from "./development-conversations.js";
import type { Store } from "./storage.js";
import { isManualAttempt } from "./call-store.js";
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
  start: Simulator["start"] = (request, key) => this.simulator.start(request, key);
  get(id: string) { return this.require(id).call; }
  async stop(id: string) {
    if (isManualAttempt(this.require(id))) { await this.manual.stop(id); return this.manual.snapshot(id); }
    return this.simulator.stop(id);
  }
  decide: Simulator["decide"] = (id, decision, key) => {
    if (isManualAttempt(this.require(id))) throw new CommandError(409, "CALL_NOT_ACTIVE", "Manual mock calls cannot authorize bookings");
    return this.simulator.decide(id, decision, key);
  };
  history: Simulator["history"] = (limit, cursor) => this.simulator.history(limit, cursor);
  deleteConversation(id: string) {
    return isManualAttempt(this.require(id)) ? this.manual.deleteConversation(id) : this.simulator.deleteConversation(id);
  }
  replayEvents(id: string, after: number) {
    const a = this.require(id);
    return after < a.replayFloor || after > a.call.lastEventSequence ? null : this.store.calls.events(id, after);
  }
  observe(id: string, listener: () => void) {
    return isManualAttempt(this.require(id)) ? this.manual.observe(id, listener) : this.simulator.observe(id, listener);
  }
}
