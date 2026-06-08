/**
 * Provider Registry - 简化的 Provider 管理
 *
 * 设计原则：
 * 1. 最小配置 - 只需 id + baseUrl + apiKey
 * 2. 自动发现 - 调用 /models 自动获取模型列表
 * 3. 统一接口 - 所有 OpenAI 兼容 provider 用同一个适配器
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { OpenAICompatibleProvider, PRESET_PROVIDERS, createProvider, listPresetProviders } from './openai-compatible.js';
import { AnthropicAdapter, createAnthropicProvider } from './anthropic-adapter.js';
import { GeminiAdapter, createGeminiProvider } from './gemini-adapter.js';
import { AzureOpenAIAdapter, createAzureOpenAIProvider } from './azure-adapter.js';
import { CohereAdapter, createCohereProvider } from './cohere-adapter.js';
import { BedrockProxyAdapter, createBedrockProxyProvider } from './bedrock-adapter.js';
import { persistentConfig, setKeyResolver, clearKeyResolver, hasKeyResolver, resolveApiKey } from '../core/persistent-config.js';

const OPENCHAT_CONFIG_PATHS = [
  join(homedir(), '.config', 'openchat', 'config.json'),
  join(homedir(), '.openchat', 'config.json'),
];

function loadOpenChatConfig() {
  for (const p of OPENCHAT_CONFIG_PATHS) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
    } catch {}
  }
  return null;
}

/**
 * Router Provider — transparent dispatch to model-specific adapters.
 * Supports per-model multi-protocol entries: { __multiProtocol, strategy, providers: [] }
 * Strategies:
 *   - failover (default): try providers in order, fall back on error. Zero waste.
 *   - race: parallel, first successful response wins. 2x token cost.
 */
class RouterProvider {
  constructor(type, defaultProvider, adapters) {
    this.id = type;
    this.name = defaultProvider.name;
    this.nameCn = defaultProvider.nameCn;
    this.type = type;
    this._default = defaultProvider;
    this._adapters = adapters;
    this.connected = defaultProvider.connected;
    this.skipAuth = defaultProvider.skipAuth;
    this.baseUrl = defaultProvider.baseUrl;
    this.apiKey = defaultProvider.apiKey;
    this.defaultModel = defaultProvider.defaultModel;
    this.models = defaultProvider.models;
    this.description = defaultProvider.description;
    this.timeout = defaultProvider.timeout;
    this.headers = defaultProvider.headers;
  }

  _resolveEntry(model) {
    const e = this._adapters.get(model) || this._default;
    return e;
  }

  chat(model, messages, opts) {
    const entry = this._resolveEntry(model);
    if (entry && entry.__multiProtocol) {
      return this._multiChat(entry, model, messages, opts);
    }
    return entry.chat(model, messages, opts);
  }

  chatStream(model, messages, opts) {
    const entry = this._resolveEntry(model);
    if (entry && entry.__multiProtocol) {
      // 流式不能用 race（异步迭代器无法抢答），按 failover 处理
      return this._multiChatStream(entry, model, messages, opts);
    }
    return entry.chatStream(model, messages, opts);
  }

  _multiChat(entry, model, messages, opts) {
    const { strategy, providers } = entry;
    if (strategy === 'race') {
      return Promise.any(providers.map(p =>
        Promise.resolve().then(() => p.chat(model, messages, opts))
      ));
    }
    // failover（默认）：按顺序试，挂了走下一个
    return this._failoverChat(providers, model, messages, opts);
  }

  async _failoverChat(providers, model, messages, opts) {
    let lastErr;
    for (const p of providers) {
      try {
        return await p.chat(model, messages, opts);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  async _multiChatStream(entry, model, messages, opts) {
    const { strategy, providers } = entry;
    if (strategy === 'race') {
      // 流式无法 race：异步迭代器无法抢答，用第一个
      return providers[0].chatStream(model, messages, opts);
    }
    // failover（默认）：按顺序试，挂了走下一个
    let lastErr;
    for (const p of providers) {
      try {
        return p.chatStream(model, messages, opts);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  async connect(apiKey) {
    await this._default.connect(apiKey);
    for (const e of this._adapters.values()) {
      if (e && e.__multiProtocol) {
        for (const p of e.providers) await p.connect(apiKey).catch(() => {});
      } else {
        await e.connect(apiKey).catch(() => {});
      }
    }
    this.connected = true;
  }

  async disconnect() {
    await this._default.disconnect();
    for (const e of this._adapters.values()) {
      if (e && e.__multiProtocol) {
        for (const p of e.providers) await p.disconnect().catch(() => {});
      } else {
        await e.disconnect().catch(() => {});
      }
    }
    this.connected = false;
  }

  fetchModels() { return this._default.fetchModels(); }
  getModels() { return this._default.getModels(); }
  setModel(m) { return this._default.setModel?.(m); }
  getModel() { return this._default.getModel?.(); }
}

class ProviderRegistry {
  constructor() {
    this.providers = new Map();
    this.models = new Map();
    this._modelTimestamps = new Map();
    this._modelCacheTtl = 60000;
    this.presets = PRESET_PROVIDERS;
    this._ocConfig = loadOpenChatConfig();
  }

  _ocApiKey(providerId) {
    const oc = this._ocConfig;
    const cfg = oc?.providers?.[providerId];
    return cfg?.options?.apiKey || cfg?.apiKey || null;
  }

  _buildAdapterProviders(providerId, preset, apiKey) {
    const oc = this._ocConfig;
    const providerCfg = oc?.providers?.[providerId];
    const adapters = providerCfg?.adapter;
    if (!adapters || typeof adapters !== 'object' || Array.isArray(adapters)) return null;

    const adapterProviders = new Map();
    for (const [model, protocolMap] of Object.entries(adapters)) {
      if (!protocolMap || typeof protocolMap !== 'object' || Array.isArray(protocolMap)) continue;
      // 协议作 key，遍历每个协议端点
      const perProtocol = [];
      for (const [protocol, cfg] of Object.entries(protocolMap)) {
        if (!cfg || typeof cfg !== 'object') continue;
        const baseURL = cfg.baseURL || cfg.baseUrl;
        let p;
        if (protocol === 'anthropic') {
          p = createAnthropicProvider(apiKey, {
            id: `${providerId}:anthropic`,
            name: `${providerId} (anthropic)`,
            baseUrl: baseURL || 'https://api.anthropic.com',
            defaultModel: model,
          });
        } else if (protocol === 'openai' || protocol === 'openai-compatible') {
          p = createProvider(providerId, apiKey, { baseURL });
        } else {
          p = createProvider(providerId, apiKey, { baseURL });
        }
        // 同步标记 connected：chat() 是同步检查该标志的，
        // 真实连通性验证由后台 connect() 完成（失败也不影响 chat 同步标记）。
        if (apiKey) p.connected = true;
        p.connect(apiKey).catch(() => {});
        perProtocol.push({ protocol, provider: p });
      }
      if (perProtocol.length === 1) {
        adapterProviders.set(model, perProtocol[0].provider);
      } else if (perProtocol.length > 1) {
        const strategy = protocolMap.strategy || 'failover';
        adapterProviders.set(model, {
          __multiProtocol: true,
          strategy,
          providers: perProtocol.map(x => x.provider),
        });
      }
    }
    return adapterProviders;
  }

  getProvider(providerId) {
    if (this.providers.has(providerId)) {
      return this.providers.get(providerId);
    }

    const preset = this.presets[providerId];
    if (!preset) return null;

    // Try OpenChat config first, then persistentConfig
    const apiKey = this._ocApiKey(providerId) || persistentConfig.getApiKey(providerId);
    const adapterProviders = this._buildAdapterProviders(providerId, preset, apiKey);

    if (adapterProviders && adapterProviders.size > 0) {
      const defaultProvider = createProvider(providerId, apiKey);
      if (apiKey) defaultProvider.connected = true;
      defaultProvider.connect(apiKey).catch(() => {});
      const router = new RouterProvider(providerId, defaultProvider, adapterProviders);
      this.providers.set(providerId, router);
      return router;
    }

    if (providerId === 'anthropic' || preset.special) {
      const provider = this.createSpecialProvider(providerId, apiKey, preset);
      if (provider) {
        if (apiKey) provider.connected = true;
        provider.connect(apiKey).catch(() => {});
        this.providers.set(providerId, provider);
        return provider;
      }
    }

    const provider = createProvider(providerId, apiKey);
    if (apiKey) provider.connected = true;
    provider.connect(apiKey).catch(() => {});
    this.providers.set(providerId, provider);
    return provider;
  }

  /**
   * 创建特殊 Provider (Anthropic, Azure, Gemini, Cohere, Bedrock 等)
   */
  createSpecialProvider(providerId, apiKey, preset) {
    switch (providerId) {
      case 'anthropic':
        return createAnthropicProvider(apiKey, preset);

      case 'gemini':
      case 'google':
        return createGeminiProvider(apiKey, preset);

      case 'azure':
        return createAzureOpenAIProvider({ apiKey, ...preset });

      case 'cohere':
        return createCohereProvider(apiKey, preset);

      case 'bedrock-proxy':
        return createBedrockProxyProvider(apiKey, preset);

      // 未来可添加其他特殊 provider

      default:
        console.warn(`[Provider] Special provider ${providerId} not implemented, using OpenAI-compatible`);
        return null;
    }
  }

  /**
   * 配置 Provider
   */
  async configure(providerId, options = {}) {
    const { apiKey, baseUrl, defaultModel } = options;

    // 保存 API Key
    if (apiKey) {
      persistentConfig.setApiKey(providerId, apiKey);
    }

    // 使用 getProvider 创建（含 adapter 路由支持）
    let provider = this.getProvider(providerId);

    if (!provider) {
      provider = createProvider(providerId, apiKey || persistentConfig.getApiKey(providerId), {
        baseUrl,
        defaultModel
      });
      this.providers.set(providerId, provider);
    }

    // 连接并获取模型列表
    try {
      await provider.connect(apiKey);
      await this.refreshModels(providerId);
      return { success: true, provider };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 刷新模型列表
   */
  async refreshModels(providerId) {
    const provider = this.getProvider(providerId);
    if (!provider) return [];

    try {
      const models = await provider.fetchModels();
      this.models.set(providerId, models);
      this._modelTimestamps.set(providerId, Date.now());
      return models;
    } catch (e) {
      return provider.getModels();
    }
  }

  /**
   * 获取模型列表（缓存 60 秒，过期自动刷新）
   */
  async getModels(providerId) {
    const cached = this.models.get(providerId);
    const lastFetch = this._modelTimestamps.get(providerId) || 0;
    const stale = Date.now() - lastFetch > this._modelCacheTtl;

    if (cached && !stale) return cached;

    // 尝试刷新，失败则返回缓存
    if (this.getProvider(providerId)) {
      const fresh = await this.refreshModels(providerId).catch(() => cached || []);
      return fresh;
    }

    return cached || [];
  }

  /**
   * 列出所有预设 Provider
   */
  listPresets() {
    return listPresetProviders();
  }

  /**
   * 列出已配置的 Provider
   */
  listConfigured() {
    const configured = [];
    const current = persistentConfig.getPreference('currentProvider');

    for (const [id, provider] of this.providers) {
      configured.push({
        id,
        name: provider.name,
        nameCn: provider.nameCn,
        connected: provider.connected,
        modelCount: provider.getModels().length,
        isCurrent: id === current,
        hasApiKey: !!provider.apiKey
      });
    }

    return configured;
  }

  /**
   * 列出所有 Provider（预设 + 已配置）
   */
  listAll() {
    const result = [];
    const current = persistentConfig.getPreference('currentProvider');
    const configuredIds = new Set(this.providers.keys());

    // 已配置的
    for (const [id, provider] of this.providers) {
      result.push({
        id,
        name: provider.name,
        nameCn: provider.nameCn,
        connected: provider.connected,
        isCurrent: id === current,
        hasApiKey: !!provider.apiKey,
        modelCount: provider.getModels().length,
        configured: true
      });
    }

    // 未配置的预设
    for (const [id, preset] of Object.entries(this.presets)) {
      if (!configuredIds.has(id)) {
        const hasKey = !!persistentConfig.getApiKey(id);
        result.push({
          id,
          name: preset.name,
          nameCn: preset.nameCn,
          connected: false,
          isCurrent: id === current,
          hasApiKey: hasKey,
          modelCount: 0,
          configured: false,
          description: preset.description || ''
        });
      }
    }

    return result;
  }

  /**
   * 设置当前 Provider
   */
  setCurrent(providerId, model = null) {
    persistentConfig.setPreference('currentProvider', providerId);
    if (model) {
      persistentConfig.setPreference('currentModel', model);
    } else {
      // 使用默认模型
      const provider = this.getProvider(providerId);
      if (provider && provider.defaultModel) {
        persistentConfig.setPreference('currentModel', provider.defaultModel);
      }
    }
  }

  /**
   * 获取当前 Provider
   */
  getCurrent() {
    const providerId = persistentConfig.getPreference('currentProvider');
    const model = persistentConfig.getPreference('currentModel');

    if (!providerId) return null;

    const provider = this.getProvider(providerId);
    return {
      providerId,
      model,
      provider
    };
  }

  /**
   * 移除 Provider
   */
  remove(providerId) {
    this.providers.delete(providerId);
    this.models.delete(providerId);
    persistentConfig.removeApiKey(providerId);
  }

  /**
   * 发送聊天消息
   */
  async chat(messages, options = {}) {
    const { providerId, model } = options;

    // 使用指定的或当前的 provider
    let pid = providerId || persistentConfig.getPreference('currentProvider');
    let m = model || persistentConfig.getPreference('currentModel');

    if (!pid) {
      throw new Error('No provider configured. Run: connect <provider>');
    }

    const provider = this.getProvider(pid);
    if (!provider) {
      throw new Error(`Provider ${pid} not found`);
    }

    // 确保已连接
    if (!provider.connected && !provider.skipAuth) {
      let apiKey = persistentConfig.getApiKey(pid);
      // resolver fallback
      if (!apiKey && hasKeyResolver()) {
        const r = await Promise.resolve(resolveApiKey(pid));
        if (r?.key) apiKey = r.key;
      }
      if (!apiKey) {
        throw new Error(`No API key for ${pid}. Run: connect ${pid}`);
      }
      await provider.connect(apiKey);
    }

    return provider.chat(m, messages, options);
  }

  /**
   * 获取统计信息
   */
  getStats() {
    let totalModels = 0;
    for (const models of this.models.values()) {
      totalModels += models.length;
    }

    return {
      providersConfigured: this.providers.size,
      presetsAvailable: Object.keys(this.presets).length,
      totalModels
    };
  }

  /**
   * 释放所有资源：断开所有 provider 连接，清空缓存
   * 用于 HMR / 测试 cleanup / 进程退出
   */
  async dispose() {
    for (const provider of this.providers.values()) {
      try {
        await provider.disconnect?.();
      } catch {}
    }
    this.providers.clear();
    this.models.clear();
    this._modelTimestamps.clear();
  }
}

// 单例
export const providerRegistry = new ProviderRegistry();
export default providerRegistry;

// 兼容旧 API
export { PRESET_PROVIDERS, createProvider, listPresetProviders };
