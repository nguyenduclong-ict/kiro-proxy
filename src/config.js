import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT) || 20197,
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'kiro-proxy.sqlite'),
  envFile: path.join(ROOT, '.env'),
  bodyLimit: 64 * 1024 * 1024,
  upstreamTimeoutMs: 15 * 60 * 1000,
  usageRefreshMs: 10 * 60 * 1000,
  modelsRefreshMs: 6 * 60 * 60 * 1000,
  cleanupMs: 60 * 60 * 1000,
};

export const KIRO = {
  endpoints: [
    'https://q.us-east-1.amazonaws.com/generateAssistantResponse',
    'https://runtime.us-east-1.kiro.dev/generateAssistantResponse',
  ],
  qHost: 'https://q.us-east-1.amazonaws.com',
  userAgent: 'aws-sdk-js/3.0.0 kiro-ide/1.0.0',
};

export const DEFAULT_SETTINGS = {
  rotation: 'sticky', // 'sticky' = round robin per session, 'per_request' = round robin per request
  capture_bodies: false,
  body_retention_days: 3,
  log_retention_days: 30,
  // A request counts as a cache hit when credits per 1M input tokens, divided by the
  // model's rateMultiplier, is below this. Measured: ~1.65 on hit, ~6.15 on miss.
  cache_hit_threshold: 4,
  context_window_overrides: {},
  default_context_window: 1_000_000,
};

// Used until ListAvailableModels has been fetched with a real key.
export const FALLBACK_MODELS = {
  auto: { contextWindow: 1_000_000, rateMultiplier: 1.0 },
  'claude-opus-5.5': { contextWindow: 1_000_000, rateMultiplier: 2.0 },
  'claude-sonnet-5.5': { contextWindow: 1_000_000, rateMultiplier: 1.3 },
  'claude-haiku-5.5': { contextWindow: 1_000_000, rateMultiplier: 0.06 },
  'claude-opus-5': { contextWindow: 1_000_000, rateMultiplier: 2.2 },
  'claude-sonnet-5': { contextWindow: 1_000_000, rateMultiplier: 1.3 },
  'claude-opus-4.8': { contextWindow: 1_000_000, rateMultiplier: 2.2 },
  'claude-opus-4.7': { contextWindow: 1_000_000, rateMultiplier: 2.2 },
  'claude-opus-4.6': { contextWindow: 1_000_000, rateMultiplier: 2.2 },
  'claude-sonnet-4.6': { contextWindow: 1_000_000, rateMultiplier: 1.3 },
  'claude-opus-4.5': { contextWindow: 200_000, rateMultiplier: 2.2 },
  'claude-sonnet-4.5': { contextWindow: 200_000, rateMultiplier: 1.3 },
  'claude-haiku-4.5': { contextWindow: 200_000, rateMultiplier: 0.4 },
};

/** "kr/claude-opus-5-5[1m]" -> "claude-opus-5.5", "claude-haiku-4-5-20251001" -> "claude-haiku-4.5" */
export function normalizeModel(input) {
  let m = String(input || '').trim();
  m = m.replace(/^[a-z0-9_-]+\//i, '');
  m = m.replace(/\[[^\]]*\]$/, '');
  m = m.replace(/-\d{8}$/, '');
  m = m.replace(/^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d+)$/i, '$1-$2.$3');
  return m.toLowerCase() || 'auto';
}

export function modelInfo(store, modelId) {
  const settings = store.getSettings();
  const cached = store.getSetting('models_cache', null)?.models?.find((m) => m.id === modelId);
  const fallback = FALLBACK_MODELS[modelId];
  const override = Number(settings.context_window_overrides?.[modelId]);
  return {
    contextWindow: override || cached?.contextWindow || fallback?.contextWindow || settings.default_context_window,
    rateMultiplier: cached?.rateMultiplier ?? fallback?.rateMultiplier ?? 1,
  };
}
