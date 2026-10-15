import { z } from "zod";
import {
  ApprovalDecisionSchema, ConversationDecisionSchema, CallSnapshotSchema, HistoryEntrySchema, IdSchema,
  ReadinessSchema, RequestDraftSchema, ReviewPlanSchema, SettingsSchema, StartCallRequestSchema,
} from "./schemas.js";

// All paths are private loopback API routes, never public Twilio callback routes.
export const api = {
  readiness: { method: "GET", path: "/api/v1/readiness", response: ReadinessSchema },
  createPlan: { method: "POST", path: "/api/v1/plans", request: RequestDraftSchema,
    response: z.strictObject({ plan: ReviewPlanSchema }) },
  startCall: { method: "POST", path: "/api/v1/calls", request: StartCallRequestSchema,
    response: z.strictObject({ call: CallSnapshotSchema }) },
  getCall: { method: "GET", path: "/api/v1/calls/:attemptId", response: z.strictObject({ call: CallSnapshotSchema }) },
  stopCall: { method: "POST", path: "/api/v1/calls/:attemptId/stop", request: z.strictObject({}),
    response: z.strictObject({ call: CallSnapshotSchema }) },
  decideApproval: { method: "POST", path: "/api/v1/calls/:attemptId/approvals", request: ApprovalDecisionSchema,
    response: z.strictObject({ call: CallSnapshotSchema }) },
  decideConversation: { method: "POST", path: "/api/v1/calls/:attemptId/conversation-decisions", request: ConversationDecisionSchema,
    response: z.strictObject({ call: CallSnapshotSchema }) },
  history: { method: "GET", path: "/api/v1/history",
    query: z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(20), cursor: IdSchema.optional() }),
    response: z.strictObject({ items: z.array(HistoryEntrySchema), nextCursor: IdSchema.nullable() }) },
  deleteConversation: { method: "DELETE", path: "/api/v1/calls/:attemptId/conversation",
    response: z.strictObject({ attemptId: IdSchema, deleted: z.literal(true) }) },
  getSettings: { method: "GET", path: "/api/v1/settings", response: SettingsSchema },
  updateSettings: { method: "PUT", path: "/api/v1/settings", request: SettingsSchema, response: SettingsSchema },
  events: { method: "GET", path: "/api/v1/calls/:attemptId/events", contentType: "text/event-stream" },
} as const;

export const AttemptParamsSchema = z.strictObject({ attemptId: IdSchema });
export const EventCursorSchema = z.string().regex(/^(0|[1-9]\d*)$/)
  .transform(Number).pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
