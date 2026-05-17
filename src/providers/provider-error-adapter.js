/**
 * ProviderError taxonomy for LLM API errors.
 *
 * Types: rate_limit | auth | timeout | server_error | quota | bad_request | network | unknown
 *
 * Each type has a default user-facing message so callers get
 * actionable information instead of "Provider error".
 */

const ERROR_MESSAGES = {
  rate_limit: 'Rate limit exceeded — slow down or upgrade your plan',
  auth: 'Authentication failed — check your API key',
  timeout: 'Request timed out — the provider did not respond in time',
  server_error: 'Provider server error — try again later',
  quota: 'Quota exceeded — you have used up your allowed tokens',
  bad_request: 'Bad request — check your input parameters',
  network: 'Network error — unable to reach the provider',
  unknown: 'An unknown error occurred',
};

export class ProviderError extends Error {
  constructor(message, { provider, statusCode, retryable, type } = {}) {
    const friendly = message || ERROR_MESSAGES[type] || ERROR_MESSAGES.unknown;
    super(friendly);
    this.name = 'ProviderError';
    this.provider = provider || 'unknown';
    this.statusCode = statusCode;
    this.retryable = retryable ?? (statusCode >= 500 || statusCode === 429);
    this.type = type || 'unknown';
    this.timestamp = Date.now();
  }
}

export class AbortError extends Error {
  constructor(message = 'Request was aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export async function withRetry(fn, { retries = 2, baseDelay = 1000, provider } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AbortError) throw e;
      if (i === retries) throw e;
      const isRetryable = e instanceof ProviderError ? e.retryable : true;
      if (!isRetryable) throw e;
      // Exponential backoff with jitter (±25%) to prevent thundering herd
      const delay = baseDelay * Math.pow(2, i);
      const jitter = delay * (0.75 + Math.random() * 0.5);
      await new Promise(r => setTimeout(r, jitter));
    }
  }
}

export function withTimeout(fn, timeoutMs = 15000) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => {
      reject(new ProviderError(undefined, { type: 'timeout', retryable: true }));
    }, timeoutMs)),
  ]);
}

export async function safeProviderCall(fn, { provider, retries, timeout } = {}) {
  return withRetry(() => withTimeout(fn, timeout), { retries, provider });
}

export function classifyError(error, provider) {
  if (error instanceof ProviderError) return error;
  if (error instanceof AbortError) return error;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    const type = msg.includes('rate') || msg.includes('429') ? 'rate_limit'
      : msg.includes('auth') || msg.includes('401') || msg.includes('key') ? 'auth'
      : msg.includes('timeout') || msg.includes('timed out') ? 'timeout'
      : msg.includes('5') || msg.includes('server') ? 'server_error'
      : msg.includes('quota') || msg.includes('402') ? 'quota'
      : msg.includes('4') || msg.includes('bad') || msg.includes('invalid') ? 'bad_request'
      : msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('network') ? 'network'
      : 'unknown';
    return new ProviderError(error.message, { provider, type, retryable: type === 'timeout' || type === 'server_error' || type === 'network' || type === 'rate_limit' });
  }
  return new ProviderError(String(error), { provider, type: 'unknown' });
}

/**
 * createCancelSignal — returns { signal, cancel } for abortable streaming
 *
 * Usage:
 *   const { signal, cancel } = createCancelSignal();
 *   const stream = provider.chatStream('gpt-4', messages, { signal });
 *   // later: cancel('User cancelled');
 */
export function createCancelSignal() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    cancel: (reason) => controller.abort(new AbortError(reason || 'Cancelled by user')),
  };
}

/**
 * createRouter — model fallback router
 *
 * Tries models in order. If one fails (rate_limit/timeout/server_error),
 * automatically falls back to the next.
 *
 * Usage:
 *   const router = createRouter([
 *     { provider: 'openai', model: 'gpt-4', apiKey: 'sk-...' },
 *     { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-...' },
 *     { provider: 'anthropic', model: 'claude-3-haiku', apiKey: 'sk-...' },
 *   ]);
 *   const reply = await router.chat([{ role: 'user', content: 'Hi' }]);
 */
export function createRouter(strategies) {
  if (!Array.isArray(strategies) || strategies.length === 0) {
    throw new ProviderError('createRouter requires a non-empty array of strategies', { type: 'bad_request' });
  }

  async function chat(messages) {
    const errors = [];
    for (const entry of strategies) {
      try {
        const { createProvider } = await import('./openai-compatible.js');
        const provider = await createProvider(entry.provider, entry.apiKey, { baseUrl: entry.baseUrl });
        return await safeProviderCall(
          () => provider.chat(entry.model, messages),
          { provider: entry.provider, retries: 1, timeout: 15000 }
        );
      } catch (e) {
        const ce = classifyError(e, entry.provider);
        if (ce.type === 'auth' || ce.type === 'bad_request' || ce.type === 'quota') throw ce;
        errors.push({ provider: entry.provider, model: entry.model, error: ce.message });
        continue;
      }
    }
    throw new ProviderError(`All models failed: ${errors.map(e => `${e.provider}/${e.model}`).join(', ')}`, { type: 'server_error' });
  }

  return { chat, strategies };
}
