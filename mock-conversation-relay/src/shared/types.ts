export type Status = "queued" | "ringing" | "in-progress" | "completed" | "busy" | "canceled" | "no-answer" | "failed";
export type Connection = "waiting" | "connecting" | "connected" | "disconnected" | "failed";
export type Diagnostic = { code: string; message: string; at: string };
export type LogEvent = { sequence: number; at: string; mockGenerated: true; direction: "lifecycle" | "to-backend" | "from-backend" | "operator" | "callback";
  type: string; sessionId: string | null; payload: unknown };
export type Transcript = { id: string; at: string; speaker: "operator" | "assistant" | "platform"; text: string;
  final: boolean; lang: string; interruptible: boolean; preemptible: boolean };
export type SessionView = {
  id: string; callSid: string; accountSid: string; sessionId: string | null; from: string; to: string;
  status: Status; connection: Connection; createdAt: string; updatedAt: string; startedAt: string | null; endedAt: string | null;
  relayWsUrl: string | null; language: string; ttsLanguage: string; customParameters: Record<string, string>;
  lastError: Diagnostic | null; lastClose: { code: number; reason: string } | null; handoffData: string | null;
  transitions: { status: Status; at: string }[]; transcript: Transcript[]; events: LogEvent[];
  droppedEvents: number; callbacks: { event: string; at: string; status: number | null; error: string | null }[];
  operatorId: string | null;
};
export type PublicConfig = { language: string; from: string; to: string; relayWsUrl: string; twimlUrl: string;
  browserSpeech: boolean; maxActiveCalls: number };
