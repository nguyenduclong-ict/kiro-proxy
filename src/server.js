import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config, ROOT } from './config.js';
import { openDatabase, Store } from './db.js';
import { KeyPool } from './keys.js';
import { getUsage, listModels } from './kiro/account.js';
import { Recorder } from './recorder.js';
import { registerAnthropicRoutes } from './routes/anthropic.js';
import { registerApiRoutes } from './routes/api.js';
import { PrefixTracker } from './session.js';
import { errorBody } from './translate/response.js';

function readEnvKey(file) {
  try {
    const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((l) => /^\s*KIRO_API_KEY\s*=/.test(l));
    return line ? line.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '') : null;
  } catch {
    return null;
  }
}

export function buildApp({ store, logger = true } = {}) {
  const app = Fastify({
    logger,
    bodyLimit: config.bodyLimit,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const pool = new KeyPool(store);
  const tracker = new PrefixTracker();
  const recorder = new Recorder(store, app.log);

  async function refreshKeyUsage(key, { strict = false } = {}) {
    try {
      const usage = await getUsage(key.api_key);
      const fields = { usage_json: JSON.stringify(usage), usage_checked_at: Date.now() };
      if (usage.exhausted) {
        Object.assign(fields, { cooldown_until: usage.nextReset || Date.now() + 3_600_000, last_error: 'quota: credits exhausted for this cycle' });
      } else if (/^(quota|auth)/.test(key.last_error || '')) {
        Object.assign(fields, { cooldown_until: null, last_error: null });
      }
      store.updateKey(key.id, fields);
      return usage;
    } catch (err) {
      store.updateKey(key.id, { usage_checked_at: Date.now(), last_error: `usage check: ${err.message}`.slice(0, 500) });
      if (strict) throw err;
      return null;
    }
  }

  async function refreshModels({ strict = false } = {}) {
    const key = store.listKeys().find((k) => k.enabled);
    if (!key) {
      if (strict) throw new Error('no enabled key');
      return null;
    }
    try {
      const models = await listModels(key.api_key);
      const value = { at: Date.now(), models };
      if (models.length) store.setSetting('models_cache', value);
      return value;
    } catch (err) {
      if (strict) throw err;
      app.log.warn(`model list refresh failed: ${err.message}`);
      return null;
    }
  }

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    if (req.url.startsWith('/v1/')) {
      const type = status === 413 ? 'request_too_large' : status < 500 ? 'invalid_request_error' : 'api_error';
      return reply.code(status).send(errorBody(type, err.message));
    }
    return reply.code(status).send({ error: err.message });
  });

  registerAnthropicRoutes(app, { store, pool, tracker, recorder });
  registerApiRoutes(app, { store, refreshKeyUsage, refreshModels });

  app.register(fastifyStatic, { root: path.join(ROOT, 'public'), index: 'index.html' });
  app.get('/vendor/chart.js', (req, reply) => {
    reply.type('application/javascript').header('cache-control', 'max-age=86400');
    return reply.send(fs.createReadStream(path.join(ROOT, 'node_modules/chart.js/dist/chart.umd.min.js')));
  });

  app.decorate('kiro', { pool, refreshKeyUsage, refreshModels });
  return app;
}

async function main() {
  const store = new Store(openDatabase(config.dbPath));

  if (!store.getSetting('proxy_token')) store.setSetting('proxy_token', `kp-${randomBytes(24).toString('hex')}`);
  if (!store.listKeys().length) {
    const envKey = process.env.KIRO_API_KEY || readEnvKey(config.envFile) || readEnvKey(path.join(ROOT, '..', '.env'));
    if (envKey) store.addKey({ label: 'From .env', apiKey: envKey });
  }

  const app = buildApp({ store, logger: { level: process.env.LOG_LEVEL || 'info' } });
  await app.listen({ host: config.host, port: config.port });

  const { refreshKeyUsage, refreshModels } = app.kiro;
  const refreshAll = async () => {
    for (const k of store.listKeys().filter((x) => x.enabled)) await refreshKeyUsage(k);
  };
  const cleanup = () => {
    const s = store.getSettings();
    store.cleanup({ logRetentionDays: s.log_retention_days, bodyRetentionDays: s.body_retention_days });
  };
  refreshModels().then(refreshAll).catch(() => {});
  cleanup();
  setInterval(() => refreshAll().catch(() => {}), config.usageRefreshMs).unref();
  setInterval(() => refreshModels().catch(() => {}), config.modelsRefreshMs).unref();
  setInterval(cleanup, config.cleanupMs).unref();

  app.log.info(`kiro-proxy ready. Dashboard: http://${config.host}:${config.port}  keys: ${store.listKeys().length}`);

  const stop = async () => {
    await app.close().catch(() => {});
    store.db.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
