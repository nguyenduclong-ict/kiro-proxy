/**
 * Key pool with round robin rotation.
 *
 * - sticky (default): each new session gets the next key in round robin order and keeps it,
 *   so Kiro's per-account prompt cache keeps hitting. A session moves only when its key fails.
 * - per_request: every request takes the next key.
 */
export class KeyPool {
  constructor(store, now = () => Date.now()) {
    this.store = store;
    this.now = now;
  }

  enabledCount() {
    return this.store.listKeys().filter((k) => k.enabled).length;
  }

  pick(sessionId, exclude = new Set()) {
    const { rotation } = this.store.getSettings();
    const t = this.now();
    const enabled = this.store.listKeys().filter((k) => k.enabled && !exclude.has(k.id));
    if (!enabled.length) return null;

    let ready = enabled.filter((k) => !(k.cooldown_until > t));
    // Every key is cooling down: use the one that recovers first instead of failing outright.
    if (!ready.length) ready = [enabled.reduce((a, b) => (a.cooldown_until <= b.cooldown_until ? a : b))];

    const sticky = rotation !== 'per_request' && sessionId;
    if (sticky) {
      const assigned = this.store.getSessionKey(sessionId);
      const key = assigned && ready.find((k) => k.id === assigned.key_id);
      if (key) {
        this.store.setSessionKey(sessionId, key.id);
        return key;
      }
    }

    const key = this.nextRoundRobin(ready);
    if (sticky) this.store.setSessionKey(sessionId, key.id);
    return key;
  }

  nextRoundRobin(ready) {
    const sorted = [...ready].sort((a, b) => a.id - b.id);
    const last = Number(this.store.getSetting('rr_last_key_id', 0));
    const key = sorted.find((k) => k.id > last) || sorted[0];
    this.store.setSetting('rr_last_key_id', key.id);
    return key;
  }

  reportSuccess(key) {
    this.store.updateKey(key.id, { last_used_at: this.now(), cooldown_until: null });
  }

  reportFailure(key, classification, message) {
    if (classification.kind === 'request') return; // the request was bad, not the key
    const fields = { last_error: `${classification.kind}: ${String(message).slice(0, 500)}` };
    if (classification.cooldownMs) fields.cooldown_until = this.now() + classification.cooldownMs;
    this.store.updateKey(key.id, fields);
  }
}

export function classifyUpstreamError(status, text = '') {
  const t = String(text).toLowerCase();
  if (status === 429 || /throttl|too many requests|rate exceeded/.test(t)) {
    return { kind: 'rate_limit', cooldownMs: 30_000, failover: true };
  }
  if (status === 400 || status === 413) return { kind: 'request', cooldownMs: 0, failover: false };
  if (status === 402 || /quota|reached the limit|limit reached|insufficient|monthly_request_count|overage/.test(t)) {
    return { kind: 'quota', cooldownMs: 60 * 60_000, failover: true };
  }
  if (status === 401 || status === 403) return { kind: 'auth', cooldownMs: 10 * 60_000, failover: true };
  if (status === 0 || status >= 500) return { kind: 'upstream', cooldownMs: 0, failover: true };
  return { kind: 'request', cooldownMs: 0, failover: false };
}

/**
 * Calculates exponential backoff delay with jitter for rate limit (429) retries.
 * Respects Retry-After header if provided.
 */
export function calculateRetryDelay({
  attempt = 0,
  baseDelayMs = 2000,
  maxDelayMs = 30000,
  retryAfter = null,
  random = Math.random,
} = {}) {
  let delay = Math.min(maxDelayMs, Math.max(0, baseDelayMs * Math.pow(2, attempt)));
  if (retryAfter) {
    const sec = Number(retryAfter);
    if (Number.isFinite(sec) && sec > 0) {
      delay = Math.min(maxDelayMs, Math.max(delay, sec * 1000));
    } else {
      const parsed = Date.parse(retryAfter);
      if (Number.isFinite(parsed)) {
        const diff = parsed - Date.now();
        if (diff > 0) delay = Math.min(maxDelayMs, Math.max(delay, diff));
      }
    }
  }
  const jitterRange = Math.min(1000, Math.max(100, delay * 0.2));
  const jitter = Math.floor(random() * jitterRange);
  return Math.min(maxDelayMs, delay + jitter);
}
