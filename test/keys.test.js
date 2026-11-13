import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Store } from '../src/db.js';
import { calculateRetryDelay, classifyUpstreamError, KeyPool } from '../src/keys.js';

function setup(n = 3) {
  const store = new Store(openDatabase(':memory:'));
  for (let i = 1; i <= n; i++) store.addKey({ label: `k${i}`, apiKey: `key-${i}` });
  let now = 1_000_000;
  const pool = new KeyPool(store, () => now);
  return { store, pool, advance: (ms) => { now += ms; } };
}

test('sticky: new sessions take keys in round robin order and keep them', () => {
  const { pool } = setup();
  assert.equal(pool.pick('s1').label, 'k1');
  assert.equal(pool.pick('s2').label, 'k2');
  assert.equal(pool.pick('s3').label, 'k3');
  assert.equal(pool.pick('s4').label, 'k1');
  assert.equal(pool.pick('s2').label, 'k2');
  assert.equal(pool.pick('s1').label, 'k1');
});

test('per_request: every request rotates', () => {
  const { store, pool } = setup();
  store.setSetting('rotation', 'per_request');
  assert.deepEqual(['s', 's', 's', 's'].map((s) => pool.pick(s).label), ['k1', 'k2', 'k3', 'k1']);
});

test('a failing key is put on cooldown and its session moves to the next key', () => {
  const { pool, advance } = setup();
  const k1 = pool.pick('s1');
  pool.reportFailure(k1, classifyUpstreamError(429, 'ThrottlingException'), 'throttled');
  const next = pool.pick('s1');
  assert.notEqual(next.id, k1.id);
  assert.equal(pool.pick('s1').id, next.id, 'session stays on its new key');
  advance(31_000);
  assert.equal(pool.pick('s1').id, next.id, 'does not jump back after cooldown');
});

test('excluded keys are skipped during failover', () => {
  const { pool } = setup(2);
  const a = pool.pick('s1');
  const b = pool.pick('s1', new Set([a.id]));
  assert.notEqual(a.id, b.id);
  assert.equal(pool.pick('s1', new Set([a.id, b.id])), null);
});

test('disabled keys are never picked', () => {
  const { store, pool } = setup(2);
  store.updateKey(1, { enabled: false });
  assert.equal(pool.pick('s1').label, 'k2');
  assert.equal(pool.pick('s2').label, 'k2');
});

test('bad requests do not penalise the key', () => {
  const { store, pool } = setup(1);
  const k = pool.pick('s1');
  pool.reportFailure(k, classifyUpstreamError(400, 'ValidationException'), 'bad');
  assert.equal(store.getKey(k.id).cooldown_until, null);
});

test('error classification', () => {
  assert.equal(classifyUpstreamError(429).kind, 'rate_limit');
  assert.equal(classifyUpstreamError(403, 'You have reached the limit for this month').kind, 'quota');
  assert.equal(classifyUpstreamError(403, 'Invalid token').kind, 'auth');
  assert.equal(classifyUpstreamError(400, 'Improperly formed request').kind, 'request');
  assert.equal(classifyUpstreamError(503).kind, 'upstream');
});

test('calculateRetryDelay: exponential backoff, max delay, and retry-after', () => {
  const zeroJitter = () => 0;
  // Exponential backoff
  assert.equal(calculateRetryDelay({ attempt: 0, baseDelayMs: 2000, random: zeroJitter }), 2000);
  assert.equal(calculateRetryDelay({ attempt: 1, baseDelayMs: 2000, random: zeroJitter }), 4000);
  assert.equal(calculateRetryDelay({ attempt: 2, baseDelayMs: 2000, random: zeroJitter }), 8000);
  assert.equal(calculateRetryDelay({ attempt: 3, baseDelayMs: 2000, random: zeroJitter }), 16000);

  // Caps at maxDelayMs
  assert.equal(calculateRetryDelay({ attempt: 4, baseDelayMs: 2000, maxDelayMs: 30000, random: zeroJitter }), 30000);
  assert.equal(calculateRetryDelay({ attempt: 10, baseDelayMs: 2000, maxDelayMs: 30000, random: zeroJitter }), 30000);

  // Honors retry-after in seconds
  assert.equal(calculateRetryDelay({ attempt: 0, baseDelayMs: 2000, retryAfter: '15', random: zeroJitter }), 15000);
  // Respects maxDelayMs even if retry-after is higher
  assert.equal(calculateRetryDelay({ attempt: 0, baseDelayMs: 2000, maxDelayMs: 10000, retryAfter: '30', random: zeroJitter }), 10000);

  // Jitter is applied when random > 0
  const delayWithJitter = calculateRetryDelay({ attempt: 0, baseDelayMs: 2000, random: () => 0.5 });
  assert.ok(delayWithJitter > 2000 && delayWithJitter <= 2500);
});
