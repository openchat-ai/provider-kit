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
