'use strict';

const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => (n == null || Number.isNaN(Number(n)) ? '–' : Number(n).toLocaleString('vi-VN', { maximumFractionDigits: d, minimumFractionDigits: d }));
const fmtTok = (n) => (n == null ? '–' : n >= 1e6 ? `${fmt(n / 1e6, 2)}M` : n >= 1e3 ? `${fmt(n / 1e3, 1)}k` : fmt(n));
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('vi-VN', { hour12: false }) : '–');
const ago = (ts) => {
  if (!ts) return '–';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s trước`;
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  return fmtTime(ts);
};

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function setMsg(el, text, ok) {
  el.textContent = text;
  el.className = `msg ${ok ? 'ok' : 'err'}`;
}

// ---------- tabs ----------
let current = 'keys';
const loaders = {};
function showTab(name) {
  current = name;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('active', s.id === `tab-${name}`);
  try { localStorage.setItem('tab', name); } catch { /* storage unavailable */ }
  loaders[name]?.();
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
});
$('#endpoint').textContent = `· ${location.host}`;

// ---------- keys ----------
let keysCache = [];
function renderKeys() {
  const tb = $('#keys-table tbody');
  if (!keysCache.length) {
    tb.innerHTML = '<tr><td colspan="8" class="muted">Chưa có key nào.</td></tr>';
    return;
  }
  const now = Date.now();
  tb.innerHTML = keysCache.map((k) => {
    const u = k.usage;
    const pct = u && u.limit ? Math.min(100, (u.used / u.limit) * 100) : 0;
    const usage = u
      ? `${fmt(u.used, 1)} / ${fmt(u.limit)} <span class="muted small">${esc(u.plan || '')}</span><div class="bar"><i style="width:${pct}%"></i></div><span class="muted small">reset ${u.nextReset ? new Date(u.nextReset).toLocaleDateString('vi-VN') : '–'}</span>`
      : '<span class="muted">–</span>';
    let state = k.enabled ? '<span class="chip ok">bật</span>' : '<span class="chip">tắt</span>';
    if (k.cooldown_until > now) state += ` <span class="chip warn" title="${esc(k.last_error || '')}">cooldown đến ${new Date(k.cooldown_until).toLocaleTimeString('vi-VN', { hour12: false })}</span>`;
    else if (k.last_error) state += ` <span class="chip err" title="${esc(k.last_error)}">lỗi gần nhất</span>`;
    return `<tr data-id="${k.id}">
      <td>${k.id}</td>
      <td><span class="label">${esc(k.label)}</span> <button class="small" data-act="rename">sửa</button></td>
      <td class="mono">${esc(k.masked)}</td>
      <td>${usage}</td>
      <td>${state}</td>
      <td class="num">${k.active_sessions}</td>
      <td>${ago(k.last_used_at)}</td>
      <td>
        <button class="small" data-act="toggle">${k.enabled ? 'Tắt' : 'Bật'}</button>
        <button class="small" data-act="test">Kiểm tra</button>
        ${k.cooldown_until > now || k.last_error ? '<button class="small" data-act="clear">Bỏ cooldown</button>' : ''}
        <button class="small danger" data-act="delete">Xoá</button>
      </td></tr>`;
  }).join('');
}

// Kiro only returns credit when asked. Refreshing on every visit to the Keys tab keeps
// the numbers current; the server skips keys it checked less than a minute ago.
let usageRefresh = null;
function loadKeysUsage() {
  if (usageRefresh || !keysCache.some((k) => k.enabled)) return usageRefresh;
  const note = $('#keys-usage-note');
  note.textContent = 'Đang cập nhật credit…';
  usageRefresh = api('/api/keys/usage', { method: 'POST', body: {} })
    .then((list) => {
      keysCache = list;
      renderKeys();
      const at = Math.max(0, ...list.map((k) => k.usage_checked_at || 0));
      note.textContent = at ? `Credit cập nhật ${ago(at)}` : '';
    })
    .catch((err) => { note.textContent = `Không cập nhật được credit: ${err.message}`; })
    .finally(() => { usageRefresh = null; });
  return usageRefresh;
}

loaders.keys = async () => {
  keysCache = await api('/api/keys');
  renderKeys();
  loadKeysUsage();
};

$('#keys-table').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = Number(b.closest('tr').dataset.id);
  const k = keysCache.find((x) => x.id === id);
  try {
    if (b.dataset.act === 'toggle') await api(`/api/keys/${id}`, { method: 'PATCH', body: { enabled: !k.enabled } });
    if (b.dataset.act === 'clear') await api(`/api/keys/${id}`, { method: 'PATCH', body: { clearCooldown: true } });
    if (b.dataset.act === 'rename') {
      const label = prompt('Nhãn mới', k.label);
      if (label == null) return;
      await api(`/api/keys/${id}`, { method: 'PATCH', body: { label } });
    }
    if (b.dataset.act === 'test') {
      b.disabled = true;
      b.textContent = '…';
      await api(`/api/keys/${id}/test`, { method: 'POST', body: {} });
    }
    if (b.dataset.act === 'delete') {
      if (!confirm(`Xoá key "${k.label}" (${k.masked})? Không hoàn tác được.`)) return;
      await api(`/api/keys/${id}`, { method: 'DELETE' });
    }
  } catch (err) {
    alert(err.message);
  }
  loaders.keys();
});

$('#add-key').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = $('#add-key-msg');
  const btn = f.querySelector('button');
  btn.disabled = true;
  setMsg(msg, 'Đang kiểm tra key với Kiro…', true);
  try {
    await api('/api/keys', { method: 'POST', body: { label: f.label.value, apiKey: f.apiKey.value } });
    f.reset();
    setMsg(msg, 'Đã thêm.', true);
    loaders.keys();
  } catch (err) {
    setMsg(msg, err.message, false);
  } finally {
    btn.disabled = false;
  }
});

// ---------- stats ----------
let chart;
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const hitRate = (r) => (r.hits + r.misses ? `${fmt((100 * r.hits) / (r.hits + r.misses))}%` : '–');
const perM = (r) => (r.input_tokens ? fmt(r.credits / (r.input_tokens / 1e6), 2) : '–');
const fmtMs = (ms) => (ms == null || Number.isNaN(Number(ms)) ? '–' : ms < 1000 ? `${fmt(ms)} ms` : `${fmt(ms / 1000, 1)}s`);
const fmtTps = (v) => (v == null ? '–' : `${fmt(v, 1)} tok/s`);

function aggTable(el, rows, firstCol, firstLabel, rowAttrs = () => '') {
  el.innerHTML = `<thead><tr><th>${firstLabel}</th><th class="num">Request</th><th class="num">Lỗi</th><th class="num">Credit</th><th class="num">Input</th><th class="num">Credit/1M</th><th class="num">Cache hit</th><th class="num" title="Thời gian tới token đầu">TTFT</th><th class="num" title="Output token mỗi giây">TPS</th></tr></thead><tbody>${
    rows.length
      ? rows.map((r) => `<tr ${rowAttrs(r)}><td>${firstCol(r)}</td><td class="num">${fmt(r.requests)}</td><td class="num">${fmt(r.errors)}</td><td class="num">${fmt(r.credits, 2)}</td><td class="num">${fmtTok(r.input_tokens)}</td><td class="num">${perM(r)}</td><td class="num">${hitRate(r)}</td><td class="num">${fmtMs(r.avg_ttft)}</td><td class="num">${fmtTps(r.avg_tps)}</td></tr>`).join('')
      : '<tr><td colspan="9" class="muted">Chưa có dữ liệu.</td></tr>'
  }</tbody>`;
}

loaders.stats = async () => {
  const range = $('#range').value;
  const model = $('#stats-model').value;
  const qs = new URLSearchParams({ range });
  if (model) qs.set('model', model);
  const s = await api(`/api/stats?${qs}`);

  const modelSel = $('#stats-model');
  const selectedModel = modelSel.value;
  const models = s.models || [];
  if (modelSel.dataset.loadedModels !== models.join(',')) {
    modelSel.innerHTML = '<option value="">Mọi model</option>' + models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    modelSel.dataset.loadedModels = models.join(',');
    modelSel.value = selectedModel;
  }

  const t = s.totals;
  $('#stats-note').textContent = `Cache hit ước lượng: credit/1M token/rateMultiplier < ${s.threshold}. Kiro không trả số token cache, chỉ trả credit và % context. TTFT: thời gian tới token đầu của request stream. TPS: output token ước lượng mỗi giây sinh của request stream.`;
  $('#tiles').innerHTML = [
    ['Credit', fmt(t.credits, 2)],
    ['Request', fmt(t.requests)],
    ['Lỗi', fmt(t.errors)],
    ['Input ước lượng', fmtTok(t.input_tokens)],
    ['Output ước lượng', fmtTok(t.output_tokens)],
    ['Credit / 1M input', perM(t)],
    ['Cache hit ước lượng', hitRate(t)],
    ['Độ trễ TB', t.avg_latency ? `${fmt(t.avg_latency / 1000, 1)}s` : '–'],
    ['TTFT trung bình', fmtMs(t.avg_ttft)],
    ['TPS trung bình', fmtTps(t.avg_tps)],
  ].map(([l, v]) => `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');

  const labels = s.series.map((r) => r.bucket);
  const data = {
    labels,
    datasets: [
      { type: 'bar', label: 'Credit', data: s.series.map((r) => r.credits), backgroundColor: cssVar('--series-1'), yAxisID: 'y' },
      { type: 'line', label: 'Request', data: s.series.map((r) => r.requests), borderColor: cssVar('--series-2'), backgroundColor: cssVar('--series-2'), yAxisID: 'y1', tension: 0.25, pointRadius: 2 },
    ],
  };
  const grid = cssVar('--border');
  const text = cssVar('--muted');
  if (window.Chart) {
    if (chart) {
      // Cập nhật tại chỗ để Chart.js animate mượt, không vẽ lại từ đầu mỗi lần poll.
      chart.data.labels = data.labels;
      chart.data.datasets.forEach((ds, i) => { ds.data = data.datasets[i].data; });
      chart.update();
    } else {
      chart = new Chart($('#chart-credits'), {
        data,
        options: {
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { labels: { color: text } } },
          scales: {
            x: { ticks: { color: text, maxRotation: 0, autoSkip: true }, grid: { color: grid } },
            y: { position: 'left', title: { display: true, text: 'Credit', color: text }, ticks: { color: text }, grid: { color: grid } },
            y1: { position: 'right', title: { display: true, text: 'Request', color: text }, ticks: { color: text, precision: 0 }, grid: { drawOnChartArea: false } },
          },
        },
      });
    }
  }

  aggTable($('#by-key'), s.byKey, (r) => esc(r.label || `#${r.key_id ?? '–'}`), 'Key');
  aggTable($('#by-model'), s.byModel, (r) => esc(r.model), 'Model', (r) => (r.model ? `data-model="${esc(r.model)}" class="click"` : ''));
  $('#top-sessions').innerHTML = `<thead><tr><th>Session</th><th class="num">Request</th><th class="num">Credit</th><th class="num">Context lớn nhất</th><th class="num">Credit/1M</th><th class="num">Cache hit</th><th class="num" title="Thời gian tới token đầu">TTFT</th><th class="num" title="Output token mỗi giây">TPS</th><th>Lần cuối</th></tr></thead><tbody>${
    s.topSessions.length
      ? s.topSessions.map((r) => `<tr class="click" data-session="${esc(r.session_id)}"><td class="mono">${esc(r.session_id.slice(0, 18))}</td><td class="num">${fmt(r.requests)}</td><td class="num">${fmt(r.credits, 2)}</td><td class="num">${fmtTok(r.max_input)}</td><td class="num">${perM(r)}</td><td class="num">${hitRate(r)}</td><td class="num">${fmtMs(r.avg_ttft)}</td><td class="num">${fmtTps(r.avg_tps)}</td><td>${ago(r.last_ts)}</td></tr>`).join('')
      : '<tr><td colspan="9" class="muted">Chưa có dữ liệu.</td></tr>'
  }</tbody>`;
};
$('#range').addEventListener('change', () => loaders.stats());
$('#stats-model').addEventListener('change', () => loaders.stats());
$('#by-model').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-model]');
  if (!tr) return;
  const m = tr.dataset.model;
  const sel = $('#stats-model');
  sel.value = sel.value === m ? '' : m;
  loaders.stats();
});
$('#top-sessions').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-session]');
  if (!tr) return;
  $('#f-session').value = tr.dataset.session;
  page = 0;
  showTab('logs');
});

// ---------- logs ----------
let page = 0;
const PAGE = 50;
loaders.logs = async () => {
  const sel = $('#f-key');
  if (sel.options.length <= 1 || keysCache.length + 1 !== sel.options.length) {
    if (!keysCache.length) keysCache = await api('/api/keys');
    const v = sel.value;
    sel.innerHTML = '<option value="">Mọi key</option>' + keysCache.map((k) => `<option value="${k.id}">${esc(k.label)}</option>`).join('');
    sel.value = v;
  }
  const qs = new URLSearchParams({ limit: PAGE, offset: page * PAGE });
  if ($('#f-status').value) qs.set('status', $('#f-status').value);
  if ($('#f-key').value) qs.set('key', $('#f-key').value);
  if ($('#f-model').value.trim()) qs.set('model', $('#f-model').value.trim());
  if ($('#f-session').value.trim()) qs.set('session', $('#f-session').value.trim());
  const { total, rows } = await api(`/api/logs?${qs}`);
  const tb = $('#logs-table tbody');
  tb.innerHTML = rows.length
    ? rows.map((r) => {
      const st = r.status === 'ok' ? 'ok' : r.status === 'aborted' ? 'warn' : 'err';
      const prefix = r.prev_entries == null ? '<span class="muted">mới</span>'
        : r.history_reused === r.prev_entries ? `<span class="chip ok" title="Lịch sử lượt trước được gửi lại nguyên vẹn">${r.history_reused}/${r.prev_entries}</span>`
          : `<span class="chip warn" title="Chỉ ${r.history_reused}/${r.prev_entries} mục lịch sử khớp lượt trước">${r.history_reused}/${r.prev_entries}</span>`;
      return `<tr class="click" data-id="${r.id}">
        <td>${fmtTime(r.ts)}</td>
        <td><span class="chip ${st}">${esc(r.status)}${r.http_status && r.status !== 'ok' ? ` ${r.http_status}` : ''}</span>${r.failover_from ? ' <span class="chip warn" title="failover">↻</span>' : ''}</td>
        <td>${esc(r.model)}${r.stream ? '' : ' <span class="muted small">sync</span>'}</td>
        <td>${esc(r.key_label || r.key_id || '–')}</td>
        <td class="num">${r.credits == null ? '–' : fmt(r.credits, 3)}</td>
        <td class="num">${fmtTok(r.est_input_tokens)}${r.context_pct != null ? ` <span class="muted small">${fmt(r.context_pct, 1)}%</span>` : ''}</td>
        <td class="num">${r.norm_rate == null ? '–' : fmt(r.norm_rate, 2)}</td>
        <td>${prefix}</td>
        <td class="num">${r.latency_ms == null ? '–' : `${fmt(r.latency_ms / 1000, 1)}s`}</td>
        <td class="mono small">${esc((r.session_id || '').slice(0, 12))}</td>
        <td class="err-text" title="${esc(r.error || '')}">${esc(r.error || '')}</td></tr>`;
    }).join('')
    : '<tr><td colspan="11" class="muted">Không có log.</td></tr>';
  $('#page-info').textContent = `${total ? page * PAGE + 1 : 0}–${Math.min(total, (page + 1) * PAGE)} / ${fmt(total)}`;
  $('#prev').disabled = page === 0;
  $('#next').disabled = (page + 1) * PAGE >= total;
};
for (const id of ['#f-status', '#f-key', '#f-model', '#f-session']) {
  $(id).addEventListener('change', () => { page = 0; loaders.logs(); });
}
$('#prev').addEventListener('click', () => { page = Math.max(0, page - 1); loaders.logs(); });
$('#next').addEventListener('click', () => { page += 1; loaders.logs(); });
$('#logs-table').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const d = await api(`/api/logs/${tr.dataset.id}`);
  const { body, ...meta } = d;
  let text = JSON.stringify(meta, null, 2);
  if (body) {
    const pretty = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s ?? ''; } };
    text += `\n\n===== Response =====\n${body.response_text || ''}\n\n===== Request (Anthropic) =====\n${pretty(body.request_json)}\n\n===== Request (Kiro) =====\n${pretty(body.kiro_json)}`;
  } else {
    text += '\n\n(Không lưu body. Bật "Lưu body" trong Cài đặt để xem nội dung request.)';
  }
  $('#detail-body').textContent = text;
  $('#detail').showModal();
});
setInterval(() => {
  if (current === 'logs' && $('#f-auto').checked && page === 0 && !$('#detail').open && document.visibilityState === 'visible') loaders.logs().catch(() => {});
  if (current === 'stats' && document.visibilityState === 'visible') loaders.stats().catch(() => {});
}, 5000);

// ---------- settings ----------
let token = '';
function renderConfig() {
  $('#proxy-token').textContent = token;
  $('#cc-config').textContent = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: `http://${location.host}`,
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5.5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5.5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5.5',
    },
  }, null, 2);
}
loaders.settings = async () => {
  const { settings: s, proxyToken, models } = await api('/api/settings');
  token = proxyToken;
  renderConfig();
  const f = $('#settings-form');
  for (const r of f.rotation) r.checked = r.value === s.rotation;
  f.capture_bodies.checked = s.capture_bodies;
  f.body_retention_days.value = s.body_retention_days;
  f.log_retention_days.value = s.log_retention_days;
  f.rate_limit_retries.value = s.rate_limit_retries ?? 5;
  f.rate_limit_base_delay_ms.value = s.rate_limit_base_delay_ms ?? 2000;
  f.rate_limit_max_delay_ms.value = s.rate_limit_max_delay_ms ?? 30000;
  f.cache_hit_threshold.value = s.cache_hit_threshold;
  f.context_window_overrides.value = Object.keys(s.context_window_overrides || {}).length ? JSON.stringify(s.context_window_overrides) : '';
  $('#models-at').textContent = models?.at ? `cập nhật ${ago(models.at)}` : '';
  $('#models-table').innerHTML = `<thead><tr><th>Model</th><th class="num">Context</th><th class="num">rateMultiplier</th><th>Prompt cache</th></tr></thead><tbody>${
    (models?.models || []).map((m) => `<tr><td class="mono">${esc(m.id)}</td><td class="num">${fmtTok(m.contextWindow)}</td><td class="num">${fmt(m.rateMultiplier, 2)}</td><td>${m.promptCaching ? 'có' : 'không'}</td></tr>`).join('')
  }</tbody>`;
};
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = $('#settings-msg');
  let overrides = {};
  try {
    overrides = f.context_window_overrides.value.trim() ? JSON.parse(f.context_window_overrides.value) : {};
  } catch {
    setMsg(msg, 'Context window ghi đè phải là JSON hợp lệ.', false);
    return;
  }
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: {
        rotation: f.rotation.value,
        capture_bodies: f.capture_bodies.checked,
        body_retention_days: Number(f.body_retention_days.value),
        log_retention_days: Number(f.log_retention_days.value),
        cache_hit_threshold: Number(f.cache_hit_threshold.value),
        context_window_overrides: overrides,
        rate_limit_retries: Number(f.rate_limit_retries.value),
        rate_limit_base_delay_ms: Number(f.rate_limit_base_delay_ms.value),
        rate_limit_max_delay_ms: Number(f.rate_limit_max_delay_ms.value),
      },
    });
    setMsg(msg, 'Đã lưu.', true);
  } catch (err) {
    setMsg(msg, err.message, false);
  }
});
function copyButton(buttonId, getText) {
  const btn = $(buttonId);
  const label = btn.textContent;
  btn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(getText()).catch(() => {});
    btn.textContent = 'Đã copy';
    setTimeout(() => { btn.textContent = label; }, 1500);
  });
}
copyButton('#copy-token', () => token);
copyButton('#copy-config', () => $('#cc-config').textContent);
$('#refresh-models').addEventListener('click', async () => {
  try {
    await api('/api/models/refresh', { method: 'POST', body: {} });
  } catch (err) {
    alert(err.message);
  }
  loaders.settings();
});

// ---------- boot ----------
let initial = 'keys';
try { initial = localStorage.getItem('tab') || 'keys'; } catch { /* storage unavailable */ }
showTab(['keys', 'stats', 'logs', 'settings'].includes(initial) ? initial : 'keys');
