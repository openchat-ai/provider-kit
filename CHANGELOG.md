# Changelog

## 0.1.0 (2026-05-17)

- 42 LLM provider unified API via `createProvider(type, config)`
- Adapters: OpenAI, Anthropic, Azure, Bedrock, Cohere, Gemini, Ollama, Local, OpenAI-compatible
- `ProviderError` with typed taxonomy: rate_limit, auth, timeout, server_error, quota, bad_request, network, unknown
- `AbortError` for user-initiated cancellation
- `withRetry()` exponential backoff (respects `AbortError`, skips non-retryable errors)
- `withTimeout()` race-based timeout
- `safeProviderCall()` combined retry + timeout
- `createCancelSignal()` for abortable streaming
- `classifyError()` maps raw errors to typed `ProviderError`
- `createStore()` DI mode for custom storage
- 27 unit tests covering error paths, retry, timeout, abort, security audit
- Zero dependencies, Node.js 18+
