import { ProviderError } from './provider-error-adapter.js';
import { epcFromResponse } from './epc-codec.js';
import { extractContent } from '../utils/normalize.js';
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
   *          + { role: 'assistant', tool_calls: [{id, function:{name, arguments}}] }
   *          + { role: 'tool', tool_call_id, content }
   * Anthropic: system: '...', messages: [{ role: 'user', content: '...' },
   *                                     { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
   *                                     { role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }]
   *
   * 关键转换:
   * - role: 'assistant', tool_calls → assistant message with tool_use content blocks
   * - role: 'tool', tool_call_id → user message with tool_result content block (Anthropic 要求 tool_result 必须在 user role)
   */
  convertMessages(messages) {
    const systemMessages = [];
    const anthropicMessages = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
      } else if (msg.role === 'user') {
        anthropicMessages.push({
          role: 'user',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        });
      } else if (msg.role === 'assistant') {
        // assistant 可能有 tool_calls (FC 流程) — 转 Anthropic tool_use blocks
        const blocks = [];
        if (msg.content && (typeof msg.content === 'string' ? msg.content.trim() : true)) {
          const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          if (text) blocks.push({ type: 'text', text });
        }
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
          for (const tc of msg.tool_calls) {
            const fn = tc.function || {};
            let input = {};
            try {
              input = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : (fn.arguments || {});
            } catch {
              input = { _parse_error: true, raw: String(fn.arguments) };
            }
            blocks.push({ type: 'tool_use', id: tc.id, name: fn.name, input });
          }
        }
        if (blocks.length === 0) {
          // 空 assistant message — Anthropic 不允许, 给个空文本占位
          blocks.push({ type: 'text', text: '' });
        }
        anthropicMessages.push({ role: 'assistant', content: blocks });
      } else if (msg.role === 'tool') {
        // OpenAI tool result → Anthropic 必须在 user message 里用 tool_result block
        // 合并连续 tool results 到同一个 user message
        const last = anthropicMessages[anthropicMessages.length - 1];
        const block = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        };
        if (last && last.role === 'user' && Array.isArray(last.content) && last.content.some(c => c.type === 'tool_result')) {
          last.content.push(block);
        } else {
          anthropicMessages.push({ role: 'user', content: [block] });
        }
      } else if (msg.role === 'function') {
        // legacy 'function' role (OpenAI 旧版) — 视为 tool result
        const last = anthropicMessages[anthropicMessages.length - 1];
        const block = {
          type: 'tool_result',
          tool_use_id: msg.name || 'unknown',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        };
        if (last && last.role === 'user' && Array.isArray(last.content) && last.content.some(c => c.type === 'tool_result')) {
          last.content.push(block);
        } else {
          anthropicMessages.push({ role: 'user', content: [block] });
        }
      }
      // 未知 role 跳过 (不抛错, 静默丢弃, 避免外部脏数据炸流程)
    }

    return {
      system: systemMessages.join('\n\n'),
      messages: anthropicMessages,
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
    const toolCalls = [];
    const rawBlocks = anthropicResponse.content || [];

    for (const block of rawBlocks) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'thinking') {
        if (block.thinking) thinkParts.push(block.thinking);
      } else if (block.type === 'redacted_thinking') {
        thinkParts.push('[redacted thinking]');
      } else if (block.type === 'tool_use') {
        // Convert Anthropic tool_use → OpenAI-style toolCalls
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
          },
        });
      }
    }

    const content = extractContent(textParts.join(''));
    const reasoningContent = thinkParts.join('\n');

    return {
      content,
      reasoningContent,
      toolCalls: toolCalls.length ? toolCalls : undefined,
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

    // Collect tool_use blocks during streaming for batched tool_calls yield
    const collectedToolCalls = new Map();

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

            if (json.type === 'content_block_start') {
              const block = json.content_block;
              if (block?.type === 'tool_use') {
                collectedToolCalls.set(json.index, { id: block.id, name: block.name, inputJson: '' });
              }
            } else if (json.type === 'content_block_delta') {
              const delta = json.delta;
              if (delta?.type === 'text_delta' && delta.text) {
                yield { type: 'content', content: delta.text, done: false };
              } else if (delta?.type === 'input_json_delta' && collectedToolCalls.has(json.index)) {
                collectedToolCalls.get(json.index).inputJson += delta.partial_json || '';
              }
            } else if (json.type === 'message_stop') {
              if (collectedToolCalls.size > 0) {
                const toolCalls = [];
                for (const tc of collectedToolCalls.values()) {
                  let args = tc.inputJson;
                  try { JSON.parse(args); } catch { args = '{}'; }
                  toolCalls.push({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: args },
                  });
                }
                yield { type: 'tool_calls', toolCalls };
              }
              yield { done: true };
              return;
            }
          } catch (e) {
            // ignore parse errors
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
