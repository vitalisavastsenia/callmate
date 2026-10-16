// An in-browser fake backend. Production authority and persistence belong to apps/server.
import {
  ApprovalDecisionSchema, CallSnapshotSchema, DomainEventSchema, ReadinessSchema,
  RequestDraftSchema, ReviewPlanSchema, SettingsSchema, StartCallRequestSchema,
  type ApprovalDecision, type CallSnapshot, type DomainEvent, type Offer,
  type RequestDraft, type ReviewPlan, type Scenario, type Settings, type TranscriptMessage,
} from './types';
import { describeTime, money, zonedFromInstant } from './time';

const storeKey = 'zeus-llama.simulator.v1';
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const delay = 1800;
const terminal = (call: CallSnapshot) => ['ended', 'busy', 'no_answer', 'failed'].includes(call.callState);
export const defaultSettings: Settings = {
  defaultCallLimits: { maxDurationSeconds: 300, maxEstimatedCost: { amountMinor: 200, currency: 'EUR' } },
  transcriptRetentionDays: 30,
};
interface Session {
  call: CallSnapshot;
  scenario: Scenario;
  step: number;
  nextAt: number;
  changed: boolean;
  startKey: string;
  startBody: string;
  decisions: Record<string, { body: string }>;
  events: DomainEvent[];
}
interface Store { plans: ReviewPlan[]; sessions: Session[]; settings: Settings }
let memory: Store | undefined;
function read(): Store {
  if (memory) return memory;
  const text = localStorage.getItem(storeKey);
  if (text) {
    try {
      const value = JSON.parse(text) as Store;
      value.plans = value.plans.map(p => ReviewPlanSchema.parse(p));
      value.settings = SettingsSchema.parse(value.settings);
      for (const s of value.sessions) {
        s.call = CallSnapshotSchema.parse(s.call);
        s.events = s.events.map(e => DomainEventSchema.parse(e));
        if (!Number.isInteger(s.step) || !Number.isFinite(s.nextAt) || !s.decisions || typeof s.startKey !== 'string') throw new Error();
      }
      memory = value;
      return value;
    } catch { throw new Error('Saved simulator data is incompatible. Clear the Zeus Llama simulator data in your browser before continuing.'); }
  }
  memory = { plans: [], sessions: [], settings: structuredClone(defaultSettings) };
  return memory;
}
function save() { localStorage.setItem(storeKey, JSON.stringify(read())); }
function copy(call: CallSnapshot): CallSnapshot { return CallSnapshotSchema.parse(structuredClone(call)); }
function find(attemptId: string): Session {
  const session = read().sessions.find(s => s.call.id === attemptId);
  if (!session) throw new Error('Call not found.');
  return session;
}
type EventData = { type: DomainEvent['type']; payload: unknown };
function commit(s: Session, events: EventData[]) {
  s.call.revision++;
  s.call.updatedAt = now();
  for (const event of events) {
    s.call.lastEventSequence++;
    s.events.push(DomainEventSchema.parse({ contractVersion: 1, id: id(), attemptId: s.call.id,
      sequence: s.call.lastEventSequence, snapshotRevision: s.call.revision, occurredAt: now(), ...event }));
  }
  s.call = CallSnapshotSchema.parse(s.call);
  save();
}
function message(s: Session, speaker: 'assistant' | 'business', originalText: string, translationEn: string, playback: TranscriptMessage['playback'] = 'played'): TranscriptMessage {
  const item: TranscriptMessage = { id: id(), turnId: id(), speaker, originalText, translationEn, language: 'es-ES',
    final: true, playback: speaker === 'business' ? 'not_applicable' : playback, createdAt: now() };
  s.call.messages.push(item);
  return item;
}
function finish(s: Session, status: 'not_booked' | 'uncertain', summaryEn: string, reason = 'policy_declined') {
  const approval = s.call.pendingApproval;
  s.call.pendingApproval = null;
  s.call.callState = 'ended'; s.call.bookingState = status;
  s.call.outcome = status === 'uncertain'
    ? { status, reason: 'disconnected_near_confirmation', summaryEn }
    : { status, reason: reason as 'policy_declined' | 'user_stopped' | 'no_answer', summaryEn };
  s.nextAt = 0;
  commit(s, [
    ...(approval ? [{ type: 'approval.resolved' as const, payload: { approvalId: approval.id, offer: { offerId: approval.offer.id, offerVersion: approval.offer.version }, status: 'invalidated' } }] : []),
    { type: 'call.status', payload: { callState: 'ended' } },
    { type: 'booking.updated', payload: { bookingState: s.call.bookingState, outcome: s.call.outcome } },
  ]);
}
function makeOffer(s: Session): Offer {
  const request = s.call.plan.request;
  const start = request.availability[0]!.start;
  const maximum = request.pricePolicy.maximum?.amountMinor;
  const above = ['above_price', 'changed_offer'].includes(s.scenario);
  const appointment = s.scenario === 'alternative'
    ? zonedFromInstant(new Date(Date.parse(request.availability[0]!.end.instant) + 60 * 60_000).toISOString(), start.timeZone) : start;
  const evidence = message(s, 'business', 'Tenemos una cita disponible. El precio incluye el servicio solicitado, sin depósito ni cargos adicionales.', 'We have an appointment available. The price includes the requested service, with no deposit or additional fees.');
  return { id: id(), version: 1, service: request.service, bookingName: request.bookingName, appointment, durationMinutes: null,
    price: { amountMinor: above ? (maximum ?? 3000) + 500 : Math.min(maximum ?? 2500, 2500), currency: 'EUR' },
    conditions: { deposit: 'none', cancellationFee: 'none', paidAddOn: 'none' }, evidenceMessageIds: [evidence.id] };
}
function requestApproval(s: Session, offer: Offer, reason: 'outside_availability' | 'above_price_limit' | 'user_confirmation_required') {
  s.call.activeOffer = offer; s.call.bookingState = 'awaiting_approval';
  s.call.pendingApproval = {
    id: id(), attemptId: s.call.id, plan: { planId: s.call.plan.id, planVersion: s.call.plan.version }, offer, reason,
    createdAt: now(), expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
}
// Custom tasks never enter the appointment-offer/acceptance path. The scripted
// simulator reports unanswered questions and preserves existing bookings.
function taskFindings(request: RequestDraft) {
  const clinic = request.business.name === 'Example clinic' && /documents/i.test(request.goal ?? '');
  return (request.requestType === 'ask' ? request.questions ?? [] : [request.goal!]).map(question => {
    const documents = clinic && /documents.*bring/i.test(question);
    return { question, answered: documents,
      answerEn: documents ? 'In this example, bring identification and relevant medical records.'
        : request.requestType === 'change' ? 'The existing booking was not changed or cancelled. The exact change and any conditions still need confirmation.'
        : 'This scripted simulator has no verified answer to this question. Check with the business.' };
  });
}
function advanceTask(s: Session) {
  const r = s.call.plan.request;
  const step = s.step++;
  if (step === 3) {
    const text = r.requestType === 'change'
      ? ['Hola, soy un asistente de inteligencia artificial. Quisiera consultar cómo modificar o cancelar una cita existente, sin cambiarla todavía.', 'Hello, I am an AI assistant. I would like to ask how to change or cancel an existing appointment, without changing it yet.']
      : ['Hola, soy un asistente de inteligencia artificial. Llamo para hacer unas consultas, sin reservar ni aceptar ningún compromiso.', 'Hello, I am an AI assistant. I am calling to ask some questions, without booking or accepting any commitment.'];
    const m = message(s, 'assistant', text[0]!, text[1]!, s.scenario === 'interrupted' ? 'interrupted' : 'played');
    commit(s, [{ type: 'transcript.updated', payload: m }]);
  } else if (step === 4) {
    const clinic = r.business.name === 'Example clinic' && /documents/i.test(r.goal ?? '');
    const text = r.requestType === 'change'
      ? ['Para modificar o cancelar la cita, necesitamos confirmar los datos y las condiciones. De momento la reserva sigue igual.', 'To change or cancel the appointment, we need to confirm the details and conditions. For now the booking is unchanged.']
      : clinic ? ['Para la primera visita, traiga su documento de identidad y los informes médicos pertinentes. La necesidad de una derivación depende del servicio.', 'For a first visit, bring identification and relevant medical records. Whether a referral is needed depends on the service.']
      : ['En esta simulación no podemos verificar los detalles concretos de su consulta. No se ha realizado ninguna reserva ni cambio.', 'In this simulation we cannot verify the specific details of your request. No booking or change has been made.'];
    commit(s, [{ type: 'transcript.updated', payload: message(s, 'business', text[0]!, text[1]!) }]);
  } else if (step === 5) {
    commit(s, [{ type: 'transcript.updated', payload: message(s, 'assistant', 'Gracias. Informaré a la persona de lo que falta por confirmar. No autorizo ninguna reserva, modificación ni cargo.', 'Thank you. I will tell the owner what still needs confirmation. I am not authorizing any booking, change, or charge.') }]);
  } else {
    if (s.scenario === 'uncertain') return finish(s, 'uncertain', 'The connection was lost before the request could be verified. Check with the business before trying again.');
    const findings = taskFindings(r);
    const resolved = findings.every(f => f.answered);
    s.call.outcome = { status: 'completed', resolution: resolved ? 'resolved' : 'needs_follow_up', findings,
      summaryEn: r.requestType === 'change' ? 'The business explained that a change needs further confirmation. The existing booking is unchanged.'
        : resolved ? 'The requested information was gathered in the simulator.' : 'The simulated call ended with questions still open. No booking, change, or other commitment was made.',
      nextSteps: resolved ? [] : ['Contact the business to verify the open questions before relying on this result.'],
      evidenceMessageIds: s.call.messages.filter(m => m.speaker === 'business' && m.final).slice(1).map(m => m.id) };
    s.call.bookingState = 'completed'; s.call.callState = 'ended'; s.nextAt = 0;
    s.call.usage = { ...s.call.usage, settledTotal: { amountMinor: 12, currency: r.callLimits.maxEstimatedCost.currency }, status: 'settled', measuredAt: now() };
    commit(s, [{ type: 'booking.updated', payload: { bookingState: 'completed', outcome: s.call.outcome } },
      { type: 'call.status', payload: { callState: 'ended' } }, { type: 'usage.updated', payload: s.call.usage }]);
  }
}
function advance(s: Session) {
  if (terminal(s.call)) return;
  const approval = s.call.pendingApproval;
  if (approval && Date.now() >= Date.parse(approval.expiresAt)) {
    s.call.pendingApproval = null; s.call.bookingState = 'pending';
    const expired: EventData = { type: 'approval.resolved', payload: { approvalId: approval.id, offer: { offerId: approval.offer.id, offerVersion: approval.offer.version }, status: 'expired' } };
    commit(s, [expired, { type: 'booking.updated', payload: { bookingState: 'pending', outcome: { status: 'pending' } } }]);
    // Set the consistent terminal result atomically below (no acceptance is generated).
    return finish(s, 'not_booked', 'The approval expired. No appointment was booked.');
  }
  if (Date.now() - Date.parse(s.call.createdAt) >= s.call.plan.request.callLimits.maxDurationSeconds * 1000) {
    return finish(s, 'not_booked', 'The simulator stopped at the approved call-duration limit.', 'user_stopped');
  }
  if (approval) {
    if (s.scenario === 'changed_offer' && !s.changed && Date.now() >= s.nextAt) {
      const offer: Offer = { ...approval.offer, version: approval.offer.version + 1, price: { amountMinor: approval.offer.price!.amountMinor + 500, currency: 'EUR' } };
      s.changed = true;
      requestApproval(s, offer, 'above_price_limit');
      commit(s, [
        { type: 'approval.resolved', payload: { approvalId: approval.id, offer: { offerId: approval.offer.id, offerVersion: approval.offer.version }, status: 'invalidated' } },
        { type: 'offer.updated', payload: offer }, { type: 'approval.requested', payload: s.call.pendingApproval },
        { type: 'booking.updated', payload: { bookingState: 'awaiting_approval', outcome: s.call.outcome } },
      ]);
    }
    return;
  }
  if (!s.nextAt || Date.now() < s.nextAt) return;
  s.nextAt = Date.now() + delay;
  if (s.call.plan.request.requestType && s.call.plan.request.requestType !== 'book' && s.step >= 3) return advanceTask(s);
  const events: EventData[] = [];
  switch (s.step++) {
    case 0:
      if (s.call.plan.request.callLimits.maxEstimatedCost.amountMinor < 20) return finish(s, 'not_booked', 'The estimated call charge exceeds your approved call-spend limit. No call was placed.');
      s.call.callState = 'dialing'; events.push({ type: 'call.status', payload: { callState: 'dialing' } }); break;
    case 1:
      if (s.scenario === 'no_answer') return finish(s, 'not_booked', (s.call.plan.request.requestType ?? 'book') === 'book' ? 'The business did not answer. No appointment was booked.' : 'The destination did not answer. Your request was not completed.', 'no_answer');
      s.call.callState = 'ringing'; events.push({ type: 'call.status', payload: { callState: 'ringing' } }); break;
    case 2:
      s.call.callState = 'connected';
      events.push({ type: 'call.status', payload: { callState: 'connected' } });
      events.push({ type: 'transcript.updated', payload: message(s, 'business', 'Buenos días. ¿En qué puedo ayudarle?', 'Good morning. How can I help?') }); break;
    case 3:
      events.push({ type: 'transcript.updated', payload: message(s, 'assistant', 'Hola, soy un asistente de inteligencia artificial. Llamo para pedir una cita para el servicio solicitado.', 'Hello, I am an AI assistant. I’m calling to arrange ' + s.call.plan.request.service + '.', s.scenario === 'interrupted' ? 'interrupted' : 'played') }); break;
    case 4: {
      if (!s.call.plan.request.bookingName) return finish(s, 'not_booked', 'The business needs a booking name. No name was authorized for sharing, so no appointment was booked.');
      const offer = makeOffer(s);
      s.call.activeOffer = offer;
      events.push({ type: 'transcript.updated', payload: s.call.messages.at(-1)! }, { type: 'offer.updated', payload: offer });
      const reason = s.scenario === 'alternative' ? 'outside_availability' : ['above_price', 'changed_offer'].includes(s.scenario) ? 'above_price_limit' : (s.call.plan.request.bookingAuthority === 'ask_before_accepting' || !!s.call.plan.request.boundaries?.mustAskMe.length) ? 'user_confirmation_required' : null;
      if (reason) {
        events.push({ type: 'transcript.updated', payload: message(s, 'assistant', 'Un momento, por favor. Necesito que la persona apruebe esta propuesta antes de aceptarla.', 'One moment, please. I need the owner to approve this offer before accepting it.') });
        requestApproval(s, offer, reason); s.nextAt = Date.now() + 8000;
        events.push({ type: 'approval.requested', payload: s.call.pendingApproval });
      } else s.call.bookingState = 'reading_back';
      events.push({ type: 'booking.updated', payload: { bookingState: s.call.bookingState, outcome: s.call.outcome } });
      break;
    }
    case 5: {
      const offer = s.call.activeOffer!;
      s.call.bookingState = 'awaiting_business_confirmation';
      events.push({ type: 'transcript.updated', payload: message(s, 'assistant', 'Confirmemos el servicio solicitado: ' + offer.appointment.localDate + ' a las ' + offer.appointment.localTime + ', a nombre de ' + offer.bookingName + ', por ' + (offer.price ? offer.price.amountMinor / 100 + ' euros' : 'un precio no indicado') + ', sin depósito ni cargos adicionales. ¿Puede confirmar la cita?', 'Let’s read back the details before booking: ' + offer.service + ', ' + describeTime(offer.appointment) + ', under ' + offer.bookingName + ', ' + money(offer.price) + ', no deposit, fees or paid add-ons. Can you confirm?') });
      events.push({ type: 'booking.updated', payload: { bookingState: s.call.bookingState, outcome: s.call.outcome } }); break;
    }
    case 6: {
      if (s.scenario === 'uncertain') return finish(s, 'uncertain', 'The call disconnected near confirmation. The appointment may exist. Check with the business before trying again.');
      const offer = s.call.activeOffer!;
      const confirmation = message(s, 'business', 'Sí, la cita queda confirmada con esos datos y ese precio, sin depósito ni cargos adicionales.', 'Yes, the appointment is confirmed with those details and that price, with no deposit or additional fees.');
      s.call.bookingState = 'confirmed';
      s.call.outcome = { status: 'confirmed', offer, confirmedAt: now(), confirmationMessageIds: [confirmation.id], summaryEn: offer.service + ' booked under ' + offer.bookingName + ' for ' + describeTime(offer.appointment) + ', ' + money(offer.price) + '.' };
      events.push({ type: 'transcript.updated', payload: confirmation }, { type: 'booking.updated', payload: { bookingState: 'confirmed', outcome: s.call.outcome } }); break;
    }
    default:
      s.call.callState = 'ended'; s.nextAt = 0;
      s.call.usage = { ...s.call.usage, settledTotal: { amountMinor: 12, currency: s.call.plan.request.callLimits.maxEstimatedCost.currency }, status: 'settled', measuredAt: now() };
      events.push({ type: 'call.status', payload: { callState: 'ended' } }, { type: 'usage.updated', payload: s.call.usage });
  }
  commit(s, events);
}

export function mockReadiness() {
  return ReadinessSchema.parse({ mode: 'simulator', ready: true, voiceEngine: null,
    capabilities: [
      ...['scripted_calls', 'history', 'approvals', 'automatic_retention'].map(name => ({ name, enabled: true, ready: true })),
      ...['manual_mock_calls', 'mock_relay', 'mock_status_callbacks', 'test_rate_budgets', 'live_calls', 'dialogue_integration', 'provider_billing'].map(name => ({ name, enabled: false, ready: false })),
    ],
    checks: ['storage', 'telephony', 'voice', 'dialogue', 'tunnel'].map(name => ({ name, status: name === 'storage' ? 'ready' : 'not_required', message: name === 'storage' ? 'Simulated data stays in this browser.' : 'No provider access in simulator mode.' })) });
}
export function mockSettings(value?: Settings): Settings {
  const store = read();
  if (value) { store.settings = SettingsSchema.parse(value); save(); }
  return structuredClone(store.settings);
}
export function mockPlan(draft: RequestDraft): { plan: ReviewPlan } {
  const plan = ReviewPlanSchema.parse({ id: id(), version: 1, createdAt: now(), request: RequestDraftSchema.parse(draft) });
  read().plans.push(plan); save(); return { plan: structuredClone(plan) };
}
export function mockStart(input: unknown, key: string, scenario: Scenario = 'alternative'): { call: CallSnapshot } {
  const body = StartCallRequestSchema.parse(input);
  if (body.mode !== 'simulator') throw new Error('Simulator mode cannot make real calls.');
  const prior = read().sessions.find(s => s.startKey === key);
  if (prior) {
    if (prior.startBody !== JSON.stringify(body)) throw new Error('IDEMPOTENCY_CONFLICT: this command was used for another plan.');
    return { call: copy(prior.call) };
  }
  if (read().sessions.some(s => { advance(s); return !terminal(s.call); })) throw new Error('CALL_ALREADY_ACTIVE: finish the current call first.');
  const plan = read().plans.find(p => p.id === body.planId && p.version === body.planVersion);
  if (!plan) throw new Error('PLAN_VERSION_MISMATCH: review the current plan first.');
  if (plan.request.templateId && plan.request.templateId !== 'haircut') throw new Error('Select Settings → Backend for domain dialogue templates. The browser simulator uses its existing scripted examples.');
  if (plan.request.language && plan.request.language !== 'es-ES') throw new Error('The browser simulator uses a Spanish script. Select Settings → Backend for multilingual dialogue with the configured model and mock relay.');
  const call = CallSnapshotSchema.parse({ id: id(), revision: 1, lastEventSequence: 0, mode: 'simulator', plan: { ...plan, approvedAt: now() },
    callState: 'creating', bookingState: 'pending', outcome: { status: 'pending' }, activeOffer: null, pendingApproval: null,
    conversationData: 'retained', messages: [], usage: { estimate: { amountMinor: 20, currency: plan.request.callLimits.maxEstimatedCost.currency }, settledTotal: null, status: 'estimated', measuredAt: now() }, createdAt: now(), updatedAt: now() });
  read().sessions.unshift({ call, scenario, step: 0, nextAt: Date.now() + delay, changed: false, startKey: key, startBody: JSON.stringify(body), decisions: {}, events: [] });
  save(); return { call: copy(call) };
}
export function mockCall(attemptId: string): { call: CallSnapshot } {
  const s = find(attemptId); advance(s);
  const age = Date.now() - Date.parse(s.call.updatedAt);
  if (terminal(s.call) && s.call.conversationData === 'retained' && age > read().settings.transcriptRetentionDays * 86400_000) mockDelete(attemptId);
  return { call: copy(s.call) };
}
export function mockDecision(attemptId: string, input: ApprovalDecision, key: string): { call: CallSnapshot } {
  const body = ApprovalDecisionSchema.parse(input);
  const s = find(attemptId); advance(s);
  const previous = s.decisions[key];
  if (previous) {
    if (previous.body !== JSON.stringify(body)) throw new Error('IDEMPOTENCY_CONFLICT: the decision changed.');
    return { call: copy(s.call) };
  }
  const approval = s.call.pendingApproval;
  if (!approval || approval.id !== body.approvalId || approval.offer.id !== body.offer.offerId || approval.offer.version !== body.offer.offerVersion || approval.plan.planId !== body.plan.planId || approval.plan.planVersion !== body.plan.planVersion) throw new Error('APPROVAL_STALE: this offer changed, expired, or closed. Review the latest call.');
  s.decisions[key] = { body: JSON.stringify(body) }; s.call.pendingApproval = null;
  s.call.bookingState = 'reading_back'; s.nextAt = Date.now() + delay;
  commit(s, [{ type: 'approval.resolved', payload: { approvalId: approval.id, offer: body.offer, status: body.decision === 'approve' ? 'approved' : 'rejected' } }, { type: 'booking.updated', payload: { bookingState: s.call.bookingState, outcome: s.call.outcome } }]);
  if (body.decision === 'reject') finish(s, 'not_booked', 'You rejected the offer. No appointment was booked.');
  return { call: copy(s.call) };
}
export function mockStop(attemptId: string): { call: CallSnapshot } {
  const s = find(attemptId); advance(s);
  if (terminal(s.call)) return { call: copy(s.call) };
  if (s.call.outcome.status === 'confirmed' || s.call.outcome.status === 'completed') {
    s.call.callState = 'ended'; s.nextAt = 0;
    commit(s, [{ type: 'call.status', payload: { callState: 'ended' } }]);
  } else if (s.call.bookingState === 'awaiting_business_confirmation') finish(s, 'uncertain', 'You stopped near confirmation. Check with the business before trying again. Stopping does not cancel an appointment.');
  else finish(s, 'not_booked', (s.call.plan.request.requestType ?? 'book') === 'book' ? 'You stopped the call. No appointment was booked.' : 'You stopped the call before the request was completed. No commitments were made.', 'user_stopped');
  return { call: copy(s.call) };
}
export function mockHistory() {
  return { items: read().sessions.map(s => {
    const { call } = mockCall(s.call.id);
    return { id: call.id, mode: call.mode, businessName: call.plan.request.business.name, requestType: call.plan.request.requestType, callState: call.callState, outcome: call.outcome, createdAt: call.createdAt, usage: call.usage, agreementDeletedAt: call.agreementDeletedAt };
  }), nextCursor: null };
}
export function mockDelete(attemptId: string) {
  const s = find(attemptId);
  if (!terminal(s.call)) throw new Error('DATA_NOT_DELETABLE: end the call before deleting the conversation.');
  s.call.messages = []; s.call.conversationData = 'deleted'; s.events = [];
  commit(s, [{ type: 'conversation.deleted', payload: { conversationData: 'deleted' } }]);
  return { attemptId, deleted: true as const };
}
export function mockDeleteAgreement(attemptId: string) {
  const s = find(attemptId);
  if (!terminal(s.call) || !(s.call.outcome.status === 'confirmed'
    || (s.call.outcome.status === 'completed' && s.call.outcome.findings.some(finding => finding.answered))))
    throw new Error('DATA_NOT_DELETABLE: only a saved agreement from a finished call can be deleted.');
  if (!s.call.agreementDeletedAt) {
    const previous = copy(s.call); const eventCount = s.events.length;
    try {
      s.call.agreementDeletedAt = now();
      commit(s, [{ type: 'agreement.deleted', payload: { agreementDeletedAt: s.call.agreementDeletedAt } }]);
    } catch (error) { s.call = previous; s.events.splice(eventCount); throw error; }
  }
  return { call: copy(s.call) };
}
export function mockEvents(attemptId: string): DomainEvent[] { return structuredClone(find(attemptId).events); }
