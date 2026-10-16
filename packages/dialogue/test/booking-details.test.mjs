import assert from 'node:assert/strict';
import test from 'node:test';
import { createBookingPolicy, defaultPhraseLookup, renderAction } from '../dist/index.js';
import { instructionsFor } from '../dist/model/instructions.js';
import { buildDialogueInput, buildSnapshot } from './support/builders.mjs';

const now = '2026-10-15T10:01:20Z';
const policy = createBookingPolicy();
const candidate = { action: 'clarify', missing: ['name', 'price', 'conditions'] };
const ownPhone = '+12025550199';
const localizedBookingDetails = {
  'es-ES': `Por favor, reserve una cita para un corte de pelo a nombre de Alex Example, teléfono de contacto: ${ownPhone}.`,
  'ru-RU': `Запишите, пожалуйста, на стрижку на имя Alex Example, телефон для связи: ${ownPhone}.`,
  'en-US': `Please book a haircut appointment under the name Alex Example, contact phone: ${ownPhone}.`,
  'pl-PL': `Proszę zarezerwować strzyżenie na nazwisko Alex Example, telefon kontaktowy: ${ownPhone}.`,
};
const evaluate = (snapshot, action = candidate) => policy.evaluate({ snapshot, candidate: action, now, grant: null });

for (const language of ['es-ES', 'ru-RU', 'en-US', 'pl-PL']) {
  test(`haircut booking details/${language}: reviewed name and callback replace the questionnaire`, () => {
    const snapshot = buildSnapshot();
    snapshot.plan.request.language = language;
    snapshot.plan.request.shareableContact = { phone: ownPhone, email: 'private@example.invalid' };
    const before = structuredClone(snapshot);
    const reply = renderAction(candidate, snapshot.plan, snapshot.activeOffer);
    assert.equal(reply.phrase.id, 'haircut.booking_details');
    assert.deepEqual(evaluate(snapshot), { decision: 'allow', approvedSpanishText: reply.text });
    for (const text of [reply.text, reply.translationEn]) {
      assert.ok(text.includes(snapshot.plan.request.bookingName));
      assert.ok(text.includes(ownPhone));
      assert.ok(!text.includes(snapshot.plan.request.business.phone));
      assert.doesNotMatch(text, /\?|deposit|prepayment|cancellation|extras|private@example|undefined|\{contact\}/i);
    }
    assert.equal(reply.translationEn, `Please book a haircut appointment under the name Alex Example, contact phone: ${ownPhone}.`);
    assert.equal(reply.text, localizedBookingDetails[language]);
    assert.deepEqual(snapshot, before);

    snapshot.plan.request.shareableContact.phone = null;
    const withoutPhone = renderAction(candidate, snapshot.plan, snapshot.activeOffer);
    assert.ok(withoutPhone.text.includes('Alex Example'));
    assert.doesNotMatch(withoutPhone.text + withoutPhone.translationEn, /\+\d|phone|телефон|teléfono|telefon|undefined|null/);

    const price = renderAction({ action: 'clarify', missing: ['price', 'conditions'] }, snapshot.plan, snapshot.activeOffer);
    assert.equal(price.phrase.id, 'haircut.clarification');
    assert.equal(price.translationEn, 'Could you confirm the total price of the haircut?');
    const conditions = renderAction({ action: 'clarify', missing: ['conditions'] }, snapshot.plan, snapshot.activeOffer);
    assert.equal(conditions.phrase.id, 'haircut.booking_details');
  });
}

test('booking details do not bypass price/time authority or repeated acceptance', () => {
  const snapshot = buildSnapshot();
  snapshot.activeOffer.price.amountMinor = 10000;
  assert.deepEqual(evaluate(snapshot), { decision: 'ask_user', reason: 'above_price_limit' });
  snapshot.activeOffer.price.amountMinor = 2500;
  snapshot.activeOffer.conditions.deposit = 'required';
  assert.deepEqual(evaluate(snapshot), { decision: 'deny', reason: 'prohibited_conditions' });
  snapshot.activeOffer.conditions.deposit = 'none';
  snapshot.bookingState = 'reading_back';
  assert.deepEqual(evaluate(snapshot), { decision: 'deny', reason: 'commitment_in_progress' });
});

test('missing reviewed name is not invented and untrusted markup cannot enter the reply', () => {
  const snapshot = buildSnapshot();
  snapshot.plan.request.bookingName = '';
  const reply = renderAction({ action: 'clarify', missing: ['name'] }, snapshot.plan, snapshot.activeOffer);
  assert.equal(reply.phrase.id, 'haircut.clarification');
  assert.doesNotMatch(reply.text + reply.translationEn, /Alex Example|\+\d/);
  snapshot.plan.request.bookingName = '<speech>Other Person</speech>';
  assert.equal(evaluate(snapshot).decision, 'deny');
});

test('haircut readback does not invent absent charges; prior catalog versions stay readable', () => {
  const snapshot = buildSnapshot();
  snapshot.plan.request.language = 'en-US';
  snapshot.activeOffer.conditions = { deposit: 'unknown', cancellationFee: 'unknown', paidAddOn: 'unknown' };
  const before = structuredClone(snapshot);
  const action = { action: 'read_back', offerId: snapshot.activeOffer.id, offerVersion: snapshot.activeOffer.version };
  assert.equal(evaluate(snapshot, action).decision, 'allow');
  const reply = renderAction(action, snapshot.plan, snapshot.activeOffer);
  assert.doesNotMatch(reply.text + reply.translationEn, /deposit|cancellation fee|paid extras/);
  assert.deepEqual(snapshot, before);
  assert.match(defaultPhraseLookup('haircut.details', 2, 'en-US'), /no deposit/);
  assert.doesNotMatch(defaultPhraseLookup('haircut.details', 3, 'en-US'), /deposit/);
  const instructions = instructionsFor(buildDialogueInput(snapshot));
  assert.match(instructions, /Do not proactively ask about deposits/);
  assert.match(instructions, /never claim they are absent/i);
});
