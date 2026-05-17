# provider-kit

**One API for 42 LLM providers.** OpenAI, Anthropic, Ollama, OpenRouter, Google Gemini, Azure, AWS Bedrock, Cohere �?same interface, built-in retry and timeout.

```bash
npm install provider-kit
```

## Quickstart �?first response in under 60 seconds

```js
import { createProvider } from 'provider-kit'

const client = await createProvider('openai', { apiKey: process.env.OPENAI_API_KEY })

const stream = client.chatStream('gpt-4o-mini', [
  { role: 'user', content: 'Say hello in one sentence' },
])

for await (const chunk of stream) {
  if (chunk.type === 'content') process.stdout.write(chunk.content)
}
```

Run it:

```bash
export OPENAI_API_KEY=sk-...
node quickstart.mjs
# �?Hello! I'm an AI assistant ready to help you.
```

## Install

```bash
npm install provider-kit
```

## Usage

## Usage

### Basic chat

```js
import { createProvider } from 'provider-kit'

const provider = await createProvider('openai', { apiKey: process.env.OPENAI_API_KEY })
const reply = await provider.chat('gpt-4o-mini', [
  { role: 'system', content: 'You are a poet' },
  { role: 'user', content: 'Write a haiku' },
])
console.log(reply.content)
```

### With retry and timeout

```js
import { safeProviderCall } from 'provider-kit'

const reply = await safeProviderCall(
  () => provider.chat('gpt-4', messages),
  { provider: 'openai', retries: 3, timeout: 30000 }
)
```

### Available providers

| Provider | `type` | Requires |
|----------|--------|----------|
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| Ollama | `ollama` | local server at `http://localhost:11434` |
| Azure OpenAI | `azure` | Azure credentials |
| AWS Bedrock | `bedrock` | AWS credentials |
| Cohere | `cohere` | `COHERE_API_KEY` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` |
| OpenAI-compatible | `openai` with custom `baseUrl` | Any OpenAI-compatible API |

### Streaming

```js
const stream = await provider.chatStream('gpt-4', messages)
for await (const chunk of stream) {
  if (chunk.type === 'content') process.stdout.write(chunk.content)
}
```

### Error handling

`createProvider`, `.chat()`, `.chatStream()` �?all throw `ProviderError` with consistent fields:

```js
import { ProviderError } from 'provider-kit'

try { /* ... */ } catch (e) {
  if (e instanceof ProviderError) {
    console.log(e.provider, e.statusCode, e.retryable, e.type)
    // e.g. 'openai', 429, true, 'rate_limit'
  }
}
```

### Function Calling

```js
const reply = await provider.chat('gpt-4', messages, {
  tools: [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } } }
    }
  }]
})
if (reply.toolCalls) {
  // [{ id, name, arguments: { city: 'Tokyo' } }]
}
```

## ProviderRegistry

Manage multiple providers with a registry:

```js
import { providerRegistry, createProvider } from 'provider-kit'

await providerRegistry.configure('openai', { apiKey: 'sk-...' })
await providerRegistry.configure('ollama', { baseUrl: 'http://localhost:11434' })

const provider = providerRegistry.get('openai')
const reply = await provider.chat('gpt-4', messages)
```

## Known Limitations (v0.1.0)

- **10 adapters implemented out of 42 presets.** The remaining 32 use OpenAI-compatible fallback. Contributions welcome.
- **No TypeScript types.** Planned for v0.2.0.
- **Not for production.** API keys are stored in memory. No OS keychain integration.

## Related

- `@openchat/fairy-guardian` �?self-healing process cluster for AI model servers
