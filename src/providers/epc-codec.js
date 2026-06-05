/**
 * EPC 帧编码器/解码器
 *
 * 帧结构 (与 Flutter lmdn_codec.dart 一致):
 *   BB [Type(1)] [Sub(1)] [PL(3BE)] [Payload(PL)] [XOR-CS(1)] 7E(1)
 *
 * 多帧串联: 一个 Buffer 可包含多个 BB...7E 帧。
 * 全二进制: 所有操作都有独立 opcode，避免 JSON 解析。
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │                          EPC Type 空间                               │
 * ├──────┬────────────────┬──────────┬───────────────────────────────────┤
 * │ Type │ 域             │ Sub 范围 │ 说明                              │
 * ├──────┼────────────────┼──────────┼───────────────────────────────────┤
 * │ 0x10 │ LLM            │ 10-1F    │ Agent 输出 (content/thinking/等)   │
 * │ 0x11 │ AGENT          │ 20-2F    │ Agent 框架事件 (spawn/join/task)   │
 * │ 0x12 │ MEDIA          │ 30-5F    │ 音视频帧 (LMDN/Opus/H264/等)      │
 * │ 0x13 │ IMAGE          │ 40-4F    │ 图片 (raw/url/gen/analyze)        │
 * │ 0x14 │ FS             │ 70-7F    │ 文件系统 (ls/cat/write/等)        │
 * │ 0x15 │ S3             │ 80-8F    │ 对象存储 (list/get/put/presign)   │
 * │ 0x16 │ EXEC           │ 90-9F    │ 命令执行 (exec/shell/std* /kill)  │
 * │ 0x17 │ CHAT           │ F0-FF    │ 文字聊天 (msg/typing/reaction)    │
 * │ 0x18 │ ROOM           │ E0-EF    │ 语音房间 (join/leave/members)     │
 * │ 0x19 │ CALL           │ D0-DF    │ 通话 (in/out/accept/end/mute)    │
 * │ 0x1A │ SIGNAL         │ C0-CF    │ WebRTC 信令 (offer/ice/ping)      │
 * │ 0x1B │ SDUI           │ B0-BF    │ Server-Driven UI (tree/nav/toast) │
 * │ 0x1C │ SECURITY       │ 00-0F    │ 加密安全 (pubkey/auth/sign)       │
 * │ 0x1D │ SYSTEM         │ 10-1F    │ 系统事件 (log/metric/config/alert) │
 * │ 0x1E │ DEBUG          │ 20-2F    │ 调试诊断 (trace/inspect/heap)     │
 * │ 0x1F │ FILE_XFER      │ 60-6F    │ 文件传输 (blob/chunk/xfer)        │
 * │ 0x20 │ PLUGIN         │ 60-6F    │ 插件系统 (load/exec/event)        │
 * │ 0x21 │ UI_INPUT       │ 50-5F    │ 端侧输入 (key/mouse/touch/scroll) │
 * │ 0x22 │ NETWORK        │ 30-3F    │ 网络 (discovery/route/sync)       │
 * │ 0x23 │ TRANSPORT      │ 40-4F    │ 传输控制 (ack/heartbeat/connect)  │
 * │ 0x24 │ DB             │ A0-AF    │ 数据库 (query/insert/tx)          │
 * ├──────┼────────────────┼──────────┼───────────────────────────────────┤
 * │0x25-0xFC │ 预留      │ 00-FF    │ 共 216 种 × 256 子 = 55,296 空    │
 * ├──────┼────────────────┼──────────┼───────────────────────────────────┤
 * │ 0xFD │ BIZ_EXT       │ 00-FF    │ 业务方自定义扩展                  │
 * │ 0xFE │ EXPERIMENT    │ 00-FF    │ 实验性/私有协议                   │
 * │ 0xFF │ RAW           │ 00-FF    │ JSON fallback（渐进式迁移用）      │
 * └──────┴────────────────┴──────────┴───────────────────────────────────┘
 */

const HEADER = 6;
const FOOTER = 2;

// =================== 编码 ===================

export function encodeEpcFrame(type, subtype, payload) {
  const pl = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const frame = Buffer.alloc(HEADER + pl.length + FOOTER);
  let off = 0;
  frame[off++] = 0xBB;
  frame[off++] = type;
  frame[off++] = subtype;
  frame[off++] = (pl.length >> 16) & 0xFF;
  frame[off++] = (pl.length >> 8) & 0xFF;
  frame[off++] = pl.length & 0xFF;
  pl.copy(frame, off); off += pl.length;
  let cs = 0;
  for (let i = 1; i < off; i++) cs ^= frame[i];
  frame[off++] = cs;
  frame[off++] = 0x7E;
  return frame.slice(0, off);
}

// =================== 类型 ===================

export const EPC_TYPE_LLM       = 0x10;
export const EPC_TYPE_AGENT     = 0x11;
export const EPC_TYPE_MEDIA     = 0x12;
export const EPC_TYPE_IMAGE     = 0x13;
export const EPC_TYPE_FS        = 0x14;
export const EPC_TYPE_S3        = 0x15;
export const EPC_TYPE_EXEC      = 0x16;
export const EPC_TYPE_CHAT      = 0x17;
export const EPC_TYPE_ROOM      = 0x18;
export const EPC_TYPE_CALL      = 0x19;
export const EPC_TYPE_SIGNAL    = 0x1A;
export const EPC_TYPE_SDUI      = 0x1B;
export const EPC_TYPE_SECURITY  = 0x1C;
export const EPC_TYPE_SYSTEM    = 0x1D;
export const EPC_TYPE_DEBUG     = 0x1E;
export const EPC_TYPE_FILE_XFER = 0x1F;
export const EPC_TYPE_PLUGIN    = 0x20;
export const EPC_TYPE_UI_INPUT  = 0x21;
export const EPC_TYPE_NETWORK   = 0x22;
export const EPC_TYPE_TRANSPORT = 0x23;
export const EPC_TYPE_DB        = 0x24;
export const EPC_TYPE_BIZ_EXT   = 0xFD;
export const EPC_TYPE_EXPER     = 0xFE;
export const EPC_TYPE_RAW       = 0xFF;

// =================== 子类型 ===================

// ── 0x10 LLM ──
export const EPC_SUB_CONTENT      = 0x10;
export const EPC_SUB_THINKING     = 0x11;
export const EPC_SUB_TOOL_CALL    = 0x12;
export const EPC_SUB_TOOL_RESULT  = 0x13;
export const EPC_SUB_ERROR        = 0x14;
export const EPC_SUB_META         = 0x16;

// ── 0x11 AGENT ──
export const EPC_SUB_AGENT_STATE   = 0x20;
export const EPC_SUB_TASK_START    = 0x21;
export const EPC_SUB_TASK_PROGRESS = 0x22;
export const EPC_SUB_TASK_DONE     = 0x23;
export const EPC_SUB_SPAWN         = 0x24;
export const EPC_SUB_JOIN          = 0x25;
export const EPC_SUB_MEM_READ      = 0x26;
export const EPC_SUB_MEM_WRITE     = 0x27;
export const EPC_SUB_SESSION_EVENT = 0x28;

// ── 0x12 MEDIA (audio + video) ──
export const EPC_SUB_LMDN        = 0x30;
export const EPC_SUB_OPUS        = 0x31;
export const EPC_SUB_PCM         = 0x32;
export const EPC_SUB_VAD         = 0x33;
export const EPC_SUB_REC_START   = 0x38;
export const EPC_SUB_REC_STOP    = 0x39;
export const EPC_SUB_PLAY_START  = 0x3A;
export const EPC_SUB_PLAY_STOP   = 0x3B;
export const EPC_SUB_H264        = 0x50;
export const EPC_SUB_MEDIA_META  = 0x52;

// ── 0x13 IMAGE ──
export const EPC_SUB_IMG_RAW     = 0x40;
export const EPC_SUB_IMG_URL     = 0x41;
export const EPC_SUB_IMG_META    = 0x42;
export const EPC_SUB_IMG_GEN     = 0x43;
export const EPC_SUB_IMG_ANALYZE = 0x44;

// ── 0x14 FS ──
export const EPC_SUB_FS_LS       = 0x70;
export const EPC_SUB_FS_DIR      = 0x71;
export const EPC_SUB_FS_CAT      = 0x72;
export const EPC_SUB_FS_READ     = 0x73;
export const EPC_SUB_FS_WRITE    = 0x74;
export const EPC_SUB_FS_APPEND   = 0x75;
export const EPC_SUB_FS_DELETE   = 0x76;
export const EPC_SUB_FS_COPY     = 0x77;
export const EPC_SUB_FS_MOVE     = 0x78;
export const EPC_SUB_FS_MKDIR    = 0x79;
export const EPC_SUB_FS_RMDIR    = 0x7A;
export const EPC_SUB_FS_STAT     = 0x7B;
export const EPC_SUB_FS_CHMOD    = 0x7C;
export const EPC_SUB_FS_EXISTS   = 0x7D;
export const EPC_SUB_FS_TREE     = 0x7E;
export const EPC_SUB_FS_GLOB     = 0x7F;

// ── 0x15 S3 ──
export const EPC_SUB_S3_LIST_BK  = 0x80;
export const EPC_SUB_S3_LIST_OBJ = 0x81;
export const EPC_SUB_S3_GET      = 0x82;
export const EPC_SUB_S3_PUT      = 0x83;
export const EPC_SUB_S3_DEL      = 0x84;
export const EPC_SUB_S3_COPY     = 0x85;
export const EPC_SUB_S3_PRESIGN  = 0x86;
export const EPC_SUB_S3_UPLOAD_TK = 0x87;

// ── 0x16 EXEC ──
export const EPC_SUB_EXEC_EXEC   = 0x90;
export const EPC_SUB_EXEC_RESULT = 0x91;
export const EPC_SUB_EXEC_SHELL  = 0x92;
export const EPC_SUB_EXEC_SHELL_OUT = 0x93;
export const EPC_SUB_EXEC_STDIN  = 0x94;
export const EPC_SUB_EXEC_STDOUT = 0x95;
export const EPC_SUB_EXEC_STDERR = 0x96;
export const EPC_SUB_EXEC_EXIT   = 0x97;
export const EPC_SUB_EXEC_KILL   = 0x98;
export const EPC_SUB_EXEC_SIGNAL = 0x99;

// ── 0x17 CHAT ──
export const EPC_SUB_CHAT_MSG      = 0xF0;
export const EPC_SUB_CHAT_TYPING   = 0xF1;
export const EPC_SUB_CHAT_REACTION = 0xF2;
export const EPC_SUB_CHAT_ATTACH   = 0xF3;
export const EPC_SUB_CHAT_QUOTE    = 0xF4;
export const EPC_SUB_CHAT_DELETE   = 0xF5;
export const EPC_SUB_CHAT_EDIT     = 0xF6;
export const EPC_SUB_CHAT_RECEIPT  = 0xF7;
export const EPC_SUB_CHAT_HISTORY  = 0xF8;

// ── 0x18 ROOM ──
export const EPC_SUB_ROOM_CREATE    = 0xE0;
export const EPC_SUB_ROOM_JOIN      = 0xE1;
export const EPC_SUB_ROOM_LEAVE     = 0xE2;
export const EPC_SUB_ROOM_MEMBERS   = 0xE3;
export const EPC_SUB_ROOM_MEMBER_IN = 0xE4;
export const EPC_SUB_ROOM_MEMBER_OUT = 0xE5;
export const EPC_SUB_ROOM_MEMBER_MUTE = 0xE6;
export const EPC_SUB_ROOM_SETTINGS  = 0xE7;
export const EPC_SUB_ROOM_INVITE    = 0xE8;

// ── 0x19 CALL ──
export const EPC_SUB_CALL_IN      = 0xD0;
export const EPC_SUB_CALL_OUT     = 0xD1;
export const EPC_SUB_CALL_ACCEPT  = 0xD2;
export const EPC_SUB_CALL_REJECT  = 0xD3;
export const EPC_SUB_CALL_END     = 0xD4;
export const EPC_SUB_CALL_MUTE    = 0xD5;
export const EPC_SUB_CALL_UNMUTE  = 0xD6;
export const EPC_SUB_CALL_SPEAKER = 0xD7;
export const EPC_SUB_CALL_VOLUME  = 0xD8;

// ── 0x1A SIGNAL ──
export const EPC_SUB_SIG_OFFER    = 0xC0;
export const EPC_SUB_SIG_ANSWER   = 0xC1;
export const EPC_SUB_SIG_ICE      = 0xC2;
export const EPC_SUB_SIG_PING     = 0xC3;
export const EPC_SUB_SIG_PONG     = 0xC4;
export const EPC_SUB_SIG_PRESENCE = 0xC5;
export const EPC_SUB_SIG_PEERS    = 0xC6;

// ── 0x1B SDUI ──
export const EPC_SUB_SDUI_TREE    = 0xB0;
export const EPC_SUB_SDUI_DIFF    = 0xB1;
export const EPC_SUB_SDUI_NAV     = 0xB2;
export const EPC_SUB_SDUI_MODAL   = 0xB3;
export const EPC_SUB_SDUI_TOAST   = 0xB4;
export const EPC_SUB_SDUI_SNACK   = 0xB5;
export const EPC_SUB_SDUI_DIALOG  = 0xB6;
export const EPC_SUB_SDUI_REFRESH = 0xB7;
export const EPC_SUB_SDUI_THEME   = 0xB8;
export const EPC_SUB_SDUI_LAYOUT  = 0xB9;
export const EPC_SUB_SDUI_INPUT   = 0xBA;
export const EPC_SUB_SDUI_STATE   = 0xBB;

// ── 0x1C SECURITY ──
export const EPC_SUB_SEC_PUBKEY   = 0x00;
export const EPC_SUB_SEC_ENVELOPE = 0x01;
export const EPC_SUB_SEC_SIGN     = 0x02;
export const EPC_SUB_SEC_AUTH     = 0x03;
export const EPC_SUB_SEC_CHALLENGE = 0x04;
export const EPC_SUB_SEC_SESSION  = 0x05;
export const EPC_SUB_SEC_PERM     = 0x06;

// ── 0x1D SYSTEM ──
export const EPC_SUB_SYS_LOG      = 0x10;
export const EPC_SUB_SYS_METRIC   = 0x11;
export const EPC_SUB_SYS_CONFIG   = 0x12;
export const EPC_SUB_SYS_ALERT    = 0x13;
export const EPC_SUB_SYS_HEALTH   = 0x14;
export const EPC_SUB_SYS_VERSION  = 0x15;
export const EPC_SUB_SYS_STATUS   = 0x16;
export const EPC_SUB_SYS_ERR_LOG  = 0x17;
export const EPC_SUB_SYS_WARN     = 0x18;
export const EPC_SUB_SYS_INFO     = 0x19;
export const EPC_SUB_SYS_DEBUG    = 0x1A;

// ── 0x1E DEBUG ──
export const EPC_SUB_DBG_TRACE    = 0x20;
export const EPC_SUB_DBG_INSPECT  = 0x21;
export const EPC_SUB_DBG_PROFILE  = 0x22;
export const EPC_SUB_DBG_BREAK    = 0x23;
export const EPC_SUB_DBG_WATCH    = 0x24;
export const EPC_SUB_DBG_STACK    = 0x25;
export const EPC_SUB_DBG_HEAP     = 0x26;
export const EPC_SUB_DBG_MEM_DUMP = 0x27;

// ── 0x1F FILE_XFER ──
export const EPC_SUB_FILE_BLOB    = 0x60;
export const EPC_SUB_FILE_META    = 0x61;
export const EPC_SUB_FILE_CHUNK   = 0x62;
export const EPC_SUB_FILE_XFER_START = 0x63;
export const EPC_SUB_FILE_XFER_DONE  = 0x64;
export const EPC_SUB_FILE_XFER_CANCEL = 0x65;

// ── 0x20 PLUGIN ──
export const EPC_SUB_PLUGIN_LOAD    = 0x60;
export const EPC_SUB_PLUGIN_UNLOAD  = 0x61;
export const EPC_SUB_PLUGIN_EVENT   = 0x62;
export const EPC_SUB_PLUGIN_REG_TOOL = 0x63;
export const EPC_SUB_PLUGIN_EXEC_TOOL = 0x64;
export const EPC_SUB_PLUGIN_RESULT  = 0x65;

// ── 0x21 UI_INPUT ──
export const EPC_SUB_UI_KEY_DOWN   = 0x50;
export const EPC_SUB_UI_KEY_UP     = 0x51;
export const EPC_SUB_UI_MOUSE_MOVE = 0x52;
export const EPC_SUB_UI_MOUSE_DOWN = 0x53;
export const EPC_SUB_UI_MOUSE_UP   = 0x54;
export const EPC_SUB_UI_SCROLL     = 0x55;
export const EPC_SUB_UI_TOUCH      = 0x56;
export const EPC_SUB_UI_GESTURE    = 0x57;
export const EPC_SUB_UI_CLIPBOARD  = 0x58;
export const EPC_SUB_UI_DRAG       = 0x59;
export const EPC_SUB_UI_DROP       = 0x5A;

// ── 0x22 NETWORK ──
export const EPC_SUB_NET_DISC     = 0x30;
export const EPC_SUB_NET_ROUTE    = 0x31;
export const EPC_SUB_NET_SYNC     = 0x32;
export const EPC_SUB_NET_GOSSIP   = 0x33;
export const EPC_SUB_NET_PEER     = 0x34;
export const EPC_SUB_NET_TOPOLOGY = 0x35;

// ── 0x23 TRANSPORT ──
export const EPC_SUB_TP_STREAM    = 0x40;
export const EPC_SUB_TP_ACK       = 0x41;
export const EPC_SUB_TP_HEARTBEAT = 0x42;
export const EPC_SUB_TP_FLOW_CTL  = 0x43;
export const EPC_SUB_TP_RETRY     = 0x44;
export const EPC_SUB_TP_BACKPRESS = 0x45;
export const EPC_SUB_TP_CONNECT   = 0x46;
export const EPC_SUB_TP_DISCONNECT = 0x47;
export const EPC_SUB_TP_RECONNECT = 0x48;

// ── 0x24 DB ──
export const EPC_SUB_DB_QUERY     = 0xA0;
export const EPC_SUB_DB_EXEC      = 0xA1;
export const EPC_SUB_DB_INSERT    = 0xA2;
export const EPC_SUB_DB_UPDATE    = 0xA3;
export const EPC_SUB_DB_DELETE    = 0xA4;
export const EPC_SUB_DB_SCHEMA    = 0xA5;
export const EPC_SUB_DB_MIGRATE   = 0xA6;
export const EPC_SUB_DB_INDEX     = 0xA7;
export const EPC_SUB_DB_TX_BEGIN  = 0xA8;
export const EPC_SUB_DB_TX_COMMIT = 0xA9;
export const EPC_SUB_DB_TX_ROLLBACK = 0xAA;

// =================== 编码辅助 ===================

export function epcFromResponse({ content, reasoningContent, toolCalls }) {
  const frames = [];
  if (content) frames.push(encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_CONTENT, content));
  if (reasoningContent) frames.push(encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_THINKING, reasoningContent));
  if (toolCalls?.length) {
    const json = JSON.stringify(toolCalls.map(t => ({ i: t.id, n: t.name, a: t.arguments })));
    frames.push(encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_TOOL_CALL, json));
  }
  if (frames.length === 0) {
    frames.push(encodeEpcFrame(EPC_TYPE_LLM, EPC_SUB_CONTENT, ''));
  }
  return Buffer.concat(frames);
}

// =================== 解码 ===================

/** 校验帧的 CS（XOR bytes[1..frame.length-3]） */
export function verifyFrameCs(frame) {
  if (frame.length < HEADER + FOOTER) return false;
  let cs = 0;
  for (let i = 1; i < frame.length - 2; i++) cs ^= frame[i];
  return cs === frame[frame.length - 2];
}

/**
 * 扫描下一帧。
 * @param {boolean} [strict=false] — true 时同时校验 CS，CS 不符则跳过
 */
export function scanNextFrame(epc, off, strict = false) {
  if (off < 0) off = 0;
  const len = epc.length;
  while (off + HEADER + FOOTER <= len) {
    if (epc[off] !== 0xBB) { off++; continue; }
    const plen = (epc[off + 3] << 16) | (epc[off + 4] << 8) | epc[off + 5];
    const frameEnd = off + HEADER + plen + FOOTER;
    if (frameEnd > len) break;
    if (epc[frameEnd - 1] !== 0x7E) { off = frameEnd; continue; }
    if (strict && !verifyFrameCs(epc.slice(off, frameEnd))) { off = frameEnd; continue; }
    return { frame: epc.slice(off, frameEnd), nextOffset: frameEnd };
  }
  return { frame: null, nextOffset: len };
}

/** 迭代器：安全地遍历多帧，自动跳过错帧，返回 [type, sub, payload][] */
export function parseFrames(epc) {
  const result = [];
  if (!Buffer.isBuffer(epc) || epc.length < HEADER + FOOTER) return result;
  let off = 0;
  while (off + HEADER + FOOTER <= epc.length) {
    const { frame, nextOffset } = scanNextFrame(epc, off, true);
    if (!frame) break;
    off = nextOffset;
    const type = frame[1], sub = frame[2];
    const plen = (frame[3] << 16) | (frame[4] << 8) | frame[5];
    const payload = frame.slice(HEADER, HEADER + plen);
    result.push({ type, sub, payload, raw: frame });
  }
  return result;
}

export function parseEpcPayload(epc) {
  const result = { content: '', reasoningContent: '', toolCalls: [] };
  for (const { type, sub, payload } of parseFrames(epc)) {
    if (type !== EPC_TYPE_LLM) continue;
    const text = payload.toString('utf8');
    if (sub === EPC_SUB_CONTENT) result.content = text;
    else if (sub === EPC_SUB_THINKING) result.reasoningContent = text;
    else if (sub === EPC_SUB_TOOL_CALL) {
      try { result.toolCalls = JSON.parse(text).map(t => ({ id: t.i, name: t.n, arguments: t.a })); } catch {}
    }
  }
  return result;
}
