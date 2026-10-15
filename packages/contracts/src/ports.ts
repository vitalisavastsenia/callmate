import type {
  ApprovedPlan, CallSnapshot, CandidateAction, DialogueInput, DialogueProposal, PlaybackPermit, TranscriptMessage,
} from "./schemas.js";

export type AttemptContext = { attemptId: string; plan: ApprovedPlan };
export type CallStartResult =
  | { status: "accepted"; providerCallId: string }
  | { status: "unknown"; correlationId: string };
export type ProviderCallStatus =
  | { status: "found"; callState: CallSnapshot["callState"]; providerCallId: string }
  | { status: "unknown" };

/** Engineer 2. Local idempotency does not imply exactly-once provider execution. */
export interface TelephonyPort {
  startCall(context: AttemptContext): Promise<CallStartResult>;
  requestHangup(providerCallId: string): Promise<{ status: "acknowledged" | "unknown" }>;
  queryCall(providerCallId: string): Promise<ProviderCallStatus>;
}

/** Engineer 3. Candidates are never authorization or provider commands. */
export interface DialoguePort {
  propose(input: DialogueInput, signal: AbortSignal): Promise<DialogueProposal>;
}

export type PolicyDecision =
  | { decision: "allow"; approvedSpanishText: string }
  | { decision: "ask_user"; reason: "outside_availability" | "above_price_limit" | "unknown_price" | "user_confirmation_required" }
  | { decision: "clarify"; field: string }
  | { decision: "deny"; reason: string };
export interface BookingPolicyPort {
  evaluate(input: {
    snapshot: CallSnapshot; candidate: CandidateAction; now: string;
    // Backend-resolved grant; never supplied directly by the browser or model.
    grant: { approvalId: string; attemptId: string; planId: string; planVersion: number;
      offerId: string; offerVersion: number; expiresAt: string } | null;
  }): PolicyDecision;
}

type VoiceBase = {
  cancelOutput(outputId: string): Promise<void>;
  close(): Promise<void>;
};
export type TextVoicePort = VoiceBase & {
  engine: "conversation_relay";
  sendAuthorizedText(permit: PlaybackPermit): Promise<void>;
};
export type NativeAudioVoicePort = VoiceBase & {
  engine: "openai_realtime";
  // Output starts withheld; validating a tool call is not permission to release audio.
  releaseAuthorizedAudio(permit: PlaybackPermit): Promise<void>;
};
export type VoicePort = TextVoicePort | NativeAudioVoicePort;

/** Engineer 2 owns event normalization and rejects uncorrelated provider sessions. */
export type VoiceEvent =
  | { type: "business.utterance"; attemptId: string; message: TranscriptMessage }
  | { type: "assistant.output"; attemptId: string; outputId: string; turnId: string;
      turnVersion: number; text: string; complete: boolean }
  | { type: "assistant.interrupted"; attemptId: string; outputId: string; heardText: string | null }
  | { type: "voice.failed"; attemptId: string; retryable: boolean };
