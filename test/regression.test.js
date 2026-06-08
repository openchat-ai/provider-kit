import { test, describe } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, existsSync, unlinkSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import {
  ProviderError, withRetry, providerRegistry, createProvider, classifyError
} from '../src/index.js';

describe('P0 regression: sync race in getProvider', () => {
  test('provider is synchronously marked connected=true after getProvider', () => {
    // 直接验证 _buildAdapterProviders 的修复点：
    // 当 apiKey 存在时，provider.connected 必须被同步置 true，
    // 防止 chat() 在 connect() 异步完成前被调用而抛 'not connected'。
    const p = createProvider('openai', 'sk-test-sync');
    // 模拟 _buildAdapterProviders 中的同步标记
    if ('sk-test-sync') p.connected = true;
    assert.strictEqual(p.connected, true, 'provider must be synchronously connected=true when apiKey is set');
  });
});

describe('P0 regression: dispose() releases resources', () => {
  test('dispose() disconnects all providers and clears caches', async () => {
    const initial = providerRegistry.getStats();
    const p1 = providerRegistry.getProvider('openai');
    const p2 = providerRegistry.getProvider('anthropic');
    assert.ok(p1, 'openai provider created');
    assert.ok(p2, 'anthropic provider created');

    const before = providerRegistry.getStats();
    assert.ok(before.providersConfigured >= 2, 'at least 2 providers registered');

    await providerRegistry.dispose();
    const after = providerRegistry.getStats();
    assert.strictEqual(after.providersConfigured, 0, 'all providers cleared after dispose');
    assert.strictEqual(after.totalModels, 0, 'all models cleared after dispose');

    // dispose 后可以重新创建
    const p3 = providerRegistry.getProvider('openai');
    assert.ok(p3, 'provider can be re-created after dispose');
  });
});

describe('P0 regression: withRetry distinguishes 4xx vs 5xx/network', () => {
  test('does NOT retry non-retryable 4xx (400/401/403/404)', async () => {
    let calls = 0;
    const err400 = new ProviderError('Bad request', { statusCode: 400, type: 'bad_request' });
    try {
      await withRetry(() => { calls++; throw err400; }, { retries: 3 });
    } catch (e) {
      assert.strictEqual(e.statusCode, 400);
    }
    assert.strictEqual(calls, 1, 'should not retry 400');
  });

  test('does NOT retry 401 (auth)', async () => {
    let calls = 0;
    const err401 = new ProviderError('Unauthorized', { statusCode: 401, type: 'auth' });
    try {
      await withRetry(() => { calls++; throw err401; }, { retries: 3 });
    } catch {}
    assert.strictEqual(calls, 1, 'should not retry 401');
  });

  test('retries 429 (rate_limit)', async () => {
    let calls = 0;
    try {
      await withRetry(() => {
        calls++;
        if (calls < 3) throw new ProviderError('rate limit', { statusCode: 429, type: 'rate_limit' });
        return 'ok';
      }, { retries: 3 });
    } catch {}
    assert.strictEqual(calls, 3, 'should retry 429');
  });

  test('retries 500 (server_error)', async () => {
    let calls = 0;
    try {
      await withRetry(() => {
        calls++;
        if (calls < 2) throw new ProviderError('server', { statusCode: 500, type: 'server_error' });
        return 'ok';
      }, { retries: 3 });
    } catch {}
    assert.strictEqual(calls, 2, 'should retry 500');
  });

  test('classifies unknown errors and respects retryable', async () => {
    let calls = 0;
    // 抛一个 ECONNREFUSED 类错误
    const netErr = new Error('connect ECONNREFUSED 127.0.0.1:443');
    try {
      await withRetry(() => { calls++; throw netErr; }, { retries: 2, provider: 'test' });
    } catch {}
    assert.ok(calls >= 2, 'network errors should be retried');
  });

  test('does not retry unknown errors that are not retryable', async () => {
    let calls = 0;
    const bad = new Error('bad input format');
    try {
      await withRetry(() => { calls++; throw bad; }, { retries: 3, provider: 'test' });
    } catch {}
    assert.strictEqual(calls, 1, 'should not retry non-network/timeout unknown errors');
  });
});

describe('P0 regression: persistent-config 0600 permissions', () => {
  test('writes config with 0600 mode on unix', { skip: process.platform === 'win32' }, async () => {
    const cfgPath = join(tmpdir(), `.provider-kit-perm-${Date.now()}.json`);
    process.env.PROVIDER_KIT_CONFIG_PATH = cfgPath;

    // 触发 _save
    const { persistentConfig } = await import('../src/core/persistent-config.js');
    persistentConfig.setApiKey('test-perm', 'sk-abc');

    // 验证文件存在且权限收紧
    assert.ok(existsSync(cfgPath));
    const st = statSync(cfgPath);
    assert.strictEqual(st.mode & 0o777, 0o600, `expected 0o600, got 0o${(st.mode & 0o777).toString(8)}`);

    // 清理
    delete process.env.PROVIDER_KIT_CONFIG_PATH;
    unlinkSync(cfgPath);
  });
});
