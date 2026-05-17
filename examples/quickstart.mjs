/**
 * Quickstart — first LLM response in under 60 seconds
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-...
 *   node examples/quickstart.mjs
 *
 * Or with any provider:
 *   PROVIDER=ollama node examples/quickstart.mjs
 */

const provider = process.env.PROVIDER || 'openai';
const model = process.env.MODEL || (provider === 'openai' ? 'gpt-4o-mini' : 'llama3.2');

const { createProvider } = await import('provider-kit');

const client = await createProvider(provider, {
  apiKey: process.env[`${provider.toUpperCase()}_API_KEY`],
});

console.log(`\n  Calling ${provider} (${model})...\n`);

const stream = client.chatStream(model, [
  { role: 'user', content: 'Say hello in one sentence' },
]);

for await (const chunk of stream) {
  if (chunk.type === 'content') process.stdout.write(chunk.content);
}
console.log('\n');
