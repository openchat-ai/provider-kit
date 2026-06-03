/**
 * Provider Registry - 简化的 Provider 管理
 *
 * 设计原则：
 * 1. 最小配置 - 只需 id + baseUrl + apiKey
 * 2. 自动发现 - 调用 /models 自动获取模型列表
 * 3. 统一接口 - 所有 OpenAI 兼容 provider 用同一个适配器
 */

import { OpenAICompatibleProvider, PRESET_PROVIDERS, createProvider, listPresetProviders } from './openai-compatible.js';
import { AnthropicAdapter, createAnthropicProvider } from './anthropic-adapter.js';
import { GeminiAdapter, createGeminiProvider } from './gemini-adapter.js';
import { AzureOpenAIAdapter, createAzureOpenAIProvider } from './azure-adapter.js';
import { CohereAdapter, createCohereProvider } from './cohere-adapter.js';
import { BedrockProxyAdapter, createBedrockProxyProvider } from './bedrock-adapter.js';
import { persistentConfig, setKeyResolver, clearKeyResolver, hasKeyResolver, resolveApiKey } from '../core/persistent-config.js';

class ProviderRegistry {
  constructor() {
    this.providers = new Map();
    this.models = new Map();
    this._modelTimestamps = new Map();    // providerId -> last fetch timestamp
    this._modelCacheTtl = 60000;          // 60s
    this.presets = PRESET_PROVIDERS;
  }

  /**
   * 获取或创建 Provider
   */
  getProvider(providerId) {
    // 已存在
    if (this.providers.has(providerId)) {
      return this.providers.get(providerId);
    }

    // 从预设创建
    const preset = this.presets[providerId];
    if (preset) {
      // 注意: getProvider 保持同步，resolver 兜底仅在 chat() 内（async）做
      const apiKey = persistentConfig.getApiKey(providerId);

      // 特殊处理: Anthropic 使用专用适配器
      if (providerId === 'anthropic' || preset.special) {
        const provider = this.createSpecialProvider(providerId, apiKey, preset);
        if (provider) {
          this.providers.set(providerId, provider);
          return provider;
        }
      }

      // 默认使用 OpenAI 兼容适配器
      const provider = createProvider(providerId, apiKey);
      this.providers.set(providerId, provider);
      return provider;
    }

    return null;
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

    // 创建或更新 provider
    let provider = this.providers.get(providerId);

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
}

// 单例
export const providerRegistry = new ProviderRegistry();
export default providerRegistry;

// 兼容旧 API
export { PRESET_PROVIDERS, createProvider, listPresetProviders };
