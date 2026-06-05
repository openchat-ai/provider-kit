import { ProviderError } from './provider-error-adapter.js';
import { epcFromResponse } from './epc-codec.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Anthropic Claude API 适配器
 *
 * Anthropic 使用独特的 Messages API 格式，与 OpenAI 不同：
 * - Endpoint: /v1/messages (不是 /chat/completions)
 * - Header: x-api-key (不是 Authorization: Bearer)
 * - 请求格式: { model, messages, max_tokens, ... }
 * - 响应格式: { id, content: [{ type: 'text', text: '...' }], ... }
 *
 * 参考文档: https://docs.anthropic.com/claude/reference/messages_post
 */

// 加载用户配置
function loadModelConfig() {
  try {
    const configPath = path.join(__dirname, '../config/model-selection.json');
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(data);
      return config.modelSelection?.anthropic || {};
    }
  } catch (e) {
    console.warn('[AnthropicAdapter] Failed to load model config:', e.message);
  }
  return {};
}

const modelConfig = loadModelConfig();

export class AnthropicAdapter {
  constructor(config) {
    this.id = config.id || 'anthropic';
    this.name = config.name || 'Claude';
    this.nameCn = config.nameCn || 'Anthropic Claude';
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
    this.apiKey = config.apiKey || null;

    // 完全从配置读取模型，配置有什么就用什么
    this.defaultModel = config.defaultModel || modelConfig.defaultModel || null;

    // 可用模型列表完全来自配置
    this.models = config.models || modelConfig.availableModels || [];
    this.connected = false;
    this.description = config.description || 'Anthropic Claude 系列模型';

    // Anthropic 特定配置
    this.anthropicVersion = config.anthropicVersion || '2023-06-01';
    this.timeout = config.timeout || 60000;
    this.headers = config.headers || {};
  }

  /**
   * 连接/验证 API Key
   */
  async connect(apiKey) {
    if (apiKey) this.apiKey = apiKey;

    if (!this.apiKey) {
      throw new ProviderError('API Key required for Anthropic Claude');
    }

    // Anthropic 没有 /models 端点，直接测试连接
    try {
      // 发送一个简单的测试请求
      await this.chat(this.defaultModel, [
        { role: 'user', content: 'Hi' }
      ], { max_tokens: 10 });

      this.connected = true;
      return true;
    } catch (e) {
      // 如果有 API Key，假定连接成功
      if (this.apiKey) {
        this.connected = true;
        return true;
      }
      throw e;
    }
  }

  /**
   * 断开连接
   */
  disconnect() {
    this.connected = false;
  }

  /**
   * 转换消息格式: OpenAI -> Anthropic
   *
   * OpenAI:  [{ role: 'system', content: '...' }, { role: 'user', content: '...' }]
   * Anthropic: system: '...', messages: [{ role: 'user', content: '...' }]
   */
  convertMessages(messages) {
    const systemMessages = [];
    const anthropicMessages = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg.content);
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        anthropicMessages.push({
          role: msg.role,
          content: typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content)
        });
      }
    }

    return {
      system: systemMessages.join('\n\n'),
      messages: anthropicMessages
    };
  }

  /**
   * 转换响应格式: Anthropic -> 统一格式
   *
   * Anthropic Messages API 的 content 是 blocks 数组，包含多种类型：
   * - { type: 'text', text: '...' }               → content
   * - { type: 'thinking', thinking: '...', signature: '...' } → reasoningContent
   * - { type: 'redacted_thinking', data: '...', signature: '...' } → reasoningContent（加密）
   * - { type: 'tool_use', ... }                   → toolCalls
   *
   * 参考: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
   */
  convertResponse(anthropicResponse) {
    const textParts = [];
    const thinkParts = [];
    const rawBlocks = anthropicResponse.content || [];

    for (const block of rawBlocks) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'thinking') {
        if (block.thinking) thinkParts.push(block.thinking);
      } else if (block.type === 'redacted_thinking') {
        thinkParts.push('[redacted thinking]');
      }
    }

    const content = textParts.join('');
    const reasoningContent = thinkParts.join('\n');

    return {
      content,
      epc: epcFromResponse({ content, reasoningContent }),
      raw: anthropicResponse,
    };
  }

  /**
   * 发送聊天消息
   */
  async chat(model, messages, options = {}) {
    if (!this.connected) {
      throw new ProviderError('Anthropic provider not connected');
    }

    const url = `${this.baseUrl}/v1/messages`;

    const { system, messages: anthropicMessages } = this.convertMessages(messages);

    const body = {
      model: model || this.defaultModel,
      messages: anthropicMessages,
      max_tokens: options.max_tokens || options.maxTokens || 4096,
      stream: options.stream || false
    };

    // 添加 system 消息
    if (system) {
      body.system = system;
    }

    // 可选参数
    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options.top_p !== undefined) {
      body.top_p = options.top_p;
    }
    if (options.top_k !== undefined) {
      body.top_k = options.top_k;
    }

    // Tool Use (Function Calling)
    if (options.tools && options.tools.length > 0) {
      body.tools = this.convertTools(options.tools);
    }

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.anthropicVersion,
      ...this.headers
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: this.timeout ? AbortSignal.timeout(this.timeout) : undefined
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new ProviderError(
        error.error?.message ||
        `Anthropic API error: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    return this.convertResponse(data);
  }

  /**
   * 流式聊天
   */
  async *chatStream(model, messages, options = {}) {
    if (!this.connected) {
      throw new ProviderError('Anthropic provider not connected');
    }

    const url = `${this.baseUrl}/v1/messages`;

    const { system, messages: anthropicMessages } = this.convertMessages(messages);

    const body = {
      model: model || this.defaultModel,
      messages: anthropicMessages,
      max_tokens: options.max_tokens || options.maxTokens || 4096,
      stream: true
    };

    if (system) {
      body.system = system;
    }

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options.top_p !== undefined) {
      body.top_p = options.top_p;
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = this.convertTools(options.tools);
    }

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.anthropicVersion,
      ...this.headers
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: this.timeout ? AbortSignal.timeout(this.timeout) : undefined
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new ProviderError(
        error.error?.message ||
        `Anthropic API error: ${response.status} ${response.statusText}`
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);

          try {
            const json = JSON.parse(data);

            // 处理不同的事件类型
            if (json.type === 'content_block_delta') {
              const delta = json.delta;
              if (delta?.type === 'text_delta' && delta.text) {
                yield { type: 'content', content: delta.text, done: false };
              }
            } else if (json.type === 'message_stop') {
              yield { done: true };
              return;
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }

    yield { done: true };
  }

  /**
   * 转换工具格式: OpenAI tools -> Anthropic tools
   */
  convertTools(openaiTools) {
    return openaiTools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description || '',
      input_schema: tool.function.parameters || {
        type: 'object',
        properties: {}
      }
    }));
  }

  /**
   * 获取模型列表
   */
  async fetchModels() {
    // Anthropic 没有 /models 端点，返回硬编码列表
    return this.models;
  }

  /**
   * 获取模型列表（本地）
   */
  getModels() {
    return this.models;
  }

  /**
   * 获取状态
   */
  getStatus() {
    return {
      id: this.id,
      name: this.name,
      nameCn: this.nameCn,
      baseUrl: this.baseUrl,
      connected: this.connected,
      modelCount: this.models.length,
      defaultModel: this.defaultModel,
      hasApiKey: !!this.apiKey,
      transport: 'anthropic_messages'
    };
  }
}

/**
 * 创建 Anthropic Provider
 */
export function createAnthropicProvider(apiKey = null, overrides = {}) {
  return new AnthropicAdapter({
    id: 'anthropic',
    name: 'Claude',
    nameCn: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com',
    apiKey,
    ...overrides
  });
}

export default AnthropicAdapter;
