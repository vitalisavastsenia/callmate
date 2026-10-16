import { type CallSnapshot } from "@callmate/contracts";
import { ConversationPacing, type PacingOptions } from "../language/pacing.js";
import { reduceConversation, type ConversationEvent, type ConversationUpdate } from "./conversation.js";

/** Per-call conversation companion; authoritative snapshots and all playback remain controller-owned. */
export class ConversationSession extends ConversationPacing {
  apply(snapshot: CallSnapshot, event: ConversationEvent, now: string): ConversationUpdate {
    this.read(snapshot);
    const update = reduceConversation(snapshot, event, now);
    return { ...update, reply: update.reply ? this.reply({ ...snapshot, conversation: update.conversation }, update.reply) : null };
  }
}
export const createConversationSession = (attemptId: string, options: PacingOptions = {}): ConversationSession =>
  new ConversationSession(attemptId, options);
