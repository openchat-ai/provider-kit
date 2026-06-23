/**
 * @openchat/provider-kit v2.0
 *
 * 简化版 LLM provider SDK。OpenAI 兼容协议（覆盖 OpenAI / Anthropic / DeepSeek /
 * OpenRouter / MiniMax / Ollama / 任意 OpenAI-compatible 端点），EPC 帧编码用于
 * 流式 reasoning 传输。
 *
 * Quick start:
 *   import { createProvider } from 'provider-kit';
 *   const p = createProvider({ apiKey: 'sk-...', baseURL: 'https://api.openai.com/v1' });
 *   const reply = await p.chat('gpt-4o-mini', [{ role: 'user', content: 'Hi' }]);
 */

export {
  OpenAICompatibleProvider,
  createProvider,
  listPresetProviders,
  PRESET_PROVIDERS,
} from './providers/openai-compatible.js';

export {
  encodeEpcFrame,
  epcFromResponse,
  parseEpcPayload,
  scanNextFrame,
  verifyFrameCs,
  parseFrames,
  EPC_TYPE_LLM, EPC_TYPE_AGENT, EPC_TYPE_MEDIA, EPC_TYPE_IMAGE, EPC_TYPE_FS, EPC_TYPE_S3,
  EPC_TYPE_EXEC, EPC_TYPE_CHAT, EPC_TYPE_ROOM, EPC_TYPE_CALL, EPC_TYPE_SIGNAL, EPC_TYPE_SDUI,
  EPC_TYPE_SECURITY, EPC_TYPE_SYSTEM, EPC_TYPE_DEBUG, EPC_TYPE_FILE_XFER, EPC_TYPE_PLUGIN,
  EPC_TYPE_UI_INPUT, EPC_TYPE_NETWORK, EPC_TYPE_TRANSPORT, EPC_TYPE_DB,
  EPC_TYPE_BIZ_EXT, EPC_TYPE_EXPER, EPC_TYPE_RAW,
  EPC_SUB_CONTENT, EPC_SUB_THINKING, EPC_SUB_TOOL_CALL, EPC_SUB_TOOL_RESULT, EPC_SUB_ERROR,
  EPC_SUB_META, EPC_SUB_LMDN, EPC_SUB_OPUS, EPC_SUB_PCM, EPC_SUB_VAD,
} from './providers/epc-codec.js';

export {
  extractContent,
  extractReasoning,
  normalizeToolCalls,
  parseActionFallback,
} from './utils/normalize.js';
