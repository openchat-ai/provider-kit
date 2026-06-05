/**
 * EPC 编解码端到端测试
 */
import {
  encodeEpcFrame, parseEpcPayload, scanNextFrame, verifyFrameCs, parseFrames,
  EPC_TYPE_LLM, EPC_TYPE_FS, EPC_TYPE_CHAT, EPC_TYPE_S3, EPC_TYPE_MEDIA, EPC_TYPE_AGENT,
  EPC_TYPE_IMAGE, EPC_TYPE_EXEC, EPC_TYPE_ROOM, EPC_TYPE_CALL, EPC_TYPE_SIGNAL,
  EPC_TYPE_SDUI, EPC_TYPE_SECURITY, EPC_TYPE_SYSTEM, EPC_TYPE_DEBUG, EPC_TYPE_FILE_XFER,
  EPC_TYPE_PLUGIN, EPC_TYPE_UI_INPUT, EPC_TYPE_NETWORK, EPC_TYPE_TRANSPORT, EPC_TYPE_DB,
  EPC_SUB_CONTENT, EPC_SUB_THINKING, EPC_SUB_TOOL_CALL, EPC_SUB_ERROR, EPC_SUB_META,
  EPC_SUB_FS_LS, EPC_SUB_FS_DIR, EPC_SUB_FS_CAT, EPC_SUB_FS_READ,
  EPC_SUB_FS_WRITE, EPC_SUB_FS_APPEND, EPC_SUB_FS_DELETE, EPC_SUB_FS_COPY,
  EPC_SUB_FS_MOVE, EPC_SUB_FS_MKDIR, EPC_SUB_FS_RMDIR, EPC_SUB_FS_STAT,
  EPC_SUB_FS_CHMOD, EPC_SUB_FS_EXISTS, EPC_SUB_FS_TREE, EPC_SUB_FS_GLOB,
  EPC_SUB_LMDN, EPC_SUB_REC_START,
  EPC_SUB_CHAT_MSG, EPC_SUB_CHAT_TYPING,
  EPC_SUB_S3_PRESIGN, EPC_SUB_S3_GET,
  EPC_SUB_AGENT_STATE, EPC_SUB_TASK_START, EPC_SUB_TASK_DONE, EPC_SUB_SPAWN,
} from '../src/index.js';

let pass = 0, fail = 0;

function assert(label, cond) {
  if (cond) { pass++; }
  else { fail++; console.error(`✗ ${label}`); }
}

// ── 1. LLM: 单帧编码解码 ──
{
  const buf = encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_CONTENT, 'hello world');
  assert('frame starts with BB', buf[0] === 0xBB);
  assert('frame type LLM', buf[1] === EPC_TYPE_LLM);
  assert('frame sub CONTENT', buf[2] === EPC_SUB_CONTENT);
  assert('PL=11', (buf[3] << 16 | buf[4] << 8 | buf[5]) === 11);
  assert('payload matches', buf.slice(6, 17).toString() === 'hello world');
  assert('ends with 7E', buf[buf.length - 1] === 0x7E);

  // scanNextFrame
  const { frame, nextOffset } = scanNextFrame(buf, 0);
  assert('frame found', frame !== null);
  assert('frame consumed all', nextOffset === buf.length);
}

// ── 2. LLM: 多帧串联 ──
{
  const f1 = encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_THINKING, 'step 1');
  const f2 = encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_CONTENT, 'answer');
  const f3 = encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_TOOL_CALL, '[]');
  const concat = Buffer.concat([f1, f2, f3]);

  let off = 0, frames = 0;
  while (off < concat.length) {
    const r = scanNextFrame(concat, off);
    if (!r.frame) break;
    frames++;
    off = r.nextOffset;
  }
  assert('3 frames in concat', frames === 3);

  const parsed = parseEpcPayload(concat);
  assert('parse thinking', parsed.reasoningContent === 'step 1');
  assert('parse content', parsed.content === 'answer');
  assert('parse tool call', Array.isArray(parsed.toolCalls));
}

// ── 3. LLM: epcFromResponse ──
{
  const { epcFromResponse } = await import('../src/providers/epc-codec.js');
  const buf = epcFromResponse({
    content: 'hi',
    reasoningContent: 'thinking...',
    toolCalls: [{ id: 't1', name: 'read', arguments: { path: '/' } }],
  });
  const parsed = parseEpcPayload(buf);
  assert('epcFromResponse content', parsed.content === 'hi');
  assert('epcFromResponse thinking', parsed.reasoningContent === 'thinking...');
  assert('epcFromResponse toolCalls', parsed.toolCalls.length === 1);
}

// ── 4. FS: 二进制操作码 ──
{
  const path = '/home/user/file.txt';
  const buf = encodeEpcFrame(EPC_TYPE_FS, EPC_SUB_FS_LS, path);
  assert('FS LS path', buf.slice(6, buf.length - 2).toString() === path);
  assert('FS LS type', buf[1] === EPC_TYPE_FS);
  assert('FS LS sub', buf[2] === EPC_SUB_FS_LS);

  const buf2 = encodeEpcFrame(EPC_TYPE_FS, EPC_SUB_FS_WRITE, JSON.stringify({ path: '/x', content: 'abc' }));
  assert('FS WRITE type', buf2[1] === EPC_TYPE_FS);
  assert('FS WRITE sub', buf2[2] === EPC_SUB_FS_WRITE);

  const buf3 = encodeEpcFrame(EPC_TYPE_FS, EPC_SUB_FS_MKDIR, '/new/dir');
  const r3 = scanNextFrame(buf3, 0);
  assert('FS MKDIR payload', r3.frame.slice(6, r3.frame.length - 2).toString() === '/new/dir');
}

// ── 5. FS: 16 种 opcode 互不冲突 ──
{
  const ops = [
    EPC_SUB_FS_LS, EPC_SUB_FS_DIR, EPC_SUB_FS_CAT, EPC_SUB_FS_READ,
    EPC_SUB_FS_WRITE, EPC_SUB_FS_APPEND, EPC_SUB_FS_DELETE, EPC_SUB_FS_COPY,
    EPC_SUB_FS_MOVE, EPC_SUB_FS_MKDIR, EPC_SUB_FS_RMDIR, EPC_SUB_FS_STAT,
    EPC_SUB_FS_CHMOD, EPC_SUB_FS_EXISTS, EPC_SUB_FS_TREE, EPC_SUB_FS_GLOB,
  ];
  const seen = new Set();
  for (const op of ops) {
    const buf = encodeEpcFrame(EPC_TYPE_FS, op, '');
    seen.add(buf[2]);
  }
  assert('16 unique FS subtypes', seen.size === 16);
}

// ── 6. Chat: 消息帧 ──
{
  const msg = JSON.stringify({ from: 'alice', text: 'hi', ts: 1 });
  const buf = encodeEpcFrame(EPC_TYPE_CHAT, EPC_SUB_CHAT_MSG, msg);
  assert('CHAT MSG type', buf[1] === EPC_TYPE_CHAT);
  assert('CHAT MSG sub', buf[2] === EPC_SUB_CHAT_MSG);
  const dec = buf.slice(6, buf.length - 2).toString();
  assert('CHAT MSG payload', dec === msg);

  const typing = encodeEpcFrame(EPC_TYPE_CHAT, EPC_SUB_CHAT_TYPING, 'alice');
  assert('CHAT TYPING sub', typing[2] === EPC_SUB_CHAT_TYPING);
}

// ── 7. S3: 预签名 URL ──
{
  const req = JSON.stringify({ bucket: 'my-b', key: 'a/b.txt', expires: 3600 });
  const buf = encodeEpcFrame(EPC_TYPE_S3, EPC_SUB_S3_PRESIGN, req);
  assert('S3 PRESIGN type', buf[1] === EPC_TYPE_S3);
  assert('S3 PRESIGN sub', buf[2] === EPC_SUB_S3_PRESIGN);

  const buf2 = encodeEpcFrame(EPC_TYPE_S3, EPC_SUB_S3_GET, 'my-b/file.bin');
  const r2 = scanNextFrame(buf2, 0);
  assert('S3 GET payload', r2.frame.slice(6, r2.frame.length - 2).toString() === 'my-b/file.bin');
}

// ── 8. MEDIA: 音频帧 ──
{
  const pcm = Buffer.alloc(320, 0xAA); // 320 bytes PCM
  const buf = encodeEpcFrame(EPC_TYPE_MEDIA, EPC_SUB_LMDN, pcm);
  assert('MEDIA LMDN type', buf[1] === EPC_TYPE_MEDIA);
  assert('MEDIA LMDN sub', buf[2] === EPC_SUB_LMDN);
  assert('MEDIA LMDN PL=320', (buf[3] << 16 | buf[4] << 8 | buf[5]) === 320);

  const start = encodeEpcFrame(EPC_TYPE_MEDIA, EPC_SUB_REC_START, '');
  assert('REC_START type', start[1] === EPC_TYPE_MEDIA);
  assert('REC_START sub', start[2] === EPC_SUB_REC_START);
  assert('REC_START PL=0', (start[3] << 16 | start[4] << 8 | start[5]) === 0);
}

// ── 9. AGENT: 框架事件 ──
{
  const buf = encodeEpcFrame(EPC_TYPE_AGENT, EPC_SUB_AGENT_STATE, 'running');
  assert('AGENT STATE type', buf[1] === EPC_TYPE_AGENT);
  assert('AGENT STATE sub', buf[2] === EPC_SUB_AGENT_STATE);

  const spawn = encodeEpcFrame(EPC_TYPE_AGENT, EPC_SUB_SPAWN, JSON.stringify({ agent: 'coder', task: 'fix bug' }));
  assert('AGENT SPAWN sub', spawn[2] === EPC_SUB_SPAWN);

  const task = encodeEpcFrame(EPC_TYPE_AGENT, EPC_SUB_TASK_START, '42');
  assert('AGENT TASK sub', task[2] === EPC_SUB_TASK_START);
}

// ── 10. 多类型混拼 + CS 校验 ──
{
  const frames = [
    encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_CONTENT, 'hello'),
    encodeEpcFrame(EPC_TYPE_FS, EPC_SUB_FS_LS, '/tmp'),
    encodeEpcFrame(EPC_TYPE_CHAT, EPC_SUB_CHAT_MSG, '{}'),
    encodeEpcFrame(EPC_TYPE_MEDIA, EPC_SUB_LMDN, Buffer.alloc(64)),
    encodeEpcFrame(EPC_TYPE_AGENT, EPC_SUB_TASK_DONE, 'ok'),
  ];
  const concat = Buffer.concat(frames);

  let off = 0, count = 0;
  const types = [];
  while (off < concat.length) {
    const r = scanNextFrame(concat, off);
    if (!r.frame) break;
    types.push(r.frame[1]);
    // 校验 CS
    let cs = 0;
    for (let i = 1; i < r.frame.length - 2; i++) cs ^= r.frame[i];
    assert('CS valid for frame ' + count, cs === r.frame[r.frame.length - 2]);
    count++;
    off = r.nextOffset;
  }
  assert('5 mixed frames decoded', count === 5);
  assert('types in order', types[0] === EPC_TYPE_LLM && types[1] === EPC_TYPE_FS);
}

// ── 11. 边界: 空 payload ──
{
  const buf = encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_ERROR, '');
  assert('empty PL=0', (buf[3] << 16 | buf[4] << 8 | buf[5]) === 0);
  assert('empty frame len=8', buf.length === 8);
  const r = scanNextFrame(buf, 0);
  assert('empty frame decoded', r.frame !== null);
}

// ── 12. 边界: 大 payload (100KB) ──
{
  const big = 'x'.repeat(100000);
  const buf = encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_CONTENT, big);
  assert('big PL=100000', (buf[3] << 16 | buf[4] << 8 | buf[5]) === 100000);
  const r = scanNextFrame(buf, 0);
  const dec = r.frame.slice(6, r.frame.length - 2).toString();
  assert('big payload roundtrip', dec.length === 100000);
  assert('big payload first 10', dec.slice(0, 10) === 'xxxxxxxxxx');
}

// ── 13. scanNextFrame: 扫描垃圾 ──
{
  const garbage = Buffer.from([0x00, 0x01, 0x02, 0xBB, 0x10, 0x10, 0x00, 0x00, 0x05, 0x68, 0x65, 0x6C, 0x6C, 0x6F, 0x1E, 0x7E, 0xFF]);
  const r = scanNextFrame(garbage, 0);
  assert('skip garbage finds frame', r.frame !== null);
  assert('skipped garbage offset', r.nextOffset > 2);
  const payload = r.frame.slice(6, r.frame.length - 2).toString();
  assert('payload = hello', payload === 'hello');
}

// ── 14. 所有 21 种类型不冲突 ──
{
  const types = [
    EPC_TYPE_LLM, EPC_TYPE_AGENT, EPC_TYPE_MEDIA, EPC_TYPE_IMAGE,
    EPC_TYPE_FS, EPC_TYPE_S3, EPC_TYPE_EXEC, EPC_TYPE_CHAT,
    EPC_TYPE_ROOM, EPC_TYPE_CALL, EPC_TYPE_SIGNAL, EPC_TYPE_SDUI,
    EPC_TYPE_SECURITY, EPC_TYPE_SYSTEM, EPC_TYPE_DEBUG, EPC_TYPE_FILE_XFER,
    EPC_TYPE_PLUGIN, EPC_TYPE_UI_INPUT, EPC_TYPE_NETWORK, EPC_TYPE_TRANSPORT,
    EPC_TYPE_DB,
  ];
  const seen = new Set();
  for (const t of types) {
    const buf = encodeEpcFrame(t, 0x00, '');
    seen.add(buf[1]);
  }
  assert('21 unique types', seen.size === 21);
}

// ── 15. 端到端: AI → encode → decode → dispatch ──
{
  // 模拟 LLM 返回多帧 EPC
  const agentOutput = [
    { type: 'thinking', text: 'need to list /tmp' },
    { type: 'tool_call', tool: 'fs:ls', args: { path: '/tmp' } },
    { type: 'content', text: 'listing files...' },
  ];

  // 编码 (AI → EPC)
  const frames = agentOutput.map(o => {
    if (o.type === 'thinking') return encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_THINKING, o.text);
    if (o.type === 'tool_call') return encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_TOOL_CALL, JSON.stringify([{ i: '1', n: o.tool, a: o.args }]));
    if (o.type === 'content') return encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_CONTENT, o.text);
  });
  const epc = Buffer.concat(frames);

  // 解码 + 分发 (EPC → AI decision)
  const decisions = [];
  let off = 0;
  while (off < epc.length) {
    const { frame, nextOffset } = scanNextFrame(epc, off);
    if (!frame) break;
    off = nextOffset;
    const type = frame[1], sub = frame[2];
    const payload = frame.slice(6, frame.length - 2).toString();
    if (type === EPC_TYPE_LLM && sub === EPC_SUB_THINKING) decisions.push('saw thinking');
    if (type === EPC_TYPE_LLM && sub === EPC_SUB_TOOL_CALL) decisions.push('executed tool call');
    if (type === EPC_TYPE_LLM && sub === EPC_SUB_CONTENT) decisions.push('returned content');
  }
  assert('3 decisions from dispatch', decisions.length === 3);
  assert('thinking dispatched', decisions[0] === 'saw thinking');
  assert('tool dispatched', decisions[1] === 'executed tool call');
  assert('content dispatched', decisions[2] === 'returned content');
}

// ── 16. verifyFrameCs ──
{
  const buf = encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_CONTENT, 'hello');
  assert('valid frame CS', verifyFrameCs(buf) === true);
  const corrupted = Buffer.from(buf);
  corrupted[corrupted.length - 2] = 0xFF; // corrupt CS byte
  assert('corrupted frame CS fails', verifyFrameCs(corrupted) === false);
}

// ── 17. 严格模式: 跳过二进制 payload 内的假 0xBB ──
{
  const raw = Buffer.from([0x61, 0xBB, 0x62]); // a[0xBB]b
  const f1 = encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_CONTENT, raw);
  const f2 = encodeEpcFrame(EPC_TYPE_FS, EPC_SUB_FS_LS, '/tmp');
  const concat = Buffer.concat([f1, f2]);

  let strictCount = 0; let off = 0;
  while (off < concat.length) {
    const r = scanNextFrame(concat, off, true);
    if (!r.frame) break;
    strictCount++;
    off = r.nextOffset;
  }
  assert('strict handles 0xBB in binary payload', strictCount === 2);
}

// ── 18. 严格模式: 跳过 CS 损坏帧，恢复后续帧 ──
{
  const f1 = encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_CONTENT, 'good');
  const f2 = encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_THINKING, 'corrupted');
  f2[f2.length - 2] ^= 0xFF; // 反转 CS 模拟损坏

  const f3 = encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_CONTENT, 'recovered');
  const concat = Buffer.concat([f1, f2, f3]);

  const strictParsed = parseFrames(concat);
  assert('2 valid frames after CS corruption', strictParsed.length === 2);
  assert('first valid', strictParsed[0].payload.toString() === 'good');
  assert('recovered after bad CS', strictParsed[1].payload.toString() === 'recovered');
}

// ── 19. 复合指令: 3 步原子序列 ──
{
  // AI 发 "创建目录→写入文件→改权限" 三帧
  const steps = [
    encodeEpcFrame(EPC_TYPE_FS, EPC_SUB_FS_MKDIR, '/tmp/test'),
    encodeEpcFrame(EPC_TYPE_FS, EPC_SUB_FS_WRITE, JSON.stringify({ path: '/tmp/test/f', content: 'data' })),
    encodeEpcFrame(EPC_TYPE_FS, EPC_SUB_FS_CHMOD, JSON.stringify({ path: '/tmp/test/f', mode: '644' })),
  ];
  const stream = Buffer.concat(steps);

  // 接收方严格解析 → 拿到 3 个 opcode
  const ops = parseFrames(stream).map(f => f.sub);
  assert('composite 3 ops', ops.length === 3);
  assert('composite order', ops[0] === EPC_SUB_FS_MKDIR && ops[1] === EPC_SUB_FS_WRITE && ops[2] === EPC_SUB_FS_CHMOD);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
