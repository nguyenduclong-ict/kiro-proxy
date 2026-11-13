import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Store } from '../src/db.js';
import { buildApp } from '../src/server.js';

function setupStatsStore() {
  const store = new Store(openDatabase(':memory:'));
  const k1 = store.addKey({ label: 'Key 1', apiKey: 'k1' });
  const k2 = store.addKey({ label: 'Key 2', apiKey: 'k2' });
  const now = Date.now();

  store.insertRequest({
    ts: now - 1000,
    session_id: 's1',
    conversation_id: 'c1',
    key_id: k1.id,
    model: 'claude-opus-5.5',
    client_model: 'claude-opus-5.5',
    stream: 1,
    status: 'ok',
    credits: 1.5,
    est_input_tokens: 1000,
    est_output_tokens: 50,
  });

  store.insertRequest({
    ts: now - 500,
    session_id: 's2',
    conversation_id: 'c2',
    key_id: k2.id,
    model: 'claude-sonnet-5.5',
    client_model: 'claude-sonnet-5.5',
    stream: 1,
    status: 'ok',
    credits: 0.5,
    est_input_tokens: 800,
    est_output_tokens: 30,
  });

  return { store, now };
}

test('store.stats: returns all models when no model filter is specified', () => {
  const { store, now } = setupStatsStore();
  const res = store.stats({ since: now - 60_000, bucket: 'hour', threshold: 4 });

  assert.equal(res.totals.requests, 2);
  assert.equal(res.totals.credits, 2.0);
  assert.deepEqual(res.models.sort(), ['claude-opus-5.5', 'claude-sonnet-5.5']);
  assert.equal(res.selectedModel, null);
  assert.equal(res.byModel.length, 2);
});

test('store.stats: filters totals, series, byKey, and topSessions by model', () => {
  const { store, now } = setupStatsStore();
  const res = store.stats({ since: now - 60_000, bucket: 'hour', threshold: 4, model: 'claude-opus-5.5' });

  assert.equal(res.totals.requests, 1);
  assert.equal(res.totals.credits, 1.5);
  assert.equal(res.selectedModel, 'claude-opus-5.5');
  assert.deepEqual(res.models.sort(), ['claude-opus-5.5', 'claude-sonnet-5.5'], 'available models list remains complete');
  assert.equal(res.byModel.length, 1);
  assert.equal(res.byModel[0].model, 'claude-opus-5.5');
  assert.equal(res.topSessions.length, 1);
  assert.equal(res.topSessions[0].session_id, 's1');
});

test('GET /api/stats: accepts model query param', async () => {
  const { store } = setupStatsStore();
  const app = buildApp({ store, logger: false });

  try {
    const resAll = await app.inject({ method: 'GET', url: '/api/stats?range=24h' });
    assert.equal(resAll.statusCode, 200);
    const jsonAll = JSON.parse(resAll.body);
    assert.equal(jsonAll.totals.requests, 2);
    assert.deepEqual(jsonAll.models.sort(), ['claude-opus-5.5', 'claude-sonnet-5.5']);

    const resFiltered = await app.inject({ method: 'GET', url: '/api/stats?range=24h&model=claude-sonnet-5.5' });
    assert.equal(resFiltered.statusCode, 200);
    const jsonFiltered = JSON.parse(resFiltered.body);
    assert.equal(jsonFiltered.totals.requests, 1);
    assert.equal(jsonFiltered.totals.credits, 0.5);
    assert.equal(jsonFiltered.selectedModel, 'claude-sonnet-5.5');
  } finally {
    await app.close();
  }
});
