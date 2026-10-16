import { type CallSnapshot, type HistoryEntry } from './types';
import { localDateInZone } from './time';

export interface AgreementEntry {
  call: HistoryEntry;
  kind: 'appointment' | 'information';
  date: string;
  instant: string;
}

/** Calendar dates come from confirmed terms, never proposed availability or free text. */
export function agreementEntries(history: HistoryEntry[], current: CallSnapshot | null, timeZone: string): AgreementEntry[] {
  const calls = new Map(history.map(call => [call.id, call]));
  if (current) calls.set(current.id, {
    id: current.id, mode: current.mode, businessName: current.plan.request.business.name,
    requestType: current.plan.request.requestType, callState: current.callState,
    outcome: current.outcome, createdAt: current.createdAt, usage: current.usage,
    agreementDeletedAt: current.agreementDeletedAt ?? calls.get(current.id)?.agreementDeletedAt,
  });
  return [...calls.values()].flatMap((call): AgreementEntry[] => {
    if (call.kind === 'manual_mock' || call.agreementDeletedAt) return [];
    if (call.outcome.status === 'confirmed') {
      const time = call.outcome.offer.appointment;
      return [{ call, kind: 'appointment', date: time.localDate, instant: time.instant }];
    }
    if (call.outcome.status === 'completed' && call.outcome.findings.some(finding => finding.answered)) {
      return [{ call, kind: 'information', date: localDateInZone(new Date(call.createdAt), timeZone), instant: call.createdAt }];
    }
    return [];
  }).sort((a, b) => Date.parse(b.instant) - Date.parse(a.instant) || a.call.id.localeCompare(b.call.id));
}

export function shiftMonth(month: string, delta: number): string {
  const [year, index] = month.split('-').map(Number);
  return new Date(Date.UTC(year!, index! - 1 + delta, 1)).toISOString().slice(0, 7);
}

/** Monday-first calendar, computed in UTC to avoid DST and viewer timezone shifts. */
export function monthDays(month: string): (string | null)[] {
  const [year, index] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year!, index! - 1, 1));
  const padding = (first.getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(year!, index!, 0)).getUTCDate();
  return Array.from({ length: Math.ceil((padding + count) / 7) * 7 }, (_, i) =>
    i < padding || i >= padding + count ? null : `${month}-${String(i - padding + 1).padStart(2, '0')}`);
}
