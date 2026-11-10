'use strict';

/**
 * ContextPocket Lite — 写入器
 *
 * 三条写路径：`log append`（记一轮 + 同步 index 头）、`log amend`（补已有轮的
 * 缺失小节，从不覆盖历史）、`handoff`（派生一份交接摘要）。appendLogBlock /
 * amendLogBlock / generateHandoff 与主包 lib/writer.js 逐字同源，唯一的能力裁剪
 * 是**写时冲突闸**（六维冲突规则 runConflictChecks 属于 full 包，Lite 不带）——
 * append 返回值形状不变，autoConflicts 恒为空数组、conflictCheckSkipped 恒为 true，
 * CLI/MCP 的消费方不需要为两种包长两套判断。
 *
 * req add / decision add / archive / state update 等写命令仍不在 Lite 的
 * 11 命令面上（docs/ROADMAP-2.0.md §5 的分化矩阵）。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const path = require('path');
const { writeAtomic, readTextOr, readTextRequired, lockedWrite, sanitizeInline } = require('./io');
const { parseLog, parseAll, nextT } = require('./parser');
const {
  readConfig,
  fileExists,
  readFileSafe,
  isPlaceholderLine,
  stripPlaceholders,
  cleanIdentityLine,
  getTodayStr,
} = require('./core');
const { WHEN_LINE_RE, whenLine, parseWhen, parseWhenLine, nowStamp, todayDate, formatSupportsWhen } = require('./when');

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
// 顺序即规范顺序：append 按它写，amend 按它插。与主包同表 —— 两边写出的块逐字节同构，
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

const SECTION_ORDER = Object.values(AMENDABLE_SECTIONS);

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

// ============================================================
// 补全已有 T-block 的缺失小节（log amend）
// ============================================================

/** 去掉行尾的连续空行（不改动中间的内容行） */
function trimTrailingBlanks(lines) {
  const out = lines.slice();
  while (out.length > 0 && String(out[out.length - 1]).trim() === '') {
    out.pop();
  }
  return out;
}

/**
 * 补全一个已存在的 T-block 里**缺失**的小节
 *
 * 设计约束（对应 SKILL.md 的 Corrections 原则）：
 *   - 只补缺失的小节，**从不覆盖已有内容**
 *   - 历史 T-block 的既有行逐字保留
 *   - 新增小节按规范顺序插入
 *
 * 用途：verify 会把"缺 ### User / ### Action"判为 ERROR，但此前没有任何命令能给
 * 已写入的 T-block 补上这些小节 —— 用户只能手改 markdown（而 SKILL.md 明令禁止）。
 * 与主包 lib/writer.js 逐字同源。
 *
 * @param {string} pocketDir
 * @param {number} tId - 要补全的 T 编号
 * @param {object} options - 字段名 → 字符串数组（与 appendLogBlock 同构）
 * @returns {object} { success, tId, filled: [小节名], skipped: [小节名], when, unchanged? }
 */
function amendLogBlock(pocketDir, tId, options = {}) {
  const logPath = path.join(pocketDir, 'log.md');
  if (!fileExists(logPath)) {
    return { success: false, error: 'log.md not found' };
  }

  const lines = readTextRequired(logPath).split('\n');

  // 定位 T-block：要求 `## T<n> ·`，因此 T1 不会误匹配 T10
  const headerRe = new RegExp(`^##\\s+T${tId}\\s*·`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    return { success: false, error: `T${tId} not found in log.md` };
  }

  // 定位块尾：下一个 `## T` 块头，或文件末尾
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+T\d+\s*·/.test(lines[i])) {
      end = i;
      break;
    }
  }

  // 解析块内小节
  const header = lines[start];
  const body = lines.slice(start + 1, end);
  const sections = [];
  // 第一个 `###` 之前的结构行（v2 的 `--- WHEN: … ---` 就住在这里）。
  // 以前这一段会被**静默丢掉**：下面的循环只在 current 存在时收行，而 current 要到
  // 第一个小节标题才建立 —— 于是任何一次 amend 都会把时间行抹掉。
  const preamble = [];
  let current = null;

  for (const line of body) {
    const m = line.match(/^###\s+(.+?)\s*$/);
    if (m) {
      current = { name: m[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (current) {
      current.lines.push(line);
      continue;
    }
    if (line.trim()) preamble.push(line.trim());
  }

  const existing = new Set(sections.map((s) => s.name));
  const filled = [];
  const skipped = [];
  let whenNote = null;

  if (options.when !== undefined && options.when !== null && String(options.when).trim() !== '') {
    const outcome = applyWhenToPreamble(preamble, pocketDir, String(options.when), tId);
    if (outcome.changed) filled.push('When');
    // 只有"块里本来就有一行记好的时间"才算 skipped。v1 的 pocket 或取值解析失败
    // 时根本没有这一行，报成 "already present" 会把人引向不存在的内容。
    else if (outcome.skipped) skipped.push('When');
    whenNote = outcome.note;
  }

  for (const [field, sectionName] of Object.entries(AMENDABLE_SECTIONS)) {
    const values = normalizeItems(options[field]);
    if (values.length === 0) continue;

    if (existing.has(sectionName)) {
      // 已有内容 → 不覆盖，记为 skipped
      skipped.push(sectionName);
      continue;
    }

    sections.push({
      name: sectionName,
      lines: values.map((v) => `- ${v}`),
    });
    filled.push(sectionName);
  }

  if (filled.length === 0) {
    return {
      success: true,
      tId,
      filled: [],
      skipped,
      when: whenNote,
      unchanged: true,
    };
  }

  // 按规范顺序重排（稳定排序，未知小节保持相对位置在末尾）
  const orderOf = (name) => {
    const i = SECTION_ORDER.indexOf(name);
    return i === -1 ? SECTION_ORDER.length : i;
  };
  const indexed = sections.map((s, i) => ({ s, i, k: orderOf(s.name) }));
  indexed.sort((a, b) => (a.k - b.k) || (a.i - b.i));

  // 重新拼装。每个小节统一以"内容行 + 一个空行"结束：解析时每个小节的
  // lines 末尾本来就带一个空行（它和下一个 ### 之间隔着一行），如果不先
  // 裁掉尾部空行，重排后会出现连续两个空行。
  const out = [header, ...preamble, ''];
  for (const { s } of indexed) {
    out.push(`### ${s.name}`);
    out.push(...trimTrailingBlanks(s.lines));
    out.push('');
  }

  // 保留块尾之后（若有 session 分隔线等）
  const newLines = [
    ...lines.slice(0, start),
    ...out,
    ...lines.slice(end),
  ];

  writeAtomic(logPath, newLines.join('\n'));

  return { success: true, tId, filled, skipped, when: whenNote };
}

/**
 * amend 的 `--when`：把时间行放进（或换掉）块头的结构行。
 *
 * 三条规矩，都为了不与 SKILL.md 的"从不回写既有 T-block"打架：
 * - 块里没有这一行 → 补一行（这是"填缺失"，与 amend 的其它小节同一语义）
 * - 现值是 `(day)`（v1 迁移留下的粗粒度）→ 允许换成更准的值
 * - 现值是当时记下的时刻或区间 → **不改**，那是历史。要说清楚请新起一条 `T<n>-fix`
 * - v1 的 pocket 不写这一行，否则内容超出它自己声明的格式版本
 *
 * @param {string[]} preamble 就地修改
 * @param {string} pocketDir
 * @param {string} raw `--when` 的取值
 * @param {number} tId 只用于更正提示里该新起的 fix 块编号
 * @returns {{changed:boolean, skipped?:boolean, note:string}}
 */
function applyWhenToPreamble(preamble, pocketDir, raw, tId) {
  if (!formatSupportsWhen(pocketDir)) {
    return { changed: false, note: 'pocket 还是 v1 格式：升级需要 full 包的 migrate 命令（Lite 只读写 v2 口袋，不迁移）' };
  }

  const idx = preamble.findIndex((line) => WHEN_LINE_RE.test(line));
  const line = whenLine(parseWhen(raw));
  if (!line) return { changed: false, note: '时间取值解析不出内容，未改动' };

  if (idx === -1) {
    preamble.unshift(line);
    return { changed: true, note: `补上时间行：${line}` };
  }

  const before = parseWhenLine(preamble[idx]);
  if (before && before.kind === 'day') {
    const old = preamble[idx];
    preamble[idx] = line;
    return { changed: true, note: `把只有天的 ${old} 换成 ${line}` };
  }

  return {
    changed: false,
    skipped: true,
    note: `这一轮已经有记下的时间（${preamble[idx]}），amend 不覆盖历史；要更正就新起一条 T${tId}-fix`,
  };
}

// ============================================================
// index.md 条目行更新
// ============================================================

/**
 * 重写 index.md 里某个文件的描述行。
 *
 * 刻意用"整行重写"而不是"匹配旧值再替换"：bootstrap 写入的字面量
 * （`0 files/modules`、`T0 (empty — bootstrap state)`）和各计数器期望的
 * 格式不一致，基于替换的写法会静默不命中，index.md 从此停在初始值。
 *
 * @param {string} pocketDir
 * @param {string} file - 例如 'log.md' / 'handoff.md'
 * @param {string} text - 箭头之后的内容
 * @returns {boolean}
 */
function setIndexEntry(pocketDir, file, text) {
  const indexPath = path.join(pocketDir, 'index.md');
  if (!fileExists(indexPath)) return false;

  const lines = readTextOr(indexPath, '').split('\n');
  const needle = `${file} →`;
  const newLine = `- ${file} → ${text}`;

  for (let i = 1; i < lines.length; i++) {
    // `log-archive.md →` 不含 `log.md →` 子串，不会误命中
    if (lines[i].includes(needle)) {
      lines[i] = newLine;
      writeAtomic(indexPath, lines.join('\n'));
      return true;
    }
  }

  // 行被用户删掉了 → 补回末尾，避免计数从此彻底失踪
  if (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  lines.push(newLine);
  writeAtomic(indexPath, lines.join('\n'));
  return true;
}

// ============================================================
// handoff — 派生一份交接摘要
// ============================================================

/**
 * 解析 code-map.md Structure 段里的目录树（``` 围栏内）。
 *
 * 深度判定用**缩进宽度**而非 `│` 计数：第 3 层起生成器不再重复 `│`，
 * 而是写成 `│` + 空格（每层固定 4 列），只数 `│` 会把第 3 层误判成第 2 层，
 * 导致 `src/auth.ts` 这类路径丢掉中间目录。与主包 lib/writer.js 逐字同源。
 *
 * @param {string} block - ``` 代码块内的文本
 * @param {number} [maxDepth=2] - 最多返回几层
 * @param {number} [maxEntries=40] - 最多返回多少条
 * @returns {Array<{path: string, depth: number, desc: string}>}
 */
const CODE_MAP_INDENT = 4;
const CODE_MAP_TODO = '⚠️ TODO: add description';

function parseTreeLines(block, maxDepth = 2, maxEntries = 40) {
  const out = [];
  const stack = [];

  for (const raw of String(block).split('\n')) {
    const m = raw.match(/^([\s│]*)(?:├──|└──)\s*(.+?)\s*$/);
    if (!m) continue;

    const prefix = m[1];
    const indentCols = prefix.length;
    // 每层 4 列；不整除时退回按 `│` 计数（兼容手写的等宽树）
    const depth = indentCols % CODE_MAP_INDENT === 0
      ? indentCols / CODE_MAP_INDENT + 1
      : (prefix.match(/│/g) || []).length + 1;

    if (depth > maxDepth) continue;

    // 标签可能自带描述：`login.ts → 登录鉴权入口`
    let label = m[2];
    let desc = '';
    const arrow = label.indexOf('→');
    if (arrow !== -1) {
      desc = label.slice(arrow + 1).trim();
      label = label.slice(0, arrow).trim();
    }

    if (isPlaceholderLine(label)) continue;

    // 目录标签自带尾斜杠（`src/`），拼接前去掉，否则会出现 `src//api.ts`
    const seg = label.replace(/\/+$/, '');
    if (!seg) continue;

    stack.length = depth;
    stack[depth - 1] = seg;
    // 只拼接已定义的上层（防御手写树里出现跳级缩进的情况）
    const fullPath = stack
      .slice(0, depth)
      .filter(Boolean)
      .join('/');

    // 自动生成的 "TODO: add description" 是 code-map 的维护提示，
    // 对交接没有信息量，带过去只会让 handoff 显得很空。
    if (desc === CODE_MAP_TODO) desc = '';

    out.push({ path: fullPath, depth, desc });
    if (out.length >= maxEntries) break;
  }

  return out;
}

/**
 * 生成 handoff.md：把口袋现状蒸馏成一页交接摘要（身份 / 状态 / 最近 5 轮 /
 * 未决需求 / 下一步 / 代码地图 / 关键决策 / 待确认 / 绝对保留 / 恢复指引）。
 * 纯派生、可重写：真值永远在那几份 Markdown 里，handoff 只是给下一个接手的人
 * （或下一个 session 的自己）一份不用翻全量 log 的入口。与主包逐字同源。
 *
 * @param {string} pocketDir
 * @returns {{success:boolean, tId:number, date:string}}
 */
function generateHandoff(pocketDir) {
  const data = parseAll(pocketDir);
  const config = readConfig(pocketDir);
  const today = getTodayStr();
  const latestT = data.log.latestT;

  let content = `# Handoff · T${latestT} · ${today}\n`;
  content += '> ⚠️ STALE if log.md\'s latest T > T' + latestT + '. Regenerate the handoff before relying on this.\n\n';

  // Project Identity
  content += '## Project Identity\n';
  const readmeContent = readFileSafe(path.join(pocketDir, 'readme.md'));
  if (readmeContent) {
    const firstLine = readmeContent.split('\n').find(l => l.trim() && !l.startsWith('#'));
    // readme.md 的 identity 行是"真实值 + 模板占位符"混排的（bootstrap 预填），
    // 直接照搬会产出一行 `project: x · <one line: what this project does> · …`，
    // 交接方会把占位符当成真实描述。这里逐段剔除占位符。
    const cleaned = cleanIdentityLine(firstLine || '');
    content += (cleaned || '(see project readme)') + '\n\n';
  } else {
    content += '(see project readme)\n\n';
  }

  // State
  content += '## State\n';
  const stateSummary = stripPlaceholders(data.state.summary);
  if (stateSummary.length > 0) {
    content += stateSummary.map((s) => `- ${s}`).join('\n') + '\n';
  }
  const statePitfalls = stripPlaceholders(data.state.pitfalls);
  if (statePitfalls.length > 0) {
    content += '\nPitfalls:\n';
    for (const p of statePitfalls) {
      content += `- ${p}\n`;
    }
  }
  if (stateSummary.length === 0 && statePitfalls.length === 0) {
    content += '(not filled in yet — see state.md)\n';
  }
  content += '\n';

  // Recent (last 5)
  content += '## Recent (last 5 T gists)\n';
  const recent = data.log.blocks.slice(-5).reverse();
  for (const block of recent) {
    content += `- T${block.id}: ${block.gist}\n`;
  }
  content += '\n';

  // Open Requirements
  content += '## Open Requirements\n';
  const openReqs = data.requirements.items.filter(r => r.status === 'Open');
  if (openReqs.length === 0) {
    content += '(none)\n';
  } else {
    for (const req of openReqs) {
      let line = `- ${req.uncertain ? '❓ ' : ''}R${req.id}: ${req.text}`;
      if (req.impl && req.impl.length > 0) {
        line += ` (impl: ${req.impl.join(', ')})`;
      }
      content += line + '\n';
    }
  }
  content += '\n';

  // Next Steps
  content += '## Next Steps\n';
  const stateNextSteps = stripPlaceholders(data.state.nextSteps);
  if (stateNextSteps.length > 0) {
    for (const step of stateNextSteps) {
      content += `- ${step}\n`;
    }
  } else {
    content += '(see state.md)\n';
  }
  content += '\n';

  // Code Map（structure 段的目录树，最多 3 层 / 40 条）
  content += '## Code Map (top 3 levels; full detail in code-map.md)\n';
  const codeMapPath = path.join(pocketDir, 'code-map.md');
  let codeMapLines = [];
  if (fileExists(codeMapPath)) {
    const mapContent = readTextOr(codeMapPath, '');
    const structureMatch = mapContent.match(/##\s+Structure\s*\n+```\n([\s\S]*?)```/);
    if (structureMatch) {
      codeMapLines = parseTreeLines(structureMatch[1], 3, 40);
    }
  }
  if (codeMapLines.length === 0) {
    content += '(empty — keep code-map.md\'s Structure tree filled in)\n';
  } else {
    for (const entry of codeMapLines) {
      const desc = entry.desc ? ` → ${entry.desc}` : '';
      content += `- ${entry.path}${desc}\n`;
    }
  }
  content += '\n';

  // Key Decisions
  content += '## Key Decisions\n';
  if (data.decisions.count === 0) {
    content += '(none)\n';
  } else {
    for (const adr of data.decisions.adrs) {
      content += `- ADR-${adr.id}: ${adr.title}\n`;
    }
  }
  content += '\n';

  // Open ❓
  content += '## Open ❓\n';
  const uncertainReqs = data.requirements.items.filter(r => r.uncertain);
  const uncertainFromLog = [];
  for (const block of data.log.blocks) {
    if (block.sections.Uncertain) {
      for (const item of block.sections.Uncertain) {
        uncertainFromLog.push({ tId: block.id, text: item });
      }
    }
  }

  if (uncertainReqs.length === 0 && uncertainFromLog.length === 0) {
    content += '(none)\n';
  } else {
    for (const req of uncertainReqs) {
      content += `- [R${req.id}] ${req.text}\n`;
    }
    for (const u of uncertainFromLog) {
      content += `- [T${u.tId}] ${u.text.replace(/^❓\s*/, '')}\n`;
    }
  }
  content += '\n';

  // 🔒 Index
  content += '## 🔒 Index\n';
  if (data.absolute.count === 0) {
    content += '(none)\n';
  } else {
    for (const entry of data.absolute.entries) {
      content += `- T${entry.tId}: ${entry.gist}\n`;
    }
  }
  content += '\n';

  // Resume
  content += '## Resume\n';
  content += 'Read code-map.md + state.md first. Open log.md for detail.\n';
  content += 'ContextPocket is already active in this project — keep recording every turn.\n';

  // 写入文件
  const handoffPath = path.join(pocketDir, 'handoff.md');
  writeAtomic(handoffPath, content);

  // 更新 index.md
  updateIndexHandoff(pocketDir, today);

  return { success: true, tId: latestT, date: today };
}

function updateIndexHandoff(pocketDir, date) {
  setIndexEntry(pocketDir, 'handoff.md', `last generated: ${date}`);
}

module.exports = {
  // 字段名 → 小节标题的规范表：入口层与测试都读它，避免"加一节只改了一处"
  SECTION_FIELDS: AMENDABLE_SECTIONS,
  appendLogBlock: lockedWrite(appendLogBlock),
  amendLogBlock: lockedWrite(amendLogBlock),
  generateHandoff: lockedWrite(generateHandoff),
  updateIndexHeader: lockedWrite(updateIndexHeader),
};
