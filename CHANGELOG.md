# Changelog

All notable changes to provider-kit.

## [1.5.0] - 2026-06-08

### Fixed (from expert review P0)

- **#1 Sync race in `getProvider`**: `chat()` could throw "Provider not connected" when called before the fire-and-forget `connect()` finished. Now providers are synchronously marked `connected = true` if `apiKey` is set, with async validation running in background.
- **#3 Config file permissions (0600)**: `persistent-config` now writes configs with mode `0o600` and tightens permissions on load (Unix only; Windows ignored). API keys no longer world-readable.
- **#2 `ProviderRegistry.dispose()`**: New `dispose()` method disconnects all providers and clears `providers` / `models` / `_modelTimestamps` maps. Use for HMR, test cleanup, process exit.
- **#5 `withRetry` 4xx/5xx classification**:
  - Previously `'4'` substring in error message would mis-classify (e.g., IP `127.0.0.1:443` matched as `bad_request`).
  - Now uses `\bN{3}\b` word boundaries. Network errors (`ECONNREFUSED`/`ENOTFOUND`/`fetch failed`) are correctly retryable.
  - Non-ProviderError errors are run through `classifyError` so retryable flag is honored.
- **#6 `AnthropicAdapter` Function Calling was silently broken**:
  - `convertResponse` dropped `tool_use` blocks — response looked like empty content with raw Anthropic blocks, no `toolCalls` array, so callers (Orchestrator, dev-repl) couldn't dispatch tools. Affected every provider that uses the Anthropic Messages API protocol (Anthropic, minimax, kimi, zhipu, etc).
  - `convertMessages` did not convert OpenAI-style `tool_calls` (assistant) / `tool` / legacy `function` messages into Anthropic `tool_use` / `tool_result` blocks, so the LLM never received the conversation history in a form it could reason about.
  - `chatStream` did not collect `tool_use` blocks across `content_block_start` / `input_json_delta` / `message_stop` SSE events, so streaming FC returned nothing.
  - All three conversions now match the spec. 26 new regression tests in `test/tool-use-conversion.test.js` lock the behaviour.

### Added

- `RouterProvider` multi-protocol routing (race / failover) per model via `~/.config/openchat/config.json` `adapter.<model>.<protocol>.baseURL`.
- 7 new regression tests in `test/regression.test.js`.
- 26 new regression tests in `test/tool-use-conversion.test.js` covering `convertResponse`, `convertMessages`, and `chatStream` for Function Calling on Anthropic-protocol providers.

### Changed

- `classifyError` reordering: network/timeout checked first (most specific), then 4xx/5xx (avoid `4` substring false positives).
- ProviderError `auth` type now matches "api key" / "apikey" / "invalid key" in messages.

## [1.3.9] and earlier

See git history.
