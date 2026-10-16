import { expect, it } from 'vitest';
import { awaitingApprovalFixture, connectedCallFixture, confirmedCallFixture, uncertainCallFixture } from '@callmate/contracts/fixtures';
import { callActivityChanges } from '../src/callActivity';

it('reports an exact approval reason and changed offer without treating either as confirmation', () => {
  const items = callActivityChanges(awaitingApprovalFixture, connectedCallFixture);
  expect(items.map(item => item.title)).toEqual(['Offer received · version 2', 'Agent paused for your approval']);
  expect(items[0]!.detail).toContain('€35.00');
  expect(items[1]!.detail).toBe('The service price exceeds your approved maximum.');
  expect(callActivityChanges(awaitingApprovalFixture, awaitingApprovalFixture)).toEqual([]);
});

it('requires the recorded outcome to claim confirmation and preserves uncertain results', () => {
  const readingBack = { ...connectedCallFixture, bookingState: 'reading_back' as const };
  expect(callActivityChanges(readingBack, connectedCallFixture)[0]!.detail).toContain('Business confirmation is still required');
  expect(callActivityChanges(confirmedCallFixture, readingBack).at(-1)!.title).toBe('Business confirmation recorded');
  expect(callActivityChanges(uncertainCallFixture, readingBack).at(-1)!.title).toBe('Result uncertain');
  expect(callActivityChanges({ ...confirmedCallFixture, conversationData: 'deleted', messages: [] })).toEqual([]);
});

it('restores only observable current state and does not invent earlier actions for another call', () => {
  const id = crypto.randomUUID();
  const next = { ...awaitingApprovalFixture, id, pendingApproval: { ...awaitingApprovalFixture.pendingApproval!, attemptId: id } };
  expect(callActivityChanges(next, awaitingApprovalFixture).map(item => item.title)).toEqual(['Offer received · version 2', 'Agent paused for your approval']);
});
