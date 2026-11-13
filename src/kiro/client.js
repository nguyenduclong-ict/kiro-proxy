import { randomUUID } from 'node:crypto';
import { KIRO } from '../config.js';

export function kiroHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/vnd.amazon.eventstream',
    'User-Agent': KIRO.userAgent,
    'X-Amz-User-Agent': KIRO.userAgent,
    Authorization: `Bearer ${apiKey}`,
    TokenType: 'API_KEY',
    'x-amzn-kiro-agent-mode': 'spec',
    'x-amzn-codewhisperer-machine-id': 'kiro-desktop',
    'Amz-Sdk-Request': 'attempt=1; max=1',
    'Amz-Sdk-Invocation-Id': randomUUID(),
  };
}

/**
 * POST generateAssistantResponse. Tries the next endpoint only on network errors and 5xx.
 * Returns { ok:true, res, endpoint } or { ok:false, status, text, endpoint }.
 */
export async function callKiro({ apiKey, body, signal, endpoints = KIRO.endpoints }) {
  let last = { ok: false, status: 0, text: 'no endpoint', endpoint: null };
  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i];
    let res;
    try {
      res = await fetch(endpoint, { method: 'POST', headers: kiroHeaders(apiKey), body, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      last = { ok: false, status: 0, text: `network error: ${err.cause?.code || err.message}`, endpoint };
      continue;
    }
    if (res.ok) return { ok: true, res, endpoint };
    const text = (await res.text().catch(() => '')).slice(0, 4000);
    const retryAfter = res.headers.get('retry-after');
    last = { ok: false, status: res.status, text, endpoint, retryAfter };
    if (res.status < 500) return last;
  }
  return last;
}

/** Maps an EventStream exception that arrived before any content to an HTTP-like status. */
export function statusForException(type = '') {
  if (/throttl|toomanyrequests/i.test(type)) return 429;
  if (/validation|badrequest|contentlength/i.test(type)) return 400;
  if (/quota|limitexceeded/i.test(type)) return 402;
  if (/accessdenied|unauthorized|expiredtoken|forbidden/i.test(type)) return 403;
  return 500;
}
