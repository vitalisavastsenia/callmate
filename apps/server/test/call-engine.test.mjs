import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CallEngineSettingsSchema, TWILIO_NOT_IMPLEMENTED } from '@callmate/contracts';
import { reviewPlanFixture } from '@callmate/contracts/fixtures';
import { createRuntime } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';
import { authHeaders } from './fixtures/auth.mjs';

const path = '/api/v1/settings/call-engine';
async function fixture(t, provider = 'fake', env = {}) {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ mock: true, service: 'CallMate Mock ConversationRelay' })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'zeus-call-engine-'));
  const config = loadConfig({ NODE_ENV: 'test', TELEPHONY_PROVIDER: provider, CALLMATE_DATA_DIR: directory,
    CALLMATE_MOCK_API_BASE: `http://127.0.0.1:${server.address().port}`, CALLMATE_LOG_LEVEL: 'silent', ...env });
  let app = createRuntime(config, undefined, { automatic: false }, { automatic: false });
  const headers = { host: 'localhost:3000', ...authHeaders(directory) };
  t.after(async () => { await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const request = (method = 'GET', payload, extra = {}) => app.privateApi.inject({ url: path, method, headers, ...(payload === undefined ? {} : { payload }), ...extra });
  function plan() {
    const draft = structuredClone(reviewPlanFixture.request), year = new Date().getUTCFullYear() + 1;
    for (const window of draft.availability) for (const endpoint of [window.start, window.end]) {
      endpoint.localDate = `${year}-10-20`; endpoint.instant = endpoint.instant.replace(/^\d{4}/, String(year));
    }
    return app.controller.createPlan(draft);
  }
  return { directory, headers, request, plan, get app() { return app; }, get requests() { return requests; },
    async restart() { await app.close(); app = createRuntime(config, undefined, { automatic: false }, { automatic: false }); },
    start(plan, key = randomUUID()) { return app.privateApi.inject({ method: 'POST', url: '/api/v1/calls', headers: { ...headers, 'idempotency-key': key }, payload: { planId: plan.id, planVersion: plan.version, mode: 'simulator' } }); } };
}

test('call engine settings require owner session/local JSON commands and reject unsupported providers', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('GET', undefined, { headers: { host: 'localhost:3000' } })).statusCode, 401);
  assert.equal((await f.request('PUT', { engine: 'twilio' }, { headers: { ...f.headers, origin: 'https://foreign.test' } })).statusCode, 400);
  for (const payload of [{}, { engine: 'other' }, { engine: 'twilio', token: 'not-accepted' }]) assert.equal((await f.request('PUT', payload)).statusCode, 400);
  const initial = await f.request(); assert.equal(initial.headers['cache-control'], 'no-store');
  assert.deepEqual(CallEngineSettingsSchema.parse(initial.json()), { engine: 'mock', editable: true });
});

test('the selected call engine persists across restart independently of general settings', async t => {
  const f = await fixture(t);
  const settings = (await f.app.privateApi.inject({ url: '/api/v1/settings', headers: f.headers })).json();
  assert.equal((await f.request('PUT', { engine: 'twilio' })).statusCode, 200);
  await f.restart(); assert.deepEqual((await f.request()).json(), { engine: 'twilio', editable: true });
  await f.app.privateApi.inject({ method: 'PUT', url: '/api/v1/settings', headers: f.headers, payload: { ...settings, transcriptRetentionDays: 14 } });
  assert.equal((await f.request()).json().engine, 'twilio'); assert.equal(f.requests, 0);
});

for (const provider of ['fake', 'mock']) test(`Twilio disables ${provider} Starts/readiness without fallback or provider requests`, async t => {
  const f = await fixture(t, provider); await f.request('PUT', { engine: 'twilio' });
  const readiness = (await f.app.privateApi.inject({ url: '/api/v1/readiness', headers: f.headers })).json();
  assert.equal(readiness.ready, false); assert.equal(readiness.voiceEngine, null);
  assert.deepEqual(readiness.checks.find(check => check.name === 'telephony'), { name: 'telephony', status: 'missing', message: TWILIO_NOT_IMPLEMENTED });
  for (const name of ['scripted_calls', 'manual_mock_calls', 'mock_relay', 'mock_status_callbacks', 'live_calls', 'dialogue_integration'])
    assert.deepEqual(readiness.capabilities.find(capability => capability.name === name), { name, enabled: false, ready: false });
  const response = await f.start(f.plan()); assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'PROVIDER_NOT_READY'); assert.equal(response.json().error.message, TWILIO_NOT_IMPLEMENTED);
  const manual = await f.app.privateApi.inject({ method: 'POST', url: '/api/dev/conversations', headers: f.headers,
    payload: { requestId: randomUUID(), initialMessage: 'Hello', language: 'en-US' } });
  assert.equal(manual.statusCode, 503);
  assert.equal(f.app.controller.history(10).items.length, 0); assert.equal(f.requests, 0);
});

test('active and ending calls lock engine changes; old Start replays remain recoverable and mock can be restored', async t => {
  const f = await fixture(t); const plan = f.plan(), key = randomUUID();
  const start = await f.start(plan, key); assert.equal(start.statusCode, 202);
  assert.equal((await f.request()).json().editable, false);
  assert.equal((await f.request('PUT', { engine: 'twilio' })).statusCode, 409);
  await f.app.controller.stop(start.json().call.id);
  assert.equal((await f.request('PUT', { engine: 'twilio' })).statusCode, 409);
  await f.app.simulator.tick();
  assert.equal((await f.request('PUT', { engine: 'twilio' })).statusCode, 200);
  const replay = await f.start(plan, key); assert.equal(replay.statusCode, 202); assert.equal(replay.json().call.id, start.json().call.id);
  assert.equal((await f.start(plan)).statusCode, 503);
  await f.request('PUT', { engine: 'mock' });
  assert.equal((await f.start(plan)).statusCode, 202);
});

test('switching to Twilio during Codex preflight rejects Start before reserving or creating a mock call', async t => {
  const f = await fixture(t, 'mock', { CALLMATE_DIALOGUE_PROVIDER: 'codex' });
  const previousPath = process.env.PATH, waiting = join(f.directory, 'waiting'), release = join(f.directory, 'release');
  writeFileSync(join(f.directory, 'codex'), `#!${process.execPath}
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(waiting)}, '');
const timer = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { clearInterval(timer); console.log('Logged in using ChatGPT'); } }, 5);
`, { mode: 0o700 });
  process.env.PATH = `${f.directory}:${previousPath}`; t.after(() => { process.env.PATH = previousPath; });
  const result = Promise.resolve(f.start(f.plan()));
  for (let i = 0; !existsSync(waiting) && i < 500; i++) await delay(5);
  assert.ok(existsSync(waiting));
  assert.equal((await f.request('PUT', { engine: 'twilio' })).statusCode, 200); writeFileSync(release, '');
  const response = await result; assert.equal(response.statusCode, 503); assert.equal(response.json().error.message, TWILIO_NOT_IMPLEMENTED);
  assert.equal(f.app.controller.history(10).items.length, 0); assert.equal(f.requests, 0);
});
