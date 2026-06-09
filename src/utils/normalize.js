// LLM 响应标准化纯函数 (provider 无关)
//
//   ① extractContent       — 自动识别 JSON/XML/string 格式并提取文本内容
//   ② extractReasoning     — 提取 reasoning_content / reasoningContent 字段
//   ③ normalizeToolCalls   — OpenAI 嵌套 {function:{name,arguments}} → 扁平 {name,arguments}
//   ④ parseActionFallback  — 文本协议降级: "ACTION: name {json}" → 伪 toolCall
//
// 设计原则:
//   - 纯函数,无副作用; 幂等; 容忍非预期输入; 零正则
//   - 零硬编码: 不写死任何 provider 特定字符串或标签名
//   - 格式自识别: 靠结构特征 (首尾字符 + 能否 parse) 判断,不靠关键字匹配

/**
 * ① 自动识别 JSON/XML/string 并提取文本内容
 *
 * 检测顺序:
 *   1. JSON: 首字符是 { 或 [ → 尝试 parse → 深度遍历收集所有字符串值
 *   2. XML : 首字符是 < 且末字符是 > → 逐字符扫描剥离标签,收集标签间文本
 *   3. 默认: 原样返回 (仅规整空白)
 *
 * 不写死任何标签名/字段名/分隔符。
 */
export function extractContent(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';
  const first = s[0];

  // JSON
  if (first === '{' || first === '[') {
    try { return extractFromJson(JSON.parse(s)); } catch {}
  }

  // XML (仅靠首个字符判断)
  if (first === '<') {
    return extractFromXml(s);
  }

  // 内容内嵌 <...> (如 `txt.<]minimax[>stuff`) — 取 `<` 前文本 + XML 内容
  const firstAngle = s.indexOf('<');
  if (firstAngle !== -1) {
    const prefix = trimDelimTail(s.slice(0, firstAngle));
    const extracted = extractFromXml(s.slice(firstAngle));
    if (extracted) {
      return prefix ? prefix + ' ' + extracted : extracted;
    }
  }

  return normalizeSpace(s);
}

function extractFromJson(value, visited = new Set()) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const p = [];
    for (const v of value) { const t = extractFromJson(v, visited); if (t) p.push(t); }
    return p.join('\n');
  }
  if (typeof value === 'object') {
    if (visited.has(value)) return '';
    visited.add(value);
    const p = [];
    for (const v of Object.values(value)) { const t = extractFromJson(v, visited); if (t) p.push(t); }
    return p.join('\n');
  }
  return '';
}

function extractFromXml(s) {
  const p = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '<') {
      while (i < s.length && s[i] !== '>') i++;
      if (i < s.length) i++;
    } else {
      let t = '';
      while (i < s.length && s[i] !== '<') { t += s[i]; i++; }
      const tt = t.trim();
      if (tt) p.push(tt);
    }
  }
  return p.join(' ');
}

function normalizeSpace(s) {
  let o = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\t' || c === '\r') { o += ' '; } else { o += c; }
  }
  return o.trim();
}

/** 去除尾部非内容字符 (配对括号/尖括号等,归类为格式残余) */
function trimDelimTail(s) {
  let i = s.length;
  while (i > 0) {
    const c = s[i - 1];
    if (c === ']' || c === '[' || c === ')' || c === '(' || c === '>' || c === '<' || c === '}' || c === '{') { i--; continue; }
    break;
  }
  return s.slice(0, i).trimEnd();
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
  // String-based: find "ACTION:", extract name and JSON body
  const prefix = 'ACTION:';
  const startIdx = rawContent.indexOf(prefix);
  if (startIdx === -1) return existingToolCalls || [];
  const afterAction = rawContent.slice(startIdx + prefix.length).trimStart();
  // Extract tool name (word characters until space or {)
  let nameEnd = 0;
  while (nameEnd < afterAction.length && afterAction[nameEnd] !== ' ' && afterAction[nameEnd] !== '{' && afterAction[nameEnd] !== '\n') {
    nameEnd++;
  }
  const name = afterAction.slice(0, nameEnd);
  if (!name) return existingToolCalls || [];
  // Find JSON body starting with {
  const jsonStart = afterAction.indexOf('{', nameEnd);
  if (jsonStart === -1) return existingToolCalls || [];
  // Match braces to find the JSON body end (handles nested braces)
  let depth = 0;
  let jsonEnd = -1;
  for (let i = jsonStart; i < afterAction.length; i++) {
    if (afterAction[i] === '{') depth++;
    if (afterAction[i] === '}') { depth--; if (depth === 0) { jsonEnd = i; break; } }
  }
  if (jsonEnd === -1) return existingToolCalls || [];
  const argsStr = afterAction.slice(jsonStart, jsonEnd + 1);
  try {
    JSON.parse(argsStr);
    return [{ id: `textfb_${Date.now()}`, name, arguments: argsStr }];
  } catch {
    return existingToolCalls || [];
  }
}
