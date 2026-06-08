// LLM 响应标准化纯函数 (provider 无关)
//
// 这些处理在 OpenAI/Azure/Bedrock 等多个 adapter 里重复出现,抽出来做单一来源:
//   ① stripThink           — 剥 <think>...</think> 块
//   ② extractReasoning     — 提取 reasoning_content / reasoningContent 字段
//   ③ normalizeToolCalls   — OpenAI 嵌套 {function:{name,arguments}} → 扁平 {name,arguments}
//                            兼容已扁平输入 (幂等,二次调用不破坏数据)
//   ④ parseActionFallback  — 文本协议降级: "ACTION: name {json}" → 伪 toolCall
//
// 设计原则:
//   - 纯函数,无副作用
//   - 幂等: 二次调用得到相同结果 (避免下游再处理一次时数据丢失)
//   - 容忍: null/undefined/非预期类型不抛错

const THINK_RE = /<think>[\s\S]*?<\/think>/g;
const ACTION_RE = /ACTION:\s*(\w+)\s*({[\s\S]*?})/;

/** ① 剥 <think>...</think> 块 (含多行) */
export function stripThink(rawContent) {
  if (typeof rawContent !== 'string') return '';
  return rawContent.replace(THINK_RE, '').trim();
}

/** ② 提取 reasoning_content / reasoningContent (两种命名都兼容) */
export function extractReasoning(msg) {
  if (!msg || typeof msg !== 'object') return '';
  return msg.reasoning_content || msg.reasoningContent || '';
}

/**
 * ③ 标准化 tool_calls 为扁平 {id, name, arguments}
 * 兼容两种输入:
 *   - OpenAI 原始: { id, function: { name, arguments } }
 *   - 已扁平 (provider-kit 处理后): { id, name, arguments }
 * 幂等: 二次调用得到相同结果
 */
export function normalizeToolCalls(rawToolCalls) {
  if (!Array.isArray(rawToolCalls)) return [];
  const out = [];
  for (const tc of rawToolCalls) {
    if (!tc) continue;
    if (tc.function && typeof tc.function === 'object') {
      // OpenAI 原始 schema
      out.push({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
    } else if (typeof tc.name === 'string') {
      // 已扁平 schema (幂等分支)
      out.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
    }
    // 其他不可识别条目直接丢
  }
  return out;
}

/**
 * ④ ACTION: 文本协议降级 — 无 toolCalls 且 content 含 ACTION: 时降级为伪 toolCall
 * @param {string} rawContent           LLM 响应文本
 * @param {Array}  existingToolCalls    已有的 toolCalls (若非空则原样返回)
 */
export function parseActionFallback(rawContent, existingToolCalls) {
  if (Array.isArray(existingToolCalls) && existingToolCalls.length > 0) return existingToolCalls;
  if (typeof rawContent !== 'string' || !rawContent.includes('ACTION:')) return existingToolCalls || [];
  const match = rawContent.match(ACTION_RE);
  if (!match) return existingToolCalls || [];
  const [, name, argsStr] = match;
  try {
    JSON.parse(argsStr);
    return [{ id: `textfb_${Date.now()}`, name, arguments: argsStr }];
  } catch {
    return existingToolCalls || [];
  }
}
