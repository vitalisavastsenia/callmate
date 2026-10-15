import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { reviewPlanFixture } from '@callmate/contracts/fixtures';
import { CallSnapshotSchema, DomainEventSchema, type ApprovalDecision, type CallSnapshot, type Scenario } from '../src/types';

let mock: typeof import('../src/mock');
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T10:00:00Z'));
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
  vi.resetModules(); mock = await import('../src/mock');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function begin(scenario: Scenario = 'within_plan') {
  const { plan } = mock.mockPlan(reviewPlanFixture.request);
  const body = { planId: plan.id, planVersion: plan.version, mode: 'simulator' };
  return { plan, body, call: mock.mockStart(body, crypto.randomUUID(), scenario).call };
}
function ticks(id: string, count: number) {
  let call!: CallSnapshot;
  for (let i = 0; i < count; i++) { vi.advanceTimersByTime(1800); call = mock.mockCall(id).call; }
  return call;
}
function decision(call: CallSnapshot, value: 'approve' | 'reject' = 'approve'): ApprovalDecision {
  const a = call.pendingApproval!;
  return { approvalId: a.id, plan: a.plan, offer: { offerId: a.offer.id, offerVersion: a.offer.version }, decision: value };
}
describe('shared-contract simulator', () => {
  it('saves the approved plan, starts once, and requires business evidence for confirmation', () => {
    const { call, body } = begin();
    expect(() => mock.mockStart(body, crypto.randomUUID())).toThrow('CALL_ALREADY_ACTIVE');
    const key = crypto.randomUUID(); mock.mockStop(call.id);
    const next = mock.mockStart(body, key, 'within_plan').call;
    expect(mock.mockStart(body, key, 'within_plan').call.id).toBe(next.id);
    const reading = ticks(next.id, 6);
    expect(reading.bookingState).toBe('awaiting_business_confirmation');
    expect(reading.outcome.status).toBe('pending');
    const confirmed = ticks(next.id, 1);
    expect(confirmed.outcome.status).toBe('confirmed');
    expect(CallSnapshotSchema.safeParse(confirmed).success).toBe(true);
    expect(mock.mockEvents(next.id).every(e => DomainEventSchema.safeParse(e).success)).toBe(true);
  });
  it('ties approval to the exact offer and never treats approval itself as confirmation', () => {
    const { call } = begin('alternative');
    const waiting = ticks(call.id, 5);
    expect(waiting.pendingApproval?.reason).toBe('outside_availability');
    const key = crypto.randomUUID(); const body = decision(waiting);
    const approved = mock.mockDecision(call.id, body, key).call;
    expect(approved.outcome.status).toBe('pending');
    expect(mock.mockDecision(call.id, body, key).call.id).toBe(call.id);
    expect(ticks(call.id, 2).outcome.status).toBe('confirmed');
  });
  it.each(['reject', 'expire'] as const)('ends without booking on %s', action => {
    const { call } = begin('above_price'); const waiting = ticks(call.id, 5);
    if (action === 'reject') mock.mockDecision(call.id, decision(waiting, 'reject'), crypto.randomUUID());
    else vi.advanceTimersByTime(30_001);
    const ended = mock.mockCall(call.id).call;
    expect(ended.outcome.status).toBe('not_booked'); expect(ended.pendingApproval).toBeNull();
    expect(() => mock.mockDecision(call.id, decision(waiting), crypto.randomUUID())).toThrow('APPROVAL_STALE');
  });
  it('invalidates old offer versions while the card is open', () => {
    const { call } = begin('changed_offer'); const old = ticks(call.id, 5);
    vi.advanceTimersByTime(8001); const next = mock.mockCall(call.id).call;
    expect(next.pendingApproval!.offer.version).toBe(old.pendingApproval!.offer.version + 1);
    expect(() => mock.mockDecision(call.id, decision(old), crypto.randomUUID())).toThrow('APPROVAL_STALE');
    expect(next.outcome.status).toBe('pending');
  });
  it('reports uncertainty, stops safely, and retains an already confirmed booking on Stop', () => {
    const first = begin('uncertain').call;
    expect(ticks(first.id, 7).outcome.status).toBe('uncertain');
    const second = begin().call;
    expect(mock.mockStop(second.id).call.outcome.status).toBe('not_booked');
    const third = begin().call; ticks(third.id, 7);
    expect(mock.mockStop(third.id).call.outcome.status).toBe('confirmed');
  });
  it('respects call limits and treats Stop near confirmation as uncertain', () => {
    const { call } = begin(); ticks(call.id, 6);
    expect(mock.mockStop(call.id).call.outcome.status).toBe('uncertain');
    const request = structuredClone(reviewPlanFixture.request); request.callLimits.maxEstimatedCost.amountMinor = 1;
    const { plan } = mock.mockPlan(request);
    const capped = mock.mockStart({ planId: plan.id, planVersion: 1, mode: 'simulator' }, crypto.randomUUID(), 'within_plan').call;
    const ended = ticks(capped.id, 1);
    expect(ended.outcome.status).toBe('not_booked');
    expect(ended.messages).toEqual([]);
  });
  it('restores the same attempt across module reload and deletes transcript replay data', async () => {
    const { call } = begin(); ticks(call.id, 8);
    const spanish = mock.mockCall(call.id).call.messages[0]!.originalText;
    vi.resetModules(); mock = await import('../src/mock');
    expect(mock.mockCall(call.id).call.outcome.status).toBe('confirmed');
    mock.mockDelete(call.id);
    expect(mock.mockCall(call.id).call.messages).toEqual([]);
    expect(mock.mockHistory().items[0]!.outcome.status).toBe('confirmed');
    expect(localStorage.getItem('zeus-llama.simulator.v1')).not.toContain(spanish);
  });
});

describe('generic task simulation', () => {
  function task(kind: 'ask' | 'change' | 'other') {
    const request = { ...structuredClone(reviewPlanFixture.request), requestType: kind,
      goal: 'Find out the information I need.', timeZone: 'Europe/Madrid', service: '', bookingName: '', availability: [],
      questions: kind === 'ask' ? ['What do I need to bring?'] : [],
      changeRequest: kind === 'change' ? { description: 'Cancel my existing visit without a fee.', bookingReference: 'VET-123' } : null,
      boundaries: { canDecideAlone: [], mustAskMe: ['Ask before any commitment.'] },
      callLimits: { maxDurationSeconds: 300, maxEstimatedCost: { amountMinor: 200, currency: 'EUR' as const } } };
    const { plan } = mock.mockPlan(request);
    return { plan, call: mock.mockStart({ planId: plan.id, planVersion: 1, mode: 'simulator' }, crypto.randomUUID(), 'within_plan').call };
  }
  it.each(['ask', 'change', 'other'] as const)('%s never fabricates a booking or reuses the appointment script', async kind => {
    const { call } = task(kind);
    const ended = ticks(call.id, 7);
    expect(ended.callState).toBe('ended'); expect(ended.activeOffer).toBeNull(); expect(ended.pendingApproval).toBeNull();
    expect(ended.outcome.status).toBe('completed');
    if (ended.outcome.status !== 'completed') throw new Error('Expected information result');
    expect(ended.outcome.resolution).toBe('needs_follow_up');
    expect(ended.outcome.findings[0]!.answered).toBe(false);
    expect(ended.usage.estimate?.currency).toBe('EUR'); expect(ended.usage.settledTotal?.currency).toBe('EUR');
    expect(mock.mockEvents(call.id).every(e => DomainEventSchema.safeParse(e).success)).toBe(true);
    const { calendarText } = await import('../src/calendar');
    expect(() => calendarText(ended)).toThrow('Only confirmed bookings');
    vi.resetModules(); mock = await import('../src/mock');
    expect(mock.mockCall(call.id).call.outcome).toEqual(ended.outcome);
    expect(mock.mockHistory().items[0]!.requestType).toBe(kind);
    mock.mockDelete(call.id);
    expect(mock.mockCall(call.id).call.messages).toEqual([]);
    expect(mock.mockCall(call.id).call.outcome).toEqual(ended.outcome);
  });
  it('keeps questions and boundaries in the approved plan and records incomplete clinic answers honestly', () => {
    const request = { ...task('ask').plan.request, business: { name: 'Example clinic', phone: '+12025550123' },
      goal: 'Find out which documents I need for my first visit.', questions: ['Which documents should I bring?', 'Do I need a referral?'] };
    const current = mock.mockHistory().items[0]!; mock.mockStop(current.id);
    const { plan } = mock.mockPlan(request);
    const call = mock.mockStart({ planId: plan.id, planVersion: 1, mode: 'simulator' }, crypto.randomUUID(), 'within_plan').call;
    expect(call.plan.request.boundaries).toEqual(request.boundaries);
    const ended = ticks(call.id, 7);
    if (ended.outcome.status !== 'completed') throw new Error('Expected information result');
    expect(ended.outcome.findings.map(f => f.question)).toEqual(request.questions);
    expect(ended.outcome.findings.map(f => f.answered)).toEqual([true, false]);
    expect(ended.outcome.resolution).toBe('needs_follow_up');
  });
});
