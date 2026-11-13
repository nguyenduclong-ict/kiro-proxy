import { timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { config, modelInfo, normalizeModel } from '../config.js';
import { calculateRetryDelay, classifyUpstreamError } from '../keys.js';
import { callKiro, statusForException } from '../kiro/client.js';
import { EventStreamDecoder } from '../kiro/eventstream.js';
import { resolveSessionId } from '../session.js';
import { buildKiroRequest, estimateTokens } from '../translate/request.js';
import { clientError, errorBody, KiroResponseTranslator, sseFrame } from '../translate/response.js';

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function registerAnthropicRoutes(app, { store, pool, tracker, recorder }) {
  function authorized(req) {
    const h = req.headers;
    const given = h['x-api-key'] || String(h.authorization || '').replace(/^Bearer\s+/i, '');
    return Boolean(given) && safeEqual(given, store.getSetting('proxy_token'));
  }

  app.post('/v1/messages', async (req, reply) => {
    const t0 = Date.now();
    if (!authorized(req)) return reply.code(401).send(errorBody('authentication_error', 'Invalid proxy token'));
    const body = req.body;
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || !body.messages.length) {
      return reply.code(400).send(errorBody('invalid_request_error', 'messages: at least one message is required'));
    }

    const clientModel = String(body.model || '');
    const modelId = normalizeModel(clientModel);
    const info = modelInfo(store, modelId);
    const sessionId = resolveSessionId(req.headers, body);
    const stream = body.stream === true;
    const built = buildKiroRequest(body, { modelId, sessionId });
    const prefix = tracker.observe(built.conversationId, built.historyHashes, built.allHashes);

    const row = {
      ts: t0,
      session_id: sessionId,
      conversation_id: built.conversationId,
      model: modelId,
      client_model: clientModel,
      stream,
      req_bytes: Buffer.byteLength(built.json),
      history_len: built.historyLen,
      history_reused: prefix.reused,
      prev_entries: prefix.prevLen,
      attempts: 0,
    };
    const capture = () => ({ requestJson: JSON.stringify(body), kiroJson: built.json });

    const abort = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) abort.abort();
    });

    const tried = new Set();
    const failovers = [];
    let lastErr = null;
    let totalAttempts = 0;
    let rateLimitRetry = 0;

    const settings = store.getSettings();
    const maxRetries = Number(settings.rate_limit_retries ?? 5);
    const baseDelayMs = Number(settings.rate_limit_base_delay_ms ?? 2000);
    const maxDelayMs = Number(settings.rate_limit_max_delay_ms ?? 30000);

    retryLoop: while (true) {
      const maxAttempts = Math.max(1, pool.enabledCount());
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const key = pool.pick(sessionId, tried);
        if (!key) break;
        tried.add(key.id);
        totalAttempts++;
        row.attempts = totalAttempts;
        row.key_id = key.id;

        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(config.upstreamTimeoutMs)]);
        let r;
        try {
          r = await callKiro({ apiKey: key.api_key, body: built.json, signal });
        } catch (err) {
          if (abort.signal.aborted) {
            recorder.record({ ...row, status: 'aborted', latency_ms: Date.now() - t0, error: 'client closed before Kiro answered' }, capture());
            return reply;
          }
          r = { ok: false, status: 0, text: `upstream timeout or network error: ${err.message}`, endpoint: null };
        }
        row.endpoint = r.endpoint ? new URL(r.endpoint).host : null;

        if (!r.ok) {
          const cls = classifyUpstreamError(r.status, r.text);
          pool.reportFailure(key, cls, r.text);
          lastErr = { status: r.status, text: r.text, cls, retryAfter: r.retryAfter };
          if (cls.failover) {
            failovers.push(`${key.id}:${cls.kind}`);
            continue;
          }
          break retryLoop;
        }

        const out = await consume({ req, reply, res: r.res, key, row, built, info, t0, stream, clientModel, modelId, body, abort, capture, failovers });
        if (out.retry) {
          const cls = classifyUpstreamError(out.status, out.text);
          pool.reportFailure(key, cls, out.text);
          lastErr = { status: out.status, text: out.text, cls };
          if (cls.failover) {
            failovers.push(`${key.id}:${cls.kind}`);
            continue;
          }
          break retryLoop;
        }
        return reply;
      }

      // Check if the failure was rate limit (429) and we still have retry budget
      const isRateLimit = lastErr && (lastErr.status === 429 || lastErr.cls?.kind === 'rate_limit');
      if (isRateLimit && rateLimitRetry < maxRetries && !abort.signal.aborted) {
        const delay = calculateRetryDelay({
          attempt: rateLimitRetry,
          baseDelayMs,
          maxDelayMs,
          retryAfter: lastErr.retryAfter,
        });
        req.log.warn(
          { attempt: rateLimitRetry + 1, maxRetries, delayMs: delay, model: modelId },
          `Kiro 429 rate limit reached. Waiting ${delay}ms before retry ${rateLimitRetry + 1}/${maxRetries}...`,
        );

        try {
          await sleep(delay, undefined, { signal: abort.signal });
        } catch {
          if (abort.signal.aborted) {
            recorder.record({ ...row, status: 'aborted', latency_ms: Date.now() - t0, error: 'client closed while waiting for 429 retry' }, capture());
            return reply;
          }
        }

        if (abort.signal.aborted) {
          recorder.record({ ...row, status: 'aborted', latency_ms: Date.now() - t0, error: 'client closed while waiting for 429 retry' }, capture());
          return reply;
        }

        rateLimitRetry++;
        failovers.push(`retry_${rateLimitRetry}:429_wait_${Math.round(delay)}ms`);
        tried.clear();
        continue retryLoop;
      }

      break retryLoop;
    }

    row.failover_from = failovers.join(',') || null;
    if (!lastErr) {
      recorder.record({ ...row, status: 'error', http_status: 503, latency_ms: Date.now() - t0, error: 'no enabled Kiro key' }, capture());
      return reply.code(503).send(errorBody('api_error', 'kiro-proxy has no enabled Kiro key. Add one at http://127.0.0.1:20197'));
    }
    const ce = clientError(lastErr.status, lastErr.text, lastErr.cls?.kind);
    recorder.record({
      ...row,
      status: 'error',
      http_status: lastErr.status,
      latency_ms: Date.now() - t0,
      error: `${lastErr.cls?.kind || 'error'} ${lastErr.status}: ${String(lastErr.text).slice(0, 1500)}`,
    }, capture());
    return reply.code(ce.status).send(ce.body);
  });

  /**
   * Reads one Kiro EventStream response. An exception that arrives before any content
   * returns { retry } so the caller can try the next key; after content it is reported in-stream.
   */
  async function consume({ reply, res, key, row, built, info, t0, stream, clientModel, modelId, body, abort, capture, failovers }) {
    const tr = new KiroResponseTranslator({
      model: clientModel || modelId,
      fromKiro: built.fromKiro,
      inputTokensEstimate: estimateTokens(body),
      contextWindow: info.contextWindow,
    });
    const decoder = new EventStreamDecoder();
    let started = false;
    let ttfb = null;
    let streamError = null;

    const start = () => {
      ttfb = Date.now() - t0;
      if (!stream) return;
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      for (const f of tr.messageStart()) reply.raw.write(sseFrame(f));
      started = true;
    };

    try {
      outer: for await (const chunk of res.body) {
        for (const ev of decoder.push(chunk)) {
          const frames = tr.handle(ev);
          if (tr.error) break outer;
          if (frames.length) {
            if (ttfb === null) start();
            if (stream) for (const f of frames) reply.raw.write(sseFrame(f));
          }
        }
      }
    } catch (err) {
      if (abort.signal.aborted) {
        if (started) reply.raw.end();
        finishRow('aborted', 'client closed during stream');
        return { retry: false };
      }
      streamError = err.message;
    }

    function finishRow(status, error = null) {
      const inputTokens = tr.contextPct == null ? null : tr.inputTokens();
      const normRate = tr.credits != null && inputTokens >= 20_000
        ? tr.credits / (inputTokens / 1e6) / (info.rateMultiplier || 1)
        : null;
      recorder.record({
        ...row,
        status,
        http_status: status === 'ok' ? 200 : row.http_status,
        ttfb_ms: ttfb,
        latency_ms: Date.now() - t0,
        credits: tr.credits,
        context_pct: tr.contextPct,
        est_input_tokens: inputTokens ?? tr.inputTokensEstimate,
        est_output_tokens: tr.outputTokens(),
        norm_rate: normRate,
        stop_reason: tr.stopReason(),
        tool_calls: tr.toolCalls,
        failover_from: failovers.join(',') || null,
        error,
      }, { ...capture(), responseText: tr.transcript() });
    }

    const failure = tr.error ? tr.error.message : streamError;
    if (failure && !tr.hasContent) {
      const status = tr.error ? statusForException(tr.error.type) : 0;
      return { retry: true, status, text: failure };
    }

    if (failure) {
      // Part of the answer already reached the client: report the error in-stream.
      if (stream) {
        reply.raw.write(sseFrame({ event: 'error', data: errorBody('api_error', `Kiro stream failed: ${failure}`) }));
        reply.raw.end();
      } else {
        reply.code(502).send(errorBody('api_error', `Kiro stream failed: ${failure}`));
      }
      row.http_status = 502;
      finishRow('error', failure);
      return { retry: false };
    }

    pool.reportSuccess(key);
    if (stream) {
      if (!started) start();
      for (const f of tr.finish()) reply.raw.write(sseFrame(f));
      reply.raw.end();
    } else {
      if (ttfb === null) ttfb = Date.now() - t0;
      reply.code(200).send(tr.toMessage());
    }
    finishRow('ok');
    return { retry: false };
  }

  app.post('/v1/messages/count_tokens', async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send(errorBody('authentication_error', 'Invalid proxy token'));
    return { input_tokens: estimateTokens(req.body || {}) };
  });

  app.get('/v1/models', async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send(errorBody('authentication_error', 'Invalid proxy token'));
    const models = store.getSetting('models_cache', null)?.models || [];
    return {
      data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.name, created_at: '2026-01-01T00:00:00Z' })),
      has_more: false,
      first_id: models[0]?.id ?? null,
      last_id: models.at(-1)?.id ?? null,
    };
  });
}
