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
 * createMonitor — observability wrapper
 *
 * Wraps provider calls with latency tracking, error classification,
 * and logging hooks. No external dependencies.
 *
 * Usage:
 *   const monitor = createMonitor({ onCall: (record) => console.table(record) });
 *   const provider = monitor.wrap(await createProvider('openai', key));
 *   await provider.chat('gpt-4', messages);
 *   // → onCall receives { provider, model, latency, ok, error, timestamp }
 */
export function createMonitor(opts = {}) {
  const onCall = opts.onCall || (() => {});

  function wrap(provider) {
    const origChat = provider.chat.bind(provider);
    const origStream = provider.chatStream?.bind(provider);

    provider.chat = async (model, messages, options) => {
      const start = Date.now();
      try {
        const result = await origChat(model, messages, options);
        onCall({ provider: provider.name || 'unknown', model, latency: Date.now() - start, ok: true, tokens: result.usage?.total_tokens || 0, timestamp: Date.now() });
        return result;
      } catch (e) {
        const ce = classifyError(e, provider.name);
        onCall({ provider: provider.name || 'unknown', model, latency: Date.now() - start, ok: false, error: ce.type, message: ce.message, timestamp: Date.now() });
        throw e;
      }
    };

    if (origStream) {
      provider.chatStream = async function* (model, messages, options) {
        const start = Date.now();
        try {
          const stream = origStream(model, messages, options);
          for await (const chunk of stream) yield chunk;
          onCall({ provider: provider.name || 'unknown', model, latency: Date.now() - start, ok: true, timestamp: Date.now() });
        } catch (e) {
          const ce = classifyError(e, provider.name);
          onCall({ provider: provider.name || 'unknown', model, latency: Date.now() - start, ok: false, error: ce.type, timestamp: Date.now() });
          throw e;
        }
      };
    }

    return provider;
  }

  return { wrap };
}

/**
 * createRouter — model health probe + auto-routing
 *
 * Periodically checks each model's availability and latency.
 * Routes requests to the best available model in real time.
 * Changes take effect immediately — no restart needed.
 *
 * Usage:
 *   const router = createRouter({
 *     probes: [
 *       { provider: 'openai',   model: 'gpt-4',        apiKey: 'sk-...' },
 *       { provider: 'openai',   model: 'gpt-4o-mini',  apiKey: 'sk-...' },
 *       { provider: 'anthropic', model: 'claude-3-haiku', apiKey: 'sk-...' },
 *       { provider: 'ollama',   model: 'llama3',       baseUrl: 'http://localhost:11434' },
 *     ],
 *     strategy: 'latency',       // 'latency' | 'failover' | 'round-robin' | 'cheapest'
 *     probeInterval: 30000,       // check every 30s (0 = no auto-probe)
 *     probeTimeout: 5000,         // per-probe timeout
 *     onProbeResult: (results) => console.log(results),
 *   });
 *
 *   const reply = await router.chat([{ role: 'user', content: 'Hi' }]);
 *   // → routed to the best available model
 */
export function createRouter(opts) {
  const probes = Array.isArray(opts) ? opts : opts.probes || opts.strategies || [];
  if (!Array.isArray(probes) || probes.length === 0) {
    throw new ProviderError('createRouter requires probes array', { type: 'bad_request' });
  }

  const strategy = opts.strategy || 'latency';
  const probeInterval = opts.probeInterval ?? 0;
  const probeTimeout = opts.probeTimeout ?? 5000;
  const onProbeResult = opts.onProbeResult || null;

  // Probe results: { provider, model, ok, latency, error, timestamp }
  let results = probes.map(p => ({ provider: p.provider, model: p.model, ok: true, latency: 0, error: null, timestamp: 0 }));
  let rrIndex = 0;
  let probeTimer = null;

  // Probe a single model
  async function probeOne(entry) {
    const start = Date.now();
    try {
      const { createProvider } = await import('./openai-compatible.js');
      const provider = await createProvider(entry.provider, entry.apiKey, { baseUrl: entry.baseUrl });
      await withTimeout(
        () => provider.chat(entry.model, [{ role: 'user', content: 'Hi' }], { max_tokens: 1 }),
        probeTimeout
      );
      return { ok: true, latency: Date.now() - start, error: null };
    } catch (e) {
      const ce = classifyError(e, entry.provider);
      return { ok: false, latency: Date.now() - start, error: ce.type === 'auth' ? 'auth_failed' : ce.message };
    }
  }

  // Probe all models, update results
  async function probeAll() {
    const newResults = await Promise.all(probes.map(async (entry, i) => {
      const { ok, latency, error } = await probeOne(entry);
      return { provider: entry.provider, model: entry.model, ok, latency, error, timestamp: Date.now() };
    }));
    results = newResults;
    if (onProbeResult) onProbeResult(results);
  }

  // Pick the best model based on strategy
  function pick() {
    const alive = results.filter(r => r.ok);
    if (alive.length === 0) return probes[0]; // all dead → try first anyway

    switch (strategy) {
      case 'latency':
        alive.sort((a, b) => a.latency - b.latency);
        return probes[results.indexOf(alive[0])];
      case 'round-robin': {
        const idx = rrIndex % alive.length;
        rrIndex++;
        return probes[results.indexOf(alive[idx])];
      }
      case 'failover': {
        const preferred = probes.map((p, i) => ({ p, i })).sort((a, b) => a.i - b.i);
        for (const { p, i } of preferred) {
          if (results[i]?.ok) return p;
        }
        return probes[0];
      }
      default:
        return probes[probes.indexOf(alive[0])];
    }
  }

  // Start auto-probe
  if (probeInterval > 0) {
    probeAll(); // first probe immediately
    probeTimer = setInterval(probeAll, probeInterval);
  }

  // Chat — route to best model
  async function chat(messages) {
    const entry = pick();
    const idx = probes.indexOf(entry);
    const r = results[idx];

    if (!r?.ok && strategy !== 'failover') {
      // All dead — force probe once
      const probeResult = await probeOne(entry);
      results[idx] = { ...results[idx], ...probeResult, timestamp: Date.now() };
    }

    const { createProvider } = await import('./openai-compatible.js');
    const provider = await createProvider(entry.provider, entry.apiKey, { baseUrl: entry.baseUrl });
    return safeProviderCall(
      () => provider.chat(entry.model, messages),
      { provider: entry.provider, retries: 1, timeout: 30000 }
    );
  }

  // Manual probe trigger
  async function checkNow() { await probeAll(); return results; }

  // Stop auto-probe
  function stop() { if (probeTimer) { clearInterval(probeTimer); probeTimer = null; } }

  return { chat, probes, results: () => results, strategy, checkNow, stop };
}
