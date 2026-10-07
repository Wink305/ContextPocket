'use strict';

/**
 * ContextPocket — 历史会话导入
 * 对标 Basic Memory 的旧数据导入能力：让「中途启用」的项目不丢历史。
 *
 * 启用 ContextPocket 只能接续代码状态，之前的对话无从记录；本模块把各家 Agent
 * 留在本地磁盘的会话记录（JSONL）解析成 T-block 批量补录进 log.md，
 * T 编号从当前最新继续，统一打 [imported] 标签。
 *
 * 支持：
 *   claude-code — ~/.claude/projects/<project>/<session>.jsonl
 *                 行格式 {type:"user"|"assistant", message:{role, content}, timestamp}
 *   codex       — ~/.codex/sessions/ 下的会话 .jsonl
 *                 行格式 {type:"response_item", payload:{type:"message", role, content}}
 *   auto        — 逐行嗅探自动识别（也是泛化兜底：任何 {message:{role,content}} /
 *                 {role, content} 形状的 JSONL）
 *
 * 每条用户消息开启一个 T-block，其后到下一条用户消息之前的助手文本作为 Action 摘要。
 * 工具调用噪音（tool_use / tool_result）、命令标记、系统注入文本一律跳过。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const fs = require('fs');
const path = require('path');
const { appendLogBlock } = require('./writer');
const { nowStamp } = require('./when');
const { afterWrite } = require('./lifecycle');

const SUPPORTED_SOURCES = ['claude-code', 'codex', 'auto'];
const NOISE_PREFIXES = [
  '<command-',
  '<local-command',
  'caveat:',
  '[request interrupted',
  '<system-reminder>',
];

// ============================================================
// 文本提取
// ============================================================

function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts = content.map(b => {
      if (typeof b === 'string') return b;
      if (b && typeof b.text === 'string' &&
          ['text', 'input_text', 'output_text'].includes(b.type)) {
        return b.text;
      }
      return null;
    }).filter(Boolean);
    return parts.join('\n').trim();
  }
  return '';
}

function isNoise(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return true;
  return NOISE_PREFIXES.some(p => lower.startsWith(p));
}

function truncate(text, max) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + '…';
}

/**
 * 从一行 JSON 提取 (role, text, timestamp)，不匹配返回 null
 */
function extractEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;

  let role = null;
  let content = null;
  let timestamp = obj.timestamp || null;

  // Claude Code: {type:"user"|"assistant", message:{role, content}, timestamp}
  if ((obj.type === 'user' || obj.type === 'assistant') && obj.message) {
    role = obj.type;
    content = obj.message.content;
    timestamp = timestamp || obj.message.timestamp;
  } else if (obj.type === 'response_item' && obj.payload && obj.payload.type === 'message') {
    // Codex: {type:"response_item", payload:{type:"message", role, content}}
    role = obj.payload.role;
    content = obj.payload.content;
    timestamp = timestamp || obj.payload.timestamp;
  } else if (obj.message && obj.message.role) {
    // 泛化: {message:{role, content}}
    role = obj.message.role;
    content = obj.message.content;
  } else if (obj.role) {
    // 泛化: {role, content}
    role = obj.role;
    content = obj.content;
  }

  if (role !== 'user' && role !== 'assistant') return null;
  const text = extractText(content);
  if (isNoise(text)) return null;

  return { role, text, timestamp: formatTs(timestamp), when: formatWhenTs(timestamp) };
}

function formatTs(ts) {
  if (!ts) return null;
  const m = String(ts).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * 源时间戳 → v2 的 `--when` 取值。与 `formatTs`（一律截成日期，写进 User 行的 `[日期]` 前缀）
 * 分开，是因为这里的原则是**源里有几分精度就搬几分**：
 * - 带钟点又带时区（Claude Code / Codex 都是 UTC 的 `...Z`）→ 换成本地钟点，和实时
 *   `log append` 记下的口径一致
 * - 带钟点但没写时区 → 原样照抄，不重读它（当成哪个时区都可能错一小时）
 * - 只有日期 → 只给日期，解析端会写成 `(day)`；绝不补一个 `00:00` 冒充钟点
 *
 * @param {string|number|null} ts
 * @returns {string|null}
 */
function formatWhenTs(ts) {
  if (!ts) return null;
  const s = String(ts).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/);
  if (!m) return formatTs(s);
  if (m[4]) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return nowStamp(d);
  }
  return `${m[1]} ${m[2]}:${m[3]}`;
}

/**
 * 嗅探 JSONL 来源
 */
function detectSource(lineObjs) {
  for (const obj of lineObjs) {
    // 会话文件里混进 `null` 这种合法 JSON 行是常态（中断写入 / 心跳行），
    // 不能让它把整个导入炸掉。
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type === 'response_item' && obj.payload) return 'codex';
    if ((obj.type === 'user' || obj.type === 'assistant') && obj.message) return 'claude-code';
  }
  return 'generic';
}

// ============================================================
// 会话 → 轮次
// ============================================================

/**
 * 解析会话文件为轮次数组
 * @param {string} filePath
 * @param {object} opts { limit, truncate }
 * @returns {{source: string, turns: Array<{user: string, ts: string|null, when: string|null, summary: string}>}}
 */
function parseSession(filePath, opts = {}) {
  const limit = opts.limit || 100;
  const maxChars = opts.truncate || 400;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const lineObjs = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lineObjs.push(JSON.parse(trimmed));
    } catch (e) {
      // 非 JSON 行（头信息等）跳过
    }
  }

  const source = opts.source === 'auto' || !opts.source
    ? detectSource(lineObjs)
    : opts.source;

  // 事件流 → 轮次
  const turns = [];
  let current = null;
  for (const obj of lineObjs) {
    const ev = extractEvent(obj);
    if (!ev) continue;

    if (ev.role === 'user') {
      if (turns.length >= limit) break;
      current = { user: truncate(ev.text, maxChars), ts: ev.timestamp, when: ev.when, summary: '' };
      turns.push(current);
    } else if (current) {
      // 助手文本：拼进当前轮的摘要（总长受 maxChars 约束）
      const piece = ev.text;
      current.summary = current.summary
        ? truncate(current.summary + '\n' + piece, maxChars)
        : truncate(piece, maxChars);
    }
  }

  return { source, turns: turns.filter(t => t.user) };
}

// ============================================================
// 导入主函数
// ============================================================

/**
 * 把会话记录导入 log.md
 * @param {string} pocketDir
 * @param {object} opts
 * @param {string} opts.file - 会话 JSONL 路径（必填）
 * @param {string} [opts.source='auto'] - claude-code / codex / auto
 * @param {number} [opts.limit=100] - 最多导入多少轮
 * @param {number} [opts.truncate=400] - 每条字段截断长度
 * @param {boolean} [opts.dryRun=false]
 * @returns {object} { source, imported, tStart, tEnd, dryRun, preview }
 */
function importSession(pocketDir, opts = {}) {
  if (!opts.file) {
    throw new Error('--file is required (path to a session .jsonl file)');
  }
  const filePath = path.resolve(opts.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Session file not found: ${filePath}`);
  }
  if (opts.source && !SUPPORTED_SOURCES.includes(opts.source)) {
    throw new Error(`Unsupported source "${opts.source}". Supported: ${SUPPORTED_SOURCES.join(', ')}`);
  }

  const parsed = parseSession(filePath, {
    source: opts.source,
    limit: opts.limit || 100,
    truncate: opts.truncate || 400,
  });

  const fileLabel = path.basename(filePath);
  const importTag = 'imported';

  // 预览（dry-run）
  if (opts.dryRun) {
    return {
      source: parsed.source,
      imported: 0,
      tStart: null,
      tEnd: null,
      dryRun: true,
      preview: parsed.turns.slice(0, 5).map(t => ({
        gist: truncate(t.user, 60),
        ts: t.ts,
      })),
      plannedTurns: parsed.turns.length,
    };
  }

  let tStart = null;
  let tEnd = null;

  for (const turn of parsed.turns) {
    const userLine = turn.ts
      ? `[${turn.ts}] ${turn.user}`
      : turn.user;

    const result = appendLogBlock(pocketDir, {
      gist: truncate(turn.user, 80),
      tags: [importTag],
      user: [userLine],
      // v2 的 pocket 会把源里的时间戳搬成 WHEN 行；v1 的 pocket 里这个字段会被忽略
      when: turn.when || undefined,
      action: [
        `导入 ${parsed.source} 会话 — ${fileLabel}`,
        turn.summary ? truncate(turn.summary, 300) : '（无助手文本回复记录）',
      ],
    });

    if (tStart === null) tStart = result.tId;
    tEnd = result.tId;
  }

  // 批量补录后的副作用：hub 活跃信息 + 索引刷新（best-effort，不阻断导入）
  if (tEnd !== null) {
    afterWrite(pocketDir, { latestT: tEnd });
  }

  return {
    source: parsed.source,
    imported: parsed.turns.length,
    tStart,
    tEnd,
    dryRun: false,
    preview: [],
    plannedTurns: parsed.turns.length,
  };
}

module.exports = {
  importSession,
  parseSession,
  SUPPORTED_SOURCES,
};
