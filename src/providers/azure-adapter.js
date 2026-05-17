import { ProviderError } from './provider-error-adapter.js';
/**
 * Azure OpenAI API 适配器
 *
 * Azure OpenAI 与 OpenAI API 兼容，但有以下差异：
 * - Endpoint: /{deployment-id}/chat/completions?api-version={version}
 * - Header: api-key (不是 Authorization: Bearer)
 * - 需要指定 deployment ID 而不是 model
 *
 * 参考文档: https://learn.microsoft.com/en-us/azure/ai-services/openai/reference
 */

export class AzureOpenAIAdapter {
  constructor(config) {
    this.id = config.id || 'azure';
    this.name = config.name || 'Azure OpenAI';
    this.nameCn = config.nameCn || 'Azure OpenAI';
    this.resourceName = config.resourceName || null;  // your-resource-name
    this.deploymentId = config.deploymentId || null;   // your-deployment-id
    this.apiVersion = config.apiVersion || '2024-02-15-preview';
    this.baseUrl = config.baseUrl || `https://${this.resourceName}.openai.azure.com/openai/deployments`;
    this.apiKey = config.apiKey || null;
    this.defaultModel = config.defaultModel || this.deploymentId;
    this.models = config.models || [];
    this.connected = false;
    this.description = config.description || 'Azure 托管的 OpenAI 服务';
    this.timeout = config.timeout || 60000;
    this.headers = config.headers || {};
  }

  /**
   * 连接/验证
   */
  async connect(apiKey) {
    if (apiKey) this.apiKey = apiKey;

    if (!this.apiKey) {
      throw new ProviderError('API Key required for Azure OpenAI');
    }

    if (!this.resourceName) {
      throw new ProviderError('Resource name required for Azure OpenAI');
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
   * 构建 URL
   */
  buildUrl(deploymentId, endpoint = 'chat/completions') {
    return `${this.baseUrl}/${deploymentId}/${endpoint}?api-version=${this.apiVersion}`;
  }

  /**
   * 发送聊天消息
   */
  async chat(model, messages, options = {}) {
    if (!this.connected) {
      throw new ProviderError('Azure OpenAI provider not connected');
    }

    // Azure 使用 deployment ID 而不是 model
    const deploymentId = model || this.deploymentId || this.defaultModel;
    const url = this.buildUrl(deploymentId);

    const body = {
      messages,
      stream: options.stream || false,
      temperature: options.temperature,
      top_p: options.top_p,
      max_tokens: options.max_tokens,
      ...options.extra
    };

    // Function Calling
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      if (options.tool_choice) {
        body.tool_choice = options.tool_choice;
      }
    }

    const headers = {
      'Content-Type': 'application/json',
      'api-key': this.apiKey,
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
        `Azure OpenAI API error: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    const choice = data.choices?.[0];

    const result = {
      content: choice?.message?.content || '',
      model: data.model || deploymentId,
      usage: data.usage,
      raw: data
    };

    // Tool calls
    if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
      result.toolCalls = choice.message.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments
      }));
    }

    return result;
  }

  /**
   * 流式聊天
   */
  async *chatStream(model, messages, options = {}) {
    if (!this.connected) {
      throw new ProviderError('Azure OpenAI provider not connected');
    }

    const deploymentId = model || this.deploymentId || this.defaultModel;
    const url = this.buildUrl(deploymentId);

    const body = {
      messages,
      stream: true,
      temperature: options.temperature,
      top_p: options.top_p,
      max_tokens: options.max_tokens,
      ...options.extra
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      if (options.tool_choice) {
        body.tool_choice = options.tool_choice;
      }
    }

    const headers = {
      'Content-Type': 'application/json',
      'api-key': this.apiKey,
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
        `Azure OpenAI API error: ${response.status} ${response.statusText}`
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const toolCallChunks = new Map();

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
            if (toolCallChunks.size > 0) {
              const toolCalls = Array.from(toolCallChunks.values()).map(tc => ({
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments
              }));
              yield { type: 'tool_calls', toolCalls, done: false };
            }
            return;
          }

          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta;

            if (delta?.content) {
              yield { type: 'content', content: delta.content, done: false };
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index || 0;
                if (!toolCallChunks.has(idx)) {
                  toolCallChunks.set(idx, { id: '', name: '', arguments: '' });
                }
                const chunk = toolCallChunks.get(idx);
                if (tc.id) chunk.id = tc.id;
                if (tc.function?.name) chunk.name = tc.function.name;
                if (tc.function?.arguments) chunk.arguments += tc.function.arguments;
              }
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
   * 获取模型列表（Azure 中是 deployments）
   */
  async fetchModels() {
    // Azure 需要额外的 API 调用来列出 deployments
    // 这里返回配置的模型列表
    return this.models;
  }

  /**
   * 获取模型列表（本地）
   */
  getModels() {
    return this.models;
  }

  /**
   * Embedding API
   */
  async embeddings(input, model = 'text-embedding-ada-002') {
    if (!this.connected) {
      throw new ProviderError('Azure OpenAI provider not connected');
    }

    const deploymentId = model;
    const url = this.buildUrl(deploymentId, 'embeddings');

    const body = {
      input: Array.isArray(input) ? input : [input]
    };

    const headers = {
      'Content-Type': 'application/json',
      'api-key': this.apiKey,
      ...this.headers
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new ProviderError(error.error?.message || `Embedding API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data.map(d => d.embedding);
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
      resourceName: this.resourceName,
      deploymentId: this.deploymentId,
      connected: this.connected,
      modelCount: this.models.length,
      defaultModel: this.defaultModel,
      hasApiKey: !!this.apiKey,
      transport: 'azure_openai'
    };
  }
}

export function createAzureOpenAIProvider(config) {
  return new AzureOpenAIAdapter({
    id: 'azure',
    name: 'Azure OpenAI',
    nameCn: 'Azure OpenAI',
    ...config
  });
}

export default AzureOpenAIAdapter;
