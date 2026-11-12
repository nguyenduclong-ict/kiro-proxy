import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SETTINGS } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  cooldown_until INTEGER,
  last_error TEXT,
  usage_json TEXT,
  usage_checked_at INTEGER
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT,
  conversation_id TEXT,
  key_id INTEGER,
  model TEXT,
  client_model TEXT,
  stream INTEGER,
  status TEXT NOT NULL,
  http_status INTEGER,
  ttfb_ms INTEGER,
  latency_ms INTEGER,
  credits REAL,
  context_pct REAL,
  est_input_tokens INTEGER,
  est_output_tokens INTEGER,
  norm_rate REAL,
  req_bytes INTEGER,
  history_len INTEGER,
  history_reused INTEGER,
  prev_entries INTEGER,
  stop_reason TEXT,
  tool_calls INTEGER,
  endpoint TEXT,
  attempts INTEGER,
  failover_from TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS idx_requests_key ON requests(key_id, ts);
CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id, ts);

CREATE TABLE IF NOT EXISTS request_bodies (
  request_id INTEGER PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  request_json TEXT,
  kiro_json TEXT,
  response_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_bodies_ts ON request_bodies(ts);

CREATE TABLE IF NOT EXISTS session_keys (
  session_id TEXT PRIMARY KEY,
  key_id INTEGER NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  last_used INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const REQUEST_COLUMNS = [
  'ts', 'session_id', 'conversation_id', 'key_id', 'model', 'client_model', 'stream', 'status',
  'http_status', 'ttfb_ms', 'latency_ms', 'credits', 'context_pct', 'est_input_tokens',
  'est_output_tokens', 'norm_rate', 'req_bytes', 'history_len', 'history_reused', 'prev_entries',
  'stop_reason', 'tool_calls', 'endpoint', 'attempts', 'failover_from', 'error',
];

const KEY_UPDATABLE = new Set([
  'label', 'enabled', 'last_used_at', 'cooldown_until', 'last_error', 'usage_json', 'usage_checked_at',
]);

/** node:sqlite rejects undefined and booleans. */
function sqlValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  if (file !== ':memory:') {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      try { fs.chmodSync(f, 0o600); } catch { /* file may not exist yet */ }
    }
  }
  return db;
}

export class Store {
  constructor(db) {
    this.db = db;
    this.statements = new Map();
  }

  q(sql) {
    let st = this.statements.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.statements.set(sql, st);
    }
    return st;
  }

  // ---- settings ----
  getSetting(key, fallback = undefined) {
    const row = this.q('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  setSetting(key, value) {
    this.q('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  getSettings() {
    const out = structuredClone(DEFAULT_SETTINGS);
    for (const row of this.q('SELECT key, value FROM settings').all()) {
      if (Object.hasOwn(DEFAULT_SETTINGS, row.key)) out[row.key] = JSON.parse(row.value);
    }
    return out;
  }

  // ---- keys ----
  listKeys() {
    return this.q('SELECT * FROM keys ORDER BY id').all();
  }

  getKey(id) {
    return this.q('SELECT * FROM keys WHERE id = ?').get(id);
  }

  findKeyByValue(apiKey) {
    return this.q('SELECT * FROM keys WHERE api_key = ?').get(apiKey);
  }

  addKey({ label, apiKey }) {
    const r = this.q('INSERT INTO keys(label, api_key, enabled, created_at) VALUES (?, ?, 1, ?)')
      .run(label, apiKey, Date.now());
    return this.getKey(Number(r.lastInsertRowid));
  }

  updateKey(id, fields) {
    const cols = Object.keys(fields).filter((c) => KEY_UPDATABLE.has(c));
    if (!cols.length) return;
    const sql = `UPDATE keys SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
    this.q(sql).run(...cols.map((c) => sqlValue(fields[c])), id);
  }

  deleteKey(id) {
    this.q('DELETE FROM keys WHERE id = ?').run(id);
  }

  sessionCountsByKey(since) {
    return this.q('SELECT key_id, COUNT(*) AS n FROM session_keys WHERE last_used >= ? GROUP BY key_id').all(since);
  }

  // ---- sticky session -> key ----
  getSessionKey(sessionId) {
    return this.q('SELECT key_id FROM session_keys WHERE session_id = ?').get(sessionId);
  }

  setSessionKey(sessionId, keyId) {
    this.q(`INSERT INTO session_keys(session_id, key_id, last_used) VALUES (?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET key_id = excluded.key_id, last_used = excluded.last_used`)
      .run(sessionId, keyId, Date.now());
  }

  // ---- requests ----
  insertRequest(row) {
    const sql = `INSERT INTO requests(${REQUEST_COLUMNS.join(', ')}) VALUES (${REQUEST_COLUMNS.map(() => '?').join(', ')})`;
    const r = this.q(sql).run(...REQUEST_COLUMNS.map((c) => sqlValue(row[c])));
    return Number(r.lastInsertRowid);
  }

  insertBody(requestId, ts, { requestJson, kiroJson, responseText }) {
    this.q('INSERT INTO request_bodies(request_id, ts, request_json, kiro_json, response_text) VALUES (?, ?, ?, ?, ?)')
      .run(requestId, ts, sqlValue(requestJson), sqlValue(kiroJson), sqlValue(responseText));
  }

  getRequest(id) {
    return this.q('SELECT r.*, k.label AS key_label FROM requests r LEFT JOIN keys k ON k.id = r.key_id WHERE r.id = ?').get(id);
  }

  getBody(id) {
    return this.q('SELECT request_json, kiro_json, response_text FROM request_bodies WHERE request_id = ?').get(id);
  }

  listRequests({ limit = 50, offset = 0, status, keyId, model, session } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('r.status = ?'); params.push(status); }
    if (keyId) { where.push('r.key_id = ?'); params.push(keyId); }
    if (model) { where.push('r.model LIKE ?'); params.push(`%${model}%`); }
    if (session) { where.push('r.session_id LIKE ?'); params.push(`${session}%`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.q(`SELECT COUNT(*) AS n FROM requests r ${w}`).get(...params).n;
    const rows = this.q(`SELECT r.*, k.label AS key_label, (b.request_id IS NOT NULL) AS has_body
                         FROM requests r LEFT JOIN keys k ON k.id = r.key_id
                         LEFT JOIN request_bodies b ON b.request_id = r.id
                         ${w} ORDER BY r.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { total, rows };
  }

  // ---- stats ----
  stats({ since, bucket, threshold }) {
    const fmt = bucket === 'hour' ? '%Y-%m-%d %H:00' : '%Y-%m-%d';
    const agg = `COUNT(*) AS requests,
      SUM(status = 'ok') AS ok,
      SUM(status = 'error') AS errors,
      SUM(status = 'aborted') AS aborted,
      COALESCE(SUM(credits), 0) AS credits,
      COALESCE(SUM(est_input_tokens), 0) AS input_tokens,
      COALESCE(SUM(est_output_tokens), 0) AS output_tokens,
      SUM(norm_rate IS NOT NULL AND norm_rate < :th) AS hits,
      SUM(norm_rate IS NOT NULL AND norm_rate >= :th) AS misses,
      AVG(CASE WHEN status = 'ok' THEN latency_ms END) AS avg_latency`;
    const p = { since, th: threshold };
    return {
      totals: this.q(`SELECT ${agg} FROM requests WHERE ts >= :since`).get(p),
      series: this.q(`SELECT strftime('${fmt}', ts / 1000, 'unixepoch', 'localtime') AS bucket, ${agg}
                      FROM requests WHERE ts >= :since GROUP BY bucket ORDER BY bucket`).all(p),
      byKey: this.q(`SELECT r.key_id, k.label, ${agg} FROM requests r LEFT JOIN keys k ON k.id = r.key_id
                     WHERE r.ts >= :since GROUP BY r.key_id ORDER BY credits DESC`).all(p),
      byModel: this.q(`SELECT model, ${agg} FROM requests WHERE ts >= :since GROUP BY model ORDER BY credits DESC`).all(p),
      topSessions: this.q(`SELECT session_id, ${agg}, MAX(est_input_tokens) AS max_input, MAX(ts) AS last_ts
                           FROM requests WHERE ts >= :since AND session_id IS NOT NULL
                           GROUP BY session_id ORDER BY credits DESC LIMIT 10`).all(p),
    };
  }

  cleanup({ logRetentionDays, bodyRetentionDays }) {
    const now = Date.now();
    const day = 86_400_000;
    this.q('DELETE FROM request_bodies WHERE ts < ?').run(now - bodyRetentionDays * day);
    this.q('DELETE FROM requests WHERE ts < ?').run(now - logRetentionDays * day);
    this.q('DELETE FROM session_keys WHERE last_used < ?').run(now - 7 * day);
  }
}
