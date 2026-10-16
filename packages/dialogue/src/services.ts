import type { BookingPolicyPort, DialoguePort } from "@callmate/contracts";
import type { ModelClient } from "./model/client.js";
import { createDialogue, type DialogueOptions } from "./planner/dialogue.js";
import { createBookingPolicy } from "./policy/booking-policy.js";

/** Server bootstrap convenience; the caller owns provider setup and shutdown. */
export function createDialogueServices(model: ModelClient, options: DialogueOptions = {}): {
  dialogue: DialoguePort; bookingPolicy: BookingPolicyPort;
} {
  return { dialogue: createDialogue(model, options), bookingPolicy: createBookingPolicy() };
}
