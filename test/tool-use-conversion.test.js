/**
 * P0 regression tests for AnthropicAdapter tool_use / function-calling support.
 *
 * Background: provider-kit was originally written for OpenAI-style chat. The
 * AnthropicMessages adapter was bolted on but the bidirectional OpenAI↔Anthropic
 * tool-conversion was silently broken — `tool_use` blocks in the response were
 * dropped (no toolCalls returned), `tool_calls` in the request were not
 * converted to `tool_use` blocks, and `tool` messages were not wrapped in
 * `tool_result` blocks. Streaming tool calls were equally broken.
 *
 * These tests pin the three conversions so a future refactor cannot regress
 * end-to-end function-calling on Anthropic-protocol providers (Anthropic
 * itself, minimax, kimi, zhipu, etc).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { AnthropicAdapter } from '../src/providers/anthropic-adapter.js';

function makeAdapter() {
  return new AnthropicAdapter({
    id: 'anthropic-test',
    apiKey: 'sk-test-fc',
    defaultModel: 'claude-test',
    models: ['claude-test'],
  });
}

describe('P0 regression: convertResponse (Anthropic → OpenAI tool_calls)', () => {
  test('tool_use block with empty input → toolCalls[0].function.arguments = "{}"', () => {
    const a = makeAdapter();
    const out = a.convertResponse({
      content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: {} }],
    });
    assert.ok(Array.isArray(out.toolCalls), 'toolCalls should be an array');
    assert.strictEqual(out.toolCalls.length, 1);
    const tc = out.toolCalls[0];
    assert.strictEqual(tc.id, 'tu_1');
    assert.strictEqual(tc.type, 'function');
    assert.strictEqual(tc.function.name, 'get_weather');
    assert.strictEqual(tc.function.arguments, '{}');
  });

  test('tool_use block with object input → JSON-stringified arguments', () => {
    const a = makeAdapter();
    const out = a.convertResponse({
      content: [
        {
          type: 'tool_use',
          id: 'tu_2',
          name: 'search',
          input: { q: 'hello', n: 3 },
        },
      ],
    });
    const args = JSON.parse(out.toolCalls[0].function.arguments);
    assert.deepStrictEqual(args, { q: 'hello', n: 3 });
  });

  test('tool_use block with string input → passthrough as arguments', () => {
    const a = makeAdapter();
    const out = a.convertResponse({
      content: [
        { type: 'tool_use', id: 'tu_3', name: 'x', input: '{"already":"json"}' },
      ],
    });
    assert.strictEqual(out.toolCalls[0].function.arguments, '{"already":"json"}');
  });

  test('multiple tool_use blocks → all converted in order', () => {
    const a = makeAdapter();
    const out = a.convertResponse({
      content: [
        { type: 'tool_use', id: 'tu_a', name: 'fn_a', input: { i: 1 } },
        { type: 'tool_use', id: 'tu_b', name: 'fn_b', input: { i: 2 } },
        { type: 'tool_use', id: 'tu_c', name: 'fn_c', input: { i: 3 } },
      ],
    });
    assert.strictEqual(out.toolCalls.length, 3);
    assert.deepStrictEqual(out.toolCalls.map(t => t.function.name), ['fn_a', 'fn_b', 'fn_c']);
    assert.deepStrictEqual(out.toolCalls.map(t => t.id), ['tu_a', 'tu_b', 'tu_c']);
  });

  test('mixed text + thinking + tool_use → text concatenated, reasoning present, toolCalls populated', () => {
    const a = makeAdapter();
    const out = a.convertResponse({
      content: [
        { type: 'thinking', thinking: 'reasoning step' },
        { type: 'text', text: 'Here you go: ' },
        { type: 'tool_use', id: 'tu_x', name: 'do_it', input: { k: 'v' } },
        { type: 'text', text: ' (after tool)' },
      ],
    });
    assert.strictEqual(out.content, 'Here you go:  (after tool)');
    assert.strictEqual(out.reasoningContent, 'reasoning step');
    assert.strictEqual(out.toolCalls.length, 1);
    assert.strictEqual(out.toolCalls[0].function.name, 'do_it');
  });

  test('redacted_thinking → "[redacted thinking]" placeholder', () => {
    const a = makeAdapter();
    const out = a.convertResponse({
      content: [
        { type: 'redacted_thinking', data: 'opaque', signature: 'sig' },
      ],
    });
    assert.strictEqual(out.reasoningContent, '[redacted thinking]');
  });

  test('text-only response → toolCalls is undefined', () => {
    const a = makeAdapter();
    const out = a.convertResponse({ content: [{ type: 'text', text: 'plain' }] });
    assert.strictEqual(out.content, 'plain');
    assert.strictEqual(out.toolCalls, undefined);
  });

  test('empty content array → empty content, no toolCalls', () => {
    const a = makeAdapter();
    const out = a.convertResponse({ content: [] });
    assert.strictEqual(out.content, '');
    assert.strictEqual(out.toolCalls, undefined);
  });

  test('tool_use with missing input → defaults to "{}"', () => {
    const a = makeAdapter();
    const out = a.convertResponse({
      content: [{ type: 'tool_use', id: 'tu_n', name: 'no_input' }],
    });
    assert.strictEqual(out.toolCalls[0].function.arguments, '{}');
  });
});

describe('P0 regression: convertMessages (OpenAI → Anthropic blocks)', () => {
  test('system messages are extracted and joined', () => {
    const a = makeAdapter();
    const { system, messages } = a.convertMessages([
      { role: 'system', content: 'You are helpful.' },
      { role: 'system', content: 'Be concise.' },
    ]);
    assert.strictEqual(system, 'You are helpful.\n\nBe concise.');
    assert.strictEqual(messages.length, 0);
  });

  test('user text → user message with string content', () => {
    const a = makeAdapter();
    const { messages } = a.convertMessages([{ role: 'user', content: 'hi' }]);
    assert.deepStrictEqual(messages, [{ role: 'user', content: 'hi' }]);
  });

  test('user array content (vision-style) → JSON-stringified', () => {
    const a = makeAdapter();
    const { messages } = a.convertMessages([
      { role: 'user', content: [{ type: 'text', text: 'desc' }, { type: 'image', src: 'x' }] },
    ]);
    assert.strictEqual(messages[0].role, 'user');
    assert.ok(typeof messages[0].content === 'string', 'array content should be JSON-stringified');
    const parsed = JSON.parse(messages[0].content);
    assert.strictEqual(parsed[0].type, 'text');
  });

  test('assistant with text only → assistant text content', () => {
    const a = makeAdapter();
    const { messages } = a.convertMessages([
      { role: 'assistant', content: 'sure thing' },
    ]);
    assert.strictEqual(messages[0].role, 'assistant');
    assert.deepStrictEqual(messages[0].content, [{ type: 'text', text: 'sure thing' }]);
  });

  test('assistant with tool_calls → tool_use content blocks with parsed input', () => {
    const a = makeAdapter();
    const { messages } = a.convertMessages([
      {
        role: 'assistant',
        content: 'calling',
        tool_calls: [
          { id: 'tc_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
        ],
      },
    ]);
    const blocks = messages[0].content;
    assert.ok(Array.isArray(blocks));
    const tu = blocks.find(b => b.type === 'tool_use');
    assert.ok(tu, 'expected tool_use block');
    assert.strictEqual(tu.id, 'tc_1');
    assert.strictEqual(tu.name, 'lookup');
    assert.deepStrictEqual(tu.input, { q: 'x' });
  });

  test('assistant with object-form arguments (not stringified) → still parses', () => {
    const a = makeAdapter();
    const { messages } = a.convertMessages([
      {
        role: 'assistant',
        tool_calls: [
          { id: 'tc_o', type: 'function', function: { name: 'fn', arguments: { k: 1 } } },
        ],
      },
    ]);
    const tu = messages[0].content.find(b => b.type === 'tool_use');
    assert.deepStrictEqual(tu.input, { k: 1 });
  });

  test('assistant with malformed JSON arguments → wrapped in _parse_error', () => {
    const a = makeAdapter();
    const { messages } = a.convertMessages([
      {
        role: 'assistant',
        tool_calls: [
          { id: 'tc_bad', type: 'function', function: { name: 'fn', arguments: '{not json' } },
        ],
      },
    ]);
    const tu = messages[0].content.find(b => b.type === 'tool_use');
    assert.strictEqual(tu.input._parse_error, true);
    assert.strictEqual(tu.input.raw, '{not json');
  });

  test('assistant with empty content and tool_calls → still produces tool_use blocks (no empty text)', () => {
    const a = makeAdapter();
    const { messages } = a.convertMessages([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc_e', type: 'function', function: { name: 'fn', arguments: '{}' } },
        ],
      },
    ]);
    const blocks = messages[0].content;
    const text = blocks.find(b => b.type === 'text');
    assert.strictEqual(text, undefined, 'no text block should be emitted for empty content');
    assert.ok(blocks.find(b => b.type === 'tool_use'));
  });

  test('tool message → user message with tool_result block', () => {
    const a = makeAdapter();
    const { messages } = a.convertMessages([
      { role: 'tool', tool_call_id: 'tc_1', content: 'result data' },
    ]);
    assert.strictEqual(messages[0].role, 'user');
    const block = messages[0].content[0];
    assert.strictEqual(block.type, 'tool_result');
    assert.strictEqual(block.tool_use_id, 'tc_1');
    assert.strictEqual(block.content, 'result data');
  });

  test('consecutive tool messages → merged into one user message with multiple tool_results', () => {
    const a = makeAdapter();
    const { messages } = a.convertMessages([
      { role: 'tool', tool_call_id: 'tc_a', content: 'r_a' },
      { role: 'tool', tool_call_id: 'tc_b', content: 'r_b' },
    ]);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].role, 'user');
    assert.strictEqual(messages[0].content.length, 2);
    assert.deepStrictEqual(
      messages[0].content.map(b => b.tool_use_id),
      ['tc_a', 'tc_b'],
    );
  });

  test('legacy "function" role treated as tool_result', () => {
    const a = makeAdapter();
    const { messages } = a.convertMessages([
      { role: 'function', name: 'tc_legacy', content: 'old' },
    ]);
    assert.strictEqual(messages[0].role, 'user');
    const block = messages[0].content[0];
    assert.strictEqual(block.type, 'tool_result');
    assert.strictEqual(block.tool_use_id, 'tc_legacy');
    assert.strictEqual(block.content, 'old');
  });

  test('unknown role is silently dropped (does not throw)', () => {
    const a = makeAdapter();
    const { messages, system } = a.convertMessages([
      { role: 'system', content: 's' },
      { role: 'banana', content: 'skip me' },
      { role: 'user', content: 'real' },
    ]);
    assert.strictEqual(system, 's');
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].content, 'real');
  });

  test('full OpenAI-style FC round-trip messages convert cleanly', () => {
    const a = makeAdapter();
    const { system, messages } = a.convertMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do thing' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'do_thing', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'tc1', content: 'ok' },
    ]);
    assert.strictEqual(system, 'sys');
    assert.strictEqual(messages.length, 3);
    assert.strictEqual(messages[0].role, 'user');
    assert.strictEqual(messages[1].role, 'assistant');
    assert.ok(messages[1].content.find(b => b.type === 'tool_use'));
    assert.strictEqual(messages[2].role, 'user');
    assert.strictEqual(messages[2].content[0].type, 'tool_result');
    assert.strictEqual(messages[2].content[0].tool_use_id, 'tc1');
  });
});

/**
 * Helper: stub global fetch with a fake SSE stream reader.
 * Each chunk is a UTF-8 byte array; the consumer splits on newlines.
 */
function sseResponse(events) {
  const body = events.join('\n') + '\n';
  const encoder = new TextEncoder();
  const bytes = encoder.encode(body);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader() {
        let consumed = false;
        return {
          async read() {
            if (consumed) return { done: true, value: undefined };
            consumed = true;
            return { done: false, value: bytes };
          },
        };
      },
    },
    json: async () => ({}),
  };
}

describe('P0 regression: chatStream emits tool_calls from streamed tool_use', () => {
  let originalFetch;
  before(() => {
    originalFetch = globalThis.fetch;
  });
  after(() => {
    globalThis.fetch = originalFetch;
  });

  test('text-only stream yields content chunks then done', async () => {
    const a = makeAdapter();
    a.connected = true;
    globalThis.fetch = async () => sseResponse([
      'event: message_start\ndata: {"type":"message_start"}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]);

    const events = [];
    for await (const ev of a.chatStream('claude-test', [{ role: 'user', content: 'hi' }])) {
      events.push(ev);
    }
    const content = events.filter(e => e.type === 'content').map(e => e.content).join('');
    assert.strictEqual(content, 'Hello world');
    assert.ok(events.find(e => e.done === true));
    assert.ok(!events.find(e => e.type === 'tool_calls'));
  });

  test('tool_use stream accumulates input_json_delta and yields tool_calls at message_stop', async () => {
    const a = makeAdapter();
    a.connected = true;
    globalThis.fetch = async () => sseResponse([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_stream_1","name":"lookup"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"hi\\"}"}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]);

    const events = [];
    for await (const ev of a.chatStream('claude-test', [{ role: 'user', content: 'x' }])) {
      events.push(ev);
    }
    const tcYield = events.find(e => e.type === 'tool_calls');
    assert.ok(tcYield, 'expected a tool_calls yield event');
    assert.strictEqual(tcYield.toolCalls.length, 1);
    const tc = tcYield.toolCalls[0];
    assert.strictEqual(tc.id, 'tu_stream_1');
    assert.strictEqual(tc.function.name, 'lookup');
    const args = JSON.parse(tc.function.arguments);
    assert.deepStrictEqual(args, { q: 'hi' });
  });

  test('malformed input_json_delta falls back to "{}" without throwing', async () => {
    const a = makeAdapter();
    a.connected = true;
    globalThis.fetch = async () => sseResponse([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_bad","name":"fn"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{not even json"}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]);

    const events = [];
    for await (const ev of a.chatStream('claude-test', [{ role: 'user', content: 'x' }])) {
      events.push(ev);
    }
    const tcYield = events.find(e => e.type === 'tool_calls');
    assert.ok(tcYield);
    assert.strictEqual(tcYield.toolCalls[0].function.arguments, '{}');
  });

  test('mixed text + tool_use yields both content chunks and final tool_calls', async () => {
    const a = makeAdapter();
    a.connected = true;
    globalThis.fetch = async () => sseResponse([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Calling tool:"}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_mix","name":"do_it"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"k\\":1}"}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]);

    const events = [];
    for await (const ev of a.chatStream('claude-test', [{ role: 'user', content: 'x' }])) {
      events.push(ev);
    }
    const content = events.filter(e => e.type === 'content').map(e => e.content).join('');
    assert.strictEqual(content, 'Calling tool:');
    const tc = events.find(e => e.type === 'tool_calls');
    assert.ok(tc);
    assert.strictEqual(tc.toolCalls[0].id, 'tu_mix');
    assert.deepStrictEqual(JSON.parse(tc.toolCalls[0].function.arguments), { k: 1 });
  });
});
