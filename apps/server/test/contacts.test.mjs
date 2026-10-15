import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { api } from '@callmate/contracts';
import { reviewPlanFixture } from '@callmate/contracts/fixtures';
import { loadConfig } from '../dist/config.js';
import { createRuntime } from '../dist/server.js';

const details = { name: 'Peluquería Сол', phone: '+34612345678', timeZone: 'Europe/Madrid', tone: ['Very polite'], notes: 'Hablar despacio. Привет.' };
function setup(t) {
  const path = mkdtempSync(join(tmpdir(), 'callmate-contacts-'));
  const config = loadConfig({ CALLMATE_DATA_DIR: path, CALLMATE_LOG_LEVEL: 'silent' });
  let runtime = createRuntime(config);
  t.after(async () => { await runtime.close(); rmSync(path, { recursive: true, force: true }); });
  return {
    async http(method, url, payload, headers = {}) {
      const r = await runtime.privateApi.inject({ method, url, headers: { host: 'localhost:3000', ...headers }, ...(payload === undefined ? {} : { payload }) });
      return { status: r.statusCode, data: r.json() };
    },
    async restart() { await runtime.close(); runtime = createRuntime(config); },
    get runtime() { return runtime; },
  };
}

test('contacts CRUD persists across backend restarts, with Unicode, defaults and idempotent deletion', async t => {
  const app = setup(t);
  const created = await app.http('POST', '/api/v1/contacts', details);
  assert.equal(created.status, 201); const { contact } = api.createContact.response.parse(created.data);
  assert.deepEqual(contact, { ...details, id: contact.id });
  await app.restart();
  assert.deepEqual((await app.http('GET', '/api/v1/contacts')).data.items, [contact]);
  const changed = { ...details, name: 'New name', phone: '+34612345679', tone: [], notes: '' };
  assert.deepEqual((await app.http('PUT', `/api/v1/contacts/${contact.id}`, changed)).data.contact, { ...changed, id: contact.id });
  await app.restart();
  assert.equal((await app.http('GET', '/api/v1/contacts')).data.items[0].name, changed.name);
  for (let i = 0; i < 2; i++) assert.equal((await app.http('DELETE', `/api/v1/contacts/${contact.id}`)).status, 200);
  assert.equal((await app.http('PUT', `/api/v1/contacts/${contact.id}`, changed)).status, 404);
  await app.restart(); assert.deepEqual((await app.http('GET', '/api/v1/contacts')).data.items, []);
});

test('normalized phone uniqueness and validation protect existing records on failed create/update', async t => {
  const app = setup(t);
  const first = (await app.http('POST', '/api/v1/contacts', details)).data.contact;
  const other = (await app.http('POST', '/api/v1/contacts', { ...details, phone: '+34612345679' })).data.contact;
  const duplicate = await app.http('POST', '/api/v1/contacts', { ...details, phone: 'tel:0034 (612) 345-678' });
  assert.equal(duplicate.status, 409); assert.equal(duplicate.data.error.code, 'CONTACT_ALREADY_EXISTS');
  assert.equal((await app.http('PUT', `/api/v1/contacts/${other.id}`, details)).status, 409);
  for (const value of [{ ...details, name: ' ' }, { ...details, phone: 'invalid' }, { ...details, timeZone: 'bad/zone' },
    { ...details, notes: 'x'.repeat(2001) }, { ...details, tone: Array(11).fill('Friendly') }, { ...details, password: 'synthetic-sentinel' }]) {
    const result = await app.http('PUT', `/api/v1/contacts/${first.id}`, value);
    assert.equal(result.status, 400); assert.ok(!JSON.stringify(result.data).includes('synthetic-sentinel'));
  }
  assert.equal((await app.http('DELETE', '/api/v1/contacts/not-a-uuid')).status, 400);
  assert.deepEqual((await app.http('GET', '/api/v1/contacts')).data.items.map(c => c.phone).sort(), [first.phone, other.phone]);
});

test('batch imports are validated atomically and count duplicates in the database and within a batch', async t => {
  const app = setup(t);
  const contacts = [details, { ...details, phone: '+34 612 345 678' }, { ...details, phone: '+34612345679' }];
  assert.deepEqual((await app.http('POST', '/api/v1/contacts/import', { contacts })).data, { imported: 2, duplicates: 1 });
  assert.deepEqual((await app.http('POST', '/api/v1/contacts/import', { contacts })).data, { imported: 0, duplicates: 3 });
  const invalid = await app.http('POST', '/api/v1/contacts/import', { contacts: [{ ...details, phone: '+34612345680' }, { ...details, phone: 'bad' }] });
  assert.equal(invalid.status, 400);
  assert.equal((await app.http('GET', '/api/v1/contacts')).data.items.length, 2);
});

test('contacts stay on the private API and deleting one does not modify an existing plan', async t => {
  const app = setup(t);
  const contact = (await app.http('POST', '/api/v1/contacts', details)).data.contact;
  const draft = { ...structuredClone(reviewPlanFixture.request), contact_id: contact.id };
  const plan = await app.http('POST', '/api/v1/plans', draft); assert.equal(plan.status, 201);
  await app.http('DELETE', `/api/v1/contacts/${contact.id}`);
  // Starting the already reviewed plan still uses its copied destination and contact reference.
  const start = await app.runtime.privateApi.inject({ method: 'POST', url: '/api/v1/calls',
    headers: { host: 'localhost:3000', 'idempotency-key': randomUUID() },
    payload: { planId: plan.data.plan.id, planVersion: 1, mode: 'simulator' } });
  assert.equal(start.statusCode, 202); assert.deepEqual(start.json().call.plan.request, draft);
  for (const headers of [{ origin: 'https://foreign.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await app.http('POST', '/api/v1/contacts', details, headers)).status, 400);
  }
  assert.equal((await app.runtime.callbacks.inject({ url: '/api/v1/contacts' })).statusCode, 404);
});
