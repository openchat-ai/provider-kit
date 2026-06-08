import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { AnthropicAdapter } from '../src/providers/anthropic-adapter.js';
import { GeminiAdapter } from '../src/providers/gemini-adapter.js';
import { AzureOpenAIAdapter } from '../src/providers/azure-adapter.js';
import { BedrockProxyAdapter } from '../src/providers/bedrock-adapter.js';
import { parseEpcPayload } from '../src/providers/epc-codec.js';

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failed++; } else { passed++; }
}
function eq(a, b, msg) { assert(a === b, `${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function deepEq(a, b, msg) { try { assert.deepStrictEqual(a, b); pass++; } catch { console.error('FAIL:', msg, a, b); failed++; } }

function mock(body) {
  const orig = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  return () => { globalThis.fetch = orig; };
}

async function test(name, fn) {
  try {
    const restore = mock(fn.mockBody);
    await fn();
    restore();
    console.log('✔', name);
    passed++;
  } catch (e) {
    console.error('✖', name, '-', e.message);
    failed++;
  }
}

// — run tests —
const r1 = mock({ choices: [{ message: { content: '{"text":"HelloWorld"}', reasoning_content: 'r', tool_calls: [{ id: 'c1', function: { name: 'fn', arguments: '{}' } }] } }] });
const p1 = new OpenAICompatibleProvider({ skipAuth: true, baseUrl: 'http://0.0.0.0:1' });
await p1.connect();
const res1 = await p1.chat('m', [{ role: 'user', content: 'hi' }]);
eq(res1.content, 'HelloWorld', 'content');
assert(Buffer.isBuffer(res1.epc), 'epc is Buffer');
assert(res1.epc.length > 8, 'epc length');
assert(res1.raw, 'raw exists');
const epc1 = parseEpcPayload(res1.epc);
eq(epc1.content, 'HelloWorld', 'epc content');
eq(epc1.reasoningContent, 'r', 'epc thinking');
eq(epc1.toolCalls.length, 1, 'epc toolCalls count');
eq(epc1.toolCalls[0].name, 'fn', 'tool name');
r1();

const r2 = mock({ choices: [{ message: { content: 'Hello' } }] });
const p2 = new OpenAICompatibleProvider({ skipAuth: true, baseUrl: 'http://0.0.0.0:1' });
await p2.connect();
const res2 = await p2.chat('m', [{ role: 'user', content: 'hi' }]);
eq(res2.content, 'Hello', 'content no think');
const epc2 = parseEpcPayload(res2.epc);
eq(epc2.content, 'Hello', 'epc content no think');
eq(epc2.reasoningContent, '', 'no thinking');
r2();

const r3 = mock({
  content: [{ type: 'thinking', thinking: 'deep', signature: 's1' }, { type: 'text', text: 'Final' }],
  model: 'claude', usage: {},
});
const p3 = new AnthropicAdapter({ apiKey: 'tk', baseUrl: 'http://0.0.0.0:1' });
await p3.connect();
const res3 = await p3.chat('claude', [{ role: 'user', content: 'hi' }], { max_tokens: 100 });
eq(res3.content, 'Final', 'anthropic content');
const epc3 = parseEpcPayload(res3.epc);
eq(epc3.content, 'Final', 'anthropic epc content');
eq(epc3.reasoningContent, 'deep', 'anthropic thinking');
r3();

const r4 = mock({ candidates: [{ content: { parts: [{ text: 'step', thought: true }, { text: 'Final' }] } }], modelVersion: 'g', usageMetadata: {} });
const p4 = new GeminiAdapter({ apiKey: 'tk', baseUrl: 'http://0.0.0.0:1' });
await p4.connect();
const res4 = await p4.chat('g', [{ role: 'user', content: 'hi' }]);
eq(res4.content, 'Final', 'gemini content');
const epc4 = parseEpcPayload(res4.epc);
eq(epc4.reasoningContent, 'step', 'gemini thinking');
r4();

const r5 = mock({ choices: [{ message: { content: 'A', reasoning_content: 't' } }] });
const p5 = new AzureOpenAIAdapter({ apiKey: 'tk', resourceName: 'r', baseUrl: 'http://0.0.0.0:1' });
await p5.connect();
const res5 = await p5.chat('m', [{ role: 'user', content: 'hi' }]);
eq(res5.content, 'A', 'azure content');
const epc5 = parseEpcPayload(res5.epc);
eq(epc5.reasoningContent, 't', 'azure thinking');
r5();

const r6 = mock({ choices: [{ message: { content: 'B', reasoning_content: 't2' } }] });
const p6 = new BedrockProxyAdapter({ skipAuth: true, baseUrl: 'http://0.0.0.0:1' });
await p6.connect();
const res6 = await p6.chat('m', [{ role: 'user', content: 'hi' }]);
eq(res6.content, 'B', 'bedrock content');
const epc6 = parseEpcPayload(res6.epc);
eq(epc6.reasoningContent, 't2', 'bedrock thinking');
r6();

const r7 = mock({ choices: [{ message: { content: 'x' } }] });
const p7 = new OpenAICompatibleProvider({ skipAuth: true, baseUrl: 'http://0.0.0.0:1' });
await p7.connect();
const res7 = await p7.chat('m', [{ role: 'user', content: 'hi' }]);
const keys = Object.keys(res7).sort();
eq(keys.join(','), 'content,epc,raw,toolCalls', 'keys');
r7();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
