import { z } from "zod";
import { language } from "../server/config.js";

export const parameters = z.record(z.string().min(1).max(100), z.string().max(1000))
  .refine((value) => Object.keys(value).length <= 30, "Too many custom parameters");
export const createSession = z.object({
  to: z.string().min(1).max(100).optional(), from: z.string().min(1).max(100).optional(), language: language.optional(),
  relayWsUrl: z.string().max(2048).optional(), customParameters: parameters.optional(), autoAnswer: z.boolean().optional(),
  twiml: z.string().min(1).max(4000).optional(), url: z.string().max(2048).optional(),
  method: z.enum(["GET", "POST"]).optional(), timeout: z.number().int().min(1).max(600).optional(),
  statusCallback: z.string().max(2048).optional(), statusCallbackMethod: z.enum(["GET", "POST"]).optional(),
  statusCallbackEvents: z.array(z.enum(["initiated", "ringing", "answered", "completed"])).max(4).optional(),
}).strict();
export type CreateSession = z.infer<typeof createSession>;
const text = z.string().max(8000);
export const utterance = z.object({ text: text.min(1), lang: language.optional(), last: z.boolean().default(true) }).strict();
export const interruption = z.object({ utteranceUntilInterrupt: text.default(""),
  durationUntilInterruptMs: z.number().int().min(0).max(3_600_000).default(0) }).strict();
export const dtmf = z.object({ digit: z.string().regex(/^[0-9*#]$/) }).strict();
export const relayMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), token: text, last: z.boolean().default(false), lang: language.optional(),
    interruptible: z.boolean().optional(), preemptible: z.boolean().optional() }),
  z.object({ type: z.literal("end"), handoffData: z.string().max(8000).optional() }),
  z.object({ type: z.literal("language"), ttsLanguage: language.optional(), transcriptionLanguage: language.optional() })
    .refine((value) => value.ttsLanguage || value.transcriptionLanguage, "A language is required"),
  z.object({ type: z.literal("sendDigits"), digits: z.string().regex(/^[0-9w*#]{1,100}$/) }),
  z.object({ type: z.literal("play"), source: z.url().max(2048), loop: z.number().int().min(0).max(1000).optional(),
    interruptible: z.boolean().optional(), preemptible: z.boolean().optional() }),
]);
export const operatorMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("claim"), callSid: z.string(), requestId: z.string().max(100) }),
  z.object({ type: z.enum(["answer", "reject", "hangup", "release"]), callSid: z.string(), requestId: z.string().max(100) }),
  z.object({ type: z.literal("utterance"), callSid: z.string(), requestId: z.string().max(100), payload: utterance }),
  z.object({ type: z.literal("interrupt"), callSid: z.string(), requestId: z.string().max(100), payload: interruption }),
  z.object({ type: z.literal("dtmf"), callSid: z.string(), requestId: z.string().max(100), payload: dtmf }),
  z.object({ type: z.literal("language"), callSid: z.string(), requestId: z.string().max(100), language }),
  z.object({ type: z.literal("speech-status"), callSid: z.string(), requestId: z.string().max(100),
    code: z.enum(["BROWSER_STT_UNAVAILABLE", "BROWSER_STT_ERROR", "BROWSER_TTS_UNAVAILABLE", "BROWSER_TTS_ERROR"]), message: z.string().max(300) }),
]);
