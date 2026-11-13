import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, Store } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { encodeEvent } from '../src/kiro/eventstream.js';

function createMockApp({ retries = 2, baseDelay = 10, maxDelay = 100 } = {}) {
  const store = new Store(openDatabase(':memory:'));
  store.setSetting('proxy_token', 'test-token');
  store.setSetting('rate_limit_retries', retries);
  store.setSetting('rate_limit_base_delay_ms', baseDelay);
  store.setSetting('rate_limit_max_delay_ms', maxDelay);
  store.addKey({ label: 'Key 1', apiKey: 'test-key-1' });

  const app = buildApp({ store, logger: false });
  return { app, store };
}

function successStreamBody() {
  return Buffer.concat([
    encodeEvent('assistantResponseEvent', { content: 'Xin chao' }),
    encodeEvent('messageStopEvent', { stopReason: 'end_turn' }),
  ]);
}

test('429 retry: auto waits with backoff and succeeds on subsequent attempt', async () => {
  const { app } = createMockApp({ retries: 3, baseDelay: 10, maxDelay: 50 });
  const originalFetch = globalThis.fetch;

  let callCount = 0;
  globalThis.fetch = async (url, opts) => {
    callCount++;
    if (callCount === 1) {
      // First attempt returns 429 Too Many Requests
      return new Response('Rate limit exceeded', {
        status: 429,
        headers: { 'content-type': 'text/plain' },
      });
    }
    // Second attempt succeeds
    return new Response(successStreamBody(), {
      status: 200,
      headers: { 'content-type': 'application/vnd.amazon.eventstream' },
    });
  };

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: {
        model: 'claude-haiku-5.5',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.content[0].text, 'Xin chao');
    assert.equal(callCount, 2, 'called Kiro twice before succeeding');
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test('429 retry: works with streaming requests (stream: true)', async () => {
  const { app } = createMockApp({ retries: 3, baseDelay: 10, maxDelay: 50 });
  const originalFetch = globalThis.fetch;

  let callCount = 0;
  globalThis.fetch = async () => {
    callCount++;
    if (callCount === 1) {
      return new Response('Rate limit exceeded', {
        status: 429,
        headers: { 'content-type': 'text/plain' },
      });
    }
    return new Response(successStreamBody(), {
      status: 200,
      headers: { 'content-type': 'application/vnd.amazon.eventstream' },
    });
  };

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: {
        model: 'claude-haiku-5.5',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.match(res.body, /Xin chao/);
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test('429 retry: exhausts max retries and returns 429 when Kiro persistently rate-limits', async () => {
  const { app } = createMockApp({ retries: 2, baseDelay: 10, maxDelay: 30 });
  const originalFetch = globalThis.fetch;

  let callCount = 0;
  globalThis.fetch = async () => {
    callCount++;
    return new Response('Too many requests', {
      status: 429,
      headers: { 'content-type': 'text/plain' },
    });
  };

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: {
        model: 'claude-haiku-5.5',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    assert.equal(res.statusCode, 429);
    const json = JSON.parse(res.body);
    assert.equal(json.type, 'error');
    assert.equal(json.error.type, 'rate_limit_error');
    // Initial call (1) + 2 retries = 3 total attempts
    assert.equal(callCount, 3);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test('429 retry: when rate_limit_retries is 0, returns 429 immediately without retry', async () => {
  const { app } = createMockApp({ retries: 0, baseDelay: 10, maxDelay: 30 });
  const originalFetch = globalThis.fetch;

  let callCount = 0;
  globalThis.fetch = async () => {
    callCount++;
    return new Response('Rate exceeded', {
      status: 429,
      headers: { 'content-type': 'text/plain' },
    });
  };

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: {
        model: 'claude-haiku-5.5',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    assert.equal(res.statusCode, 429);
    assert.equal(callCount, 1, 'only called once when retries disabled');
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test('settings API: persists and returns rate limit retry options', async () => {
  const { app } = createMockApp();
  try {
    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/json' },
      body: {
        rate_limit_retries: 7,
        rate_limit_base_delay_ms: 3000,
        rate_limit_max_delay_ms: 45000,
      },
    });

    assert.equal(putRes.statusCode, 200);
    const putJson = JSON.parse(putRes.body);
    assert.equal(putJson.settings.rate_limit_retries, 7);
    assert.equal(putJson.settings.rate_limit_base_delay_ms, 3000);
    assert.equal(putJson.settings.rate_limit_max_delay_ms, 45000);

    const getRes = await app.inject({
      method: 'GET',
      url: '/api/settings',
    });
    assert.equal(getRes.statusCode, 200);
    const getJson = JSON.parse(getRes.body);
    assert.equal(getJson.settings.rate_limit_retries, 7);
    assert.equal(getJson.settings.rate_limit_base_delay_ms, 3000);
    assert.equal(getJson.settings.rate_limit_max_delay_ms, 45000);
  } finally {
    await app.close();
  }
});
