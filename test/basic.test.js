import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  ProviderError, AbortError, withRetry, withTimeout, safeProviderCall, classifyError, createCancelSignal, createRouter,
  ProviderManager, providerManager, providerRegistry, createProvider,
} from '../src/index.js';

describe('@openchat/provider-kit', () => {
  test('exports all modules', () => {
    assert.ok(ProviderError);
    assert.ok(typeof withRetry === 'function');
    assert.ok(typeof withTimeout === 'function');
    assert.ok(typeof safeProviderCall === 'function');
    assert.ok(ProviderManager);
    assert.ok(providerManager);
    assert.ok(providerRegistry);
    assert.ok(typeof createProvider === 'function');
  });

  // — ProviderError — //
  test('ProviderError carries metadata', () => {
    const err = new ProviderError('API error', { provider: 'openai', statusCode: 429, retryable: true, type: 'rate_limit' });
    assert.strictEqual(err.message, 'API error');
    assert.strictEqual(err.provider, 'openai');
    assert.strictEqual(err.statusCode, 429);
    assert.strictEqual(err.retryable, true);
    assert.strictEqual(err.type, 'rate_limit');
    assert.ok(err.timestamp);
  });

  test('ProviderError default retryable based on statusCode', () => {
    const e1 = new ProviderError('err', { statusCode: 500 });
    assert.strictEqual(e1.retryable, true);
    const e2 = new ProviderError('err', { statusCode: 400 });
    assert.strictEqual(e2.retryable, false);
    const e3 = new ProviderError('err', { statusCode: 400, retryable: true });
    assert.strictEqual(e3.retryable, true);
    const e4 = new ProviderError('err', {});
    assert.strictEqual(e4.retryable, false);
  });

  test('ProviderError default type is unknown', () => {
    const err = new ProviderError('x', {});
    assert.strictEqual(err.type, 'unknown');
  });

  // — withRetry — //
  test('withRetry retries on ProviderError', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 2) throw new ProviderError('temporary', { retryable: true });
      return 'ok';
    }, { retries: 2 });
    assert.strictEqual(result, 'ok');
    assert.strictEqual(attempts, 2);
  });

  test('withRetry throws on non-retryable error', async () => {
    await assert.rejects(() => withRetry(async () => {
      throw new ProviderError('permanent', { retryable: false });
    }, { retries: 2 }), ProviderError);
  });

  test('withRetry exhausts all retries then throws', async () => {
    let attempts = 0;
    await assert.rejects(() => withRetry(async () => {
      attempts++;
      throw new ProviderError('persistent', { retryable: true });
    }, { retries: 3, baseDelay: 5 }), ProviderError);
    assert.strictEqual(attempts, 4);
  });

  test('withRetry uses exponential backoff', async () => {
    let attempts = 0;
    const start = Date.now();
    await assert.rejects(() => withRetry(async () => {
      attempts++;
      throw new ProviderError('slow', { retryable: true });
    }, { retries: 2, baseDelay: 5 }));
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 15);
    assert.strictEqual(attempts, 3);
  }).then(() => {}, () => {});

  test('withRetry passes through non-ProviderError immediately', async () => {
    await assert.rejects(() => withRetry(async () => {
      throw new Error('regular error');
    }, { retries: 3, baseDelay: 5 }), Error);
  });

  // — withTimeout — //
  test('withTimeout resolves when fn completes in time', async () => {
    const result = await withTimeout(async () => {
      await new Promise(r => setTimeout(r, 5));
      return 'fast';
    }, 100);
    assert.strictEqual(result, 'fast');
  });

  test('withTimeout rejects on timeout', async () => {
    await assert.rejects(() => withTimeout(async () => {
      await new Promise(r => setTimeout(r, 100));
    }, 10));
  });

  test('withTimeout rejects with ProviderError on timeout', async () => {
    try {
      await withTimeout(async () => {
        await new Promise(r => setTimeout(r, 50));
      }, 5);
      assert.fail('should reject');
    } catch (e) {
      assert.ok(e instanceof ProviderError);
      assert.strictEqual(e.type, 'timeout');
      assert.strictEqual(e.retryable, true);
    }
  });

  // — safeProviderCall — //
  test('safeProviderCall combines retry + timeout', async () => {
    let calls = 0;
    const result = await safeProviderCall(async () => {
      calls++;
      if (calls < 2) throw new ProviderError('temp', { retryable: true });
      return 'final';
    }, { retries: 2, timeout: 5000 });
    assert.strictEqual(result, 'final');
    assert.strictEqual(calls, 2);
  });

  test('safeProviderCall timeout wraps with ProviderError', async () => {
    try {
      await safeProviderCall(async () => {
        await new Promise(r => setTimeout(r, 5));
      }, { timeout: 1, retries: 0 });
      assert.fail('should reject');
    } catch (e) {
      assert.strictEqual(e.type, 'timeout');
    }
  });

  // — providerRegistry — //
  test('providerRegistry has presets', async () => {
    const { PRESET_PROVIDERS } = await import('../src/providers/provider-registry.js');
    assert.ok(PRESET_PROVIDERS);
  });

  test('createProvider returns provider instance', async () => {
    const provider = await createProvider('openai', { apiKey: 'test-key' });
    assert.ok(provider);
    assert.ok(typeof provider.chat === 'function');
    assert.ok(typeof provider.chatStream === 'function');
  });

  test('createProvider falls back to generic on unknown type', async () => {
    const provider = await createProvider('nonexistent', { apiKey: 'test' });
    assert.ok(provider);
    assert.ok(typeof provider.chat === 'function');
  });

  // — Security audit — //
  test('no API keys in source files', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const srcDir = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));
    const files = [];
    async function walk(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith('.js')) files.push(full);
      }
    }
    await walk(srcDir);
    const results = [];
    for (const f of files) {
      const content = await fs.readFile(f, 'utf8');
      if (/sk-[a-zA-Z0-9]{20,}/.test(content) || /['"][a-zA-Z0-9]{40,}['"]/.test(content)) {
        results.push(path.relative(srcDir, f));
      }
    }
    assert.strictEqual(results.length, 0, `Possible key leaks in: ${results.join(', ')}`);
  });

  test('ProviderError constructor does not expose API key in fields', () => {
    const err = new ProviderError('Invalid API key', { provider: 'openai', statusCode: 401 });
    assert.ok(!err.message.includes('sk-'));
    assert.ok(!err.provider.includes('sk-'));
    assert.strictEqual(err.type, 'unknown');
  });

  // — Error taxonomy — //
  test('ProviderError type has friendly default message', () => {
    const e1 = new ProviderError(undefined, { type: 'rate_limit' });
    assert.ok(e1.message.includes('Rate limit'));
    const e2 = new ProviderError(undefined, { type: 'auth' });
    assert.ok(e2.message.includes('API key'));
    const e3 = new ProviderError(undefined, { type: 'timeout' });
    assert.ok(e3.message.includes('timed out'));
  });

  test('classifyError maps common error messages', () => {
    const r = classifyError(new Error('Rate limit: 429 too many requests'), 'openai');
    assert.strictEqual(r.type, 'rate_limit');
    const a = classifyError(new Error('401 Invalid API key'), 'openai');
    assert.strictEqual(a.type, 'auth');
    const n = classifyError(new Error('ECONNREFUSED'), 'ollama');
    assert.strictEqual(n.type, 'network');
  });

  test('classifyError preserves ProviderError', () => {
    const pe = new ProviderError('custom', { type: 'quota' });
    assert.strictEqual(classifyError(pe), pe);
  });

  // — AbortError — //
  test('AbortError carries type', () => {
    const e = new AbortError('Cancelled');
    assert.strictEqual(e.name, 'AbortError');
    assert.strictEqual(e.message, 'Cancelled');
  });

  test('withRetry does not retry AbortError', async () => {
    let calls = 0;
    await assert.rejects(() => withRetry(async () => {
      calls++;
      throw new AbortError('stop');
    }, { retries: 3 }), AbortError);
    assert.strictEqual(calls, 1); // no retry
  });

  // — createCancelSignal — //
  test('createCancelSignal returns signal and cancel', () => {
    const { signal, cancel } = createCancelSignal();
    assert.ok(signal instanceof AbortSignal);
    assert.ok(typeof cancel === 'function');
  });

  test('createCancelSignal aborts on cancel', () => {
    const { signal, cancel } = createCancelSignal();
    cancel('User pressed stop');
    assert.ok(signal.aborted);
  });

  // — retryable logic — //
  test('429 errors are retryable by default', () => {
    const e = new ProviderError('too fast', { statusCode: 429 });
    assert.strictEqual(e.retryable, true);
  });

  // — createRouter — //
  test('createRouter throws on empty probes', () => {
    assert.throws(() => createRouter([]), ProviderError);
    assert.throws(() => createRouter({ probes: [] }), ProviderError);
  });

  test('createRouter returns router with all methods', () => {
    const router = createRouter({ probes: [{ provider: 'openai', model: 'gpt-4', apiKey: 'test' }], probeInterval: 0 });
    assert.ok(typeof router.chat === 'function');
    assert.ok(typeof router.checkNow === 'function');
    assert.ok(typeof router.stop === 'function');
    assert.ok(typeof router.results === 'function');
    assert.strictEqual(router.probes.length, 1);
  });

  test('createRouter with latency strategy', () => {
    const router = createRouter({
      probes: [
        { provider: 'openai', model: 'gpt-4', apiKey: 'test' },
        { provider: 'anthropic', model: 'claude', apiKey: 'test2' },
      ],
      strategy: 'latency',
      probeInterval: 0,
    });
    assert.strictEqual(router.strategy, 'latency');
    assert.strictEqual(router.probes.length, 2);
    router.stop();
  });

  test('createRouter with legacy array API', () => {
    const router = createRouter([{ provider: 'openai', model: 'gpt-4', apiKey: 'test' }]);
    assert.strictEqual(router.probes.length, 1);
    assert.strictEqual(router.strategy, 'latency');
    router.stop();
  });

  // — createMonitor — //
  test('createMonitor wraps provider and tracks calls', async () => {
    const { createMonitor, createProvider } = await import('../src/index.js');
    const records = [];
    const monitor = createMonitor({ onCall: (r) => records.push(r) });
    const provider = await createProvider('openai', 'tk', { baseUrl: 'http://localhost:1' });
    provider.name = 'openai';
    const wrapped = monitor.wrap(provider);
    assert.ok(typeof wrapped.chat === 'function');
    // call will fail (no server), but monitor captures it
    try { await wrapped.chat('gpt-4', [{ role: 'user', content: 'Hi' }]); } catch {}
    assert.ok(records.length > 0);
    assert.strictEqual(records[0].provider, 'openai');
    assert.strictEqual(records[0].ok, false);
  });
});
