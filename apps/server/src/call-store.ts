import type Database from "better-sqlite3";
import { z } from "zod";
import { StoredCallSnapshotSchema, DomainEventSchema, ReviewPlanSchema } from "@callmate/contracts";
import type { CallSnapshot, ManualCallSnapshot, DomainEvent, ReviewPlan, SimulatorScenario, StoredCallSnapshot } from "@callmate/contracts";
import { callStatus } from "./twilio/protocol.js";

export type Internal = {
  scenario: SimulatorScenario;
  phase: "dial" | "ring" | "connect" | "offer" | "change" | "wait" | "accept" | "confirm" | "end" | "done";
  nextAt: number;
  accepted: boolean;
  grant: { approvalId: string; expiresAt: string; offerVersion: number } | null;
};
export type Attempt = { call: CallSnapshot; internal: Internal; replayFloor: number };

const manualInternal = z.object({
  kind: z.literal("manual_mock"),
  callSid: z.string().regex(/^CA[0-9a-f]{32}$/i).nullable(),
  status: z.enum(["creating", "ringing", "connected", "disconnected", "completed", "failed", "unknown"]),
  error: z.string().nullable(),
  stopRequested: z.boolean(),
  // Optional only for records written before persistent recovery was introduced.
  correlation: z.object({
    apiOrigin: z.url(), accountSid: z.string().regex(/^AC[0-9a-f]{32}$/i),
    tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
    sessionId: z.string().regex(/^VX[0-9a-f]{32}$/i).nullable(),
    creation: z.enum(["prepared", "submitted"]), recoveryRequired: z.boolean(),
    statusCallbackUrl: z.url().optional(),
    callbackSequence: z.number().int().nonnegative().safe().optional(),
    providerStatus: callStatus.optional(),
    hangupRequested: z.boolean().optional(),
  }).optional(),
});
export type ManualInternal = z.infer<typeof manualInternal>;
export type ManualAttempt = { call: ManualCallSnapshot; internal: ManualInternal; replayFloor: number };
export type StoredAttempt = Attempt | ManualAttempt;
export function isManualAttempt(attempt: StoredAttempt): attempt is ManualAttempt {
  return "kind" in attempt.call && attempt.call.kind === "manual_mock";
}

export function callStore(db: Database.Database) {
  const get = (id: string): StoredAttempt | undefined => {
    const row = db.prepare("SELECT snapshot, internal, replay_floor FROM call_attempts WHERE id = ?").get(id) as
      { snapshot: string; internal: string; replay_floor: number } | undefined;
    if (!row) return;
    const call = StoredCallSnapshotSchema.parse(JSON.parse(row.snapshot));
    return { call, internal: "kind" in call ? manualInternal.parse(JSON.parse(row.internal))
      : JSON.parse(row.internal) as Internal, replayFloor: row.replay_floor } as StoredAttempt;
  };
  return {
    get,
    transaction<T>(work: () => T): T { return db.transaction(work).immediate(); },
    putPlan(plan: ReviewPlan) {
      db.prepare("INSERT INTO review_plans (id, value) VALUES (?, ?)").run(plan.id, JSON.stringify(ReviewPlanSchema.parse(plan)));
    },
    plan(id: string): ReviewPlan | undefined {
      const row = db.prepare("SELECT value FROM review_plans WHERE id = ?").get(id) as { value: string } | undefined;
      return row && ReviewPlanSchema.parse(JSON.parse(row.value));
    },
    latestManual(): ManualAttempt | undefined {
      const row = db.prepare("SELECT id FROM call_attempts WHERE json_extract(snapshot, '$.kind') = 'manual_mock' ORDER BY rowid DESC LIMIT 1")
        .get() as { id: string } | undefined;
      const attempt = row && get(row.id);
      return attempt && isManualAttempt(attempt) ? attempt : undefined;
    },
    active(): StoredAttempt | undefined {
      const row = db.prepare("SELECT id FROM call_attempts WHERE active = 1").get() as { id: string } | undefined;
      return row && get(row.id);
    },
    save(attempt: StoredAttempt, events: DomainEvent[] = []) {
      const call = StoredCallSnapshotSchema.parse(attempt.call);
      const active = !["ended", "busy", "no_answer", "failed"].includes(call.callState);
      db.prepare(`INSERT INTO call_attempts (id, snapshot, internal, active, replay_floor) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot, internal=excluded.internal,
        active=excluded.active, replay_floor=excluded.replay_floor`)
        .run(call.id, JSON.stringify(call), JSON.stringify(isManualAttempt(attempt) ? manualInternal.parse(attempt.internal) : attempt.internal), Number(active), attempt.replayFloor);
      const insert = db.prepare("INSERT INTO call_events (attempt_id, sequence, value) VALUES (?, ?, ?)");
      for (const event of events) insert.run(call.id, event.sequence, JSON.stringify(DomainEventSchema.parse(event)));
    },
    command(key: string) {
      return db.prepare("SELECT endpoint, body, attempt_id AS attemptId FROM commands WHERE key = ?").get(key) as
        { endpoint: string; body: string; attemptId: string } | undefined;
    },
    recordCommand(key: string, endpoint: string, body: string, attemptId: string) {
      db.prepare("INSERT INTO commands (key, endpoint, body, attempt_id) VALUES (?, ?, ?, ?)")
        .run(key, endpoint, body, attemptId);
    },
    events(id: string, after: number): DomainEvent[] {
      return (db.prepare("SELECT value FROM call_events WHERE attempt_id = ? AND sequence > ? ORDER BY sequence")
        .all(id, after) as { value: string }[]).map((row) => DomainEventSchema.parse(JSON.parse(row.value)));
    },
    purgeEvents(id: string) { db.prepare("DELETE FROM call_events WHERE attempt_id = ?").run(id); },
    list(limit: number, cursor?: string): StoredCallSnapshot[] {
      // Rowid is a stable insertion order even when timestamps match. Cursor is an attempt UUID.
      return (db.prepare(`SELECT snapshot FROM call_attempts
        WHERE rowid < COALESCE((SELECT rowid FROM call_attempts WHERE id = ?), 9223372036854775807)
        ORDER BY rowid DESC LIMIT ?`).all(cursor ?? null, limit) as { snapshot: string }[])
        .map((row) => StoredCallSnapshotSchema.parse(JSON.parse(row.snapshot)));
    },
  };
}
export type CallStore = ReturnType<typeof callStore>;
