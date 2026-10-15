import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import { DomainEventSchema, StoredCallSnapshotSchema } from '@callmate/contracts';
import { confirmedCallFixture, uncertainCallFixture } from '@callmate/contracts/fixtures';
import { loadConfig } from '../dist/config.js';
import { createRuntime } from '../dist/server.js';
import { migrate, openStore } from '../dist/storage.js';

const DAY = 86_400_000;
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); }
  assert.fail('Retention did not reach the expected state');
}
function setup(t, retentionOptions = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'callmate-retention-'));
  const clock = { ms: Date.parse('2026-10-15T12:00:00.123Z') };
  let logs = '';
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk; done(); } });
  const config = { ...loadConfig({ CALLMATE_DATA_DIR: dataDir, NODE_ENV: 'test', TELEPHONY_PROVIDER: 'mock' }), apiPort: 0, callbackPort: 0 };
  const options = { now: () => clock.ms, automatic: false };
  let runtime = createRuntime(config, stream, options, options, { ...options, ...retentionOptions });
  const store = openStore(dataDir);
  const db = new Database(join(dataDir, 'callmate.sqlite'));
  t.after(async () => { await runtime.close(); db.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { clock, store, db, dataDir, get runtime() { return runtime; }, get logs() { return logs; },
    async restart() {
      await runtime.close(); runtime = createRuntime(config, stream, options, options, { ...options, ...retentionOptions });
      await runtime.start();
    },
    async http(method, url, payload, key) {
      const port = runtime.privateApi.server.address()?.port ?? 0;
      const result = await runtime.privateApi.inject({ method, url,
        headers: { host: `localhost:${port}`, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload }) });
      return { status: result.statusCode, data: result.json() };
    },
  };
}
function seed(app, { days = 30, manual = false, active = false, uncertain = false, id = randomUUID() } = {}) {
  const at = new Date(app.clock.ms - days * DAY).toISOString();
  const text = `PRIVATE-TRANSCRIPT-${id}: Sí, mañana. Спасибо. 🧪`;
  let call = structuredClone(uncertain ? uncertainCallFixture : confirmedCallFixture);
  call.id = id; call.createdAt = new Date(Date.parse(at) - DAY).toISOString(); call.updatedAt = at;
  call.revision = 3; call.lastEventSequence = 3;
  call.messages[0].originalText = text; call.messages[0].translationEn = `PRIVATE-TRANSLATION-${id}`;
  if (manual) {
    call = { ...call, kind: 'manual_mock', plan: null, language: 'ru-RU', activeOffer: null,
      bookingState: active ? 'pending' : 'not_booked', outcome: active ? { status: 'pending' }
        : { status: 'not_booked', reason: 'development_only', summaryEn: 'Manual mock call ended without booking.' },
      messages: [{ ...call.messages[0], language: 'ru-RU', translationEn: null }],
      callState: active ? 'reconciliation_required' : 'ended' };
  } else if (active) {
    call.callState = 'connected'; call.bookingState = 'pending'; call.outcome = { status: 'pending' };
  }
  const events = [
    { type: 'transcript.updated', payload: call.messages[0] },
    { type: 'booking.updated', payload: { bookingState: call.bookingState, outcome: call.outcome } },
    { type: 'call.status', payload: { callState: call.callState } },
  ].map((event, index) => DomainEventSchema.parse({ contractVersion: 1, id: randomUUID(), attemptId: id,
    sequence: index + 1, snapshotRevision: 3, occurredAt: at, ...event }));
  const internal = manual ? { kind: 'manual_mock', callSid: 'CA' + '1'.repeat(32), status: active ? 'unknown' : 'completed', error: null,
    stopRequested: false, correlation: { apiOrigin: 'http://127.0.0.1:1', accountSid: 'AC' + '0'.repeat(32),
      tokenHash: '0'.repeat(64), sessionId: 'VX' + '2'.repeat(32), creation: 'submitted', recoveryRequired: active,
      callbackSequence: 3, providerStatus: active ? 'in-progress' : 'completed' } }
    : { scenario: 'within_plan', phase: active ? 'offer' : 'done', nextAt: 0, accepted: !active, grant: null };
  const attempt = { call: StoredCallSnapshotSchema.parse(call), replayFloor: 0, internal };
  const commandKey = randomUUID();
  const commandBody = manual ? createHash('sha256').update(text).digest('hex')
    : JSON.stringify({ planId: call.plan.id, planVersion: call.plan.version, mode: 'simulator' });
  app.store.calls.transaction(() => {
    app.store.calls.save(attempt, events);
    app.store.calls.recordCommand(commandKey, manual ? 'manual-start' : 'start', commandBody, id);
  });
  return { ...attempt, text, commandKey, commandBody };
}

async function stream(app, id, cursor) {
  const port = app.runtime.privateApi.server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/calls/${id}/events`, {
    headers: { 'Last-Event-ID': String(cursor) }, signal: AbortSignal.timeout(5000),
  });
  const reader = response.body.getReader(); let buffer = '';
  const decoder = new TextDecoder();
  return { close: () => reader.cancel().catch(() => {}), async next() {
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary !== -1) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (frame.startsWith(':')) continue;
        const event = frame.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
        const data = frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
        return { event, data: JSON.parse(data) };
      }
      const chunk = await reader.read(); if (chunk.done) return null;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  } };
}

test('retention expires exact completion boundaries, preserves booking metadata, and never touches active calls', (t) => {
  const app = setup(t);
  const expired = [seed(app), seed(app, { days: 31, manual: true }), seed(app, { days: 45, uncertain: true })];
  const recent = seed(app, { days: 30 - 1 / DAY }); // One millisecond younger than the cutoff.
  const active = seed(app, { days: 90, manual: true, active: true });
  const seen = [];
  const unsubscribe = app.runtime.controller.observe(expired[0].call.id, () => seen.push(app.runtime.controller.get(expired[0].call.id)));
  assert.equal(app.runtime.retention.sweep(), 3); unsubscribe();
  for (const before of expired) {
    const after = app.store.calls.get(before.call.id);
    assert.deepEqual(after.call, { ...before.call, messages: [], conversationData: 'deleted', revision: 4,
      lastEventSequence: 4, updatedAt: new Date(app.clock.ms).toISOString() });
    assert.deepEqual(after.internal, before.internal);
    assert.equal(after.replayFloor, 3); assert.equal(app.runtime.controller.replayEvents(before.call.id, 0), null);
    const events = app.store.calls.events(before.call.id, 0);
    assert.deepEqual(events.map((event) => event.type), ['conversation.deleted']);
    assert.ok(!JSON.stringify(events).includes(before.text));
    assert.equal(app.store.calls.command(before.commandKey).body, before.commandBody);
  }
  assert.equal(seen.length, 1); assert.deepEqual(seen[0].messages, []);
  assert.deepEqual(app.store.calls.get(recent.call.id).call, recent.call);
  assert.deepEqual(app.store.calls.get(active.call.id).call, active.call);
  assert.equal(app.store.calls.active().call.id, active.call.id);
  assert.equal(app.runtime.retention.sweep(), 0); // No duplicate event/revision on a later pass.
  const page = app.runtime.controller.history(100);
  for (const before of expired) assert.deepEqual(page.items.find((item) => item.id === before.call.id).outcome, before.call.outcome);
});

test('completion time remains stable when terminal metadata is saved again', (t) => {
  const app = setup(t); const before = seed(app, { days: 31 });
  const changed = app.store.calls.get(before.call.id);
  changed.call.updatedAt = new Date(app.clock.ms).toISOString(); changed.call.revision++;
  app.store.calls.save(changed);
  assert.equal(app.db.prepare('SELECT terminal_at FROM call_attempts WHERE id = ?').get(before.call.id).terminal_at, before.call.updatedAt);
  assert.equal(app.runtime.retention.sweep(), 1);
});

test('startup purges expired text before serving snapshots, history, retry commands or replay', async (t) => {
  const app = setup(t); const before = seed(app, { days: 31 });
  await app.runtime.start();
  const after = await app.http('GET', `/api/v1/calls/${before.call.id}`);
  assert.equal(after.status, 200); assert.equal(after.data.call.conversationData, 'deleted');
  assert.deepEqual(after.data.call.messages, []); assert.deepEqual(after.data.call.outcome, before.call.outcome);
  const replay = await app.http('POST', '/api/v1/calls', JSON.parse(before.commandBody), before.commandKey);
  assert.equal(replay.status, 202); assert.deepEqual(replay.data.call, after.data.call);
  const history = await app.http('GET', '/api/v1/history');
  assert.deepEqual(history.data.items[0].outcome, before.call.outcome);
  const reset = await stream(app, before.call.id, 0); t.after(() => reset.close());
  assert.deepEqual(await reset.next(), { event: 'reset', data: { reason: 'snapshot_required' } });
  assert.equal(await reset.next(), null);
  await app.restart();
  assert.deepEqual(app.runtime.controller.get(before.call.id), after.data.call);
  assert.equal(app.store.calls.events(before.call.id, 0).length, 1);
});

test('retention settings changes purge newly expired data and never restore deleted text', async (t) => {
  const app = setup(t); const before = seed(app, { days: 10 });
  const settings = app.store.getSettings();
  const invalid = await app.http('PUT', '/api/v1/settings', { ...settings, transcriptRetentionDays: 0 });
  assert.equal(invalid.status, 400); assert.equal(app.store.calls.get(before.call.id).call.conversationData, 'retained');
  const saved = await app.http('PUT', '/api/v1/settings', { ...settings, transcriptRetentionDays: 7 });
  assert.equal(saved.status, 200);
  const deleted = app.runtime.controller.get(before.call.id); assert.equal(deleted.conversationData, 'deleted');
  await app.http('PUT', '/api/v1/settings', { ...settings, transcriptRetentionDays: 365 });
  assert.deepEqual(app.runtime.controller.get(before.call.id), deleted);
  assert.equal(app.runtime.controller.deleteConversation(before.call.id).deleted, true);
  assert.deepEqual(app.runtime.controller.get(before.call.id), deleted);
});

test('live SSE receives deletion while stale clients reset, including manual console projections', async (t) => {
  const app = setup(t); const before = seed(app, { days: 29, manual: true }); await app.runtime.start();
  const live = await stream(app, before.call.id, 3); t.after(() => live.close());
  app.clock.ms += DAY; assert.equal(app.runtime.retention.sweep(), 1);
  const event = await live.next(); assert.equal(event.data.type, 'conversation.deleted');
  DomainEventSchema.parse(event.data);
  const projection = await app.http('GET', '/api/dev/conversations');
  assert.equal(projection.status, 200); assert.equal(projection.data.conversation.conversationData, 'deleted');
  assert.equal(projection.data.conversation.initialMessage, ''); assert.deepEqual(projection.data.conversation.responses, []);
  const future = await stream(app, before.call.id, 100); t.after(() => future.close());
  assert.equal((await future.next()).event, 'reset'); assert.equal(await future.next(), null);
  assert.ok(!app.logs.includes(before.text));
});

test('snapshot, replay purge, event and retention marker roll back together; retry succeeds', (t) => {
  const app = setup(t); const before = seed(app, { days: 31, manual: true });
  const original = app.store.calls.get(before.call.id); const events = app.store.calls.events(before.call.id, 0);
  let notified = 0; const off = app.runtime.controller.observe(before.call.id, () => notified++);
  app.db.exec("CREATE TRIGGER fail_retention BEFORE INSERT ON call_events WHEN json_extract(NEW.value, '$.type') = 'conversation.deleted' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  assert.throws(() => app.runtime.retention.sweep());
  assert.deepEqual(app.store.calls.get(before.call.id), original);
  assert.deepEqual(app.store.calls.events(before.call.id, 0), events); assert.equal(notified, 0);
  app.db.exec('DROP TRIGGER fail_retention'); assert.equal(app.runtime.retention.sweep(), 1);
  assert.equal(notified, 1); off();
  assert.equal(app.store.calls.get(before.call.id).call.conversationData, 'deleted');
});

test('periodic cleanup runs without UI requests, retries safely and stops before shutdown', async (t) => {
  const app = setup(t, { automatic: true, intervalMs: 20 }); await app.runtime.start();
  const before = seed(app, { days: 31 });
  app.db.exec("CREATE TRIGGER fail_retention BEFORE INSERT ON call_events WHEN json_extract(NEW.value, '$.type') = 'conversation.deleted' BEGIN SELECT RAISE(ABORT, 'PRIVATE-RETENTION-ERROR'); END");
  await until(() => app.logs.includes('RETENTION_FAILED'));
  assert.equal(app.store.calls.get(before.call.id).call.conversationData, 'retained');
  assert.ok(!app.logs.includes('PRIVATE-RETENTION-ERROR')); assert.ok(!app.logs.includes(before.text));
  app.db.exec('DROP TRIGGER fail_retention');
  await until(() => app.store.calls.get(before.call.id).call.conversationData === 'deleted');
  await app.runtime.close();
  const later = seed(app, { days: 31 }); await delay(60);
  assert.equal(app.store.calls.get(later.call.id).call.conversationData, 'retained');
});

test('retention processes more than one batch and preserves history pagination', (t) => {
  const app = setup(t); const calls = Array.from({ length: 205 }, () => seed(app, { days: 31, manual: true }));
  const firstPage = app.runtime.controller.history(100);
  assert.equal(app.runtime.retention.sweep(), 205);
  assert.deepEqual(app.runtime.controller.history(100), firstPage);
  assert.equal(app.runtime.controller.history(100, firstPage.nextCursor).items.length, 100);
  for (const before of calls) assert.equal(app.store.calls.get(before.call.id).call.conversationData, 'deleted');
});

test('retention migration backfills first terminal event, falls back to snapshot time and excludes active calls', () => {
  const directory = mkdtempSync(join(tmpdir(), 'callmate-old-migrations-'));
  const db = new Database(':memory:');
  try {
    const migrations = fileURLToPath(new URL('../migrations/', import.meta.url));
    for (const file of ['001_settings.sql', '002_simulator.sql']) writeFileSync(join(directory, file), readFileSync(join(migrations, file)));
    migrate(db, directory);
    const insert = db.prepare('INSERT INTO call_attempts (id, snapshot, internal, active, replay_floor) VALUES (?, ?, ?, ?, 0)');
    const old = { ...confirmedCallFixture, updatedAt: '2026-10-14T00:00:00Z' };
    insert.run('event', JSON.stringify(old), '{}', 0); insert.run('fallback', JSON.stringify(old), '{}', 0);
    insert.run('active', JSON.stringify({ ...old, callState: 'ending' }), '{}', 1);
    for (const [sequence, occurredAt] of [[1, '2026-09-01T12:00:00.123Z'], [2, '2026-09-02T12:00:00Z']]) {
      db.prepare('INSERT INTO call_events VALUES (?, ?, ?)').run('event', sequence,
        JSON.stringify({ type: 'call.status', payload: { callState: 'ended' }, occurredAt }));
    }
    migrate(db, migrations);
    const rows = Object.fromEntries(db.prepare('SELECT id, terminal_at FROM call_attempts').all().map((row) => [row.id, row.terminal_at]));
    assert.deepEqual(rows, { event: '2026-09-01T12:00:00.123Z', fallback: '2026-10-14T00:00:00.000Z', active: null });
    migrate(db, migrations); // Reopening does not reset the backfilled completion times.
    assert.equal(db.prepare("SELECT terminal_at FROM call_attempts WHERE id = 'event'").get().terminal_at, rows.event);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});


test('startup purge failure keeps text and replay intact and opens neither listener', async (t) => {
  const app = setup(t); const before = seed(app, { days: 31 });
  const original = app.store.calls.get(before.call.id); const events = app.store.calls.events(before.call.id, 0);
  app.db.exec("CREATE TRIGGER fail_retention BEFORE INSERT ON call_events WHEN json_extract(NEW.value, '$.type') = 'conversation.deleted' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  await assert.rejects(app.runtime.start());
  assert.equal(app.runtime.privateApi.server.listening, false); assert.equal(app.runtime.callbacks.server.listening, false);
  assert.deepEqual(app.store.calls.get(before.call.id), original);
  assert.deepEqual(app.store.calls.events(before.call.id, 0), events);
  app.db.exec('DROP TRIGGER fail_retention'); await app.restart();
  assert.equal(app.store.calls.get(before.call.id).call.conversationData, 'deleted');
});
