import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModel } from '../src/config.js';
import { buildKiroRequest, buildToolSpecs } from '../src/translate/request.js';

const SYSTEM = [
  { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1; cch=abc;' },
  { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } },
];
const TOOLS = [
  { name: 'Bash', description: 'Run a command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } },
  { name: 'mcp__srv__do.thing', description: 'mcp tool', input_schema: { type: 'object', properties: {} } },
];

function turn1() {
  return [{ role: 'user', content: [{ type: 'text', text: 'list files' }] }];
}
function turn2() {
  return [
    ...turn1(),
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }, { type: 'text', text: 'Running ls.' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt\nb.txt', cache_control: { type: 'ephemeral' } }] },
  ];
}
function turn3() {
  return [
    ...turn2(),
    { role: 'assistant', content: [{ type: 'text', text: 'Two files.' }] },
    { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
  ];
}

const build = (messages, extra = {}) => buildKiroRequest(
  { model: 'claude-opus-5.5', system: SYSTEM, tools: TOOLS, messages, ...extra },
  { modelId: 'claude-opus-5.5', sessionId: 'sess-1' },
);

test('history of turn N+1 starts with the exact entries of turn N', () => {
  const a = build(turn2());
  const b = build(turn3());
  // Every entry a sent (history + current, minus tools spec) must reappear unchanged in b.history.
  assert.deepEqual(b.historyHashes.slice(0, a.allHashes.length), a.allHashes);
  assert.equal(a.conversationId, b.conversationId);
});

test('output is deterministic and has no clock-based content', () => {
  const a = build(turn3());
  const b = build(turn3());
  assert.equal(a.json, b.json);
  assert.doesNotMatch(a.json, /Current time is/);
});

test('system prompt goes into the first user entry, billing header dropped, cache_control removed', () => {
  const { payload, json } = build(turn2());
  const first = payload.conversationState.history[0].userInputMessage.content;
  assert.match(first, /^<system>\nYou are Claude Code\.\n<\/system>\n\nlist files$/);
  assert.doesNotMatch(json, /billing-header|cache_control|thinking/);
});

test('tool_use and tool_result are paired and tools are attached to currentMessage', () => {
  const { payload } = build(turn2());
  const cs = payload.conversationState;
  const asst = cs.history[1].assistantResponseMessage;
  assert.deepEqual(asst.toolUses, [{ toolUseId: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]);
  const ctx = cs.currentMessage.userInputMessage.userInputMessageContext;
  assert.deepEqual(ctx.toolResults, [{ toolUseId: 'toolu_1', status: 'success', content: [{ text: 'a.txt\nb.txt' }] }]);
  assert.equal(cs.currentMessage.userInputMessage.content, 'Tool results provided.');
  assert.deepEqual(ctx.tools.map((t) => t.toolSpecification.name), ['Bash', 'mcp__srv__do_thing']);
  assert.equal(ctx.tools[0].toolSpecification.inputSchema.json.additionalProperties, undefined);
});

test('tools are not repeated in history entries', () => {
  const { payload } = build(turn3());
  for (const h of payload.conversationState.history) {
    assert.equal(h.userInputMessage?.userInputMessageContext?.tools, undefined);
  }
});

test('orphan tool_use without a result becomes text', () => {
  const msgs = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'pwd' } }] },
    { role: 'user', content: 'never mind' },
  ];
  const { payload } = build(msgs);
  const asst = payload.conversationState.history[1].assistantResponseMessage;
  assert.equal(asst.toolUses, undefined);
  assert.match(asst.content, /\[Tool call: Bash\(\{"command":"pwd"\}\)\]/);
});

test('consecutive same-role messages are merged and the last message must be user', () => {
  const msgs = [
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' },
  ];
  const { payload } = build(msgs, { system: undefined });
  const cs = payload.conversationState;
  assert.equal(cs.history.length, 2);
  assert.equal(cs.history[0].userInputMessage.content, 'a\n\nb');
  assert.equal(cs.currentMessage.userInputMessage.content, 'continue');
});

test('images become Kiro images', () => {
  const msgs = [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'what?' }] }];
  const { payload } = build(msgs, { system: undefined, tools: undefined });
  assert.deepEqual(payload.conversationState.currentMessage.userInputMessage.images, [{ format: 'png', source: { bytes: 'AAAA' } }]);
});

test('tool name sanitising keeps a reverse map', () => {
  const { fromKiro } = buildToolSpecs(TOOLS);
  assert.equal(fromKiro.get('mcp__srv__do_thing'), 'mcp__srv__do.thing');
});

test('model names from Claude Code are normalised', () => {
  assert.equal(normalizeModel('kr/claude-opus-5.5'), 'claude-opus-5.5');
  assert.equal(normalizeModel('claude-opus-5-5'), 'claude-opus-5.5');
  assert.equal(normalizeModel('claude-opus-5-5[1m]'), 'claude-opus-5.5');
  assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4.5');
  assert.equal(normalizeModel('claude-sonnet-5'), 'claude-sonnet-5');
});
