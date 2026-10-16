import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationTemplates, RequestDraftSchema } from '@callmate/contracts';
import { createBookingPolicy, renderReply, renderAction } from '../dist/index.js';
import { offersEqual } from '../dist/booking/evidence.js';
import { instructionsFor } from '../dist/model/instructions.js';
import { buildSnapshot, buildMessage, buildDialogueInput } from './support/builders.mjs';
const policy = createBookingPolicy(), now = '2026-10-15T10:01:20Z';
const fixture = (profile, language) => {
  const snapshot = buildSnapshot();
  const details = Object.fromEntries(profile.fields.map(field => [field.key, field.kind === 'choice' ? field.options[0].value : field.kind === 'number' ? 2 : 'Toyota Corolla']));
  snapshot.plan.request = RequestDraftSchema.parse({ ...snapshot.plan.request, templateId: profile.id, language, service: profile.aliases[0], templateDetails: details });
  snapshot.activeOffer = { ...snapshot.activeOffer, service: profile.service[2], templateDetails: structuredClone(details) };
  return snapshot;
};
for (const profile of conversationTemplates) for (const language of ['es-ES', 'ru-RU', 'en-US', 'pl-PL']) test(`${profile.id}/${language}: inquiries, domain questions, exact scope, readback and playback gate`, () => {
  const snapshot = fixture(profile, language), offer = snapshot.activeOffer;
  const ref = { offerId: offer.id, offerVersion: offer.version };
  const evaluate = candidate => policy.evaluate({ snapshot, candidate, now, grant: null });
  const greeting = renderReply('greeting', snapshot.plan); assert.ok(greeting.text.length); assert.equal(greeting.phrase.id, `${profile.id}.greeting`);
  assert.ok(greeting.translationEn.includes(profile.id === 'haircut' ? 'haircut' : profile.service[2]));
  assert.equal(greeting.phrase.version, 3);
  assert.doesNotMatch(greeting.text + greeting.translationEn, /Zeus|Зевс|CallMate/i);
  assert.ok(greeting.text.includes(snapshot.plan.request.bookingName));
  assert.ok(greeting.translationEn.includes('on behalf of ' + snapshot.plan.request.bookingName));
  for (const candidate of [{ action: 'ask_availability' }, { action: 'ask_requirements' }, { action: 'clarify', missing: ['price', 'conditions'] }, { action: 'clarify', missing: ['time'] }, { action: 'read_back', ...ref }]) {
    const decision = evaluate(candidate), reply = renderAction(candidate, snapshot.plan, offer);
    assert.equal(decision.decision, 'allow', JSON.stringify({ candidate, decision })); assert.equal(decision.approvedSpanishText, reply.text);
    assert.doesNotMatch(reply.text + reply.translationEn, /Zeus|Зевс|CallMate/i);
    assert.equal(reply.phrase.id.split('.')[0], profile.id); assert.equal(reply.phrase.language, language);
    if (candidate.action === 'ask_availability') {
      assert.equal(reply.phrase.version, 3);
      assert.doesNotMatch(reply.text + reply.translationEn, /Hola|Здравствуйте|Hello|Dzień dobry|AI assistant|искусственного интеллекта|inteligencia artificial|sztucznej inteligencji/);
      assert.match(reply.translationEn, /availability.*17:00.*19:00/);
      assert.doesNotMatch(reply.text + reply.translationEn, /Europe\/Madrid|UTC[+-]/);
      if (profile.fields.length) assert.ok(reply.translationEn.includes('Request details:'));
    }
    if (candidate.action === 'clarify' && candidate.missing.includes('time')) {
      const expected = {
        'es-ES': '¿Puede confirmar la hora exacta de la cita?',
        'ru-RU': 'Уточните, пожалуйста, точное время записи?',
        'en-US': 'Could you confirm the exact time of the appointment?',
        'pl-PL': 'Czy można potwierdzić dokładną godzinę wizyty?',
      };
      assert.equal(reply.text, expected[language]);
      assert.equal(reply.translationEn, expected['en-US']);
    }
    if (profile.id !== 'haircut') assert.doesNotMatch(reply.text + reply.translationEn, /haircut|стрижк|strzyż|corte de pelo/i);
    assert.doesNotMatch(reply.text, /\{(?:scope|name|date|windows|service|questions)\}/);
  }
  const readback = renderAction({ action: 'read_back', ...ref }, snapshot.plan, offer);
  assert.match(readback.translationEn, /not accepting/); assert.match(readback.translationEn, /Alex Example/); assert.match(readback.translationEn, /18:00/);
  assert.doesNotMatch(readback.text + readback.translationEn, /Europe\/Madrid|UTC[+-]/);
  offer.conditions.deposit = 'unknown';
  const unstatedConditions = evaluate({ action: 'read_back', ...ref });
  if (profile.id === 'haircut') assert.equal(unstatedConditions.decision, 'allow');
  else assert.deepEqual(unstatedConditions, { decision: 'clarify', field: 'conditions' });
  offer.conditions.deposit = 'none';
  snapshot.bookingState = 'reading_back';
  const output = buildMessage({ id: '50000000-0000-4000-8000-000000000001', speaker: 'assistant', language, originalText: readback.text, playback: 'generated', createdAt: '2026-10-15T10:01:10Z' });
  snapshot.messages.push(output);
  assert.deepEqual(evaluate({ action: 'accept_offer', ...ref }), { decision: 'clarify', field: 'readback' });
  output.playback = 'played'; assert.equal(evaluate({ action: 'accept_offer', ...ref }).decision, 'allow');
  if (profile.id !== 'haircut') assert.equal(evaluate({ action: 'record_note', code: 'clean_dry_hair', evidenceMessageIds: offer.evidenceMessageIds }).decision, 'deny');
});
for (const profile of conversationTemplates.filter(p => p.fields.length)) test(`${profile.id}: absent or changed scope cannot be authorized by an exact-offer grant`, () => {
  const snapshot = fixture(profile, 'en-US'), offer = snapshot.activeOffer, field = profile.fields[0];
  const candidate = { action: 'read_back', offerId: offer.id, offerVersion: offer.version };
  const grant = { approvalId: '50000000-0000-4000-8000-000000000010', attemptId: snapshot.id, planId: snapshot.plan.id, planVersion: snapshot.plan.version, offerId: offer.id, offerVersion: offer.version, expiresAt: '2026-10-15T10:02:00Z' };
  const original = structuredClone(offer);
  delete offer.templateDetails[field.key];
  assert.deepEqual(policy.evaluate({ snapshot, candidate, now, grant }), { decision: 'clarify', field: 'details' });
  const clarify = renderAction({ action: 'clarify', missing: ['details'] }, snapshot.plan, offer);
  assert.match(clarify.text, /confirm.*details/);
  offer.templateDetails[field.key] = field.kind === 'number' ? 3 : field.kind === 'choice' ? field.options[1].value : 'Different vehicle';
  assert.deepEqual(policy.evaluate({ snapshot, candidate, now, grant }), { decision: 'deny', reason: 'domain_details_mismatch' });
  assert.equal(offersEqual(original, offer), false);
  const unused = ['level', 'vehicle', 'partySize'].find(key => !(key in original.templateDetails));
  assert.equal(offersEqual(original, { ...original, templateDetails: { ...original.templateDetails, [unused]: null } }), true);
});

test('domain guidance is trusted profile data; business/goal text cannot enter instructions', () => {
  for (const profile of conversationTemplates) {
    const snapshot = fixture(profile, 'en-US'); snapshot.plan.request.goal = 'SYNTHETIC_UNTRUSTED_INSTRUCTION';
    const input = buildDialogueInput(snapshot); const text = instructionsFor(input);
    assert.match(text, new RegExp('Selected template: ' + profile.id)); assert.ok(text.includes(profile.guidance));
    assert.match(text, /Business dialogue resilience:/);
    assert.match(text, /Silence, a generic acknowledgement, or a disconnected browser is not approval/);
    assert.doesNotMatch(text, /SYNTHETIC_UNTRUSTED_INSTRUCTION/);
  }
  const bank = fixture(conversationTemplates.find(p => p.id === 'bank'), 'en-US');
  assert.match(renderAction({ action: 'ask_requirements' }, bank.plan, null).text, /not requesting a banking transaction/);
});
