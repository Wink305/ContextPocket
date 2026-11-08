'use strict';

/**
 * ContextPocket Lite — 写入器
 *
 * 只保留 `log append` 一条写路径（Lite 的写入面：记一轮 + 同步 index 头）。
 * appendLogBlock 与主包 lib/writer.js 逐字同源，唯一的能力裁剪是**写时冲突闸**
 * （六维冲突规则 runConflictChecks 属于 full 包，Lite 不带）—— 返回值形状不变，
 * autoConflicts 恒为空数组、conflictCheckSkipped 恒为 true，CLI/MCP 的消费方
 * 不需要为两种包长两套判断。
 *
 * amend / req add / decision add / archive / state update 等写命令不在 Lite 的
 * 8 命令面上（docs/ROADMAP-2.0.md §5 的分化矩阵）。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const path = require('path');
const { writeAtomic, readTextOr, readTextRequired, lockedWrite, sanitizeInline } = require('./io');
const { parseLog, nextT } = require('./parser');
const {
  fileExists,
  getTodayStr,
} = require('./core');const { whenLine, parseWhen, nowStamp, todayDate, formatSupportsWhen } = require('./when');

// ============================================================
// 工具函数
// ============================================================

// getTodayStr 来自 lib/core（SESSION 行与 digest 文件名要用同一个日期实现）

function getLastSessionDate(logData) {
  if (logData.sessions.length > 0) {
    return logData.sessions[logData.sessions.length - 1].date;
  }
  return null;
}

// ============================================================
// T-block 小节定义（唯一的真相来源）
// ============================================================

// 字段名（CLI / MCP 参数用的复数或单数形式）→ log.md 里的小节标题。
// 顺序即规范顺序：append 按它写。与主包同表 —— 两边写出的块逐字节同构，
// 这是「共用 Node schema v2」在写入侧的落点。
const AMENDABLE_SECTIONS = {
  author: 'Author',
  user: 'User',
  action: 'Action',
  commits: 'Commits',
  decisions: 'Decisions & Constraints',
  pitfalls: 'Pitfalls',
  preferences: 'Preferences',
  conflicts: 'Conflicts',
  attachments: 'Attachments',
  uncertain: 'Uncertain',
};

// verify 判成 ERROR 的那两节（`lib/validator.js` 的 "missing User/Action section"）。
// 列在这里而不是各说一套，是因为 append 要在写完的当场知道自己漏写了什么 ——
// 空 pocket 一路顺畅，等到提交被拦时才撞墙，中间隔着的是用户已经关掉的终端输出。
const REQUIRED_TBLOCK_SECTIONS = ['User', 'Action'];

// [字段名, 小节标题] 有序对，append 时按顺序遍历
const TBLOCK_SECTION_FIELDS = Object.entries(AMENDABLE_SECTIONS);

/**
 * 把单值/数组/空值统一成清洗过的字符串数组
 * @param {*} value
 * @returns {string[]}
 */
function normalizeItems(value) {
  if (value === null || value === undefined || value === '') return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
    .map((v) => sanitizeInline(v));
}

// ============================================================
// 追加 T-block
// ============================================================

/**
 * 这一轮的时间结构行（v2 及以上才有）。
 *
 * 缺省值是"写下这一轮的那一刻"，这是唯一确定知道的量；用户明确给了另一个时间
 * （`09:00 → 11:30`、`上周三下午`）才用 `--when` 覆盖。认不出来的写法原样存成
 * `stated:`，绝不做换算 —— 工具不知道相对时长该从哪一刻起算。
 *
 * @param {string} pocketDir
 * @param {string} [raw] `--when` 的取值
 * @returns {string|null} 一行（不含换行）；v1 的 pocket 返回 null
 */
function whenLineFor(pocketDir, raw) {
  if (!formatSupportsWhen(pocketDir)) return null;
  const value = (raw === undefined || raw === null || String(raw).trim() === '')
    ? { kind: 'instant', date: todayDate(), from: nowStamp() }
    : parseWhen(String(raw));
  // 刻意不过 sanitizeInline：那道防护会把本行的 `---` 逃成 `\---`，见 lib/when.js 的 whenLine()
  return whenLine(value);
}

/**
 * 追加一个 T-block 到 log.md
 * @param {string} pocketDir
 * @param {object} options
 * @param {string} options.gist - 一句话摘要
 * @param {string[]} options.tags - 标签数组
 * @param {string[]} [options.author] - 记这一轮的是谁（多 Agent 共用一个 pocket 时用来分来源）
 * @param {string[]} options.user - 用户请求（数组，每行一条）—— 缺了 verify 判 ERROR
 * @param {string[]} options.action - 操作列表（数组，每行一条）—— 缺了 verify 判 ERROR
 * @param {string[]} [options.commits] - commit 列表
 * @param {string[]} [options.decisions] - 决策与约束
 * @param {string[]} [options.pitfalls] - 坑点
 * @param {string[]} [options.preferences] - 偏好
 * @param {string[]} [options.conflicts] - 冲突
 * @param {string[]} [options.attachments] - 附件
 * @param {string[]} [options.uncertain] - 待确认项
 * @param {string} [options.when] - 这一轮发生的时间（`2026-10-03 09:00 → 11:30` 等）；缺省记为写入时刻
 * @param {boolean} [options.conflictCheck] - 收下但忽略：Lite 不带写时冲突闸（六维规则在 full 包）
 * @returns {object} { tId, success, when, whenSkipped, missingSections, autoConflicts, conflictsWritten, conflictCheckSkipped, conflictCheckError }
 */
function appendLogBlock(pocketDir, options) {
  const logPath = path.join(pocketDir, 'log.md');
  const logData = parseLog(pocketDir);

  const tId = nextT(logData);
  const today = getTodayStr();
  const lastSessionDate = getLastSessionDate(logData);

  // Lite 的能力裁剪：没有写时冲突闸（runConflictChecks 的六维规则在 full 包，
  // 拉进来等于把 query 的冲突引擎整份带上，「更轻」就成了空话）。
  // 返回值形状与 full 包保持一致，消费方不用分叉。

  // 构建 T-block 内容
  let blockContent = '';

  // 如果日期变了，加 session 分隔线
  if (lastSessionDate !== today) {
    blockContent += `\n--- SESSION: ${today} ---\n\n`;
  }

  // 标题行
  const tagsStr = (options.tags || []).map(t => `[${t}]`).join(' ');
  blockContent += `## T${tId} · ${sanitizeInline(options.gist || '')}`;
  if (tagsStr) {
    blockContent += ` · ${tagsStr}`;
  }
  blockContent += '\n';

  // v2 才写时间结构行：v1 的 pocket 里冒出一行 v2 的东西，等于内容超出它自己声明的格式版本。
  // 但用户明确给过的时间不能悄悄蒸发：块照记（log.md 永远是 P0），把"没记下"说回去。
  const whenLineText = whenLineFor(pocketDir, options.when);
  const whenSkipped = !whenLineText && options.when !== undefined && options.when !== null
    && String(options.when).trim() !== ''
    ? 'pocket 还是 v1 格式：升级需要 full 包的 migrate 命令（Lite 只读写 v2 口袋，不迁移）'
    : null;
  if (whenLineText) blockContent += whenLineText + '\n';
  blockContent += '\n';

  // 各小节按 AMENDABLE_SECTIONS 的规范顺序输出（有内容才加）。
  // 注意：所有值都要过 sanitizeInline —— log.md 用 `## T<n>` / `### X` 分结构，
  // 未清洗的换行能让一条 gist 伪造出新的 T-block。
  const missingRequired = [];
  for (const [field, title] of TBLOCK_SECTION_FIELDS) {
    const items = normalizeItems(options[field]);
    if (items.length === 0) {
      if (REQUIRED_TBLOCK_SECTIONS.includes(title)) missingRequired.push(title);
      continue;
    }
    blockContent += '### ' + title + '\n';
    for (const item of items) {
      blockContent += '- ' + item + '\n';
    }
    blockContent += '\n';
  }

  // 写入 log.md（追加到末尾）
  let logContent = readTextRequired(logPath);

  // 确保末尾有空行
  if (!logContent.endsWith('\n')) {
    logContent += '\n';
  }

  logContent += blockContent;
  writeAtomic(logPath, logContent);

  // 同步更新 index.md
  updateIndexHeader(pocketDir, tId, today);

  return {
    tId,
    success: true,
    when: whenLineText || null,
    whenSkipped,
    // 这一块里 verify 会判成 ERROR 的缺失小节（`['User','Action']` 的子集，空 = 齐）
    missingSections: missingRequired,
    // Lite 不带写时冲突闸：形状不变、值恒为「没检查」
    autoConflicts: [],
    conflictsWritten: 0,
    conflictCheckSkipped: true,
    conflictCheckError: null,
  };
}

// ============================================================
// 更新 index.md 标题行
// ============================================================

function updateIndexHeader(pocketDir, latestT, date) {
  const indexPath = path.join(pocketDir, 'index.md');
  if (!fileExists(indexPath)) return;

  let content = readTextOr(indexPath, '');
  const lines = content.split('\n');

  // 更新标题行
  if (!lines[0] || /^#\s*Index/.test(lines[0])) {
    lines[0] = `# Index · T${latestT} · ${date}`;
  }

  // 更新 log.md 的 T 范围
  // start 必须来自 log.md 现状：归档搬走旧块后，行内原来那个 `T1–` 是过期的，
  // 继续抄它就会永久显示 `T1–T25`，而 T1 已经在 log-archive.md 里。
  const firstLiveT = parseLog(pocketDir).firstT;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].includes('log.md →')) {
      if (latestT > 0) {
        const rangeMatch = lines[i].match(/T(\d+)–T\d+/);
        const start = firstLiveT > 0
          ? firstLiveT
          : (rangeMatch ? rangeMatch[1] : '1');
        lines[i] = `- log.md → T${start}–T${latestT}`;
      } else {
        lines[i] = '- log.md → T0 (empty — bootstrap state)';
      }
      break;
    }
  }

  writeAtomic(indexPath, lines.join('\n'));
}

module.exports = {
  // 字段名 → 小节标题的规范表：入口层与测试都读它，避免"加一节只改了一处"
  SECTION_FIELDS: AMENDABLE_SECTIONS,
  appendLogBlock: lockedWrite(appendLogBlock),
  updateIndexHeader: lockedWrite(updateIndexHeader),
};
