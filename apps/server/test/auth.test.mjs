import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import Database from 'better-sqlite3';
import { api } from '@callmate/contracts';
import { reviewPlanFixture } from '@callmate/contracts/fixtures';
import { loadConfig } from '../dist/config.js';
import { createRuntime } from '../dist/server.js';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'callmate-auth-'));
  const password = randomBytes(24).toString('hex'); let logs = '';
  const config = loadConfig({ CALLMATE_DATA_DIR: dataDir, CALLMATE_LOG_LEVEL: 'info' });
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk; done(); } });
  let runtime = createRuntime(config, stream);
  const db = new Database(join(dataDir, 'callmate.sqlite'));
  t.after(async () => { await runtime.close(); db.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { password, db, config, get logs() { return logs; }, get runtime() { return runtime; },
    async http(method, url, payload, cookie, headers = {}) {
      return runtime.privateApi.inject({ method, url, headers: { host: `localhost:${config.apiPort}`, ...(cookie ? { cookie } : {}), ...headers },
        ...(payload === undefined ? {} : { payload }) });
    },
    async setup() {
      const response = await this.http('POST', api.authSetup.path, { username: 'Owner', password });
      assert.equal(response.statusCode, 200); return response.headers['set-cookie'].split(';')[0];
    },
    async restart() { await runtime.close(); runtime = createRuntime(config, stream); },
  };
}

test('private contacts, calls, settings, readiness and console APIs require a session before and after setup', async t => {
  const app = fixture(t);
  assert.deepEqual((await app.http('GET', api.authSession.path)).json(), { setupRequired: true, authenticated: false, username: null, expiresAt: null });
  for (let i = 0; i < 2; i++) {
    for (const path of ['/api/v1/contacts', '/api/v1/history', '/api/v1/settings', '/api/v1/readiness', '/api/dev/conversations', `/api/v1/calls/${crypto.randomUUID()}/events`]) {
      const response = await app.http('GET', path); assert.equal(response.statusCode, 401, path);
      assert.equal(response.json().error.code, 'UNAUTHENTICATED');
    }
    if (i === 0) await app.setup();
  }
  for (const path of ['/health', '/console/', '/console/auth.js']) assert.equal((await app.http('GET', path)).statusCode, 200);
  for (const [method, path, body] of [
    ['POST', '/api/v1/contacts', { name: 'Private', phone: '+34612345678', timeZone: 'Europe/Madrid' }],
    ['PUT', '/api/v1/settings', {}], ['DELETE', `/api/v1/contacts/${crypto.randomUUID()}`, undefined],
    ['POST', '/api/dev/conversations', {}], ['POST', '/api/v1/plans', reviewPlanFixture.request],
    ['POST', '/api/v1/calls', {}], ['POST', `/api/v1/calls/${crypto.randomUUID()}/stop`, {}],
    ['POST', `/api/v1/calls/${crypto.randomUUID()}/approvals`, {}],
  ]) assert.equal((await app.http(method, path, body)).statusCode, 401, `${method} ${path}`);
  assert.equal((await app.runtime.callbacks.inject({ url: api.authSession.path })).statusCode, 404);
});

test('owner setup is one-time, hashes credentials, and sets a private cookie; sessions survive restart', async t => {
  const app = fixture(t);
  assert.equal((await app.http('POST', api.authSetup.path, { username: 'owner', password: 'short' })).statusCode, 400);
  const response = await app.http('POST', api.authSetup.path, { username: 'Owner', password: app.password });
  const session = api.authSession.response.parse(response.json()); assert.equal(session.username, 'owner'); assert.equal(session.authenticated, true);
  assert.match(response.headers['set-cookie'], /HttpOnly; SameSite=Strict; Max-Age=43200/);
  assert.equal(response.headers['cache-control'], 'no-store');
  const cookie = response.headers['set-cookie'].split(';')[0];
  const owner = app.db.prepare('SELECT * FROM auth_owner').get();
  assert.notEqual(owner.password_hash, app.password); assert.equal(owner.password_hash.length, 128);
  const stored = app.db.prepare('SELECT * FROM auth_sessions').get();
  assert.ok(!cookie.includes(stored.token_hash)); assert.equal(stored.token_hash.length, 64);
  assert.equal((await app.http('POST', api.authSetup.path, { username: 'other', password: app.password })).statusCode, 409);
  await app.restart();
  assert.equal((await app.http('GET', api.authSession.path, undefined, cookie)).json().authenticated, true);
  assert.equal((await app.http('GET', '/api/v1/contacts', undefined, cookie)).statusCode, 200);
  await app.runtime.close();
  assert.ok(!app.logs.includes(app.password)); assert.ok(!app.logs.includes(cookie.slice(cookie.indexOf('=') + 1)));
});

test('login rejects wrong credentials without revealing the account; logout revokes only its session', async t => {
  const app = fixture(t); const first = await app.setup();
  for (const credentials of [{ username: 'owner', password: 'wrong' }, { username: 'unknown', password: app.password }]) {
    const response = await app.http('POST', api.authLogin.path, credentials);
    assert.equal(response.statusCode, 401); assert.equal(response.json().error.code, 'INVALID_CREDENTIALS');
  }
  const login = await app.http('POST', api.authLogin.path, { username: 'OWNER', password: app.password });
  assert.equal(login.statusCode, 200); const second = login.headers['set-cookie'].split(';')[0]; assert.notEqual(first, second);
  const logout = await app.http('POST', api.authLogout.path, {}, first);
  assert.equal(logout.statusCode, 200); assert.match(logout.headers['set-cookie'], /Max-Age=0/);
  assert.equal((await app.http('GET', '/api/v1/contacts', undefined, first)).statusCode, 401);
  assert.equal((await app.http('GET', '/api/v1/contacts', undefined, second)).statusCode, 200);
  assert.equal((await app.http('POST', api.authLogout.path, {}, first)).statusCode, 200);
  for (const cookie of ['callmate_session=invalid', second + '; ' + second, second.slice(0, -1) + 'z']) {
    assert.equal((await app.http('GET', '/api/v1/contacts', undefined, cookie)).statusCode, 401);
  }
  app.db.prepare('UPDATE auth_sessions SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await app.http('GET', '/api/v1/contacts', undefined, second)).statusCode, 401);
  assert.equal((await app.http('GET', api.authSession.path, undefined, second)).json().authenticated, false);
});

test('login limit persists across restart and rejects even with spoofed forwarding headers', async t => {
  const app = fixture(t); await app.setup();
  for (let i = 0; i < 9; i++) assert.equal((await app.http('POST', api.authLogin.path, { username: 'owner', password: 'wrong' })).statusCode, 401);
  await app.restart();
  const limited = await app.http('POST', api.authLogin.path, { username: 'owner', password: app.password }, undefined, { 'x-forwarded-for': '192.0.2.1' });
  assert.equal(limited.statusCode, 429); assert.equal(limited.headers['retry-after'], '300');
  app.db.prepare('UPDATE auth_rate_limit SET window_start = ?').run(Date.now() - 300_001);
  assert.equal((await app.http('POST', api.authLogin.path, { username: 'owner', password: app.password })).statusCode, 200);
});

test('foreign origins, cross-site requests and form posts cannot set up, log in or log out', async t => {
  const app = fixture(t); const cookie = await app.setup();
  for (const path of [api.authSetup.path, api.authLogin.path, api.authLogout.path]) {
    for (const headers of [{ origin: 'https://foreign.example' }, { host: 'foreign.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }]) {
      assert.equal((await app.http('POST', path, { username: 'owner', password: app.password }, cookie, headers)).statusCode, 400);
    }
  }
  assert.equal((await app.http('GET', '/api/v1/contacts', undefined, cookie)).statusCode, 200);
});

test('concurrent setup cannot replace the owner; local recovery preserves contacts and revokes sessions', async t => {
  const app = fixture(t);
  const responses = await Promise.all(['first', 'second'].map(username => app.http('POST', api.authSetup.path, { username, password: app.password })));
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 409]);
  const cookie = responses.find(r => r.statusCode === 200).headers['set-cookie'].split(';')[0];
  await app.http('POST', '/api/v1/contacts', { name: 'Barber', phone: '+34612345678', timeZone: 'Europe/Madrid' }, cookie);
  const { openStore } = await import('../dist/storage.js'); const store = openStore(app.config.dataDir);
  try {
    const oldOwner = store.auth.owner(); store.auth.resetOwner();
    assert.equal(store.auth.addSession(randomBytes(32).toString('hex'), Date.now() + 10000, oldOwner), false);
  } finally { store.close(); }
  assert.equal((await app.http('GET', '/api/v1/contacts', undefined, cookie)).statusCode, 401);
  assert.equal((await app.http('GET', api.authSession.path)).json().setupRequired, true);
  const next = await app.setup();
  assert.equal((await app.http('GET', '/api/v1/contacts', undefined, next)).json().items.length, 1);
});

test('logout and expiry close an already-open SSE connection', async t => {
  const app = fixture(t); app.config.apiPort = 0; app.config.callbackPort = 0; await app.runtime.start();
  app.config.apiPort = app.runtime.privateApi.server.address().port;
  const base = `http://localhost:${app.config.apiPort}`;
  for (const action of ['logout', 'expiry']) {
    const cookie = action === 'logout' ? await app.setup() : (await app.http('POST', api.authLogin.path, { username: 'owner', password: app.password })).headers['set-cookie'].split(';')[0];
    const plan = (await app.http('POST', '/api/v1/plans', structuredClone(reviewPlanFixture.request), cookie)).json().plan;
    const id = (await app.http('POST', '/api/v1/calls', { planId: plan.id, planVersion: 1, mode: 'simulator' }, cookie,
      { 'idempotency-key': crypto.randomUUID() })).json().call.id;
    const response = await fetch(`${base}/api/v1/calls/${id}/events`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); const reader = response.body.getReader(); await reader.read();
    if (action === 'logout') await app.http('POST', api.authLogout.path, {}, cookie);
    else app.db.prepare('UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1, createHash('sha256').update(cookie.split('=')[1]).digest('hex'));
    await assert.rejects(async () => { while (!(await reader.read()).done) {} });
    app.runtime.simulator.stop(id);
  }
});
