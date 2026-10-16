import { CallEngineSettingsSchema, TWILIO_NOT_IMPLEMENTED } from "@callmate/contracts";
import type { Store } from "./storage.js";
import { CommandError } from "./errors.js";

export function callEngineSettings(store: Store) {
  return CallEngineSettingsSchema.parse({ engine: store.getCallEngine(), editable: !store.calls.active() });
}
export function requireMockCallEngine(store: Store) {
  if (store.getCallEngine() === "twilio") throw new CommandError(503, "PROVIDER_NOT_READY", TWILIO_NOT_IMPLEMENTED);
}
