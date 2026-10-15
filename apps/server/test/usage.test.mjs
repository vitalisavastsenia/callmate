import assert from 'node:assert/strict';
import test from 'node:test';
import { UsageSchema } from '@callmate/contracts';
import { loadConfig } from '../dist/config.js';
import { initialUsage, measureUsage, budgetExpired } from '../dist/usage.js';

const at = '2026-10-15T10:00:00.000Z';
const start = Date.parse(at);
const budget = (amountMinor) => ({ amountMinor, currency: 'USD' });
const call = (rate, limit) => ({ createdAt: at, usage: initialUsage(at, rate, budget(limit)) });

test('rates are explicitly opt-in, bounded integers; absent pricing remains unavailable', () => {
  assert.equal(loadConfig({}).testRateMinorPerMinute, undefined);
  assert.equal(loadConfig({ CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE: '' }).testRateMinorPerMinute, undefined);
  for (const value of ['0', '-1', '0.5', '60001', 'NaN', 'Infinity', 'private-invalid-rate']) {
    assert.throws(() => loadConfig({ CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE: value }), (error) => {
      assert.ok(!error.message.includes(value)); return true;
    });
  }
  const unavailable = initialUsage(at, undefined, budget(0));
  assert.deepEqual(unavailable, { estimate: null, settledTotal: null, status: 'unavailable', measuredAt: at });
  assert.throws(() => initialUsage(at, 60, budget(0)), (error) => error.code === 'BUDGET_EXCEEDED');
});

test('test rates round up once over cumulative elapsed time and never masquerade as provider charges', () => {
  const a = call(7, 1); const emitted = [];
  const emit = (type, value) => emitted.push({ type, value });
  measureUsage(a, start + 1, emit); assert.equal(a.usage.estimate.amountMinor, 1);
  measureUsage(a, start + 8571, emit); assert.equal(a.usage.estimate.amountMinor, 1);
  assert.equal(budgetExpired(a, start + 8571), false);
  assert.equal(budgetExpired(a, start + 8572), true);
  measureUsage(a, start + 8572, emit); assert.equal(a.usage.estimate.amountMinor, 2);
  // Sampling again at the same instant cannot double count; clocks going backwards do not refund usage.
  measureUsage(a, start + 8572, emit); measureUsage(a, start - 1, emit); assert.equal(emitted.length, 3);
  assert.equal(a.usage.testUsage.elapsedMs, 8572); assert.equal(a.usage.settledTotal, null);
  assert.equal(a.usage.status, 'estimated'); UsageSchema.parse(a.usage);
  assert.equal(UsageSchema.safeParse({ ...a.usage, status: 'settled', settledTotal: budget(2) }).success, false);
  assert.equal(UsageSchema.safeParse({ ...a.usage, status: 'unavailable' }).success, false);
  assert.equal(UsageSchema.safeParse({ ...a.usage, estimate: null }).success, false);
});

test('large budgets use exact arithmetic without unsafe multiplication or premature expiry', () => {
  const a = call(60000, Number.MAX_SAFE_INTEGER);
  assert.equal(budgetExpired(a, start + 600000), false);
  measureUsage(a, start + 600000, () => {});
  assert.equal(a.usage.estimate.amountMinor, 600000);
});
