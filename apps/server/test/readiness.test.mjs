import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Database from 'better-sqlite3';
import { CapabilitySchema, ReadinessSchema } from '@callmate/contracts';
import { configurationValid, loadConfig } from '../dist/config.js';
import { createRuntime } from '../dist/server.js';
import { Readiness } from '../dist/readiness.js';

const capabilities = (report) => Object.fromEntries(report.capabilities.map((c) => [c.name, c]));
const check = (report, name) => report.checks.find((c) => c.name === name);
async function fixture(t, env = {}, health = {}) {
  const requests = []; let logs = '';
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    assert.equal(req.method, 'GET'); assert.equal(req.url, '/healthz');
    if (health.hang) return;
    if (health.delay) await delay(health.delay);
    res.writeHead(health.status ?? 200, { 'content-type': 'application/json', ...(health.headers ?? {}) });
    res.end(health.raw ?? JSON.stringify(health.body ?? { mock: true, service: 'CallMate Mock ConversationRelay' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dataDir = mkdtempSync(join(tmpdir(), 'callmate-readiness-'));
  const config = loadConfig({ CALLMATE_DATA_DIR: dataDir, CALLMATE_LOG_LEVEL: 'info', NODE_ENV: 'test', TELEPHONY_PROVIDER: 'mock',
    CALLMATE_MOCK_API_BASE: `http://127.0.0.1:${server.address().port}`, ...env });
  const runtime = createRuntime(config, new Writable({ write(chunk, _encoding, done) { logs += chunk; done(); } }), { automatic: false }, { automatic: false });
  t.after(async () => {
    await runtime.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { runtime, config, dataDir, requests, health, get logs() { return logs; }, async report() {
    const response = await runtime.privateApi.inject({ url: '/api/v1/readiness', headers: { host: 'localhost:3000' } });
    assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
    return ReadinessSchema.parse(response.json());
  } };
}

test('healthy mock reports validated prerequisites and enabled capabilities without calls or database writes', async (t) => {
  const app = await fixture(t, { CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE: '60' });
  const db = new Database(join(app.dataDir, 'callmate.sqlite'));
  try {
    const before = db.prepare('SELECT * FROM app_settings').all();
    const report = await app.report(); assert.equal(report.ready, true); assert.equal(report.voiceEngine, null);
    for (const name of ['storage', 'configuration', 'mock']) assert.equal(check(report, name).status, 'ready');
    const caps = capabilities(report);
    for (const name of ['scripted_calls', 'manual_mock_calls', 'mock_relay', 'mock_status_callbacks', 'history', 'approvals', 'automatic_retention', 'test_rate_budgets']) {
      assert.equal(caps[name].enabled, true); assert.equal(caps[name].ready, true);
    }
    for (const name of ['live_calls', 'dialogue_integration', 'provider_billing']) assert.deepEqual(caps[name], { name, enabled: false, ready: false });
    assert.equal(new Set(report.checks.map((c) => c.name)).size, report.checks.length);
    assert.equal(new Set(report.capabilities.map((c) => c.name)).size, report.capabilities.length);
    assert.deepEqual(app.requests, [{ method: 'GET', url: '/healthz' }]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM call_attempts').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM commands').get().n, 0);
    assert.deepEqual(db.prepare('SELECT * FROM app_settings').all(), before);
  } finally { db.close(); }
});

test('mock outage degrades overall readiness while local scripted capabilities and health remain available', async (t) => {
  const app = await fixture(t, {}, { status: 503 });
  const report = await app.report(); assert.equal(report.ready, false);
  assert.equal(check(report, 'mock').status, 'failed');
  const caps = capabilities(report);
  assert.deepEqual(caps.manual_mock_calls, { name: 'manual_mock_calls', enabled: true, ready: false });
  assert.equal(caps.scripted_calls.ready, true); assert.equal(caps.history.ready, true);
  assert.equal(caps.test_rate_budgets.enabled, false);
  const health = await app.runtime.privateApi.inject({ url: '/health', headers: { host: 'localhost:3000' } });
  assert.equal(health.statusCode, 200); assert.equal(app.requests.length, 1);
  app.health.status = 200; assert.equal((await app.report()).ready, true); assert.equal(app.requests.length, 2);
});

test('disabled, production and live mock gates never probe the provider', async (t) => {
  for (const env of [{ TELEPHONY_PROVIDER: 'fake' }, { NODE_ENV: 'production' }, { CALLMATE_MODE: 'live' }]) {
    const app = await fixture(t, env, { status: 503 });
    const report = await app.report(); const caps = capabilities(report);
    assert.equal(report.ready, env.CALLMATE_MODE !== 'live'); assert.equal(check(report, 'mock').status, 'not_required');
    assert.equal(caps.manual_mock_calls.enabled, false); assert.equal(caps.mock_relay.ready, false);
    assert.equal(caps.live_calls.enabled, false); assert.equal(app.requests.length, 0);
    if (env.CALLMATE_MODE === 'live') {
      assert.equal(caps.scripted_calls.enabled, false); assert.equal(caps.approvals.enabled, false);
      for (const name of ['telephony', 'voice', 'dialogue', 'tunnel']) assert.equal(check(report, name).status, 'missing');
    }
  }
});

test('unresponsive mock probe is bounded and concurrent requests share one request', async (t) => {
  const app = await fixture(t, {}, { hang: true }); const start = Date.now();
  const reports = await Promise.all(Array.from({ length: 6 }, () => app.report()));
  assert.ok(Date.now() - start < 5000); assert.equal(app.requests.length, 1);
  for (const report of reports) { assert.equal(report.ready, false); assert.equal(check(report, 'mock').status, 'failed'); }
});

test('wrong service, malformed/oversized/truncated responses and redirects fail without echoing remote data', async (t) => {
  const app = await fixture(t, { MOCK_API_PASSWORD: 'PRIVATE-MOCK-PASSWORD', MOCK_AUTH_TOKEN: 'PRIVATE-SIGNING-TOKEN' });
  for (const response of [
    { body: { mock: false, service: 'PRIVATE-REMOTE-DETAIL' } },
    { raw: 'PRIVATE-INVALID-JSON' },
    { raw: 'PRIVATE-' + 'x'.repeat(65536) },
    { status: 302, headers: { location: 'http://127.0.0.1:1/PRIVATE-REDIRECT' } },
    { raw: '{"mock":true,' },
  ]) {
    Object.assign(app.health, { raw: undefined, body: undefined, headers: undefined, status: 200 }, response);
    const report = await app.report(); assert.equal(report.ready, false); assert.equal(check(report, 'mock').status, 'failed');
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes('PRIVATE-')); assert.ok(!serialized.includes(app.config.mockApiBase));
  }
  assert.equal(app.requests.length, 5); assert.ok(!app.logs.includes('PRIVATE-'));
});

test('a refused connection reports a failed mock check instead of an HTTP error', async (t) => {
  const app = await fixture(t);
  const unused = createServer(); await new Promise((resolve) => unused.listen(0, '127.0.0.1', resolve));
  app.config.mockApiBase = `http://127.0.0.1:${unused.address().port}`;
  await new Promise((resolve) => unused.close(resolve));
  const report = await app.report(); assert.equal(report.ready, false); assert.equal(check(report, 'mock').status, 'failed');
});

test('corrupt settings disable dependent capabilities without exposing values or probing the mock', async (t) => {
  const app = await fixture(t); const db = new Database(join(app.dataDir, 'callmate.sqlite'));
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE id = 1').get();
    db.prepare('UPDATE app_settings SET value = ? WHERE id = 1').run(JSON.stringify({ invalid: 'PRIVATE-CORRUPT-SETTINGS' }));
    const report = await app.report(); assert.equal(report.ready, false);
    assert.equal(check(report, 'configuration').status, 'failed'); assert.equal(check(report, 'storage').status, 'ready');
    assert.equal(report.capabilities.some((c) => c.ready), false); assert.equal(app.requests.length, 0);
    assert.ok(!JSON.stringify(report).includes('PRIVATE-')); assert.ok(!app.logs.includes('PRIVATE-'));
    db.prepare('UPDATE app_settings SET value = ? WHERE id = 1').run(row.value);
    assert.equal((await app.report()).ready, true);
  } finally { db.close(); }
});

test('missing database tables yield a structured failed storage check and recover after restoration', async (t) => {
  const app = await fixture(t); const db = new Database(join(app.dataDir, 'callmate.sqlite'));
  try {
    db.exec('ALTER TABLE call_attempts RENAME TO hidden_attempts');
    const report = await app.report(); assert.equal(report.ready, false); assert.equal(check(report, 'storage').status, 'failed');
    assert.equal(check(report, 'configuration').status, 'failed'); assert.equal(report.capabilities.some((c) => c.ready), false);
    assert.equal(app.requests.length, 0); assert.ok(!JSON.stringify(report).includes(app.dataDir));
    const health = await app.runtime.privateApi.inject({ url: '/health', headers: { host: 'localhost:3000' } });
    assert.equal(health.statusCode, 500); assert.ok(!health.body.includes(app.dataDir));
    db.exec('ALTER TABLE hidden_attempts RENAME TO call_attempts');
    assert.equal((await app.report()).ready, true);
  } finally {
    if (db.prepare("SELECT name FROM sqlite_master WHERE name = 'hidden_attempts'").get()) db.exec('ALTER TABLE hidden_attempts RENAME TO call_attempts');
    db.close();
  }
});

test('invalid runtime configuration prevents network probes; closed database failures stay sanitized', async (t) => {
  const app = await fixture(t);
  app.config.mockApiBase = 'http://external.invalid/PRIVATE-CONFIG';
  const report = await app.report(); assert.equal(report.ready, false); assert.equal(check(report, 'configuration').status, 'failed');
  assert.equal(app.requests.length, 0); assert.ok(!JSON.stringify(report).includes('PRIVATE-'));
  const unavailable = new Readiness(loadConfig({}), { check() { throw new Error('PRIVATE-DATABASE-PATH'); } });
  const failed = await unavailable.report(); assert.equal(failed.ready, false); assert.equal(check(failed, 'storage').status, 'failed');
  assert.ok(!JSON.stringify(failed).includes('PRIVATE-'));
  assert.equal(configurationValid({ ...loadConfig({ NODE_ENV: 'test' }), apiPort: 0, callbackPort: 0 }), true);
  assert.equal(configurationValid({ ...loadConfig({}), apiPort: 0 }), false);
  assert.equal(CapabilitySchema.safeParse({ name: 'live_calls', enabled: false, ready: true }).success, false);
});

test('readiness is private and origin-checked before any probe runs', async (t) => {
  const app = await fixture(t);
  const callback = await app.runtime.callbacks.inject({ url: '/api/v1/readiness' }); assert.equal(callback.statusCode, 404);
  for (const headers of [{ host: 'external.example' }, { host: 'localhost:3000', origin: 'https://external.example' }]) {
    const response = await app.runtime.privateApi.inject({ url: '/api/v1/readiness', headers }); assert.equal(response.statusCode, 400);
  }
  assert.equal(app.requests.length, 0);
});
