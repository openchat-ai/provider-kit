/**
 * Key Resolver - 让消费方（consumer project）注入自己的 apikey 查找逻辑
 *
 * 用法（消费方在启动时调用一次）:
 *   import { setKeyResolver } from '@openchat/provider-kit';
 *   setKeyResolver((providerName) => {
 *     // 例如：读 ~/.openchat/config.json
 *     const cfg = readMyConfig();
 *     return cfg.providers?.[providerName]?.apiKey ?? null;
 *   });
 *
 * 之后调 createProvider('openrouter') 不用传 apiKey，
 * kit 会按以下优先级链查找：
 *   1. opts.apiKey (createProvider 显式传入)
 *   2. resolver(providerName)  ← 消费方注入
 *   3. persistentConfig.getApiKey (kit 自己的存储)
 *   4. process.env[`${PROVIDER}_API_KEY`]
 *   5. '' (空字符串)
 *
 * 配套 clearKeyResolver() 用于测试隔离。
 */

let _resolver = null;

/**
 * 注册一个 key resolver。多次调用会覆盖。
 * @param {(providerName: string) => string | null | Promise<string | null>} fn
 */
export function setKeyResolver(fn) {
  _resolver = fn;
}

/** 清除 resolver（测试用） */
export function clearKeyResolver() {
  _resolver = null;
}

/** 当前是否注册了 resolver */
export function hasKeyResolver() {
  return _resolver !== null;
}

/**
 * 解析 apiKey。按完整优先级链查找。
 * @param {string} providerName
 * @param {string} [explicitKey] - 显式传入的 key（createProvider 的 opts.apiKey）
 * @returns {{ key: string, source: string } | null} source ∈ resolver|kit-config|env
 */
export async function resolveApiKey(providerName, explicitKey) {
  if (explicitKey) return { key: explicitKey, source: 'explicit' };

  if (_resolver) {
    try {
      const k = await _resolver(providerName);
      if (k) return { key: k, source: 'resolver' };
    } catch (e) {
      // resolver 抛异常不应阻断后续 fallback
    }
  }

  // kit 自己的 persistent-config + env 回退由调用方处理
  // 这里只负责 resolver 层
  return null;
}

export default { setKeyResolver, clearKeyResolver, hasKeyResolver, resolveApiKey };
