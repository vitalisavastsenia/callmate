import { CallSnapshotSchema, IdSchema, InstantSchema, type CallSnapshot } from "@callmate/contracts";
import { reduceConversation, type ConversationUpdate } from "../planner/conversation.js";
import { echoPhrase, plainReply, processingPhrases, waitingPhrase, type SpokenPhrase } from "./conversation.js";

export type PacingOptions = { random?: () => number };
/** One instance per call. No timers, I/O, playback, or hidden authorization. */
export class ConversationPacing {
  private readonly used = new Set<string>();
  private readonly stages = new Map<string, number>();
  private readonly processingTurns = new Set<string>();
  private readonly random: () => number;
  constructor(private readonly attemptId: string, options: PacingOptions = {}) {
    IdSchema.parse(attemptId);
    this.random = options.random ?? Math.random;
    if (typeof this.random !== "function") throw new TypeError("random must be a function");
  }
  protected read(raw: CallSnapshot): CallSnapshot {
    const snapshot = CallSnapshotSchema.parse(raw);
    if (snapshot.id !== this.attemptId) throw new TypeError("Pacing belongs to a different call");
    for (const message of snapshot.messages) if (message.speaker === "assistant") this.used.add(message.originalText);
    return snapshot;
  }
  private pick(phrases: SpokenPhrase[]): SpokenPhrase | null {
    const remaining = phrases.filter(phrase => !this.used.has(phrase.es));
    if (!remaining.length) return null;
    const random = this.random();
    if (!Number.isFinite(random) || random < 0 || random >= 1) throw new RangeError("random must return a value in [0, 1)");
    const result = remaining[Math.floor(random * remaining.length)]!;
    this.used.add(result.es); // Reserve before queueing: interrupted/withheld output is never accidentally repeated.
    return result;
  }
  /** Deduplicate fillers while allowing substantive replies on later turns. */
  reply(raw: CallSnapshot, phrase: SpokenPhrase): SpokenPhrase | null {
    const snapshot = this.read(raw);
    if (snapshot.callState !== "connected") return null;
    if (phrase.id === "wait_initial" && snapshot.conversation?.pending) {
      this.stages.set(snapshot.conversation.pending.id, 0);
      return this.pick([phrase, plainReply("wait_initial_again", "Un momento, por favor, lo consulto con la persona a la que represento.",
        "One moment, please, let me check with the person I’m calling for.")]);
    }
    return phrase.kind === "reply" ? structuredClone(phrase) : this.pick([phrase]);
  }
  processing(raw: CallSnapshot, input: {
    turnId: string; elapsedMs: number; outputActive?: boolean;
    echoField?: "date" | "time" | "price" | "name" | "staff";
  }): SpokenPhrase | null {
    const snapshot = this.read(raw);
    const latest = snapshot.messages.at(-1);
    if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0) throw new RangeError("Invalid processing elapsed time");
    if (snapshot.callState !== "connected" || snapshot.conversation?.pending || input.outputActive
      || !latest?.final || latest.speaker !== "business" || latest.turnId !== input.turnId
      || this.processingTurns.has(input.turnId) || input.elapsedMs <= 2000) return null;
    const tone = snapshot.plan.request.tone ?? "formal";
    let result: SpokenPhrase | null = null;
    if (input.echoField && snapshot.activeOffer?.evidenceMessageIds.includes(latest.id)) {
      const echo = echoPhrase(snapshot.plan, snapshot.activeOffer, input.echoField);
      if (echo) result = this.pick([echo]);
      // A concrete detail takes precedence; do not replace an exhausted echo with a generic filler.
    } else result = this.pick(processingPhrases(tone, input.elapsedMs < 3000 ? "short" : "medium"));
    if (result) this.processingTurns.add(input.turnId);
    return result;
  }
  /** Poll at controller-clock deadlines. Apply returned state before sending its phrase under a fresh permit. */
  waiting(raw: CallSnapshot, now: string, outputActive = false): ConversationUpdate {
    const snapshot = this.read(raw);
    InstantSchema.parse(now);
    if (Date.parse(now) < Date.parse(snapshot.updatedAt)) throw new RangeError("Waiting time precedes the current snapshot");
    const conversation = snapshot.conversation ?? { pending: null, decisions: [], notes: [], tasks: [] };
    const pending = conversation.pending;
    if (!pending || snapshot.callState !== "connected") return { conversation: structuredClone(conversation), reply: null };
    const elapsed = Date.parse(now) - Date.parse(pending.createdAt);
    if (elapsed < 0) throw new RangeError("Waiting time precedes request creation");
    // Expiry is processed even during active output: the controller must cancel obsolete waiting speech.
    if (Date.parse(now) >= Date.parse(pending.expiresAt)) {
      const update = reduceConversation(snapshot, { type: "decision_expired", decisionId: pending.id }, now);
      return {
        ...update,
        reply: update.reply ? this.reply({ ...snapshot, conversation: update.conversation }, update.reply) : null,
      };
    }
    if (outputActive) return { conversation: structuredClone(conversation), reply: null };
    const stage = elapsed >= 24_000 ? 2 : elapsed >= 12_000 ? 1 : 0;
    if (stage === 0 && snapshot.messages.some(message => message.speaker === "assistant"
      && message.originalText === waitingPhrase(snapshot.plan.request.tone ?? "formal", 0).es
      && Date.parse(message.createdAt) >= Date.parse(pending.createdAt))) this.stages.set(pending.id, 0);
    if ((this.stages.get(pending.id) ?? -1) >= stage) return { conversation: structuredClone(conversation), reply: null };
    this.stages.set(pending.id, stage); // Skip missed stages; never stack overdue fillers.
    const tone = snapshot.plan.request.tone ?? "formal";
    const primary = waitingPhrase(tone, stage);
    const alternatives = [primary];
    if (stage === 0) alternatives.push(plainReply("wait_initial_again", "Un momento, por favor, lo consulto con la persona a la que represento.",
      "One moment, please, let me check with the person I’m calling for."));
    if (stage === 1) alternatives.push(plainReply("wait_still_checking", "Sigo esperando la confirmación de la persona a la que represento. Gracias por esperar.",
      "I'm still waiting for confirmation from the person I'm calling for. Thank you for waiting."));
    if (stage === 2) alternatives.push(plainReply("wait_still_trying", "Gracias por esperar. Aún estoy intentando confirmarlo.",
      "Thank you for waiting. I'm still trying to confirm it."));
    return { conversation: structuredClone(conversation), reply: this.pick(alternatives) };
  }
}
