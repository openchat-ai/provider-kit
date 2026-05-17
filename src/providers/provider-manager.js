import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS_PATH = path.join(__dirname, '../config/provider-models.json');

// 运行时配置路径
const RUNTIME_CONFIG_PATH = path.join(os.homedir(), '.openchat', 'config.json');

// 服务商配置
export let PRESET_PROVIDERS = {};
let _defaultProvider = 'openrouter';

// 运行时配置缓存
let _runtimeConfig = null;

/**
 * 加载运行时配置 (C:\Users\Administrator\.openchat\config.json)
 * 包含实际的 apiKey
 */
function loadRuntimeConfig() {
  try {
    if (fs.existsSync(RUNTIME_CONFIG_PATH)) {
      const data = fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8');
      _runtimeConfig = JSON.parse(data);
      return _runtimeConfig;
    }
  } catch (e) {
    console.warn('[ProviderManager] Failed to load runtime config:', e.message);
  }
  return null;
}

/**
 * 获取 provider 的运行时 API Key
 * 优先从运行时配置读取，没有则返回 null
 * 支持两种格式:
 * 1. providers.xxx.apiKey
 * 2. providers.xxx.options.apiKey
 */
export function getRuntimeApiKey(providerName) {
  if (!_runtimeConfig) {
    loadRuntimeConfig();
  }

  if (!_runtimeConfig || !_runtimeConfig.providers) {
    return null;
  }

  const providerKey = providerName.toLowerCase();
  const providerConfig = _runtimeConfig.providers[providerKey];

  if (!providerConfig) {
    return null;
  }

  // 格式1: providers.xxx.options.apiKey (百度千帆格式)
  if (providerConfig.options && providerConfig.options.apiKey) {
    return providerConfig.options.apiKey;
  }

  // 格式2: providers.xxx.apiKey (硅基流动格式)
  if (providerConfig.apiKey) {
    return providerConfig.apiKey;
  }

  return null;
}

/**
 * 重新加载运行时配置
 */
export function reloadRuntimeConfig() {
  _runtimeConfig = null;
  return loadRuntimeConfig();
}

/**
 * 获取 provider 的运行时 Base URL
 * 支持两种格式:
 * 1. providers.xxx.baseUrl
 * 2. providers.xxx.options.baseURL
 */
export function getRuntimeBaseUrl(providerName) {
  if (!_runtimeConfig) {
    loadRuntimeConfig();
  }

  if (!_runtimeConfig || !_runtimeConfig.providers) {
    return null;
  }

  const providerKey = providerName.toLowerCase();
  const providerConfig = _runtimeConfig.providers[providerKey];

  if (!providerConfig) {
    return null;
  }

  // 格式1: providers.xxx.baseUrl
  if (providerConfig.baseUrl) {
    return providerConfig.baseUrl;
  }

  // 格式2: providers.xxx.options.baseURL
  if (providerConfig.options && providerConfig.options.baseURL) {
    return providerConfig.options.baseURL;
  }

  return null;
}

// 加载的别名缓存
let _aliases = {};

function loadProviders() {
  try {
    if (fs.existsSync(PROVIDERS_PATH)) {
      const data = fs.readFileSync(PROVIDERS_PATH, 'utf8');
      const loaded = JSON.parse(data);

      _defaultProvider = loaded._defaultProvider || 'openrouter';
      _aliases = loaded._aliases || {};
      delete loaded._defaultProvider;
      delete loaded._aliases;

      Object.assign(PRESET_PROVIDERS, loaded);
    }
  } catch (e) {
    console.error('Failed to load providers:', e.message);
  }
}

loadProviders();

export const DEFAULT_PROVIDER = _defaultProvider;
export const PROVIDER_ALIASES = _aliases;

export function saveProviders() {
  try {
    const data = {
      _defaultProvider,
      _aliases,
      ...PRESET_PROVIDERS
    };
    fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Failed to save providers:', e.message);
    return false;
  }
}

export function updateProviderModels(providerKey, models) {
  if (PRESET_PROVIDERS[providerKey]) {
    PRESET_PROVIDERS[providerKey].models = models;
    PRESET_PROVIDERS[providerKey].updatedAt = new Date().toISOString();
    return saveProviders();
  }
  return false;
}

export function addProviderEntry(providerKey, config) {
  PRESET_PROVIDERS[providerKey] = config;
  return saveProviders();
}

function normalizeProvider(name) {
  if (!name) return name;
  const lower = name.toLowerCase();
  if (PROVIDER_ALIASES[lower]) return PROVIDER_ALIASES[lower];
  if (PROVIDER_ALIASES[name]) return PROVIDER_ALIASES[name];
  return name;
}


export class ProviderManager {
  constructor() {
    this.customProviders = new Map();
  }

  getProviderConfig(name) {
    const canonical = normalizeProvider(name);
    // 从 PRESET_PROVIDERS (config/provider-models.json) 获取
    if (PRESET_PROVIDERS[canonical]) {
      return PRESET_PROVIDERS[canonical];
    }
    // 检查自定义服务商
    if (this.customProviders.has(canonical)) {
      return this.customProviders.get(canonical);
    }
    return null;
  }

  getProvider(name) {
    return this.getProviderConfig(name);
  }

  listProviders() {
    const result = [];
    const seen = new Set();

    // 从 PRESET_PROVIDERS (config/providers.json) 加载
    for (const [name, config] of Object.entries(PRESET_PROVIDERS)) {
      if (seen.has(name)) continue;
      seen.add(name);
      result.push({
        name,
        nameCn: config.nameCn || name,
        baseUrl: config.baseUrl || '',
        defaultModel: config.defaultModel || 'default',
        models: config.models || [],
        modelMeta: config.modelMeta || [],
        connected: !!(config.models && config.models.length > 0),
        transport: config.transport || 'openai_chat',
        isAggregator: config.isAggregator || false,
        description: config.description || '',
        envVars: config.envVars || []
      });
    }

    // 添加自定义服务商
    for (const [name, config] of this.customProviders) {
      if (seen.has(name)) continue;
      seen.add(name);
      result.push({
        name,
        nameCn: config.nameCn || name,
        baseUrl: config.baseUrl,
        defaultModel: config.defaultModel || 'default',
        models: config.models || [],
        modelMeta: [],
        connected: false,
        transport: config.transport || 'openai_chat',
        isAggregator: false,
        description: config.description || '',
        envVars: []
      });
    }

    return result;
  }

  _mergeProvider(name, overlay) {
    const saved = PRESET_PROVIDERS[name] || {};
    return {
      ...overlay,
      nameCn: saved.nameCn || overlay.nameCn || overlay.name,
      name: overlay.name,
      baseUrl: saved.baseUrl || overlay.baseUrl,
      defaultModel: saved.defaultModel || overlay.defaultModel,
      description: saved.description || overlay.description
    };
  }

  listModels(providerName) {
    const config = this.getProviderConfig(providerName);
    if (!config) return [];
    return config.models && config.models.length > 0
      ? config.models
      : [config.defaultModel].filter(Boolean);
  }

  addCustomProvider(name, baseUrl, apiKey, model = null) {
    this.customProviders.set(name, {
      nameCn: name,
      baseUrl,
      chatEndpoint: '/chat/completions',
      defaultModel: model,
      models: model ? [model] : [],
      apiKey
    });
  }

  getDefaultModel(providerName) {
    const config = this.getProviderConfig(providerName);
    if (!config) return 'default';
    return config.defaultModel || 'default';
  }

  getBaseUrl(providerName) {
    const config = this.getProviderConfig(providerName);
    if (!config) return null;
    return config.baseUrl;
  }

  getTransport(providerName) {
    const config = this.getProviderConfig(providerName);
    return config?.transport || 'openai_chat';
  }

  getApiMode(providerName) {
    const transport = this.getTransport(providerName);
    const map = {
      'openai_chat': 'chat_completions',
      'anthropic_messages': 'anthropic_messages',
      'codex_responses': 'codex_responses'
    };
    return map[transport] || 'chat_completions';
  }

  isAggregator(providerName) {
    const config = this.getProviderConfig(providerName);
    return config?.isAggregator || false;
  }

  getEnvVars(providerName) {
    const config = this.getProviderConfig(providerName);
    return config?.envVars || [];
  }

  reloadProviders() {
    Object.keys(PRESET_PROVIDERS).forEach(k => delete PRESET_PROVIDERS[k]);
    loadProviders();
  }
}

export const providerManager = new ProviderManager();
export default providerManager;
