import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeEvent, encodeFrame, EventStreamDecoder } from '../src/kiro/eventstream.js';
import { KiroResponseTranslator } from '../src/translate/response.js';

const FIXTURE = Buffer.concat([
  encodeEvent('assistantResponseEvent', { content: 'Hel' }),
  encodeEvent('assistantResponseEvent', { content: 'lo' }),
  encodeEvent('toolUseEvent', { toolUseId: 'tu_1', name: 'mcp__a__b_c', input: '{"comm' }),
  encodeEvent('toolUseEvent', { toolUseId: 'tu_1', name: 'mcp__a__b_c', input: 'and":"ls"}' }),
  encodeEvent('toolUseEvent', { toolUseId: 'tu_1', name: 'mcp__a__b_c', stop: true }),
  encodeEvent('metadataEvent', { stopReason: 'TOOL_USE' }),
  encodeEvent('contextUsageEvent', { contextUsagePercentage: 11.7 }),
  encodeEvent('meteringEvent', { unit: 'credit', unitPlural: 'credits', usage: 0.39 }),
]);

test('decoder handles frames split across arbitrary chunk boundaries', () => {
  for (const size of [1, 7, 64, FIXTURE.length]) {
    const d = new EventStreamDecoder();
    const events = [];
    for (let i = 0; i < FIXTURE.length; i += size) events.push(...d.push(FIXTURE.subarray(i, i + size)));
    assert.equal(events.length, 8, `chunk size ${size}`);
    assert.equal(d.pendingBytes, 0);
    assert.equal(events[0].type, 'assistantResponseEvent');
    assert.deepEqual(events[7].payload, { unit: 'credit', unitPlural: 'credits', usage: 0.39 });
  }
});

test('decoder rejects corrupted frames', () => {
  const bad = Buffer.from(FIXTURE);
  bad[20] ^= 0xff;
  assert.throws(() => new EventStreamDecoder().push(bad), /CRC/);
});

test('translator produces Anthropic stream events and usage', () => {
  const tr = new KiroResponseTranslator({ model: 'claude-opus-5.5', fromKiro: new Map([['mcp__a__b_c', 'mcp__a__b.c']]), inputTokensEstimate: 100, contextWindow: 1_000_000 });
  const frames = [...tr.messageStart()];
  for (const ev of new EventStreamDecoder().push(FIXTURE)) frames.push(...tr.handle(ev));
  frames.push(...tr.finish());
  const types = frames.map((f) => f.event);
  assert.deepEqual(types, [
    'message_start', 'ping',
    'content_block_start', 'content_block_delta', 'content_block_delta',
    'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    'message_delta', 'message_stop',
  ]);
  const toolStart = frames[6].data;
  assert.equal(toolStart.index, 1);
  assert.deepEqual(toolStart.content_block, { type: 'tool_use', id: 'tu_1', name: 'mcp__a__b.c', input: {} });
  const delta = frames.at(-2).data;
  assert.equal(delta.delta.stop_reason, 'tool_use');
  assert.equal(delta.usage.input_tokens, 117000);
  assert.equal(tr.credits, 0.39);

  const msg = tr.toMessage();
  assert.deepEqual(msg.content, [
    { type: 'text', text: 'Hello' },
    { type: 'tool_use', id: 'tu_1', name: 'mcp__a__b.c', input: { command: 'ls' } },
  ]);
});

test('tool input sent as a whole object is emitted once on close', () => {
  const tr = new KiroResponseTranslator({ model: 'm' });
  const d = new EventStreamDecoder();
  const frames = [];
  for (const ev of d.push(encodeEvent('toolUseEvent', { toolUseId: 't', name: 'Read', input: { file_path: '/a' }, stop: true }))) frames.push(...tr.handle(ev));
  const deltas = frames.filter((f) => f.event === 'content_block_delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].data.delta.partial_json, '{"file_path":"/a"}');
});

test('exception frames are surfaced as errors', () => {
  const tr = new KiroResponseTranslator({ model: 'm' });
  const frame = encodeFrame({ ':message-type': 'exception', ':exception-type': 'ThrottlingException' }, { message: 'slow down' });
  for (const ev of new EventStreamDecoder().push(frame)) tr.handle(ev);
  assert.equal(tr.error.type, 'ThrottlingException');
  assert.match(tr.error.message, /slow down/);
  assert.equal(tr.hasContent, false);
});
