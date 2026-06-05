/**
 * OpenAI Compatible Provider
 *
 * 统一适配器 - 支持 90% 的 AI 服务商
 *
 * 兼容的服务商：
 * - OpenAI, DeepSeek, 智谱GLM, 通义千问, SiliconFlow
 * - OpenRouter, Groq, xAI, Moonshot, Ollama, LM Studio
 * - 以及所有支持 OpenAI API 格式的服务商
 *
 * 使用方式：
 * const provider = new OpenAICompatibleProvider({
 *   id: 'deepseek',
 *   name: 'DeepSeek',
 *   baseUrl: 'https://api.deepseek.com/v1',
 *   apiKey: 'sk-xxx'
 * });
 */

import { epcFromResponse } from './epc-codec.js';

export class OpenAICompatibleProvider {
  constructor(config) {
    this.id = config.id || 'openai-compatible';
    this.name = config.name || config.id || 'Unknown';
    this.nameCn = config.nameCn || this.name;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.apiKey = config.apiKey || null;
    this.defaultModel = config.defaultModel || null;
    this.models = config.models || [];
    this.connected = false;
    this.description = config.description || '';

    // 可选配置
    this.timeout = config.timeout || 60000;
    this.headers = config.headers || {};
    this.skipAuth = config.skipAuth || false;  // Ollama 等本地服务不需要 auth
  }

  /**
   * 连接/验证
   */
  async connect(apiKey) {
    if (apiKey) this.apiKey = apiKey;

    if (!this.skipAuth && !this.apiKey) {
      throw new Error(`API Key required for ${this.name}`);
    }

    // 尝试获取模型列表来验证连接
    try {
      await this.fetchModels();
      this.connected = true;
      return true;
    } catch (e) {
      // 如果获取模型失败，但 API Key 存在，也认为连接成功
      if (this.apiKey || this.skipAuth) {
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
   * 发送聊天消息
   */
  async chat(model, messages, options = {}) {
    if (!this.connected && !this.skipAuth) {
      throw new Error(`Provider ${this.name} not connected`);
    }

    const url = `${this.baseUrl}/chat/completions`;

    const body = {
      model: model || this.defaultModel,
      messages,
      stream: options.stream || false,
      ...options.extra
    };

    // 支持 Function Calling
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      if (options.tool_choice) {
        body.tool_choice = options.tool_choice;
      }
    }

    const headers = {
      'Content-Type': 'application/json',
      ...this.getAuthHeader(),
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
      throw new Error(error.error?.message || `${this.name} API error: ${response.status}`);
    }

    const data = await response.json();
    const msg = data.choices?.[0]?.message || {};
    const rawContent = msg.content || '';
    const reasoningContent = msg.reasoning_content || '';
    const content = rawContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    const contentBlocks = [];
    if (reasoningContent) contentBlocks.push({ type: 'thinking', thinking: reasoningContent });
    contentBlocks.push({ type: 'text', text: content });

    let toolCalls = (msg.tool_calls || []).map(tc => ({
      id: tc.id, name: tc.function.name, arguments: tc.function.arguments,
    }));

    // Text fallback: parse ACTION: pattern for models without FC support
    if (toolCalls.length === 0 && rawContent.includes('ACTION:')) {
      const match = rawContent.match(/ACTION:\s*(\w+)\s*({[\s\S]*?})/);
      if (match) {
        const [, name, argsStr] = match;
        try {
          JSON.parse(argsStr);
          toolCalls = [{ id: `textfb_${Date.now()}`, name, arguments: argsStr }];
        } catch {}
      }
    }

    return {
      content,
      toolCalls,
      epc: epcFromResponse({ content, reasoningContent, toolCalls }),
      raw: data,
    };
  }

  /**
   * 流式聊天
   */
  async *chatStream(model, messages, options = {}) {
    if (!this.connected && !this.skipAuth) {
      throw new Error(`Provider ${this.name} not connected`);
    }

    const url = `${this.baseUrl}/chat/completions`;

    const body = {
      model: model || this.defaultModel,
      messages,
      stream: true,
      ...options.extra
    };

    // 支持 Function Calling (部分模型支持流式 FC)
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      if (options.tool_choice) {
        body.tool_choice = options.tool_choice;
      }
    }

    const headers = {
      'Content-Type': 'application/json',
      ...this.getAuthHeader(),
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
      throw new Error(error.error?.message || `${this.name} API error: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let inThink = false;
    let pendingContent = ''; // content buffer

    // 累积 FC tool_calls
    const toolCallChunks = new Map();

    // 非 FC 模型的文本缓冲：当期待 FC 但模型不支援时，先缓冲内容
    const expectTools = !!(options.tools && options.tools.length > 0);
    const textBuffer = expectTools ? [] : null; // buffer text chunks, flush at end if no text-fallback match

    function* parseThink(text) {
      const parts = text.split(/(<think>|<\/think>)/);
      for (const p of parts) {
        if (p === '<think>') {
          if (textBuffer) {
            textBuffer.push(pendingContent); pendingContent = '';
          } else {
            if (pendingContent) { yield { type: 'content', content: pendingContent, done: false }; pendingContent = ''; }
          }
          inThink = true;
        } else if (p === '</think>') {
          inThink = false;
        } else if (p) {
          if (inThink) {
            yield { type: 'thinking', content: p, done: false };
          } else {
            pendingContent += p;
          }
        }
      }
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            // Flush pending content into textBuffer if buffering
            if (textBuffer && pendingContent) {
              textBuffer.push(pendingContent); pendingContent = '';
            }

            // Text fallback: if expecting FC but got no tool_calls, check for ACTION:
            const fullContent = textBuffer ? textBuffer.join('') : pendingContent;
            if (expectTools && toolCallChunks.size === 0 && fullContent.includes('ACTION:')) {
              const match = fullContent.match(/ACTION:\s*(\w+)\s*({[\s\S]*?})/);
              if (match) {
                const [, name, argsStr] = match;
                try {
                  JSON.parse(argsStr);
                  pendingContent = '';
                  if (textBuffer) textBuffer.length = 0;
                  yield { type: 'tool_calls', toolCalls: [{ id: `textfb_${Date.now()}`, name, arguments: argsStr }], done: false };
                  return;
                } catch {}
              }
            }

            // Flush buffered content
            if (textBuffer) {
              const flushed = textBuffer.join('');
              textBuffer.length = 0;
              if (flushed) { yield { type: 'content', content: flushed, done: false }; }
            }
            if (pendingContent) { yield { type: 'content', content: pendingContent, done: false }; pendingContent = ''; }

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
              if (textBuffer) {
                // Buffer content without yielding
                const parts = delta.content.split(/(<think>|<\/think>)/);
                for (const p of parts) {
                  if (p === '<think>') {
                    if (pendingContent) { textBuffer.push(pendingContent); pendingContent = ''; }
                    inThink = true;
                  } else if (p === '</think>') {
                    inThink = false;
                  } else if (p) {
                    if (inThink) {
                      yield { type: 'thinking', content: p, done: false };
                    } else {
                      pendingContent += p;
                    }
                  }
                }
              } else {
                yield* parseThink(delta.content);
              }
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

    if (pendingContent) { yield { type: 'content', content: pendingContent, done: false }; }
  }

  /**
   * 获取模型列表
   */
  async fetchModels() {
    const url = `${this.baseUrl}/models`;

    const headers = {
      'Content-Type': 'application/json',
      ...this.getAuthHeader(),
      ...this.headers
    };

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }

    const data = await response.json();

    // 解析模型列表
    this.models = (data.data || data.models || [])
      .map(m => typeof m === 'string' ? m : (m.id || m.name))
      .filter(Boolean)
      .sort();

    return this.models;
  }

  /**
   * 获取模型列表（本地缓存）
   */
  getModels() {
    return this.models;
  }

  /**
   * 获取认证头
   */
  getAuthHeader() {
    if (this.skipAuth || !this.apiKey) {
      return {};
    }
    return { 'Authorization': `Bearer ${this.apiKey}` };
  }

  /**
   * Embedding API
   */
  async embeddings(input, model = 'text-embedding-3-small') {
    if (!this.connected && !this.skipAuth) {
      throw new Error(`Provider ${this.name} not connected`);
    }

    const url = `${this.baseUrl}/embeddings`;

    const body = {
      model,
      input: Array.isArray(input) ? input : [input]
    };

    const headers = {
      'Content-Type': 'application/json',
      ...this.getAuthHeader(),
      ...this.headers
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || `Embedding API error: ${response.status}`);
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
      connected: this.connected,
      modelCount: this.models.length,
      defaultModel: this.defaultModel,
      hasApiKey: !!this.apiKey
    };
  }
}

/**
 * 预设 Provider 配置
 * 只需要 baseUrl，其他用默认值
 */
export const PRESET_PROVIDERS = {
  // ═══════════════════════════════════════════════════════════
  // 国际主流服务商
  // ═══════════════════════════════════════════════════════════
  openai: {
    name: 'OpenAI',
    nameCn: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    description: 'GPT-4, GPT-3.5, DALL-E, Whisper'
  },
  anthropic: {
    name: 'Claude',
    nameCn: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    description: 'Claude 3.5/4 系列',
    special: true
  },
  google: {
    name: 'Gemini',
    nameCn: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.0-flash',
    description: 'Gemini 2.0/1.5 Pro/Flash'
  },
  deepseek: {
    name: 'DeepSeek',
    nameCn: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    description: 'DeepSeek-V3, DeepSeek-Reasoner'
  },
  openrouter: {
    name: 'OpenRouter',
    nameCn: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    description: '200+ 模型聚合平台'
  },
  groq: {
    name: 'Groq',
    nameCn: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    description: '极速推理，LPU芯片'
  },
  xai: {
    name: 'xAI',
    nameCn: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-2-latest',
    description: 'Elon Musk 的 AI 公司'
  },
  mistral: {
    name: 'Mistral',
    nameCn: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    description: '欧洲开源模型领导者'
  },
  cohere: {
    name: 'Cohere',
    nameCn: 'Cohere',
    baseUrl: 'https://api.cohere.ai/v1',
    defaultModel: 'command-r-plus',
    description: '企业级 AI，擅长 RAG'
  },
  replicate: {
    name: 'Replicate',
    nameCn: 'Replicate',
    baseUrl: 'https://api.replicate.com/v1',
    defaultModel: 'meta/llama-2-70b-chat',
    description: '云端运行开源模型'
  },
  together: {
    name: 'Together',
    nameCn: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3-70b-chat-hf',
    description: '开源模型云服务'
  },
  perplexity: {
    name: 'Perplexity',
    nameCn: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai',
    defaultModel: 'llama-3.1-sonar-small-128k-online',
    description: 'AI 搜索引擎'
  },
  fireworks: {
    name: 'Fireworks',
    nameCn: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/llama-v3-70b',
    description: '高速推理平台'
  },
  anyscale: {
    name: 'Anyscale',
    nameCn: 'Anyscale',
    baseUrl: 'https://api.endpoints.anyscale.com/v1',
    defaultModel: 'meta-llama/Llama-2-70b-chat-hf',
    description: 'Ray 团队出品'
  },
  octoai: {
    name: 'OctoAI',
    nameCn: 'OctoAI',
    baseUrl: 'https://text.octoai.run/v1',
    defaultModel: 'meta-llama-3-70b-instruct',
    description: '高效模型服务'
  },
  lepton: {
    name: 'Lepton',
    nameCn: 'Lepton AI',
    baseUrl: 'https://api.lepton.ai/v1',
    defaultModel: 'llama3-70b',
    description: '一键部署 AI 应用'
  },
  predibase: {
    name: 'Predibase',
    nameCn: 'Predibase',
    baseUrl: 'https://api.predibase.com/v1',
    defaultModel: 'llama-2-70b',
    description: '微调和部署平台'
  },
  nomic: {
    name: 'Nomic',
    nameCn: 'Nomic AI',
    baseUrl: 'https://api-atlas.nomic.ai/v1',
    defaultModel: 'nomic-embed-text-v1',
    description: '向量嵌入专家'
  },
  voyage: {
    name: 'Voyage',
    nameCn: 'Voyage AI',
    baseUrl: 'https://api.voyageai.com/v1',
    defaultModel: 'voyage-large-2',
    description: '高质量嵌入模型'
  },
  alephalpha: {
    name: 'AlephAlpha',
    nameCn: 'Aleph Alpha',
    baseUrl: 'https://api.aleph-alpha.com/v1',
    defaultModel: 'luminous-supreme',
    description: '欧洲企业 AI'
  },
  ai21: {
    name: 'AI21',
    nameCn: 'AI21 Labs',
    baseUrl: 'https://api.ai21.com/v1',
    defaultModel: 'jamba-1-5-large',
    description: 'Jamba 混合架构模型'
  },
  inflection: {
    name: 'Inflection',
    nameCn: 'Inflection AI',
    baseUrl: 'https://api.inflection.ai/v1',
    defaultModel: 'inflection-3-pi',
    description: 'Pi 助手'
  },
  reka: {
    name: 'Reka',
    nameCn: 'Reka AI',
    baseUrl: 'https://api.reka.ai/v1',
    defaultModel: 'reka-core',
    description: '多模态模型'
  },
  databricks: {
    name: 'Databricks',
    nameCn: 'Databricks',
    baseUrl: 'https://models.databricks.com/v1',
    defaultModel: 'databricks-dbrx-instruct',
    description: '企业数据 AI'
  },

  // ═══════════════════════════════════════════════════════════
  // 云服务商 AI
  // ═══════════════════════════════════════════════════════════
  azure: {
    name: 'Azure',
    nameCn: 'Azure OpenAI',
    baseUrl: 'https://YOUR_RESOURCE.openai.azure.com/openai/deployments',
    defaultModel: 'gpt-4o',
    description: '微软 Azure 托管 OpenAI',
    special: true
  },
  aws_bedrock: {
    name: 'Bedrock',
    nameCn: 'AWS Bedrock',
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/v1',
    defaultModel: 'anthropic.claude-3-sonnet',
    description: 'AWS 托管模型服务',
    special: true
  },
  vertex: {
    name: 'Vertex',
    nameCn: 'Google Vertex AI',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com/v1',
    defaultModel: 'gemini-pro',
    description: 'GCP 托管模型服务',
    special: true
  },

  // ═══════════════════════════════════════════════════════════
  // 国内服务商
  // ═══════════════════════════════════════════════════════════
  zhipu: {
    name: 'GLM',
    nameCn: '智谱GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4',
    description: '清华系，GLM-4 系列'
  },
  alibaba: {
    name: 'Qwen',
    nameCn: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-turbo',
    description: '阿里云，Qwen 系列'
  },
  baidu: {
    name: 'Qianfan',
    nameCn: '百度千帆',
    baseUrl: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop',
    defaultModel: 'ernie-4.0-8k',
    description: '文心一言系列',
    special: true
  },
  moonshot: {
    name: 'Moonshot',
    nameCn: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    description: '长文本专家'
  },
  minimax: {
    name: 'MiniMax',
    nameCn: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    defaultModel: 'abab6.5s-chat',
    description: '海螺AI'
  },
  siliconflow: {
    name: 'SiliconFlow',
    nameCn: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-72B-Instruct',
    description: '国内模型聚合平台'
  },
  volcengine: {
    name: 'VolcEngine',
    nameCn: '火山引擎',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-pro-4k',
    description: '字节跳动，豆包系列'
  },
  spark: {
    name: 'Spark',
    nameCn: '讯飞星火',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    defaultModel: 'generalv3.5',
    description: '科大讯飞'
  },
  baichuan: {
    name: 'Baichuan',
    nameCn: '百川智能',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    defaultModel: 'Baichuan4',
    description: '前搜狗王小川'
  },
  yi: {
    name: 'Yi',
    nameCn: '零一万物',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    defaultModel: 'yi-large',
    description: '李开复创立'
  },
  stepfun: {
    name: 'StepFun',
    nameCn: '阶跃星辰',
    baseUrl: 'https://api.stepfun.com/v1',
    defaultModel: 'step-1-8k',
    description: '上海阶跃'
  },
  lingji: {
    name: 'Lingji',
    nameCn: '无问芯穹',
    baseUrl: 'https://inference-model.lingji.ai/v1',
    defaultModel: 'qwen1.5-110b-chat',
    description: '清华系'
  },
  iflow: {
    name: 'iFlow',
    nameCn: '心流',
    baseUrl: 'https://api.xinliu.ai/v1',
    defaultModel: 'xinliu-7b-chat',
    description: '中文优化模型'
  },
  bailian: {
    name: 'Bailian',
    nameCn: '阿里百炼',
    baseUrl: 'https://bailian.cn-beijing.aliyuncs.com/v1',
    defaultModel: 'qwen-plus',
    description: '阿里云百炼平台'
  },
  tencent: {
    name: 'Tencent',
    nameCn: '腾讯混元',
    baseUrl: 'https://hunyuan.tencentcloudapi.com/v1',
    defaultModel: 'hunyuan-lite',
    description: '腾讯混元大模型'
  },
  360: {
    name: '360Zhinao',
    nameCn: '360智脑',
    baseUrl: 'https://api.360.cn/v1',
    defaultModel: '360gpt-pro',
    description: '360 安全 AI'
  },
  langboat: {
    name: 'Langboat',
    nameCn: '澜舟科技',
    baseUrl: 'https://api.langboat.com/v1',
    defaultModel: 'mengzi-gpt',
    description: '孟子模型'
  },
  sensetime: {
    name: 'SenseTime',
    nameCn: '商汤日日新',
    baseUrl: 'https://api.sensenova.cn/v1',
    defaultModel: 'nova-ptc-xl-v1',
    description: '商汤科技'
  },
  unisound: {
    name: 'Unisound',
    nameCn: '云知声',
    baseUrl: 'https://api.unisound.com/v1',
    defaultModel: '山海大模型',
    description: '语音 AI 专家'
  },
  teleai: {
    name: 'TeleAI',
    nameCn: '电信星辰',
    baseUrl: 'https://api.teleai.cn/v1',
    defaultModel: 'telechat-12b',
    description: '中国电信'
  },
  mita: {
    name: 'Mita',
    nameCn: '秘塔AI',
    baseUrl: 'https://api.metaso.cn/v1',
    defaultModel: 'metaso-search',
    description: 'AI 搜索'
  },

  // ═══════════════════════════════════════════════════════════
  // 本地服务
  // ═══════════════════════════════════════════════════════════
  ollama: {
    name: 'Ollama',
    nameCn: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3',
    skipAuth: true,
    description: '本地运行，无需 API Key'
  },
  lmstudio: {
    name: 'LM Studio',
    nameCn: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    skipAuth: true,
    description: '本地运行，可视化界面'
  },
  vllm: {
    name: 'vLLM',
    nameCn: 'vLLM',
    baseUrl: 'http://localhost:8000/v1',
    defaultModel: 'meta-llama/Llama-2-70b-hf',
    skipAuth: true,
    description: '高性能推理引擎'
  },
  localai: {
    name: 'LocalAI',
    nameCn: 'LocalAI',
    baseUrl: 'http://localhost:8080/v1',
    defaultModel: 'gpt-3.5-turbo',
    skipAuth: true,
    description: 'OpenAI 兼容本地服务'
  },
  textgen: {
    name: 'TextGen',
    nameCn: 'Text Generation WebUI',
    baseUrl: 'http://localhost:5000/v1',
    defaultModel: 'model',
    skipAuth: true,
    description: 'Oobabooga WebUI'
  },

  // ═══════════════════════════════════════════════════════════
  // 其他聚合/特殊平台
  // ═══════════════════════════════════════════════════════════
  huggingface: {
    name: 'HuggingFace',
    nameCn: 'HuggingFace',
    baseUrl: 'https://api-inference.huggingface.co/models',
    defaultModel: 'meta-llama/Llama-3.2-3B-Instruct',
    description: '开源模型中心'
  },
  monsterapi: {
    name: 'MonsterAPI',
    nameCn: 'MonsterAPI',
    baseUrl: 'https://api.monsterapi.ai/v1',
    defaultModel: 'meta-llama/Llama-2-70b-chat-hf',
    description: '低成本 AI API'
  },
  glidian: {
    name: 'Glidian',
    nameCn: 'Glidian',
    baseUrl: 'https://api.glidian.com/v1',
    defaultModel: 'gpt-4',
    description: 'AI API 网关'
  },
  inferless: {
    name: 'Inferless',
    nameCn: 'Inferless',
    baseUrl: 'https://api.inferless.com/v1',
    defaultModel: 'llama-2-70b',
    description: '无服务器推理'
  },
  cerebras: {
    name: 'Cerebras',
    nameCn: 'Cerebras AI',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama3.1-70b',
    description: '极速推理芯片'
  },
  sambanova: {
    name: 'SambaNova',
    nameCn: 'SambaNova',
    baseUrl: 'https://api.sambanova.ai/v1',
    defaultModel: 'Meta-Llama-3.1-70B-Instruct',
    description: '企业 AI 平台'
  }
};

/**
 * 创建 Provider 实例
 */
export function createProvider(providerId, apiKey = null, overrides = {}) {
  const preset = PRESET_PROVIDERS[providerId];

  if (!preset) {
    // 未知 provider，尝试用通用配置
    return new OpenAICompatibleProvider({
      id: providerId,
      name: providerId,
      baseUrl: overrides.baseUrl || `https://api.${providerId}.com/v1`,
      apiKey,
      ...overrides
    });
  }

  // 特殊 provider 需要单独处理
  if (preset.special) {
    // 将在单独文件中处理
    console.log(`[Provider] ${providerId} requires special adapter`);
  }

  return new OpenAICompatibleProvider({
    id: providerId,
    ...preset,
    apiKey,
    ...overrides
  });
}

/**
 * 获取所有预设 Provider
 */
export function listPresetProviders() {
  return Object.entries(PRESET_PROVIDERS).map(([id, config]) => ({
    id,
    name: config.name,
    nameCn: config.nameCn,
    defaultModel: config.defaultModel,
    description: config.description || '',
    skipAuth: config.skipAuth || false,
    special: config.special || false
  }));
}

export default OpenAICompatibleProvider;
