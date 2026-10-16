import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import Database from 'better-sqlite3';
import { reviewPlanFixture } from '@callmate/contracts/fixtures';
import { LlmSettingsSchema } from '@callmate/contracts';
import { createRuntime } from '../dist/server.js';
import { loadConfig } from '../dist/config.js';
import { authHeaders } from './fixtures/auth.mjs';
import { loadConversations } from '../../../packages/dialogue/test/support/conversations.mjs';

const endpoint = '/api/v1/settings/llm';
const openai = { provider: 'openai', model: 'gpt-6.1-sol', effort: 'medium' };
const claude = { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' };
function fixture(t, env = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'zeus-llm-test-')); let logs = '';
  const config = loadConfig({ CALLMATE_DATA_DIR: join(directory, 'data'), CALLMATE_LLM_SECRETS_DIR: join(directory, 'secrets'),
    NODE_ENV: 'test', TELEPHONY_PROVIDER: 'mock', CALLMATE_LOG_LEVEL: 'info', ...env });
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk; done(); } });
  let runtime = createRuntime(config, stream, undefined, { automatic: false });
  const headers = { host: 'localhost:3000', ...authHeaders(config.dataDir) };
  t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  return { config, directory, headers, get app() { return runtime; }, logs: () => logs,
    request: (method = 'GET', payload, extra = {}) => runtime.privateApi.inject({ url: endpoint, method, headers, ...(payload === undefined ? {} : { payload }), ...extra }),
    async restart() { await runtime.close(); runtime = createRuntime(config, stream, undefined, { automatic: false }); },
    database() { return new Database(join(config.dataDir, 'callmate.sqlite')); } };
}

test('LLM settings are private, same-origin only, strictly validated and secret-free', async t => {
  const f = fixture(t);
  assert.equal((await f.request('GET', undefined, { headers: { host: 'localhost:3000' } })).statusCode, 401);
  assert.equal((await f.request('PUT', { ...openai, apiKeys: { openai: 'test-placeholder-private-key' } },
    { headers: { ...f.headers, origin: 'https://foreign.test' } })).statusCode, 400);
  for (const payload of [{ ...openai, apiKeys: { openai: '' } }, { ...openai, model: null },
    { ...openai, provider: 'untrusted' }, { ...openai, model: 'gpt-5.3-codex', effort: 'max' },
    { ...openai, model: 'custom', effort: 'high' }, { ...openai, endpoint: 'https://untrusted.test' }]) {
    assert.equal((await f.request('PUT', payload)).statusCode, 400);
  }
  const initial = LlmSettingsSchema.parse((await f.request()).json()); assert.equal(initial.provider, 'disabled');
  assert.deepEqual(initial.credentials.openai, { configured: false, usable: false, source: null });
  assert.equal((await f.request('PUT', { ...openai, apiKeys: { openai: 'test-placeholder-private-key' } })).statusCode, 200);
  assert.ok(!f.logs().includes('test-placeholder-private-key'));
});

test('keys are authenticated ciphertext in SQLite/WAL; settings and keys survive restart, replace and delete', async t => {
  const f = fixture(t); const secret = 'test-placeholder-first-private-key';
  const saved = await f.request('PUT', { ...openai, apiKeys: { openai: secret, anthropic: 'test-placeholder-claude-key' } });
  assert.equal(saved.statusCode, 200); assert.ok(!saved.body.includes(secret));
  assert.deepEqual(saved.json().credentials.openai, { configured: true, usable: true, source: 'stored' });
  assert.equal(statSync(join(f.directory, 'secrets')).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.directory, 'secrets/master.key')).mode & 0o777, 0o600);
  const db = f.database();
  try {
    const row = db.prepare('SELECT encrypted_value FROM llm_credentials WHERE provider = ?').get('openai');
    assert.equal(JSON.parse(row.encrypted_value).v, 1); assert.ok(!row.encrypted_value.includes(secret));
    for (const file of ['callmate.sqlite', 'callmate.sqlite-wal']) assert.ok(!readFileSync(join(f.config.dataDir, file)).includes(Buffer.from(secret)));
  } finally { db.close(); }
  await f.restart();
  assert.equal((await f.request()).json().effort, 'medium'); assert.equal(await f.app.development.agent.ready(), true);
  await f.request('PUT', claude); assert.equal((await f.request()).json().credentials.openai.usable, true);
  assert.equal((await f.request('PUT', { ...openai, apiKeys: { openai: 'test-placeholder-replaced-key' } })).statusCode, 200);
  await f.request('PUT', { ...openai, apiKeys: { openai: null } });
  assert.equal((await f.request()).json().credentials.openai.configured, false);
  assert.equal(await f.app.development.agent.ready(), false);
});

test('missing/wrong master key, permissive permissions and provider-swapped ciphertext fail closed', async t => {
  const f = fixture(t);
  await f.request('PUT', { ...openai, apiKeys: { openai: 'test-placeholder-private-key' } });
  const path = join(f.directory, 'secrets/master.key'), master = readFileSync(path);
  rmSync(path);
  assert.equal((await f.request()).json().credentials.openai.usable, false);
  assert.equal(await f.app.development.agent.ready(), false);
  assert.equal((await f.request('PUT', { ...claude, apiKeys: { anthropic: 'test-placeholder-new-key' } })).statusCode, 503);
  writeFileSync(path, Buffer.alloc(32), { mode: 0o600 });
  assert.equal(await f.app.development.agent.ready(), false);
  writeFileSync(path, master); chmodSync(path, 0o644);
  assert.equal(await f.app.development.agent.ready(), false);
  chmodSync(path, 0o600); assert.equal(await f.app.development.agent.ready(), true);
  const db = f.database();
  try { db.exec("INSERT INTO llm_credentials SELECT 'anthropic', encrypted_value FROM llm_credentials WHERE provider = 'openai'"); }
  finally { db.close(); }
  await f.request('PUT', claude);
  assert.equal((await f.request()).json().credentials.anthropic.usable, false);
  assert.equal(await f.app.development.agent.ready(), false);
});

test('storage failure rolls selection and encrypted credentials back atomically', async t => {
  const f = fixture(t);
  await f.request('PUT', { ...openai, apiKeys: { openai: 'test-placeholder-original-key' } });
  const db = f.database();
  try {
    db.exec("CREATE TRIGGER reject_secret BEFORE INSERT ON llm_credentials BEGIN SELECT RAISE(ABORT, 'synthetic private failure'); END");
    const response = await f.request('PUT', { ...claude, apiKeys: { anthropic: 'test-placeholder-private-key' } });
    assert.equal(response.statusCode, 500); assert.ok(!response.body.includes('synthetic private'));
    const current = (await f.request()).json(); assert.equal(current.provider, 'openai'); assert.equal(current.credentials.anthropic.configured, false);
  } finally { db.close(); }
});

test('active calls block every settings/key mutation and become editable after Stop', async t => {
  const f = fixture(t);
  // A scripted call also owns the shared active slot; API secrets remain unchanged.
  const request = structuredClone(reviewPlanFixture.request); const year = new Date().getUTCFullYear() + 1;
  for (const window of request.availability) for (const endpoint of [window.start, window.end]) {
    endpoint.localDate = `${year}-10-20`; endpoint.instant = endpoint.instant.replace(/^\d{4}/, String(year));
  }
  const plan = f.app.simulator.createPlan(request);
  const call = await f.app.simulator.start({ planId: plan.id, planVersion: plan.version, mode: 'simulator' }, randomUUID());
  assert.equal((await f.request()).json().editable, false);
  assert.equal((await f.request('PUT', { ...openai, apiKeys: { openai: 'test-placeholder-blocked-key' } })).statusCode, 409);
  assert.equal((await f.request()).json().credentials.openai.configured, false);
  await f.app.simulator.stop(call.id);
  assert.equal((await f.request()).json().editable, false);
  await f.app.simulator.tick();
  assert.equal((await f.request()).json().editable, true);
});

test('saved API selection immediately drives the real adapter with model/effort/key; no startup request or CLI fallback', async t => {
  const original = globalThis.fetch; const calls = [];
  const turn = loadConversations().find(item => item.id === 'dialogue-ambiguous-time').turns[0];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json(url.includes('anthropic')
      ? { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(turn.proposal) }] }
      : { status: 'completed', error: null, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(turn.proposal) }] }] });
  };
  t.after(() => { globalThis.fetch = original; });
  const f = fixture(t);
  for (const selection of [openai, claude]) {
    await f.request('PUT', { ...selection, apiKeys: { [selection.provider]: 'test-placeholder-provider-key' } });
    assert.equal(calls.length, selection.provider === 'openai' ? 0 : 1);
    assert.deepEqual(await f.app.development.agent.generate(turn.input, new AbortController().signal), turn.proposal);
    const call = calls.at(-1), body = JSON.parse(call.init.body);
    assert.equal(body.model, selection.model);
    assert.equal(selection.provider === 'openai' ? body.reasoning.effort : body.output_config.effort, selection.effort);
    assert.equal(selection.provider === 'openai' ? call.init.headers.Authorization : call.init.headers['x-api-key'],
      selection.provider === 'openai' ? 'Bearer test-placeholder-provider-key' : 'test-placeholder-provider-key');
  }
});

test('legacy environment secrets remain server-only and deleting an override reports the fallback source', async t => {
  const f = fixture(t, { OPENAI_API_KEY: 'test-placeholder-environment-key' });
  assert.equal((await f.request()).json().credentials.openai.source, 'environment');
  await f.request('PUT', { ...openai, apiKeys: { openai: 'test-placeholder-override-key' } });
  assert.equal((await f.request()).json().credentials.openai.source, 'stored');
  await f.request('PUT', { ...openai, apiKeys: { openai: null } });
  const response = await f.request(); assert.equal(response.json().credentials.openai.source, 'environment');
  assert.ok(!response.body.includes('test-placeholder-environment-key'));
});

for (const change of ['provider', 'key']) test(`a ${change} change during Codex preflight rejects Start before reservation`, async t => {
  const f = fixture(t, { CALLMATE_DIALOGUE_PROVIDER: 'codex' });
  const selection = { provider: 'codex', model: null, effort: 'default' };
  await f.request('PUT', { ...selection, apiKeys: { openai: 'test-placeholder-first-key' } });
  const previousPath = process.env.PATH;
  const waiting = join(f.directory, 'waiting'), release = join(f.directory, 'release');
  writeFileSync(join(f.directory, 'codex'), `#!${process.execPath}
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(waiting)}, '');
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(release)})) return;
  clearInterval(timer); console.log('Logged in using ChatGPT');
}, 5);
`, { mode: 0o700 });
  process.env.PATH = `${f.directory}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  const request = structuredClone(reviewPlanFixture.request), year = new Date().getUTCFullYear() + 1;
  for (const window of request.availability) for (const endpoint of [window.start, window.end]) {
    endpoint.localDate = `${year}-10-20`; endpoint.instant = endpoint.instant.replace(/^\d{4}/, String(year));
  }
  const plan = f.app.controller.createPlan(request);
  const starting = f.app.privateApi.inject({ method: 'POST', url: '/api/v1/calls', headers: { ...f.headers, 'idempotency-key': randomUUID() },
    payload: { planId: plan.id, planVersion: plan.version, mode: 'simulator' } });
  // Fastify injection starts on consumption, just like an actual pending request.
  const result = Promise.resolve(starting);
  for (let count = 0; !existsSync(waiting) && count < 500; count++) await delay(5);
  assert.ok(existsSync(waiting));
  assert.equal((await f.request('PUT', change === 'provider' ? { ...openai } : { ...selection, apiKeys: { openai: 'test-placeholder-second-key' } })).statusCode, 200);
  writeFileSync(release, '');
  const response = await result;
  assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'PROVIDER_NOT_READY');
  assert.equal(f.app.controller.history(10).items.length, 0);
});

test('corrupt persisted LLM selection is an internal error and readiness fails closed', async t => {
  const f = fixture(t); await f.request('PUT', openai);
  const db = f.database();
  try { db.prepare('UPDATE llm_settings SET value = ?').run('{"provider":"private-invalid-provider"}'); }
  finally { db.close(); }
  const response = await f.request(); assert.equal(response.statusCode, 500); assert.ok(!response.body.includes('private-invalid-provider'));
  const readiness = await f.app.privateApi.inject({ url: '/api/v1/readiness', headers: f.headers });
  assert.equal(readiness.statusCode, 200); assert.equal(readiness.json().ready, false);
  assert.equal(readiness.json().checks.find(check => check.name === 'configuration').status, 'failed');
});
