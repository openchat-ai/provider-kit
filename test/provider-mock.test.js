import http from 'http';
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';

let mockServer;

function startMock(path, method, status, body) {
  if (mockServer) mockServer.close();
  return new Promise(r => {
    mockServer = http.createServer((req, res) => {
      if (req.url !== path || req.method !== method) { res.writeHead(500).end('mismatch'); return; }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    mockServer.listen(0, () => r(`http://localhost:${mockServer.address().port}`));
  });
}

describe('provider mock integration', () => {
  afterEach(() => { if (mockServer) { mockServer.close(); mockServer = null; } });

  // — OpenAI — //
  test('OpenAI chat 200 returns formatted response', async () => {
    const url = await startMock('/chat/completions', 'POST', 200, {
      choices: [{ message: { content: 'Hello', role: 'assistant' }, finish_reason: 'stop' }],
      usage: { total_tokens: 15 },
    });
    const { createProvider } = await import('../src/index.js');
    const p = await createProvider('openai', 'tk', { baseUrl: url });
    p.connected = true;
    const r = await p.chat('gpt-4', [{ role: 'user', content: 'Hi' }]);
    assert.strictEqual(r.content, 'Hello');
    assert.strictEqual(r.raw.usage.total_tokens, 15);
  });

  test('OpenAI 429 returns rate_limit type', async () => {
    const url = await startMock('/chat/completions', 'POST', 429, { error: { message: 'Rate limit' } });
    const { createProvider, classifyError } = await import('../src/index.js');
    const p = await createProvider('openai', 'tk', { baseUrl: url });
    p.connected = true;
    try {
      await p.chat('gpt-4', [{ role: 'user', content: 'Hi' }]);
      assert.fail('should throw');
    } catch (e) {
      assert.strictEqual(classifyError(e, 'openai').type, 'rate_limit');
    }
  });

  test('OpenAI 500 returns server_error', async () => {
    const url = await startMock('/chat/completions', 'POST', 500, {});
    const { createProvider, classifyError } = await import('../src/index.js');
    const p = await createProvider('openai', 'tk', { baseUrl: url });
    p.connected = true;
    try {
      await p.chat('gpt-4', [{ role: 'user', content: 'Hi' }]);
      assert.fail('should throw');
    } catch (e) {
      assert.strictEqual(classifyError(e, 'openai').type, 'server_error');
    }
  });

  test('OpenAI 401 returns auth error', async () => {
    const url = await startMock('/chat/completions', 'POST', 401, { error: { message: 'Invalid key' } });
    const { createProvider, classifyError } = await import('../src/index.js');
    const p = await createProvider('openai', 'tk', { baseUrl: url });
    p.connected = true;
    try {
      await p.chat('gpt-4', [{ role: 'user', content: 'Hi' }]);
      assert.fail('should throw');
    } catch (e) {
      const c = classifyError(e, 'openai');
      assert.strictEqual(c.type, 'auth');
      assert.strictEqual(c.retryable, false);
    }
  });

  // — Ollama — //
  test('Ollama chat with baseUrl works', async () => {
    const url = await startMock('/chat/completions', 'POST', 200, {
      choices: [{ message: { content: 'Hello from Ollama', role: 'assistant' } }],
    });
    const { createProvider } = await import('../src/index.js');
    const p = await createProvider('ollama', null, { baseUrl: url });
    p.connected = true;
    const r = await p.chat('llama3.2', [{ role: 'user', content: 'Hi' }]);
    assert.ok(r.content.includes('Ollama'));
  });

  // — ProviderError retryable — //
  test('ProviderError 429 is retryable, 401 is not', async () => {
    const { ProviderError } = await import('../src/index.js');
    assert.strictEqual(new ProviderError('x', { statusCode: 429 }).retryable, true);
    assert.strictEqual(new ProviderError('x', { statusCode: 401 }).retryable, false);
  });

  // — createRouter probe count — //
  test('createRouter returns correct probe count', async () => {
    const { createRouter } = await import('../src/index.js');
    const router = createRouter({
      probes: [
        { provider: 'openai', model: 'gpt-4', apiKey: 'tk' },
        { provider: 'ollama', model: 'llama3', apiKey: null },
      ],
      probeInterval: 0,
    });
    assert.strictEqual(router.probes.length, 2);
    assert.strictEqual(router.strategy, 'latency');
    router.stop();
  });
});
