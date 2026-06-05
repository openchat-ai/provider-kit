# Every LLM has its own SDK. One API for all of them.

**Switch between OpenAI, Anthropic, Ollama, Google Gemini, and 38 more — without changing a line of code.** provider-kit wraps 42 LLM providers behind one consistent `chat()` interface, with built-in retry, timeout, error handling, and model fallback routing.

```bash
npm install provider-kit
```

---

## Quickstart

```js
import { createProvider } from 'provider-kit'

const client = await createProvider('openai', process.env.OPENAI_API_KEY)
const stream = client.chatStream('gpt-4o-mini', [
  { role: 'user', content: 'Write a haiku' },
])

for await (const chunk of stream) {
  if (chunk.type === 'content') process.stdout.write(chunk.content)
}
```

Save as `demo.mjs`, run `node demo.mjs`, see the first token in under 60 seconds.

---

## Usage

### Basic chat

```js
import { createProvider } from 'provider-kit'

const provider = await createProvider('openai', process.env.OPENAI_API_KEY)
const reply = await provider.chat('gpt-4o-mini', [
  { role: 'user', content: 'Hello' },
])
console.log(reply.content)
// → "Hello! How can I help you today?"
```

### Multiple providers

```js
import { providerRegistry } from 'provider-kit'

await providerRegistry.configure('openai', { apiKey: process.env.OPENAI_API_KEY, defaultModel: 'gpt-4o-mini' })
await providerRegistry.configure('ollama', { baseUrl: 'http://localhost:11434', defaultModel: 'llama3.2' })

const provider = providerRegistry.getProvider('openai')
const reply = await provider.chat('gpt-4o-mini', [{ role: 'user', content: 'Hi' }])
```

### Model auto-routing (health probes + real-time switching)

Periodically detects which models are available and routes to the best one. Changes take effect immediately — no restart needed.

```js
import { createRouter } from 'provider-kit'

const router = createRouter({
  probes: [
    { provider: 'openai',   model: 'gpt-4',        apiKey: process.env.OPENAI_API_KEY },
    { provider: 'openai',   model: 'gpt-4o-mini',  apiKey: process.env.OPENAI_API_KEY },
    { provider: 'anthropic', model: 'claude-3-haiku', apiKey: process.env.ANTHROPIC_API_KEY },
    { provider: 'ollama',   model: 'llama3.2',     baseUrl: 'http://localhost:11434' },
  ],
  strategy: 'latency',          // 'latency' | 'failover' | 'round-robin'
  probeInterval: 30000,          // ping every 30s (0 = manual only)
  onProbeResult: (results) => console.log(results),
})

const reply = await router.chat([{ role: 'user', content: 'Hello' }])
// → auto-routed to the healthiest model

// Manual probe
const status = await router.checkNow()
// → [{ provider, model, ok, latency, error }]

// Stop auto-probe
router.stop()
```

### Streaming

```js
const stream = provider.chatStream('gpt-4o-mini', [
  { role: 'user', content: 'Count to 10' },
])
for await (const chunk of stream) {
  if (chunk.type === 'content') process.stdout.write(chunk.content)
}
```

Cancel streaming anytime:

```js
import { createCancelSignal } from 'provider-kit'
const { signal, cancel } = createCancelSignal()
setTimeout(() => cancel('User stopped'), 3000)
const stream = provider.chatStream('gpt-4', messages, { signal })
```

### Function Calling (with fallback for non-FC models)

```js
const reply = await provider.chat('gpt-4', messages, {
  tools: [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
      },
    },
  }],
})
if (reply.toolCalls) {
  console.log(reply.toolCalls[0].name)       // → "get_weather"
  console.log(reply.toolCalls[0].arguments)   // → { city: "Tokyo" }
}
```

For models without native Function Calling support (e.g. MiniMax, some local models), the provider-kit automatically falls back to text-based `ACTION:` parsing. If the model outputs:

```
ACTION: get_weather { "city": "Tokyo" }
```

It will be parsed into proper `toolCalls` — no code changes needed.

### Streaming with non-FC models

When streaming with a model that doesn't support FC, the stream may return empty content. Call `chat()` as a fallback:

```js
const stream = provider.chatStream(model, messages, { tools })
for await (const chunk of stream) {
  // non-FC models may yield little or no content here
}
// Fallback: chat() handles both FC and text-based ACTION:
const reply = await provider.chat(model, messages, { tools })
```

### Error handling

Every error is a `ProviderError` with a consistent structure:

```js
import { ProviderError, withRetry, withTimeout, safeProviderCall } from 'provider-kit'

try {
  const reply = await safeProviderCall(
    () => provider.chat('gpt-4', messages),
    { provider: 'openai', retries: 3, timeout: 30000 }
  )
} catch (e) {
  if (e instanceof ProviderError) {
    console.log(e.provider)      // → "openai"
    console.log(e.statusCode)    // → 429
    console.log(e.retryable)     // → true
    console.log(e.type)          // → "rate_limit" | "auth" | "timeout" | "server_error" | "quota" | "bad_request" | "network" | "unknown"
    console.log(e.message)       // → "Rate limit exceeded — slow down or upgrade your plan"
  }
}
```

| Type | Meaning | Retryable |
|------|---------|-----------|
| `rate_limit` | Too many requests | ✅ |
| `auth` | Bad API key | ❌ |
| `timeout` | Provider didn't respond | ✅ |
| `server_error` | Provider 5xx error | ✅ |
| `quota` | Token budget exhausted | ❌ |
| `bad_request` | Invalid input | ❌ |
| `network` | DNS/connection failure | ✅ |
| `unknown` | Catch-all | depends |

### Classify raw errors

```js
import { classifyError } from 'provider-kit'

const err = new Error('429 Too Many Requests')
console.log(classifyError(err, 'openai').type)  // → "rate_limit"
```

---

## Available providers

| Provider | `type` | Config |
|----------|--------|--------|
| OpenAI | `openai` | `apiKey` |
| Anthropic | `anthropic` | `apiKey` |
| Google Gemini | `gemini` | `apiKey` |
| Ollama | `ollama` | `baseUrl` (default http://localhost:11434) |
| Azure OpenAI | `azure` | `apiKey` + `baseUrl` |
| AWS Bedrock | `bedrock` | AWS credentials |
| Cohere | `cohere` | `apiKey` |
| Any OpenAI-compatible | `openai` + custom `baseUrl` | `apiKey` + `baseUrl` |

32 more providers available via OpenAI-compatible fallback — just set the `baseUrl`.

---

## Known Limitations (v1.0.0)

- **10 adapters implemented out of 42 presets.** The remaining 32 use OpenAI-compatible fallback. Contributions welcome.
- **No TypeScript types.** Planned.
- **API keys are stored in memory.** No OS keychain integration. Do not hardcode keys in source files.

---

## Related

- `fairy-guardian` — self-healing process cluster for AI model servers

---

**Author:** [openchat-ai](https://github.com/openchat-ai) — reach me via [GitHub Issues](https://github.com/openchat-ai/provider-kit/issues) or leave a star ⭐
