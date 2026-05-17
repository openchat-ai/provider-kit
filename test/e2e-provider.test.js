import { test, describe } from 'node:test';
import assert from 'node:assert';

/**
 * End-to-end tests with real provider API keys.
 * All tests skip if the required API key is not set.
 */

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

describe('provider-kit E2E', { concurrency: 1, timeout: 30000 }, () => {
  test('OpenAI chat returns a response', { skip: !OPENAI_KEY }, async () => {
    const { createProvider } = await import('../src/index.js');
    const provider = await createProvider('openai', OPENAI_KEY);
    const res = await provider.chat('gpt-4o-mini', [
      { role: 'user', content: 'Say "ok" in one word' },
    ]);
    assert.ok(res.content);
    assert.ok(res.usage?.total_tokens > 0);
  });

  test('OpenAI streaming yields tokens', { skip: !OPENAI_KEY }, async () => {
    const { createProvider } = await import('../src/index.js');
    const provider = await createProvider('openai', OPENAI_KEY);
    const stream = provider.chatStream('gpt-4o-mini', [
      { role: 'user', content: 'Count to 3 slowly' },
    ]);
    const chunks = [];
    for await (const c of stream) {
      if (c.type === 'content') chunks.push(c.content);
    }
    assert.ok(chunks.length > 0);
    assert.ok(chunks.join('').length > 0);
  });

  test('OpenAI withRetry handles transient errors', { skip: !OPENAI_KEY }, async () => {
    const { createProvider, withRetry } = await import('../src/index.js');
    const provider = await createProvider('openai', OPENAI_KEY);
    let attempts = 0;
    const res = await withRetry(async () => {
      attempts++;
      return provider.chat('gpt-4o-mini', [
        { role: 'user', content: 'Say "ok"' },
      ]);
    }, { retries: 2 });
    assert.ok(res.content);
  });

  test('Anthropic chat returns a response', { skip: !ANTHROPIC_KEY }, async () => {
    const { createProvider } = await import('../src/index.js');
    const provider = await createProvider('anthropic', ANTHROPIC_KEY);
    const res = await provider.chat('claude-3-haiku-20240307', [
      { role: 'user', content: 'Say "ok" in one word' },
    ]);
    assert.ok(res.content);
    assert.ok(res.usage?.total_tokens > 0);
  });
});
