import { createHash } from 'node:crypto';
import { conversationIdFor } from '../session.js';

// Every function here is a pure function of the incoming request: no clock, no randomness and no
// state carried between requests. Turn N+1 therefore resends turn N's history byte for byte, which
// is what Kiro's prefix cache needs.

const NAME_MAX = 64;
const DESC_MAX = 10237;
const PLACEHOLDER_TOOL_RESULTS = 'Tool results provided.';
const PLACEHOLDER_USER = 'continue';
const PLACEHOLDER_ASSISTANT = '...';
const IMAGE_FORMATS = new Set(['png', 'jpeg', 'gif', 'webp']);

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function stringify(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try { return JSON.stringify(v); } catch { return String(v); }
}

const truncate = (s, n) => [...String(s)].slice(0, n).join('');

/** System prompt as text. Drops Claude Code's billing header block, which is not part of the prompt. */
export function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : ''))
    .filter((t) => typeof t === 'string' && t.length && !/^\s*x-anthropic-billing-header:/i.test(t))
    .join('\n\n');
}

function cleanSchema(schema) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === 'additionalProperties') continue;
      if (k === 'required' && Array.isArray(val) && val.length === 0) continue;
      out[k] = strip(val);
    }
    return out;
  };
  const s = strip(schema && typeof schema === 'object' ? structuredClone(schema) : {});
  s.type = 'object';
  if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties)) s.properties = {};
  if (Array.isArray(s.required)) {
    s.required = [...new Set(s.required.filter((r) => typeof r === 'string' && Object.hasOwn(s.properties, r)))];
    if (!s.required.length) delete s.required;
  }
  return s;
}

/** Anthropic tools -> Kiro toolSpecifications, plus name maps in both directions. */
export function buildToolSpecs(tools) {
  const specs = [];
  const toKiro = new Map();
  const fromKiro = new Map();
  const used = new Set();
  (Array.isArray(tools) ? tools : []).forEach((tool, i) => {
    if (!tool || typeof tool !== 'object') return;
    // Server tools (web_search_*, code_execution_*, ...) run on Anthropic's side; Kiro cannot run them.
    if (tool.type && tool.type !== 'custom' && !tool.input_schema) return;
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name || toKiro.has(name)) return;
    const base = truncate(name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || `tool_${i + 1}`, NAME_MAX);
    let kiroName = base;
    for (let n = 2; used.has(kiroName); n++) kiroName = `${base.slice(0, NAME_MAX - String(n).length - 1)}_${n}`;
    used.add(kiroName);
    toKiro.set(name, kiroName);
    fromKiro.set(kiroName, name);
    specs.push({
      toolSpecification: {
        name: kiroName,
        description: truncate(tool.description || `Tool: ${name}`, DESC_MAX),
        inputSchema: { json: cleanSchema(tool.input_schema) },
      },
    });
  });
  return { specs, toKiro, fromKiro };
}

function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter((b) => b && typeof b === 'object') : [];
}

function toKiroImage(block) {
  const src = block.source;
  if (src?.type !== 'base64' || typeof src.data !== 'string') return null;
  const format = String(src.media_type || '').split('/')[1]?.toLowerCase().replace('jpg', 'jpeg');
  return IMAGE_FORMATS.has(format) ? { format, source: { bytes: src.data } } : null;
}

const toolCallText = (u, name) => `[Tool call: ${name}(${stringify(u.input ?? {})})]`;
const toolResultText = (r) => `[Tool result${r.status === 'error' ? ' (error)' : ''}: ${r.content.map((c) => c.text).join('\n')}]`;

/** Anthropic messages -> alternating user/assistant entries (still in a neutral shape). */
function collectEntries(messages, toKiro) {
  const entries = [];
  for (const msg of messages) {
    const role = msg?.role === 'assistant' ? 'assistant' : 'user';
    let e = entries.at(-1);
    if (!e || e.role !== role) {
      e = { role, texts: [], images: [], toolResults: [], toolUses: [] };
      entries.push(e);
    }
    for (const b of blocksOf(msg?.content)) {
      if (b.type === 'text') {
        if (typeof b.text === 'string' && b.text.length) e.texts.push(b.text);
      } else if (role === 'user' && b.type === 'image') {
        const img = toKiroImage(b);
        if (img) e.images.push(img);
        else e.texts.push('[image omitted: unsupported source]');
      } else if (role === 'user' && b.type === 'document') {
        const text = b.source?.type === 'text' ? b.source.data : null;
        e.texts.push(text ? `<document>${text}</document>` : `[document omitted${b.title ? `: ${b.title}` : ''}]`);
      } else if (role === 'user' && b.type === 'tool_result') {
        const parts = [];
        for (const c of blocksOf(b.content)) {
          if (c.type === 'text') parts.push(c.text ?? '');
          else if (c.type === 'image') {
            const img = toKiroImage(c);
            if (img) e.images.push(img);
          } else parts.push(stringify(c));
        }
        e.toolResults.push({
          toolUseId: String(b.tool_use_id ?? ''),
          status: b.is_error ? 'error' : 'success',
          content: [{ text: parts.join('\n') }],
        });
      } else if (role === 'assistant' && b.type === 'tool_use') {
        const name = String(b.name ?? '');
        e.toolUses.push({ toolUseId: String(b.id ?? ''), name, kiroName: toKiro.get(name) || null, input: b.input ?? {} });
      } else if (role === 'assistant' && b.type === 'server_tool_use') {
        e.texts.push(toolCallText(b, b.name));
      }
      // thinking, redacted_thinking, *_tool_result from server tools: dropped.
    }
  }
  return entries;
}

/**
 * Kiro rejects a toolUse without a matching toolResult in the next user turn, a toolResult
 * without a toolUse, duplicate ids, and tools missing from the spec. Those become plain text.
 */
function repairToolPairs(entries) {
  const seen = new Set();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.role !== 'assistant') continue;
    const next = entries[i + 1];
    const resultIds = new Set((next?.toolResults || []).map((r) => r.toolUseId));
    const kept = [];
    for (const u of e.toolUses) {
      if (u.kiroName && u.toolUseId && !seen.has(u.toolUseId) && resultIds.has(u.toolUseId)) {
        seen.add(u.toolUseId);
        kept.push(u);
      } else {
        e.texts.push(toolCallText(u, u.name));
      }
    }
    e.toolUses = kept;
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.role !== 'user' || !e.toolResults.length) continue;
    const prev = entries[i - 1];
    const ids = new Set(prev?.role === 'assistant' ? prev.toolUses.map((u) => u.toolUseId) : []);
    const kept = [];
    const used = new Set();
    for (const r of e.toolResults) {
      if (ids.has(r.toolUseId) && !used.has(r.toolUseId)) {
        used.add(r.toolUseId);
        kept.push(r);
      } else {
        e.texts.push(toolResultText(r));
      }
    }
    e.toolResults = kept;
  }
}

function toKiroEntry(e, modelId) {
  if (e.role === 'assistant') {
    const content = e.texts.join('\n\n');
    const m = { content: content.trim() ? content : PLACEHOLDER_ASSISTANT };
    if (e.toolUses.length) m.toolUses = e.toolUses.map((u) => ({ toolUseId: u.toolUseId, name: u.kiroName, input: u.input }));
    return { assistantResponseMessage: m };
  }
  const content = e.texts.join('\n\n');
  const m = {
    content: content.trim() ? content : e.toolResults.length ? PLACEHOLDER_TOOL_RESULTS : PLACEHOLDER_USER,
    modelId,
    origin: 'AI_EDITOR',
  };
  if (e.images.length) m.images = e.images;
  if (e.toolResults.length) m.userInputMessageContext = { toolResults: e.toolResults };
  return { userInputMessage: m };
}

/**
 * Anthropic Messages request -> Kiro generateAssistantResponse body.
 * Returns the body plus the per-entry hashes used to check prefix stability.
 */
export function buildKiroRequest(body, { modelId, sessionId }) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const { specs, toKiro, fromKiro } = buildToolSpecs(body?.tools);
  const entries = collectEntries(messages, toKiro);

  if (!entries.length || entries[0].role !== 'user') {
    entries.unshift({ role: 'user', texts: [], images: [], toolResults: [], toolUses: [] });
  }
  if (entries.at(-1).role !== 'user') {
    entries.push({ role: 'user', texts: [PLACEHOLDER_USER], images: [], toolResults: [], toolUses: [] });
  }
  repairToolPairs(entries);

  const sys = systemText(body?.system);
  if (sys) entries[0].texts.unshift(`<system>\n${sys}\n</system>`);

  const kiroEntries = entries.map((e) => toKiroEntry(e, modelId));
  const hashes = kiroEntries.map((k) => sha256(JSON.stringify(k)));
  const history = kiroEntries.slice(0, -1);
  const current = structuredClone(kiroEntries.at(-1));
  if (specs.length) {
    current.userInputMessage.userInputMessageContext = {
      ...(current.userInputMessage.userInputMessageContext || {}),
      tools: specs,
    };
  }

  const conversationId = conversationIdFor(sessionId, hashes[0]);
  const payload = {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId,
      currentMessage: current,
      ...(history.length ? { history } : {}),
    },
  };
  return {
    payload,
    json: JSON.stringify(payload),
    conversationId,
    fromKiro,
    historyLen: history.length,
    historyHashes: hashes.slice(0, -1),
    allHashes: hashes,
  };
}

/** Rough token estimate (4 characters per token), used where Kiro gives no count. */
export function estimateTokens(body) {
  const parts = [systemText(body?.system), stringify(body?.messages ?? []), stringify(body?.tools ?? [])];
  return Math.ceil(parts.reduce((n, s) => n + s.length, 0) / 4);
}
