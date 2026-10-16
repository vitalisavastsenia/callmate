import { describe, expect, it } from 'vitest';
import { confirmedCallFixture, uncertainCallFixture } from '@callmate/contracts/fixtures';
import { agreementEntries, monthDays, shiftMonth } from '../src/agreements';
import type { CallSnapshot, HistoryEntry } from '../src/types';

function history(call: CallSnapshot): HistoryEntry {
  return { id: call.id, mode: call.mode, businessName: call.plan.request.business.name,
    createdAt: call.createdAt, callState: call.callState, outcome: call.outcome, usage: call.usage };
}
describe('agreement dates and evidence', () => {
  it('keeps deleted entries out of both views even when the current snapshot or history is stale', () => {
    const call = structuredClone(confirmedCallFixture);
    const deleted = { ...history(call), agreementDeletedAt: '2026-10-15T12:00:00Z' };
    expect(agreementEntries([deleted], null, 'UTC')).toEqual([]);
    expect(agreementEntries([deleted], call, 'UTC')).toEqual([]);
    call.agreementDeletedAt = deleted.agreementDeletedAt;
    expect(agreementEntries([history(confirmedCallFixture)], call, 'UTC')).toEqual([]);
  });
  it('uses the confirmed business date across midnight and retains appointments after transcript deletion', () => {
    const call = structuredClone(confirmedCallFixture);
    if (call.outcome.status !== 'confirmed') throw new Error();
    call.outcome.offer.appointment = { localDate: '2026-10-20', localTime: '00:30', timeZone: 'Europe/Madrid', instant: '2026-10-19T22:30:00Z' };
    call.messages = []; call.conversationData = 'deleted';
    const [entry] = agreementEntries([history(call)], null, 'America/Los_Angeles');
    expect(entry?.date).toBe('2026-10-20'); expect(entry?.instant).toBe('2026-10-19T22:30:00Z');
  });
  it('includes answered findings and uses the call date in the viewer timezone without interpreting text dates', () => {
    const item = history(confirmedCallFixture);
    item.createdAt = '2026-10-15T23:30:00Z';
    item.outcome = { status: 'completed', resolution: 'needs_follow_up', summaryEn: 'Bring documents next Tuesday.',
      findings: [{ question: 'Documents?', answerEn: 'Bring identification next Tuesday.', answered: true },
        { question: 'Fee?', answerEn: 'Not confirmed.', answered: false }], nextSteps: ['Check the fee.'], evidenceMessageIds: [crypto.randomUUID()] };
    expect(agreementEntries([item], null, 'Europe/Warsaw')[0]).toMatchObject({ kind: 'information', date: '2026-10-16' });
    if (item.outcome.status !== 'completed') throw new Error();
    item.outcome.findings = item.outcome.findings.filter(f => !f.answered);
    expect(agreementEntries([item], null, 'Europe/Warsaw')).toEqual([]);
  });
  it('excludes pending, uncertain, failed, and manual records even when availability or old offers exist', () => {
    const pending = history(confirmedCallFixture); pending.outcome = { status: 'pending' };
    const failed = history(confirmedCallFixture); failed.id = crypto.randomUUID();
    failed.outcome = { status: 'not_booked', reason: 'no_answer', summaryEn: 'No answer.' };
    const manual = history(confirmedCallFixture); manual.id = crypto.randomUUID(); manual.kind = 'manual_mock';
    expect(agreementEntries([pending, failed, manual, history(uncertainCallFixture)], null, 'UTC')).toEqual([]);
  });
  it('uses the subscribed snapshot once and supersedes stale history', () => {
    const call = structuredClone(confirmedCallFixture);
    const stale = history(call); stale.outcome = { status: 'pending' };
    expect(agreementEntries([stale], call, 'UTC')).toHaveLength(1);
    call.outcome = { status: 'pending' };
    expect(agreementEntries([history(confirmedCallFixture)], call, 'UTC')).toEqual([]);
  });
});
describe('monthly calendar', () => {
  it('keeps Monday alignment, leap days and year transitions independent of DST', () => {
    const october = monthDays('2026-10');
    expect(october.slice(0, 4)).toEqual([null, null, null, '2026-10-01']);
    expect(october.filter(Boolean)).toHaveLength(31); expect(october.length % 7).toBe(0);
    expect(monthDays('2028-02').filter(Boolean)).toHaveLength(29);
    expect(monthDays('2026-03').filter(Boolean)).toHaveLength(31);
    expect(shiftMonth('2026-12', 1)).toBe('2027-01'); expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });
});
