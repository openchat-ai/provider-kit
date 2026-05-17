/**
 * Persistent config for @openchat/provider-kit
 *
 * Lookup order:
 *   1. PROVIDER_KIT_CONFIG_PATH 环境变量
 *   2. cwd/.provider-kit.json
 *   3. 内存（不写文件）
 *
 * 绝不写 ~/ 目录。这是公共 npm 包，不是 OpenChat 专属.
 */

import { resolve } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

function resolveConfigPath() {
  const envPath = process.env.PROVIDER_KIT_CONFIG_PATH;
  if (envPath) return resolve(envPath);
  const cwdPath = resolve(process.cwd(), '.provider-kit.json');
  if (existsSync(cwdPath)) return cwdPath;
  return null;
}

const CONFIG_PATH = resolveConfigPath();

class PersistentConfig {
  constructor() {
    this._store = {};
    this._apiKeys = {};
    this._readOnly = !CONFIG_PATH;
    this._load();
  }

  _load() {
    if (!CONFIG_PATH) return; // memory only
    try {
      const data = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      this._store = data.store || {};
      this._apiKeys = data.apiKeys || {};
    } catch {
      this._store = {};
      this._apiKeys = {};
    }
  }

  _save() {
    if (this._readOnly) return;
    try {
      mkdirSync(resolve(CONFIG_PATH, '..'), { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify({ store: this._store, apiKeys: this._apiKeys }, null, 2), 'utf8');
    } catch {
      // silent: 只读容器 / 权限不足
    }
  }

  getApiKey(provider) {
    return this._apiKeys[provider] || process.env[`${provider.toUpperCase()}_API_KEY`] || '';
  }

  setApiKey(provider, key) {
    this._apiKeys[provider] = key;
    this._save();
  }

  removeApiKey(provider) {
    delete this._apiKeys[provider];
    this._save();
  }

  listKeys() {
    return Object.keys(this._apiKeys);
  }

  getPreference(key) {
    return this._store[key];
  }

  setPreference(key, val) {
    this._store[key] = val;
    this._save();
  }

  getBridgeConfig() {
    return this._store;
  }
}

export const persistentConfig = new PersistentConfig();

/**
 * createStore — DI 模式：自定义存储实现
 * 用于框架集成者（Next.js、Remix、Bridge 等）传入自己的持久化方案
 *
 * 示例:
 *   const store = createStore({ load: () => db.get('config'), save: (d) => db.set('config', d) });
 *   store.setApiKey('openai', 'sk-xxx');
 */
export function createStore(impl = {}) {
  const store = new PersistentConfig();
  if (impl.apiKeys) store._apiKeys = impl.apiKeys;
  if (impl.store) store._store = impl.store;
  if (impl.load) { try { const d = impl.load(); if (d) { store._apiKeys = d.apiKeys || {}; store._store = d.store || {}; } } catch {} }
  if (impl.save) { const origSave = store._save.bind(store); store._save = () => { origSave(); impl.save({ apiKeys: store._apiKeys, store: store._store }); }; }
  if (impl.onSave) store._save = impl.onSave;
  return store;
}

export default persistentConfig;
