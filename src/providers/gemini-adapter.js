import { ProviderError } from './provider-error-adapter.js';
/**
 * Google Gemini API 适配器
 *
 * Google Gemini 使用独特的 API 格式：
 * - Endpoint: /v1beta/models/{model}:generateContent
 * - Header: x-goog-api-key 或 Authorization: Bearer
 * - 请求格式: { contents: [...], generationConfig: {...} }
 * - 响应格式: { candidates: [{ content: { parts: [...] } }] }
 *
 * 参考文档: https://ai.google.dev/api/rest
 */

import { epcFromResponse } from './epc-codec.js';

export class GeminiAdapter {
  constructor(config) {
    this.id = config.id || 'gemini';
    this.name = config.name || 'Gemini';
    this.nameCn = config.nameCn || 'Google Gemini';
    this.baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    this.apiKey = config.apiKey || null;
    this.defaultModel = config.defaultModel || 'gemini-2.0-flash-exp';
    this.models = config.models || [
      'gemini-2.0-flash-exp',
      'gemini-2.0-flash-thinking-exp-1219',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b'
    ];
    this.connected = false;
    this.description = config.description || 'Google Gemini 系列模型';
    this.timeout = config.timeout || 60000;
    this.headers = config.headers || {};
  }

  /**
   * 连接/验证
   */
  async connect(apiKey) {
    if (apiKey) this.apiKey = apiKey;

    if (!this.apiKey) {
      throw new ProviderError('API Key required for Google Gemini');
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
   * 转换消息格式: OpenAI -> Gemini
   */
  convertMessages(messages) {
    const systemInstructions = [];
    const contents = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstructions.push(msg.content);
      } else if (msg.role === 'user') {
        contents.push({
          role: 'user',
          parts: [{ text: msg.content }]
        });
      } else if (msg.role === 'assistant') {
        contents.push({
          role: 'model',
          parts: [{ text: msg.content }]
        });
      }
    }

    return {
      systemInstruction: systemInstructions.length > 0
        ? { parts: [{ text: systemInstructions.join('\n\n') }] }
        : undefined,
      contents
    };
  }

  /**
   * 转换响应格式: Gemini -> 统一格式
   *
   * Gemini API 返回的 parts 数组可能包含 thinking 和文本：
   * - { text: '...' }               → content 或 reasoningContent
   * - { text: '...', thought: true } → reasoningContent（当 includeThoughts 启用时）
   *
   * 参考: https://ai.google.dev/gemini-api/docs/thinking
   */
  convertResponse(geminiResponse) {
    const parts = geminiResponse.candidates?.[0]?.content?.parts || [];
    const textParts = [];
    const thinkParts = [];

    for (const p of parts) {
      if (!p.text) continue;
      if (p.thought) {
        thinkParts.push(p.text);
      } else {
        textParts.push(p.text);
      }
    }

    const content = textParts.join('');
    const reasoningContent = thinkParts.join('\n');

    return {
      content,
      epc: epcFromResponse({ content, reasoningContent }),
      raw: geminiResponse,
    };
  }

  /**
   * 发送聊天消息
   */
  async chat(model, messages, options = {}) {
    if (!this.connected) {
      throw new ProviderError('Gemini provider not connected');
    }

    const modelName = model || this.defaultModel;
    const url = `${this.baseUrl}/models/${modelName}:generateContent`;

    const { systemInstruction, contents } = this.convertMessages(messages);

    const body = {
      contents,
      generationConfig: {
        temperature: options.temperature,
        topP: options.top_p,
        topK: options.top_k,
        maxOutputTokens: options.max_tokens || 2048
      }
    };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    const headers = {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.apiKey,
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
        `Gemini API error: ${response.status} ${response.statusText}`
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
      throw new ProviderError('Gemini provider not connected');
    }

    const modelName = model || this.defaultModel;
    const url = `${this.baseUrl}/models/${modelName}:streamGenerateContent?alt=sse`;

    const { systemInstruction, contents } = this.convertMessages(messages);

    const body = {
      contents,
      generationConfig: {
        temperature: options.temperature,
        topP: options.top_p,
        topK: options.top_k,
        maxOutputTokens: options.max_tokens || 2048
      }
    };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    const headers = {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.apiKey,
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
        `Gemini API error: ${response.status} ${response.statusText}`
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
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;

            if (text) {
              yield { type: 'content', content: text, done: false };
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
      transport: 'gemini_generate_content'
    };
  }
}

export function createGeminiProvider(apiKey = null, overrides = {}) {
  return new GeminiAdapter({
    id: 'gemini',
    name: 'Gemini',
    nameCn: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey,
    ...overrides
  });
}

export default GeminiAdapter;
