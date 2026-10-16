import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationTemplates, conversationTemplateIds, templateForService, RequestDraftSchema, OfferSchema, CandidateActionSchema, DialoguePhraseRefSchema } from '../dist/index.js';
import { reviewPlanFixture, offerFixture } from '../dist/fixtures.js';

for (const profile of conversationTemplates) test(`${profile.id}: reviewed domain details are bounded, required and specific to that profile`, () => {
  const details = Object.fromEntries(profile.fields.map(field => [field.key, field.kind === 'choice' ? field.options[0].value : field.kind === 'number' ? field.min : 'Toyota Corolla']));
  const draft = { ...reviewPlanFixture.request, templateId: profile.id, templateDetails: details, service: profile.aliases[0] };
  assert.deepEqual(RequestDraftSchema.parse(draft).templateDetails, details);
  for (const service of [...profile.aliases, ...profile.service]) assert.equal(templateForService(service).id, profile.id);
  for (const language of ['es-ES', 'ru-RU', 'en-US', 'pl-PL']) assert.equal(DialoguePhraseRefSchema.parse({ id: `${profile.id}.greeting`, version: 1, language }).language, language);
  for (const field of profile.fields) {
    const incomplete = { ...details }; delete incomplete[field.key];
    assert.equal(RequestDraftSchema.safeParse({ ...draft, templateDetails: incomplete }).success, false);
    const wrong = field.kind === 'number' ? 0 : field.kind === 'choice' ? 'not-an-option' : '<voice>bad</voice>';
    assert.equal(RequestDraftSchema.safeParse({ ...draft, templateDetails: { ...details, [field.key]: wrong } }).success, false);
  }
  const extra = profile.fields.some(f => f.key === 'vehicle') ? { species: 'dog' } : { vehicle: 'Toyota Corolla' };
  assert.equal(RequestDraftSchema.safeParse({ ...draft, templateDetails: { ...details, ...extra } }).success, false);
  assert.equal(RequestDraftSchema.safeParse({ ...draft, service: profile.id === 'haircut' ? 'dental appointment' : 'haircut' }).success, false);
  assert.equal(RequestDraftSchema.safeParse({ ...draft, templateDetails: { accountNumber: 'synthetic' } }).success, false);
});

test('exactly 15 templates, safe proposal action and backwards-compatible offer details', () => {
  assert.equal(conversationTemplateIds.length, 15); assert.equal(new Set(conversationTemplates.map(p => p.id)).size, 15);
  assert.equal(CandidateActionSchema.parse({ action: 'ask_requirements' }).action, 'ask_requirements');
  assert.deepEqual(OfferSchema.parse(offerFixture), offerFixture);
  assert.equal(DialoguePhraseRefSchema.safeParse({ id: 'unknown.greeting', version: 1, language: 'en-US' }).success, false);
  assert.equal(RequestDraftSchema.safeParse({ ...reviewPlanFixture.request, templateDetails: { purpose: 'general' } }).success, false);
});
