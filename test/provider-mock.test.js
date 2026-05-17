import http from 'http';
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';

let mockServer;
let mockUrl;

function startMock(path, method, status, body) {
  if (mockServer) mockServer.close();
  return new Promise(r => {
    mockServer = http.createServer((req, res) => {
      if (req.url !== path || req.method !== method) { res.writeHead(500).end('mismatch'); return; }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    mockServer.listen(0, () => { mockUrl = `http://localhost:${mockServer.address().port}`; r(mockUrl); });
  });
}

describe('provider mock', () => {
  afterEach(() => { if (mockServer) { mockServer.close(); mockServer = null; } });

  test('chat returns formatted response', async () => {
    const url = await startMock('/chat/completions', 'POST', 200, {
      choices: [{ message: { content: 'Hello', role: 'assistant' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const { createProvider } = await import('../src/index.js');
    const provider = await createProvider('openai', 'tk', { baseUrl: url });
    provider.connected = true;
    const r = await provider.chat('gpt-4', [{ role: 'user', content: 'Hi' }]);
    assert.strictEqual(r.content, 'Hello');
    assert.strictEqual(r.usage.total_tokens, 15);
  });

  test('429 error returns rate_limit type', async () => {
    const url = await startMock('/chat/completions', 'POST', 429, {
      error: { message: 'Rate limit exceeded', type: 'rate_limit' },
    });
    const { createProvider, ProviderError, classifyError } = await import('../src/index.js');
    const provider = await createProvider('openai', 'tk', { baseUrl: url });
    provider.connected = true;
    try {
      await provider.chat('gpt-4', [{ role: 'user', content: 'Hi' }]);
      assert.fail('should throw');
    } catch (e) {
      console.log('[debug] error:', e.message, e.statusCode);
      const c = classifyError(e, 'openai');
      assert.strictEqual(c.type, 'rate_limit');
      assert.ok(c.retryable);
    }
  });
});
