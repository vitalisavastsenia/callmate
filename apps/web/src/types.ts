// All wire formats come from the shared v1 contract; no frontend schema copies.
export * from '@callmate/contracts';
import type { ReadinessSchema, SettingsSchema, RequestDraftSchema, ApprovalRequestSchema, ZonedTimeSchema, HistoryEntrySchema } from '@callmate/contracts';
export type RequestDraft = typeof RequestDraftSchema._output;
export type Settings = typeof SettingsSchema._output;
export type Readiness = typeof ReadinessSchema._output;
export type ApprovalRequest = typeof ApprovalRequestSchema._output;
export type ZonedTime = typeof ZonedTimeSchema._output;
export type HistoryEntry = typeof HistoryEntrySchema._output;
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';
export const scenarios = {
  within_plan: 'Within-plan confirmation',
  alternative: 'Alternative time needs approval',
  above_price: 'Price above the limit',
  changed_offer: 'Offer changes while approval is open',
  uncertain: 'Disconnect near confirmation',
  no_answer: 'No answer',
  interrupted: 'Interrupted assistant reply',
} as const;
export type Scenario = keyof typeof scenarios;

export const requestLabels = { book: 'Book an appointment', ask: 'Ask or find out', change: 'Change or cancel', other: 'Other' } as const;

// Home may seed a new editable form without creating a plan or granting authority.
export interface RequestPrefill { goal?: string; requestType?: NonNullable<RequestDraft['requestType']> }

// Editable suggestions, deliberately separate from the validated, resolved call plan.
export interface GoalParseContext { timeZone: string; requestType?: NonNullable<RequestDraft['requestType']> }
export interface ParsedGoal {
  requestType: NonNullable<RequestDraft['requestType']>;
  businessName?: string;
  businessPhone?: string;
  tone?: string[];
  service?: string;
  maximumPriceEur?: string;
  availability?: { date?: string; start?: string; end?: string };
  questions?: string[];
  changeDescription?: string;
  bookingReference?: string;
  canDecideAlone: string[];
  mustAskMe: string[];
  notes: string[];
}
