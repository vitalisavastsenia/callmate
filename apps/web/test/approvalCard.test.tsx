import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { awaitingApprovalFixture } from '@callmate/contracts/fixtures';
import { ApprovalCard } from '../src/components/CallViews';
import type { CallSnapshot } from '../src/types';

const now = Date.parse('2026-10-15T10:01:15Z');
function render(call: CallSnapshot, compact: boolean, disabled = false, at = now) {
  const html = renderToStaticMarkup(createElement(ApprovalCard, { call, compact, disabled, now: at, onDecision: () => {} }));
  const button = (label: string) => html.match(new RegExp(`<button([^>]*)>${label}</button>`))![1]!;
  return { html, approve: button('Approve this offer'), reject: button('Reject offer') };
}
function haircut() {
  const call = structuredClone(awaitingApprovalFixture);
  call.pendingApproval!.offer.price = { amountMinor: 5000, currency: 'EUR' };
  call.pendingApproval!.offer.conditions = { deposit: 'unknown', cancellationFee: 'unknown', paidAddOn: 'unknown' };
  return call;
}

describe.each([false, true])('exact-offer approval (compact: %s)', compact => {
  it.each([undefined, 'haircut'] as const)('allows an above-limit haircut with unstated conditions (template: %s)', templateId => {
    const call = haircut();
    if (templateId) call.plan.request.templateId = templateId;
    const card = render(call, compact);
    expect(card.approve).not.toContain('disabled');
    expect(card.reject).not.toContain('disabled');
    expect(card.html).not.toContain('role="alert"');
    expect(card.html).toContain('Deposit: unknown; cancellation fee: unknown; paid add-on: unknown');
    if (!compact) {
      expect(card.html).toContain('Offered service price €50.00; your maximum €30.00.');
    }
  });

  it.each(['deposit', 'cancellationFee', 'paidAddOn'] as const)('blocks an explicitly required %s even for a haircut', condition => {
    const call = haircut();
    call.pendingApproval!.offer.conditions[condition] = 'required';
    const card = render(call, compact);
    expect(card.approve).toContain('disabled');
    expect(card.reject).not.toContain('disabled');
    expect(card.html).toContain('This offer requires a deposit, cancellation fee, or paid add-on.');
  });

  it('requires clarification for unknown conditions in other templates', () => {
    const call = haircut();
    call.plan.request.templateId = 'dentist';
    const card = render(call, compact);
    expect(card.approve).toContain('disabled');
    expect(card.reject).not.toContain('disabled');
    expect(card.html).toContain('The business must confirm');
    call.pendingApproval!.offer.conditions = { deposit: 'none', cancellationFee: 'none', paidAddOn: 'none' };
    expect(render(call, compact).approve).not.toContain('disabled');
  });

  it('keeps decisions disabled while unavailable and at the expiry deadline', () => {
    for (const card of [render(haircut(), compact, true), render(haircut(), compact, false, Date.parse(haircut().pendingApproval!.expiresAt))]) {
      expect(card.approve).toContain('disabled');
      expect(card.reject).toContain('disabled');
    }
  });
});
