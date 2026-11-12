import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function clean(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && t.length <= 200 ? t : null;
}

/** Stable id for one Claude Code session. Never random, so restarts keep the same value. */
export function resolveSessionId(headers, body) {
  const fromHeader = clean(headers['x-claude-code-session-id']);
  if (fromHeader) return fromHeader;

  const userId = body?.metadata?.user_id;
  if (typeof userId === 'string') {
    const m = userId.match(/_session_([0-9a-f-]{36})$/i);
    if (m) return m[1];
    if (userId.trim().startsWith('{')) {
      try {
        const s = clean(JSON.parse(userId)?.session_id);
        if (s) return s;
      } catch { /* not JSON */ }
    }
  }

  const first = Array.isArray(body?.messages) ? body.messages[0]?.content : null;
  return `h-${sha256(JSON.stringify([body?.system ?? null, first ?? null])).slice(0, 32)}`;
}

/**
 * conversationId for Kiro. Derived from the session and the first history entry, so the main
 * thread and each subagent of a session get different but stable ids.
 */
export function conversationIdFor(sessionId, firstEntryHash) {
  const h = sha256(`conv:${sessionId}:${firstEntryHash}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Remembers the entry hashes of the last request per conversation thread and reports how many
 * leading history entries the next request sent unchanged. If the proxy keeps the prefix stable,
 * `reused` equals `prevLen` on every turn.
 */
export class PrefixTracker {
  constructor(maxThreads = 2000) {
    this.maxThreads = maxThreads;
    this.threads = new Map();
  }

  observe(threadKey, historyHashes, allHashes) {
    const prev = this.threads.get(threadKey);
    let reused = 0;
    if (prev) {
      while (reused < prev.length && reused < historyHashes.length && prev[reused] === historyHashes[reused]) reused++;
    }
    this.threads.delete(threadKey);
    this.threads.set(threadKey, allHashes);
    if (this.threads.size > this.maxThreads) this.threads.delete(this.threads.keys().next().value);
    return { reused: prev ? reused : null, prevLen: prev ? prev.length : null };
  }
}
