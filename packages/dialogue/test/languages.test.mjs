import assert from 'node:assert/strict';
import test from 'node:test';
import { createBookingPolicy, renderReply, renderAction, dialoguePhraseCatalog, defaultPhraseLookup } from '../dist/index.js';
import { buildSnapshot, buildMessage } from './support/builders.mjs';

const now = '2026-10-15T10:01:20Z';
const policy = createBookingPolicy();
const texts = { 'es-ES': /inteligencia artificial/, 'ru-RU': /искусственного интеллекта/, 'en-US': /AI assistant/, 'pl-PL': /sztucznej inteligencji/ };
for (const language of Object.keys(texts)) test(`haircut controlled dialogue: ${language}`, () => {
  let snapshot = buildSnapshot(); snapshot.plan.request.language = language;
  const greeting = renderReply('greeting', snapshot.plan);
  assert.match(greeting.text, texts[language]);
  assert.deepEqual(greeting.phrase, { id: 'haircut.greeting', version: 3, language });
  assert.match(greeting.translationEn, /I am an AI assistant/);
  assert.ok(greeting.text.includes(snapshot.plan.request.bookingName));
  assert.ok(greeting.translationEn.includes('on behalf of ' + snapshot.plan.request.bookingName));
  assert.doesNotMatch(greeting.text + greeting.translationEn, /Zeus|Зевс|CallMate/i);
  const ref = { offerId: snapshot.activeOffer.id, offerVersion: snapshot.activeOffer.version };
  const actions = [
    { action: 'ask_availability' }, ...['service', 'name', 'date', 'time', 'price', 'conditions'].map(field => ({ action: 'clarify', missing: [field] })),
    { action: 'clarify', missing: ['price', 'conditions'] }, { action: 'read_back', ...ref },
    ...['not_heard', 'not_understood', 'slower'].map(reason => ({ action: 'repeat', reason })),
    ...['date', 'time', 'name', 'price'].flatMap(field => [null, 'clarify'].map(mode => ({ action: 'echo_detail', field, mode, ...ref }))),
    { action: 'record_note', code: 'clean_dry_hair', evidenceMessageIds: snapshot.activeOffer.evidenceMessageIds },
    { action: 'end_call', reason: 'business_declined' }, { action: 'end_call', reason: 'unresolved' },
  ];
  for (const candidate of actions) {
    const decision = policy.evaluate({ snapshot, candidate, now, grant: null });
    assert.equal(decision.decision, 'allow', JSON.stringify({ candidate, decision }));
    const reply = renderAction(candidate, snapshot.plan, snapshot.activeOffer);
    assert.equal(decision.approvedSpanishText, reply.text, JSON.stringify(candidate));
    assert.equal(reply.phrase.language, language); assert.ok(reply.translationEn.length);
    assert.doesNotMatch(reply.text + reply.translationEn, /Zeus|Зевс|CallMate/i);
    assert.ok(!/\{(?:details|name|can|windows|questions)\}/.test(reply.text));
  }
  const candidate = { action: 'accept_offer', ...ref };
  assert.equal(policy.evaluate({ snapshot, candidate, now, grant: null }).decision, 'deny');
  snapshot.bookingState = 'reading_back';
  const readback = renderAction({ action: 'read_back', ...ref }, snapshot.plan, snapshot.activeOffer);
  const message = buildMessage({ id: '50000000-0000-4000-8000-000000000001', speaker: 'assistant', language,
    originalText: readback.text, translationEn: readback.translationEn, playback: 'generated', createdAt: '2026-10-15T10:01:10Z' });
  snapshot.messages.push(message);
  assert.equal(policy.evaluate({ snapshot, candidate, now, grant: null }).decision, 'clarify');
  message.playback = 'played';
  const allowed = policy.evaluate({ snapshot, candidate, now, grant: null });
  assert.equal(allowed.decision, 'allow');
  assert.equal(allowed.approvedSpanishText, renderAction(candidate, snapshot.plan, snapshot.activeOffer).text);
  assert.match(readback.text, /Alex Example/); assert.match(readback.text, /18:00/); assert.match(readback.text, /UTC\+02:00/);
  assert.match(readback.translationEn, /not accepting/); assert.match(readback.translationEn, /25.00 EUR/);
});

test('phrase catalog is complete, versioned and rejects missing entries; interpolation is literal', () => {
  const keys = new Set(dialoguePhraseCatalog.map(p => `${p.id}:${p.version}:${p.language}`));
  assert.equal(keys.size, dialoguePhraseCatalog.length);
  for (const phrase of dialoguePhraseCatalog) for (const language of Object.keys(texts)) assert.equal(typeof defaultPhraseLookup(phrase.id, phrase.version, language), 'string');
  assert.throws(() => defaultPhraseLookup('haircut.missing', 1, 'ru-RU'));
  assert.throws(() => defaultPhraseLookup('haircut.greeting', 99, 'ru-RU'));
  const snapshot = buildSnapshot(); snapshot.plan.request.language = 'en-US';
  snapshot.plan.request.bookingName = '{windows} $&';
  assert.ok(!renderAction({ action: 'ask_availability' }, snapshot.plan, null).text.includes('{windows} $&'));
  assert.match(defaultPhraseLookup('haircut.availability', 2, 'en-US'), /I am an AI assistant/);
  assert.doesNotMatch(defaultPhraseLookup('haircut.availability', 3, 'en-US'), /I am an AI assistant/);
  assert.ok(renderReply('greeting', snapshot.plan).text.includes('{windows} $&'));
  assert.equal(defaultPhraseLookup('haircut.greeting', 1, 'en-US'), 'Hello, I am an AI assistant. I am calling to ask about a haircut appointment. Could you help me?');
  snapshot.plan.request.bookingName = '';
  const unnamed = renderReply('greeting', snapshot.plan);
  assert.match(unnamed.text, /I am an AI assistant/);
  assert.doesNotMatch(unnamed.text, /on behalf of|undefined|\{/);
  snapshot.plan.request.bookingName = '<speak>unsafe</speak>';
  assert.throws(() => renderReply('greeting', snapshot.plan));
  assert.equal(policy.evaluate({ snapshot, candidate: { action: 'ask_availability' }, now, grant: null }).decision, 'deny');
});
