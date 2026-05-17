import { ProviderError } from './provider-error-adapter.js';
/**
 * Cohere API 适配器
 *
 * Cohere 使用自己的 API 格式：
 * - Endpoint: /v1/chat
 * - Header: Authorization: Bearer
 * - 请求格式: { message, chat_history, model, ... }
 * - 响应格式: { text, generation_id, ... }
 *
 * 参考文档: https://docs.cohere.com/reference/chat
 */

export class CohereAdapter {
  constructor(config) {
    this.id = config.id || 'cohere';
    this.name = config.name || 'Cohere';
    this.nameCn = config.nameCn || 'Cohere';
    this.baseUrl = config.baseUrl || 'https://api.cohere.ai/v1';
    this.apiKey = config.apiKey || null;
    this.defaultModel = config.defaultModel || 'command-r-plus';
    this.models = config.models || [
      'command-r-plus',
      'command-r',
      'command',
      'command-light',
      'command-nightly',
      'command-light-nightly'
    ];
    this.connected = false;
    this.description = config.description || 'Cohere 企业级 AI 模型';
    this.timeout = config.timeout || 60000;
    this.headers = config.headers || {};
  }

  /**
   * 连接/验证
   */
  async connect(apiKey) {
    if (apiKey) this.apiKey = apiKey;

    if (!this.apiKey) {
      throw new ProviderError('API Key required for Cohere');
    }

    this.connected = true;
    return true;
  }

  /**
   * 断开连接
   */
  disconnect() {
    this.connected = false;
  }

  /**
   * 转换消息格式: OpenAI -> Cohere
   */
  convertMessages(messages) {
    const preamble = [];
    const chatHistory = [];
    let lastMessage = '';

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === 'system') {
        preamble.push(msg.content);
      } else if (msg.role === 'user') {
        // 如果是最后一条消息，作为 message 参数
        if (i === messages.length - 1) {
          lastMessage = msg.content;
        } else {
          chatHistory.push({
            role: 'USER',
            message: msg.content
          });
        }
      } else if (msg.role === 'assistant') {
        chatHistory.push({
          role: 'CHATBOT',
          message: msg.content
        });
      }
    }

    return {
      preamble: preamble.join('\n\n') || undefined,
      chat_history: chatHistory.length > 0 ? chatHistory : undefined,
      message: lastMessage
    };
  }

  /**
   * 转换响应格式: Cohere -> OpenAI
   */
  convertResponse(cohereResponse) {
    return {
      content: cohereResponse.text || '',
      model: cohereResponse.model || this.defaultModel,
      usage: {
        prompt_tokens: cohereResponse.meta?.billed_units?.input_tokens || 0,
        completion_tokens: cohereResponse.meta?.billed_units?.output_tokens || 0,
        total_tokens: (cohereResponse.meta?.billed_units?.input_tokens || 0) +
                     (cohereResponse.meta?.billed_units?.output_tokens || 0)
      },
      raw: cohereResponse
    };
  }

  /**
   * 发送聊天消息
   */
  async chat(model, messages, options = {}) {
    if (!this.connected) {
      throw new ProviderError('Cohere provider not connected');
    }

    const url = `${this.baseUrl}/chat`;

    const { preamble, chat_history, message } = this.convertMessages(messages);

    const body = {
      model: model || this.defaultModel,
      message,
      chat_history,
      preamble,
      temperature: options.temperature,
      max_tokens: options.max_tokens,
      p: options.top_p,
      k: options.top_k,
      stream: false
    };

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
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
        error.message ||
        `Cohere API error: ${response.status} ${response.statusText}`
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
      throw new ProviderError('Cohere provider not connected');
    }

    const url = `${this.baseUrl}/chat`;

    const { preamble, chat_history, message } = this.convertMessages(messages);

    const body = {
      model: model || this.defaultModel,
      message,
      chat_history,
      preamble,
      temperature: options.temperature,
      max_tokens: options.max_tokens,
      p: options.top_p,
      k: options.top_k,
      stream: true
    };

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
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
        error.message ||
        `Cohere API error: ${response.status} ${response.statusText}`
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
        if (line.trim()) {
          try {
            const json = JSON.parse(line);

            if (json.event_type === 'text-generation') {
              yield { type: 'content', content: json.text, done: false };
            } else if (json.event_type === 'stream-end') {
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
   * Embedding API
   */
  async embeddings(texts, model = 'embed-english-v3.0') {
    if (!this.connected) {
      throw new ProviderError('Cohere provider not connected');
    }

    const url = `${this.baseUrl}/embed`;

    const body = {
      model,
      texts: Array.isArray(texts) ? texts : [texts],
      input_type: 'search_document'
    };

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      ...this.headers
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new ProviderError(error.message || `Embedding API error: ${response.status}`);
    }

    const data = await response.json();
    return data.embeddings;
  }

  /**
   * 获取模型列表
   */
  async fetchModels() {
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
      transport: 'cohere_chat'
    };
  }
}

export function createCohereProvider(apiKey = null, overrides = {}) {
  return new CohereAdapter({
    id: 'cohere',
    name: 'Cohere',
    nameCn: 'Cohere',
    baseUrl: 'https://api.cohere.ai/v1',
    apiKey,
    ...overrides
  });
}

export default CohereAdapter;
