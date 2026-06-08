import { ProviderError } from './provider-error-adapter.js';
import { epcFromResponse } from './epc-codec.js';
import { extractContent } from '../utils/normalize.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 加载用户配置
function loadModelConfig() {
  try {
    const configPath = path.join(__dirname, '../config/model-selection.json');
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(data);
      return config.modelSelection?.bedrock || {};
    }
  } catch (e) {
    console.warn('[BedrockAdapter] Failed to load model config:', e.message);
  }
  return {};
}

const modelConfig = loadModelConfig();

/**
 * AWS Bedrock API 适配器
 *
 * AWS Bedrock 使用 AWS Signature V4 认证：
 * - Endpoint: /model/{model-id}/invoke
 * - Header: AWS Signature V4
 * - 支持多种模型格式（Claude, Llama, Titan 等）
 *
 * 注意：此适配器需要 AWS SDK 或手动实现 SigV4 签名
 * 参考文档: https://docs.aws.amazon.com/bedrock/latest/APIReference
 */

export class BedrockAdapter {
  constructor(config) {
    this.id = config.id || 'bedrock';
    this.name = config.name || 'Bedrock';
    this.nameCn = config.nameCn || 'AWS Bedrock';
    this.region = config.region || 'us-east-1';
    this.baseUrl = config.baseUrl || `https://bedrock-runtime.${this.region}.amazonaws.com`;
    this.accessKeyId = config.accessKeyId || null;
    this.secretAccessKey = config.secretAccessKey || null;

    // 完全从配置读取模型
    this.defaultModel = config.defaultModel || modelConfig.defaultModel || null;

    // 可用模型列表完全来自配置
    this.models = config.models || modelConfig.availableModels || [];
    this.connected = false;
    this.description = config.description || 'AWS Bedrock 多模型服务';
    this.timeout = config.timeout || 60000;
  }

  /**
   * 连接/验证
   */
  async connect(credentials) {
    if (credentials) {
      this.accessKeyId = credentials.accessKeyId;
      this.secretAccessKey = credentials.secretAccessKey;
    }

    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new ProviderError('AWS credentials required for Bedrock');
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
   * 转换消息格式: OpenAI -> Bedrock (根据模型类型)
   */
  convertMessages(messages, modelId) {
    // Claude 模型使用 Anthropic 格式
    if (modelId.startsWith('anthropic.')) {
      return this.convertToAnthropicFormat(messages);
    }
    // Llama 模型使用标准格式
    else if (modelId.startsWith('meta.llama')) {
      return this.convertToLlamaFormat(messages);
    }
    // Titan 模型使用 Amazon 格式
    else if (modelId.startsWith('amazon.titan')) {
      return this.convertToTitanFormat(messages);
    }
    // 默认使用通用格式
    else {
      return { prompt: messages.map(m => `${m.role}: ${m.content}`).join('\n') };
    }
  }

  /**
   * 转换为 Anthropic 格式（Bedrock 上的 Claude）
   */
  convertToAnthropicFormat(messages) {
    const systemMessages = [];
    const anthropicMessages = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg.content);
      } else {
        anthropicMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content
        });
      }
    }

    return {
      system: systemMessages.join('\n\n'),
      messages: anthropicMessages,
      anthropic_version: 'bedrock-2023-05-31'
    };
  }

  /**
   * 转换为 Llama 格式
   */
  convertToLlamaFormat(messages) {
    return {
      prompt: messages.map(m => {
        if (m.role === 'system') return `<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n${m.content}<|eot_id|>`;
        if (m.role === 'user') return `<|start_header_id|>user<|end_header_id|>\n\n${m.content}<|eot_id|>`;
        if (m.role === 'assistant') return `<|start_header_id|>assistant<|end_header_id|>\n\n${m.content}<|eot_id|>`;
        return '';
      }).join('') + '<|start_header_id|>assistant<|end_header_id|>\n\n'
    };
  }

  /**
   * 转换为 Titan 格式
   */
  convertToTitanFormat(messages) {
    const prompt = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    return {
      inputText: prompt,
      textGenerationConfig: {
        maxTokenCount: 4096,
        temperature: 0.7,
        topP: 0.9
      }
    };
  }

  /**
   * 简化版：使用 API Key 方式（需要通过 IAM 生成临时凭证或使用代理）
   * 完整实现需要 AWS SDK 的 SigV4 签名
   */
  async chat(model, messages, options = {}) {
    if (!this.connected) {
      throw new ProviderError('Bedrock provider not connected');
    }

    // 注意：实际使用需要实现 AWS Signature V4
    console.warn('⚠️  Bedrock adapter requires AWS Signature V4. Consider using AWS SDK.');

    const modelId = model || this.defaultModel;
    const url = `${this.baseUrl}/model/${modelId}/invoke`;

    const body = {
      ...this.convertMessages(messages, modelId),
      max_tokens: options.max_tokens || 4096,
      temperature: options.temperature || 0.7
    };

    // 这里需要实现 AWS SigV4 签名
    // 建议使用 AWS SDK 或第三方库
    throw new ProviderError('Bedrock requires AWS SDK for signing. Please use AWS SDK integration.');
  }

  /**
   * 流式聊天
   */
  async *chatStream(model, messages, options = {}) {
    throw new ProviderError('Bedrock streaming requires AWS SDK. Please use AWS SDK integration.');
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
      region: this.region,
      connected: this.connected,
      modelCount: this.models.length,
      defaultModel: this.defaultModel,
      hasApiKey: !!(this.accessKeyId && this.secretAccessKey),
      transport: 'bedrock_invoke',
      note: 'Requires AWS SDK for production use'
    };
  }
}

/**
 * Bedrock 代理适配器（通过代理服务使用）
 *
 * 如果你有一个代理服务将 Bedrock 转换为 OpenAI 格式，
 * 可以使用 OpenAICompatibleProvider
 */
export class BedrockProxyAdapter {
  constructor(config) {
    this.id = config.id || 'bedrock-proxy';
    this.name = config.name || 'Bedrock Proxy';
    this.nameCn = config.nameCn || 'AWS Bedrock 代理';
    this.baseUrl = config.baseUrl || 'http://localhost:8000/v1';
    this.apiKey = config.apiKey || null;
    this.defaultModel = config.defaultModel || 'anthropic.claude-3-5-sonnet-20241022-v2:0';
    this.models = config.models || [];
    this.connected = false;
    this.skipAuth = config.skipAuth || false;
  }

  async connect(apiKey) {
    if (apiKey) this.apiKey = apiKey;
    this.connected = true;
    return true;
  }

  disconnect() {
    this.connected = false;
  }

  async chat(model, messages, options = {}) {
    const url = `${this.baseUrl}/chat/completions`;

    const headers = {
      'Content-Type': 'application/json'
    };

    if (this.apiKey && !this.skipAuth) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || this.defaultModel,
        messages,
        ...options
      })
    });

    if (!response.ok) {
      throw new ProviderError(`Bedrock Proxy error: ${response.status}`);
    }

    const data = await response.json();
    const msg = data.choices?.[0]?.message || {};
    const rawContent = msg.content || '';
    const reasoningContent = msg.reasoning_content || '';
    const content = extractContent(rawContent);

    const contentBlocks = [];
    if (reasoningContent) contentBlocks.push({ type: 'thinking', thinking: reasoningContent });
    contentBlocks.push({ type: 'text', text: content });

    const toolCalls = (msg.tool_calls || []).map(tc => ({
      id: tc.id, name: tc.function.name, arguments: tc.function.arguments,
    }));

    return {
      content,
      epc: epcFromResponse({ content, reasoningContent, toolCalls }),
      raw: data,
    };
  }

  async *chatStream(model, messages, options = {}) {
    const url = `${this.baseUrl}/chat/completions`;

    const headers = {
      'Content-Type': 'application/json'
    };

    if (this.apiKey && !this.skipAuth) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || this.defaultModel,
        messages,
        stream: true,
        ...options
      })
    });

    if (!response.ok) {
      throw new ProviderError(`Bedrock Proxy error: ${response.status}`);
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
          if (data === '[DONE]') {
            yield { done: true };
            return;
          }

          try {
            const json = JSON.parse(data);
            const content = json.choices?.[0]?.delta?.content;
            if (content) {
              yield { type: 'content', content, done: false };
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }

    yield { done: true };
  }

  getModels() {
    return this.models;
  }

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
      transport: 'bedrock_proxy'
    };
  }
}

export function createBedrockProvider(credentials = null, overrides = {}) {
  return new BedrockAdapter({
    id: 'bedrock',
    name: 'Bedrock',
    nameCn: 'AWS Bedrock',
    ...credentials,
    ...overrides
  });
}

export function createBedrockProxyProvider(apiKey = null, overrides = {}) {
  return new BedrockProxyAdapter({
    id: 'bedrock-proxy',
    name: 'Bedrock Proxy',
    nameCn: 'AWS Bedrock 代理',
    apiKey,
    ...overrides
  });
}

export default BedrockAdapter;
