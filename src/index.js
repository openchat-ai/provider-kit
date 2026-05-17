/**
 * @openchat/provider-kit
 *
 * 42 LLM provider unified API — one interface for OpenAI, Anthropic,
 * Ollama, OpenRouter, and 38 more.
 *
 * Quick start:
 *   import { providerRegistry, createProvider } from '@openchat/provider-kit';
 *   const provider = createProvider('openai', { apiKey: 'sk-...' });
 *   const reply = await provider.chat('gpt-4', [{ role: 'user', content: 'Hi' }]);
 */

export { ProviderError, AbortError, withRetry, withTimeout, safeProviderCall, classifyError, createCancelSignal, createRouter, createMonitor } from './providers/provider-error-adapter.js';
export { ProviderManager, providerManager } from './providers/provider-manager.js';
export { providerRegistry, createProvider, listPresetProviders, PRESET_PROVIDERS } from './providers/provider-registry.js';
export { persistentConfig, createStore } from './core/persistent-config.js';
