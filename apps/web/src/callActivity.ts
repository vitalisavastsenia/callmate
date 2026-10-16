import type { CallSnapshot } from './types';
import { describeTime, money } from './time';

export interface CallActivity { id: string; at: string; title: string; detail: string }
export const approvalReasons = {
  outside_availability: 'The proposed time is outside your approved availability.',
  above_price_limit: 'The service price exceeds your approved maximum.',
  unknown_price: 'The service price is unknown and needs your permission.',
  user_confirmation_required: 'You asked to approve every offer.',
};
// Summaries of observed authoritative state only; never infer unreported model reasoning.
export function callActivityChanges(next: CallSnapshot, previous?: CallSnapshot | null): CallActivity[] {
  const old = previous?.id === next.id ? previous : undefined;
  const items: CallActivity[] = [];
  const add = (kind: string, title: string, detail: string) => items.push({ id: `${next.id}:${next.revision}:${kind}`, at: next.updatedAt, title, detail });
  if (next.conversationData === 'deleted') return items;
  if (next.activeOffer && (old?.activeOffer?.id !== next.activeOffer.id || old.activeOffer.version !== next.activeOffer.version)) {
    const offer = next.activeOffer;
    add('offer', `Offer received · version ${offer.version}`, `${describeTime(offer.appointment)} · ${offer.price ? money(offer.price) : 'Price unknown'}. An offer is not a confirmed booking.`);
  }
  if (next.pendingApproval && old?.pendingApproval?.id !== next.pendingApproval.id) {
    add('approval', 'Agent paused for your approval', approvalReasons[next.pendingApproval.reason]);
  }
  if (next.bookingState !== old?.bookingState) {
    if (next.bookingState === 'reading_back') add('readback', 'Agent is reading back the offer', 'The workflow has moved to read-back. Business confirmation is still required; check the transcript for speech playback status.');
    if (next.bookingState === 'awaiting_business_confirmation') add('confirmation', 'Agent is waiting for business confirmation', 'The offer has not yet been recorded as a confirmed booking.');
  }
  if (next.outcome.status !== 'pending' && next.outcome.status !== old?.outcome.status) {
    add('outcome', next.outcome.status === 'confirmed' ? 'Business confirmation recorded' : next.outcome.status === 'uncertain' ? 'Result uncertain' : 'Call result recorded', next.outcome.summaryEn);
  }
  return items;
}
