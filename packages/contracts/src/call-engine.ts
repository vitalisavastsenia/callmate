import { z } from "zod";

export const CallEngineSchema = z.enum(["mock", "twilio"]);
export const UpdateCallEngineSchema = z.strictObject({ engine: CallEngineSchema });
export const CallEngineSettingsSchema = UpdateCallEngineSchema.extend({ editable: z.boolean() });
export type CallEngine = z.infer<typeof CallEngineSchema>;
export type CallEngineSettings = z.infer<typeof CallEngineSettingsSchema>;
export const TWILIO_NOT_IMPLEMENTED = "Twilio integration is not implemented yet. Backend calls are unavailable while Twilio is selected.";
