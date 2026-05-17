/**
 * Basic example: chat with any provider using @openchat/provider-kit
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-...
 *   node examples/basic-chat.mjs openai "Hello"
 */

import { ProviderManager } from '../src/index.js';

async function main() {
  const providerType = process.argv[2] || 'openai';
  const message = process.argv[3] || 'Say hello in one sentence';

  const manager = new ProviderManager();
  await manager.initialize();

  const provider = manager.getProvider(providerType);
  if (!provider) {
    console.error(`Provider '${providerType}' not found. Available: ${manager.listProviders().join(', ')}`);
    process.exit(1);
  }

  const model = process.env.MODEL || (providerType === 'openai' ? 'gpt-4o-mini' : 'claude-3-haiku');

  console.log(`Calling ${providerType} (${model})...`);
  console.log(`Message: ${message}\n`);

  const response = await provider.chat(model, [
    { role: 'user', content: message },
  ]);

  console.log(`Response:\n${response.content}`);
}

main().catch(console.error);
