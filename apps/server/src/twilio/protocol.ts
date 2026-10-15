import { z } from "zod";
import type { CallSnapshot } from "@callmate/contracts";

// Official wire names deliberately stay separate from the private HTTP/SSE contracts.
export const callStatus = z.enum(["queued", "ringing", "in-progress", "completed", "busy", "failed", "no-answer", "canceled"]);
export type CallStatus = z.infer<typeof callStatus>;
export const terminal = new Set<string>(["completed", "busy", "failed", "no-answer", "canceled"]);
export function normalizeStatus(status: CallStatus | "initiated"): CallSnapshot["callState"] {
  switch (status) {
    case "queued": case "initiated": return "dialing";
    case "ringing": return "ringing";
    case "in-progress": return "connected";
    case "busy": return "busy";
    case "no-answer": return "no_answer";
    case "failed": return "failed";
    default: return "ended";
  }
}
export const statusCallback = z.object({
  AccountSid: z.string().regex(/^AC[0-9a-f]{32}$/i), CallSid: z.string().regex(/^CA[0-9a-f]{32}$/i),
  From: z.string(), To: z.string(), CallStatus: z.enum([...callStatus.options, "initiated"]),
  SequenceNumber: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().safe()),
  CallbackSource: z.literal("call-progress-events"), Timestamp: z.string(),
});
export const relayInbound = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setup"), sessionId: z.string().regex(/^VX[0-9a-f]{32}$/i),
    accountSid: z.string(), callSid: z.string(), from: z.string(), to: z.string(),
    parentCallSid: z.string().optional(), forwardedFrom: z.string().optional(), callType: z.string().optional(),
    callerName: z.string().optional(), direction: z.string().optional(), callStatus: z.string().optional(),
    customParameters: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal("prompt"), voicePrompt: z.string(), lang: z.string(), last: z.boolean() }),
  z.object({ type: z.literal("dtmf"), digit: z.string().regex(/^[0-9*#]$/) }),
  z.object({ type: z.literal("interrupt"), utteranceUntilInterrupt: z.string(), durationUntilInterruptMs: z.number().nonnegative() }),
  z.object({ type: z.literal("error"), description: z.string() }),
]);
export type RelayInbound = z.infer<typeof relayInbound>;
// This mock supports text and end only; play/sendDigits/language are out of scope.
export const relayOutbound = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), token: z.string(), last: z.boolean().optional(), lang: z.string().optional(),
    interruptible: z.boolean().optional(), preemptible: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("end"), handoffData: z.string().optional() }).strict(),
]);
export type RelayOutbound = z.infer<typeof relayOutbound>;
