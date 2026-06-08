/**
 * Test: key resolver — 让消费方项目注入自己的 apikey 来源
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setKeyResolver, clearKeyResolver, hasKeyResolver, resolveApiKey, persistentConfig } from '../src/core/persistent-config.js';
import { providerRegistry } from '../src/providers/provider-registry.js';

describe('key-resolver', () => {
  beforeEach(() => {
    clearKeyResolver();
    // 清理 kit 自己的 env 干扰
    delete process.env.TESTPROV_API_KEY;
  });

  test('no resolver registered returns null', async () => {
    assert.equal(hasKeyResolver(), false);
    const r = await resolveApiKey('testprov');
    assert.equal(r, null);
  });

  test('resolver returns key', async () => {
    setKeyResolver((name) => name === 'foo' ? 'sk-foo-123' : null);
    assert.equal(hasKeyResolver(), true);
    const r = await resolveApiKey('foo');
    assert.deepEqual(r, { key: 'sk-foo-123', source: 'resolver' });
  });

  test('explicit key wins over resolver', async () => {
    setKeyResolver(() => 'from-resolver');
    const r = await resolveApiKey('foo', 'sk-explicit');
    assert.equal(r.key, 'sk-explicit');
    assert.equal(r.source, 'explicit');
  });

  test('resolver returning null falls through', async () => {
    setKeyResolver(() => null);
    const r = await resolveApiKey('foo');
    assert.equal(r, null);
  });

  test('resolver throwing does not crash', async () => {
    setKeyResolver(() => { throw new Error('boom'); });
    const r = await resolveApiKey('foo');
    assert.equal(r, null);
  });

  test('async resolver is awaited', async () => {
    setKeyResolver(async (name) => {
      await new Promise(r => setTimeout(r, 10));
      return name === 'asyncprov' ? 'sk-async' : null;
    });
    const r = await resolveApiKey('asyncprov');
    assert.equal(r.key, 'sk-async');
  });

  test('clearKeyResolver removes registration', () => {
    setKeyResolver(() => 'x');
    assert.equal(hasKeyResolver(), true);
    clearKeyResolver();
    assert.equal(hasKeyResolver(), false);
  });

  test('chat() throws "No API key" when resolver absent and config empty', async () => {
    // Use a real preset ('openrouter') but with no key anywhere
    persistentConfig.removeApiKey('openrouter');
    delete process.env.OPENROUTER_API_KEY;
    clearKeyResolver();
    // 清掉 OpenChat config 里的 key（如果有），避免新代码路径读到
    providerRegistry._ocConfig = null;
    // 强制重新创建
    providerRegistry.providers.delete('openrouter');

    // chat() should reach the "no api key" branch (resolver absent)
    await assert.rejects(
      () => providerRegistry.chat([{ role: 'user', content: 'hi' }], { providerId: 'openrouter' }),
      /No API key for openrouter/,
    );
  });

  test('chat() bypasses "No API key" error when resolver provides key', async () => {
    persistentConfig.removeApiKey('openrouter');
    delete process.env.OPENROUTER_API_KEY;
    providerRegistry._ocConfig = null;
    providerRegistry.providers.delete('openrouter');
    setKeyResolver((name) => name === 'openrouter' ? 'sk-from-resolver' : null);

    // Should now NOT throw "No API key" — it will fail at network/connect stage instead
    // We only assert the "No API key" error is NOT thrown.
    try {
      await providerRegistry.chat([{ role: 'user', content: 'hi' }], { providerId: 'openrouter' });
    } catch (e) {
      assert.ok(!/No API key for openrouter/.test(e.message),
        `unexpected "No API key" error: ${e.message}`);
    }
  });
});
