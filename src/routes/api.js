import { DEFAULT_SETTINGS } from '../config.js';
import { getUsage, listModels } from '../kiro/account.js';

const mask = (k) => (k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : '••••');

function publicKey(k, sessions) {
  let usage = null;
  try { usage = k.usage_json ? JSON.parse(k.usage_json) : null; } catch { /* ignore */ }
  return {
    id: k.id,
    label: k.label,
    masked: mask(k.api_key),
    enabled: Boolean(k.enabled),
    created_at: k.created_at,
    last_used_at: k.last_used_at,
    cooldown_until: k.cooldown_until,
    last_error: k.last_error,
    usage,
    usage_checked_at: k.usage_checked_at,
    active_sessions: sessions.get(k.id) || 0,
  };
}

const RANGES = { '24h': [86_400_000, 'hour'], '7d': [7 * 86_400_000, 'day'], '30d': [30 * 86_400_000, 'day'] };

// The Keys screen asks for fresh credit each time it opens. Kiro's usage endpoint is
// rate limited, so a key checked this recently is served from cache instead.
const USAGE_MIN_REFRESH_MS = 60_000;

export function registerApiRoutes(app, { store, refreshKeyUsage, refreshModels }) {
  // The dashboard has no login. It is reachable only on 127.0.0.1; these checks stop other
  // websites from driving it through the browser (DNS rebinding, cross-site POST).
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const host = String(req.headers.host || '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      return reply.code(403).send({ error: 'dashboard API is only available on localhost' });
    }
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return reply.code(403).send({ error: 'cross-origin request rejected' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE'
        && !String(req.headers['content-type'] || '').startsWith('application/json')) {
      return reply.code(415).send({ error: 'content-type must be application/json' });
    }
  });

  const keyList = () => {
    const sessions = new Map(store.sessionCountsByKey(Date.now() - 2 * 3_600_000).map((r) => [r.key_id, r.n]));
    return store.listKeys().map((k) => publicKey(k, sessions));
  };

  app.get('/api/keys', async () => keyList());

  app.post('/api/keys/usage', async () => {
    const now = Date.now();
    const stale = store.listKeys().filter((k) => k.enabled
      && !(k.usage_checked_at && now - k.usage_checked_at < USAGE_MIN_REFRESH_MS));
    await Promise.all(stale.map((k) => refreshKeyUsage(k)));
    return keyList();
  });

  app.post('/api/keys', async (req, reply) => {
    const apiKey = String(req.body?.apiKey || '').trim();
    const label = String(req.body?.label || '').trim().slice(0, 80);
    if (!apiKey) return reply.code(400).send({ error: 'apiKey is required' });
    if (store.findKeyByValue(apiKey)) return reply.code(409).send({ error: 'this key is already in the pool' });
    let models;
    try {
      models = await listModels(apiKey);
    } catch (err) {
      return reply.code(400).send({ error: `Kiro rejected the key: ${err.message}` });
    }
    const key = store.addKey({ label: label || `Key ${store.listKeys().length + 1}`, apiKey });
    if (models.length) store.setSetting('models_cache', { at: Date.now(), models });
    await refreshKeyUsage(key).catch(() => {});
    return keyList().find((k) => k.id === key.id);
  });

  app.patch('/api/keys/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!store.getKey(id)) return reply.code(404).send({ error: 'not found' });
    const fields = {};
    if (typeof req.body?.label === 'string') fields.label = req.body.label.trim().slice(0, 80) || `Key ${id}`;
    if (typeof req.body?.enabled === 'boolean') fields.enabled = req.body.enabled;
    if (req.body?.clearCooldown) Object.assign(fields, { cooldown_until: null, last_error: null });
    store.updateKey(id, fields);
    return keyList().find((k) => k.id === id);
  });

  app.delete('/api/keys/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!store.getKey(id)) return reply.code(404).send({ error: 'not found' });
    store.deleteKey(id);
    return { ok: true };
  });

  app.post('/api/keys/:id/test', async (req, reply) => {
    const key = store.getKey(Number(req.params.id));
    if (!key) return reply.code(404).send({ error: 'not found' });
    try {
      await refreshKeyUsage(key, { strict: true });
    } catch (err) {
      return reply.code(502).send({ error: err.message, key: keyList().find((k) => k.id === key.id) });
    }
    return keyList().find((k) => k.id === key.id);
  });

  app.get('/api/stats', async (req) => {
    const [span, bucket] = RANGES[req.query.range] || RANGES['24h'];
    const model = String(req.query.model || '').trim();
    const settings = store.getSettings();
    return {
      range: req.query.range || '24h',
      bucket,
      threshold: settings.cache_hit_threshold,
      ...store.stats({
        since: Date.now() - span,
        bucket,
        threshold: settings.cache_hit_threshold,
        model: model || undefined,
      }),
    };
  });

  app.get('/api/logs', async (req) => {
    const q = req.query;
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const offset = Math.max(0, Number(q.offset) || 0);
    return store.listRequests({
      limit,
      offset,
      status: q.status || undefined,
      keyId: Number(q.key) || undefined,
      model: q.model || undefined,
      session: q.session || undefined,
    });
  });

  app.get('/api/logs/:id', async (req, reply) => {
    const row = store.getRequest(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'not found' });
    return { ...row, body: store.getBody(row.id) || null };
  });

  app.get('/api/settings', async () => ({
    settings: store.getSettings(),
    proxyToken: store.getSetting('proxy_token'),
    models: store.getSetting('models_cache', null),
  }));

  app.put('/api/settings', async (req, reply) => {
    const b = req.body || {};
    const errors = [];
    if (b.rotation !== undefined) {
      if (b.rotation === 'sticky' || b.rotation === 'per_request') store.setSetting('rotation', b.rotation);
      else errors.push('rotation must be sticky or per_request');
    }
    if (b.capture_bodies !== undefined) store.setSetting('capture_bodies', Boolean(b.capture_bodies));
    for (const [name, min, max] of [
      ['body_retention_days', 1, 90],
      ['log_retention_days', 1, 365],
      ['cache_hit_threshold', 0.1, 100],
      ['rate_limit_retries', 0, 20],
      ['rate_limit_base_delay_ms', 100, 60000],
      ['rate_limit_max_delay_ms', 1000, 300000],
    ]) {
      if (b[name] === undefined) continue;
      const n = Number(b[name]);
      if (Number.isFinite(n) && n >= min && n <= max) store.setSetting(name, n);
      else errors.push(`${name} must be between ${min} and ${max}`);
    }
    if (b.context_window_overrides !== undefined) {
      const o = {};
      for (const [k, v] of Object.entries(b.context_window_overrides || {})) {
        const n = Number(v);
        if (k && Number.isFinite(n) && n >= 1000) o[k] = Math.round(n);
      }
      store.setSetting('context_window_overrides', o);
    }
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    return { settings: store.getSettings(), defaults: DEFAULT_SETTINGS };
  });

  app.post('/api/models/refresh', async (req, reply) => {
    try {
      return await refreshModels({ strict: true });
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }
  });
}
