import { randomUUID } from 'node:crypto';
import { eventErrorMessage } from '../kiro/eventstream.js';

/**
 * Turns Kiro EventStream events into Anthropic Messages stream events, and can also
 * assemble the final non-stream message from the same state.
 */
export class KiroResponseTranslator {
  constructor({ model, fromKiro = new Map(), inputTokensEstimate = 0, contextWindow = 1_000_000 }) {
    this.model = model;
    this.fromKiro = fromKiro;
    this.inputTokensEstimate = inputTokensEstimate;
    this.contextWindow = contextWindow;
    this.id = `msg_${randomUUID().replace(/-/g, '')}`;
    this.blocks = [];
    this.open = null; // index into this.blocks of the block currently streaming
    this.textChars = 0;
    this.toolChars = 0;
    this.reasoningChars = 0;
    this.credits = null;
    this.contextPct = null;
    this.metrics = null;
    this.stopReasonRaw = null;
    this.error = null;
    this.eventCounts = {};
  }

  /** True once something was produced that cannot be taken back by retrying on another key. */
  get hasContent() {
    return this.blocks.length > 0;
  }

  messageStart() {
    return [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: this.id,
            type: 'message',
            role: 'assistant',
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: this.inputTokensEstimate,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 1,
            },
          },
        },
      },
      { event: 'ping', data: { type: 'ping' } },
    ];
  }

  handle(ev) {
    this.eventCounts[ev.type] = (this.eventCounts[ev.type] || 0) + 1;
    if (ev.messageType !== 'event') {
      this.error = { type: ev.type, message: eventErrorMessage(ev) };
      return [];
    }
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    switch (ev.type) {
      case 'assistantResponseEvent':
      case 'codeEvent':
        return typeof p.content === 'string' && p.content ? this.text(p.content) : [];
      case 'toolUseEvent':
        return (Array.isArray(ev.payload) ? ev.payload : [p]).flatMap((t) => this.toolUse(t));
      case 'reasoningContentEvent':
        this.reasoningChars += String(p.text ?? p.content ?? '').length;
        return [];
      case 'messageStopEvent':
        this.stopReasonRaw = p.stopReason ?? p.stop_reason ?? this.stopReasonRaw;
        return [];
      case 'metadataEvent':
      case 'MetadataEvent': {
        const m = p.metadataEvent || p.metadata || p;
        this.stopReasonRaw = m.stopReason ?? m.stop_reason ?? this.stopReasonRaw;
        return [];
      }
      case 'contextUsageEvent': {
        const n = Number(p.contextUsagePercentage);
        if (Number.isFinite(n)) this.contextPct = n;
        return [];
      }
      case 'meteringEvent': {
        const n = Number((p.meteringEvent || p).usage);
        if (Number.isFinite(n)) this.credits = (this.credits || 0) + n;
        return [];
      }
      case 'metricsEvent':
        this.metrics = p.metricsEvent || p;
        return [];
      default:
        return [];
    }
  }

  text(content) {
    const out = [];
    let block = this.blocks[this.open];
    if (!block || block.type !== 'text') {
      out.push(...this.closeOpen());
      block = { type: 'text', text: '' };
      this.blocks.push(block);
      this.open = this.blocks.length - 1;
      out.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index: this.open, content_block: { type: 'text', text: '' } },
      });
    }
    block.text += content;
    this.textChars += content.length;
    out.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: this.open, delta: { type: 'text_delta', text: content } },
    });
    return out;
  }

  toolUse(t) {
    if (!t || typeof t !== 'object') return [];
    const out = [];
    let block = this.blocks[this.open];
    const id = typeof t.toolUseId === 'string' && t.toolUseId ? t.toolUseId : null;
    const sameBlock = block?.type === 'tool_use' && !block.closed && (id === null || id === block.id);
    if (!sameBlock) {
      if (!t.name && !id) return [];
      out.push(...this.closeOpen());
      const kiroName = String(t.name || '');
      block = {
        type: 'tool_use',
        id: id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        name: this.fromKiro.get(kiroName) || kiroName,
        parts: [],
        object: null,
        closed: false,
      };
      this.blocks.push(block);
      this.open = this.blocks.length - 1;
      out.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: this.open,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        },
      });
    }
    if (typeof t.input === 'string' && t.input) {
      block.parts.push(t.input);
      this.toolChars += t.input.length;
      out.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: this.open, delta: { type: 'input_json_delta', partial_json: t.input } },
      });
    } else if (t.input && typeof t.input === 'object') {
      block.object = t.input; // whole object, sent when the block closes
    }
    if (t.stop) out.push(...this.closeOpen());
    return out;
  }

  closeOpen() {
    const block = this.blocks[this.open];
    if (!block || block.closed) return [];
    const out = [];
    if (block.type === 'tool_use' && block.object && !block.parts.length) {
      const json = JSON.stringify(block.object);
      block.parts.push(json);
      this.toolChars += json.length;
      out.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: this.open, delta: { type: 'input_json_delta', partial_json: json } },
      });
    }
    block.closed = true;
    out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: this.open } });
    this.open = null;
    return out;
  }

  get toolCalls() {
    return this.blocks.filter((b) => b.type === 'tool_use').length;
  }

  stopReason() {
    const raw = String(this.stopReasonRaw || '').toLowerCase();
    if (/max_tokens|length|token_limit/.test(raw)) return 'max_tokens';
    if (this.toolCalls) return 'tool_use';
    if (/refus|content_filter|guardrail/.test(raw)) return 'refusal';
    return 'end_turn';
  }

  /** Input tokens as Kiro sees them, from contextUsagePercentage. Falls back to the local estimate. */
  inputTokens() {
    if (this.contextPct == null) return this.inputTokensEstimate;
    return Math.round((this.contextPct * this.contextWindow) / 100);
  }

  outputTokens() {
    return Math.max(1, Math.ceil((this.textChars + this.toolChars + this.reasoningChars) / 4));
  }

  finish() {
    return [
      ...this.closeOpen(),
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: this.stopReason(), stop_sequence: null },
          usage: {
            input_tokens: this.inputTokens(),
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: this.outputTokens(),
          },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ];
  }

  toMessage() {
    this.closeOpen();
    const content = this.blocks.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      let input = b.object || {};
      if (b.parts.length) {
        try { input = JSON.parse(b.parts.join('')); } catch { input = {}; }
      }
      return { type: 'tool_use', id: b.id, name: b.name, input };
    });
    return {
      id: this.id,
      type: 'message',
      role: 'assistant',
      model: this.model,
      content,
      stop_reason: this.stopReason(),
      stop_sequence: null,
      usage: {
        input_tokens: this.inputTokens(),
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: this.outputTokens(),
      },
    };
  }

  /** Short text form of the reply, for the captured-body log. */
  transcript() {
    return this.blocks
      .map((b) => (b.type === 'text' ? b.text : `[tool_use ${b.name} ${b.id}] ${b.parts.join('') || JSON.stringify(b.object || {})}`))
      .join('\n\n');
  }
}

export function sseFrame({ event, data }) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Anthropic-style error for the client, with the HTTP status Claude Code's retry logic expects. */
export function clientError(status, text = '', kind = '') {
  const t = String(text);
  if (/too long|content_length_exceeds|input is too long|exceeds.*(context|token)|contextwindow/i.test(t)) {
    return { status: 400, body: errorBody('invalid_request_error', `prompt is too long: ${t.slice(0, 500)}`) };
  }
  if (status === 400 || status === 413 || kind === 'request') {
    return { status: 400, body: errorBody('invalid_request_error', `Kiro rejected the request: ${t.slice(0, 1000)}`) };
  }
  if (status === 429 || kind === 'rate_limit') return { status: 429, body: errorBody('rate_limit_error', `Kiro rate limit: ${t.slice(0, 500)}`) };
  if (kind === 'quota' || status === 402) return { status: 402, body: errorBody('billing_error', `Kiro credits exhausted on all keys: ${t.slice(0, 500)}`) };
  if (status === 401 || status === 403 || kind === 'auth') return { status: 403, body: errorBody('permission_error', `Kiro rejected the key: ${t.slice(0, 500)}`) };
  return { status: 502, body: errorBody('api_error', `Kiro upstream error (${status}): ${t.slice(0, 500)}`) };
}

export function errorBody(type, message) {
  return { type: 'error', error: { type, message } };
}
