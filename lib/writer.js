'use strict';

/**
 * ContextPocket — 写入器
 * 所有写入操作，保证格式正确、编号连续、同步更新
 */

const fs = require('fs');
const path = require('path');
const { writeAtomic, readText, readTextOr, readTextRequired, lockedWrite, sanitizeInline, sanitizeBlockquote } = require('./io');
const { parseLog, parseRequirements, plausibleIds } = require('./parser');
const {
  readConfig,
  fileExists,
  readFileSafe,
  getProjectRoot,
  isPlaceholderLine,
  stripPlaceholders,
  cleanIdentityLine,
  maxNumber,
  getTodayStr,
  intOption,
} = require('./core');
const { SESSION_LINE_RE } = require('./constants');
const { WHEN_LINE_RE, parseWhen, parseWhenLine, whenLine, nowStamp, todayDate, formatSupportsWhen } = require('./when');

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
// 顺序即规范顺序：append 按它写，amend 按它插。
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
// 空 pocket 一路顺畅，等到 archive/migrate/pre-commit 被拦时才撞墙，中间隔着的
// 是用户已经关掉的终端输出。
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
 * 缺省值是"写下这一轮的那一刻"，这是唯一确定知道的量；用户说了别的时间
 * （`09:00 → 11:30`、`上周三下午`）才用 `--when` 覆盖。认不出来的写法原样存成
 * `stated:`，绝不做换算 —— 工具不知道"两个小时"是从哪一刻起算的。
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
 * @param {string} [options.when] - 这一轮发生的时间（`2026-10-03 09:00 → 11:30` / `2026-05-01 → 2026-05-03` / `2026-10-03` / 原话）；缺省记为写入时刻
 * @param {boolean} [options.conflictCheck] - 显式传 false 才跳过写时冲突检查（默认检查）
 * @returns {object} { tId, success, when, whenSkipped, missingSections, autoConflicts, conflictsWritten, conflictCheckSkipped, conflictCheckError }
 */
function appendLogBlock(pocketDir, options) {
  const logPath = path.join(pocketDir, 'log.md');
  const logData = parseLog(pocketDir);
  const config = readConfig(pocketDir);

  const nextT = logData.latestT + 1;
  const today = getTodayStr();
  const lastSessionDate = getLastSessionDate(logData);

  // 写时冲突闸：先假定这一块已经写进 log.md，问"会新撞上哪些既有记录"。
  // 旧实现只能等 Agent 自己传 --conflicts；忘了传，冲突就永远不在历史里，
  // 而 log.md 是这个工具唯一的真相来源。检查本身失败绝不阻断记录
  // （块照写，把"没检查成"说回去 —— 与 whenSkipped 同一口径）。
  const gate = options.conflictCheck === false
    ? null
    : detectTurnConflicts(pocketDir, {
      id: nextT,
      gist: sanitizeInline(options.gist || ''),
      tags: options.tags || [],
      sections: draftSectionsFrom(options),
    });

  // 检出的冲突写进本块的 Conflicts 节（用户给的那几条排在前面，原样保留）。
  // 只有 critical/warning 进历史：info 类提示写进块里会把 Conflicts 节变成噪音。
  const blockFields = Object.assign({}, options);
  if (gate && gate.written.length > 0) {
    blockFields.conflicts = normalizeItems(options.conflicts)
      .concat(gate.written.map((f) => `[auto] ${f.message}`));
  }

  // 构建 T-block 内容
  let blockContent = '';

  // 如果日期变了，加 session 分隔线
  if (lastSessionDate !== today) {
    blockContent += `\n--- SESSION: ${today} ---\n\n`;
  }

  // 标题行
  const tagsStr = (options.tags || []).map(t => `[${t}]`).join(' ');
  blockContent += `## T${nextT} · ${sanitizeInline(options.gist || '')}`;
  if (tagsStr) {
    blockContent += ` · ${tagsStr}`;
  }
  blockContent += '\n';

  // v2 才写时间结构行：v1 的 pocket 里冒出一行 v2 的东西，等于内容超出它自己声明的格式版本，
  // `migrate` 也就没活可干了（升级必须由用户显式触发）。
  // 但用户明确给过的时间不能悄悄蒸发：块照记（log.md 永远是 P0），把"没记下"说回去。
  const whenLineText = whenLineFor(pocketDir, options.when);
  const whenSkipped = !whenLineText && options.when !== undefined && options.when !== null
    && String(options.when).trim() !== ''
    ? 'pocket 还是 v1 格式：先 context-pocket migrate --to latest 才记时间'
    : null;
  if (whenLineText) blockContent += whenLineText + '\n';
  blockContent += '\n';

  // 各小节按 AMENDABLE_SECTIONS 的规范顺序输出（有内容才加）。
  // 注意：所有值都要过 sanitizeInline —— log.md 用 `## T<n>` / `### X` 分结构，
  // 未清洗的换行能让一条 gist 伪造出新的 T-block。
  const missingRequired = [];
  for (const [field, title] of TBLOCK_SECTION_FIELDS) {
    const items = normalizeItems(blockFields[field]);
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
  updateIndexHeader(pocketDir, nextT, today);

  return {
    tId: nextT,
    success: true,
    when: whenLineText || null,
    whenSkipped,
    // 这一块里 verify 会判成 ERROR 的缺失小节（`['User','Action']` 的子集，空 = 齐）
    missingSections: missingRequired,
    // 写时冲突闸的结果：all = 全部检出，written = 已进本块 Conflicts 节的那几条
    autoConflicts: gate ? gate.all : [],
    conflictsWritten: gate ? gate.written.length : 0,
    conflictCheckSkipped: !gate,
    // 非 null = 这一轮没检查成（例如内部模块加载失败），原因写在里面
    conflictCheckError: gate ? gate.error : null,
  };
}

/**
 * 把"用户打算写的这一轮"归一成 check-conflicts 认识的 T-block 形状。
 * 键名用 log.md 的小节标题（而不是字段名）：冲突检查读的是 `sections.Action`
 * 这类结构，两处必须按同一张表对齐，表在 AMENDABLE_SECTIONS。
 * @param {object} options appendLogBlock 的入参
 * @returns {object} { 小节标题: string[] }
 */
function draftSectionsFrom(options) {
  const sections = {};
  for (const [field, title] of TBLOCK_SECTION_FIELDS) {
    const items = normalizeItems(options[field]);
    if (items.length > 0) sections[title] = items;
  }
  return sections;
}

/**
 * 这一轮记进去会不会撞上既有记录。
 *
 * 与 `check-conflicts` 用同一份六维规则（lib/query.js 的 runConflictChecks），
 * 差别只在数据：这里把新块合成进内存里的 log.blocks 再跑一遍，
 * 只取"记进去之后才新出现"的那几条。
 *
 * @param {string} pocketDir
 * @param {object} draft { id, gist, tags, sections }
 * @returns {{all: object[], written: object[], error: string|null}}
 */
function detectTurnConflicts(pocketDir, draft) {
  try {
    // 延迟 require：validator/query 都是"读的一侧"，写入模块不在它们的依赖里，
    // 但保持和 archiveLog 一样的取法，避免以后加依赖时出现环。
    const { conflictsIntroducedBy } = require('./query');
    const all = conflictsIntroducedBy(pocketDir, draft);
    return {
      all,
      written: all.filter((f) => f.severity === 'critical' || f.severity === 'warning'),
      error: null,
    };
  } catch (e) {
    return { all: [], written: [], error: e.message };
  }
}

// ============================================================
// 补全已有 T-block 的缺失小节
// ============================================================

// SECTION_ORDER / AMENDABLE_SECTIONS / TBLOCK_SECTION_FIELDS 定义在文件头部

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
 * 用途：verify 会把"缺 ### User / ### Action"判为 ERROR 并阻断 pre-commit，
 * 但此前没有任何命令能给已写入的 T-block 补上这些小节 —— 用户只能手改
 * markdown（而 SKILL.md 明令禁止）或 `git commit --no-verify`。
 *
 * @param {string} pocketDir
 * @param {number} tId - 要补全的 T 编号
 * @param {object} options - 字段名 → 字符串数组（与 appendLogBlock 同构）
 * @returns {object} { success, tId, filled: [小节名], skipped: [小节名] }
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
    return { changed: false, note: 'pocket 还是 v1 格式：先 context-pocket migrate --to latest 才记时间' };
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
 * 这里刻意用"整行重写"而不是"匹配旧值再替换"：bootstrap 写入的字面量
 * （`0 files/modules`、`T0 (empty — bootstrap state)`）和各计数器期望的
 * 格式不一致，基于替换的写法会静默不命中，index.md 从此停在初始值。
 *
 * @param {string} pocketDir
 * @param {string} file - 例如 'log.md' / 'code-map.md'
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
// 按需文件
// ============================================================

/**
 * 读取 pocket 里的文件；缺失时从模板补一份再读。
 *
 * lite 模式只创建 5 个核心文件（constants.js 的 LITE_CORE_FILES），
 * requirements.md / decisions.md 这类文件可能根本不存在。旧的实现直接
 * fs.readFileSync 会让 `req add` 抛裸 ENOENT 堆栈，等于"lite 模式下
 * 这些功能不可用"——这里改成用到才建，功能一个不少。
 * @param {string} pocketDir
 * @param {string} file
 * @returns {string}
 */
function readFileOrTemplate(pocketDir, file) {
  const filePath = path.join(pocketDir, file);
  const existing = readText(filePath);
  if (existing !== null) return existing;

  const templatePath = path.join(__dirname, '..', 'templates', file);
  const template = readText(templatePath);
  if (template === null) {
    throw new Error(`Cannot create ${file}: template not found at ${templatePath}`);
  }
  writeAtomic(filePath, template);
  return template;
}

// ============================================================
// 新增需求
// ============================================================

/**
 * 新增一个需求
 * @param {string} pocketDir
 * @param {object} options
 * @param {string} options.text - 需求描述
 * @param {string[]} [options.tags] - 标签
 * @param {string} [options.status='Open'] - 状态
 * @param {boolean} [options.uncertain=false] - 是否为推断未确认
 * @param {number} [options.openedAt] - 开启的 T-id（默认当前最新+1）
 * @param {string[]} [options.impl] - 实现文件
 * @returns {object} { rId, success }
 */
function addRequirement(pocketDir, options) {
  const reqPath = path.join(pocketDir, 'requirements.md');
  const reqData = parseRequirements(pocketDir);
  const logData = parseLog(pocketDir);

  // 安全校验：确保 nextId 大于所有已有 R-id（畸形编号不参与，否则下一条需求跟着飞）
  const maxR = reqData.items.length > 0
    ? maxNumber(plausibleIds(reqData.items))
    : 0;
  const nextR = Math.max(reqData.nextId, maxR + 1);
  const openedAt = options.openedAt || logData.latestT + 1;
  const status = options.status || 'Open';

  // 构建需求项
  let line = '- [';
  line += status === 'Done' ? 'x' : ' ';
  line += '] ';

  if (options.uncertain) {
    line += '❓ ';
  }

  line += `R${nextR} ${sanitizeInline(options.text || '')}`;

  if (options.tags && options.tags.length > 0) {
    line += ` [${options.tags.map((tag) => sanitizeInline(tag)).join(', ')}]`;
  }

  line += ` (opened T${openedAt}`;
  if (status === 'Done') {
    line += `, completed T${openedAt}`;
  } else if (status === 'Cancelled') {
    line += `, cancelled T${openedAt}`;
  }
  line += ')';

  if (options.impl && options.impl.length > 0) {
    line += ` · impl: ${options.impl.map((p) => sanitizeInline(p)).join(', ')}`;
  }

  // 插入到对应状态的列表末尾（缺文件时从模板补建）
  let content = readFileOrTemplate(pocketDir, 'requirements.md');
  const lines = content.split('\n');

  let sectionStart = -1;
  let sectionEnd = -1;

  // 找到目标状态节的位置
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ') && lines[i].slice(3).trim() === status) {
      sectionStart = i + 1;
      // 找到下一个 ## 或文件末尾
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith('## ')) {
          sectionEnd = j - 1;
          break;
        }
      }
      if (sectionEnd === -1) {
        sectionEnd = lines.length - 1;
      }
      break;
    }
  }

  if (sectionStart === -1) {
    // 找不到对应节，追加到文件末尾
    lines.push('');
    lines.push(`## ${status}`);
    lines.push(line);
  } else {
    // 插入到节的末尾（最后一个列表项之后）
    let insertPos = sectionEnd;
    // 从后往前找第一个列表项
    for (let i = sectionEnd; i >= sectionStart; i--) {
      if (lines[i].startsWith('- [')) {
        insertPos = i + 1;
        break;
      }
    }
    lines.splice(insertPos, 0, line);
  }

  // 更新 next_id
  const newNextId = nextR + 1;
  lines[0] = lines[0].replace(/next_id:\s*R\d+/, `next_id: R${newNextId}`);

  writeAtomic(reqPath, lines.join('\n'));

  // 更新 index.md 中的需求计数
  updateIndexReqCount(pocketDir);

  return { rId: nextR, success: true };
}

function updateIndexReqCount(pocketDir) {
  const reqData = parseRequirements(pocketDir);
  const total = reqData.items.length;
  const maxR = total > 0 ? maxNumber(reqData.items.map((i) => i.id)) : 0;
  const range = maxR > 0 ? `, R1–R${maxR}` : '';

  setIndexEntry(
    pocketDir,
    'requirements.md',
    `open ${reqData.openCount} / done ${reqData.doneCount} / cancelled ${reqData.cancelledCount} / ` +
      `❓ ${reqData.uncertainCount} (${total} item${total === 1 ? '' : 's'}${range})`
  );
}

// ============================================================
// 新增 ADR
// ============================================================

/**
 * 新增一个架构决策
 * @param {string} pocketDir
 * @param {object} options
 * @param {string} options.title - 决策标题
 * @param {string} options.context - 背景
 * @param {string} options.options - 选项
 * @param {string} options.decision - 决策
 * @param {string} options.consequences - 后果
 * @param {string} [options.supersedes='none'] - 取代的 ADR
 * @param {number} [options.createdAt] - 创建的 T-id
 * @returns {object} { adrId, success }
 */
function addDecision(pocketDir, options) {
  const decPath = path.join(pocketDir, 'decisions.md');
  const decData = require('./parser').parseDecisions(pocketDir);
  const logData = parseLog(pocketDir);

  // 安全校验：用最大 id + 1，而不是 count + 1（防止编号跳号）；畸形编号除外
  const maxAdr = decData.adrs.length > 0
    ? maxNumber(plausibleIds(decData.adrs))
    : 0;
  const nextAdr = maxAdr + 1;
  const createdAt = options.createdAt || logData.latestT + 1;

  // 构建 ADR 内容
  // 每个字段过 sanitizeInline：ADR 用 `## ADR-n` 分条、`- Key:` 分字段，
  // 未清洗的换行能凭空伪造另一条 ADR。
  let adrContent = `\n## ADR-${nextAdr} · ${sanitizeInline(options.title || '')} · T${createdAt}\n`;
  adrContent += `- Context: ${sanitizeInline(options.context || '')}\n`;
  adrContent += `- Options: ${sanitizeInline(options.options || '')}\n`;
  adrContent += `- Decision: ${sanitizeInline(options.decision || '')}\n`;
  adrContent += `- Consequences: ${sanitizeInline(options.consequences || '')}\n`;
  adrContent += `- Supersedes: ${sanitizeInline(options.supersedes || 'none')}\n`;

  // 追加到文件末尾（缺文件时从模板补建）
  let content = readFileOrTemplate(pocketDir, 'decisions.md');
  if (!content.endsWith('\n')) {
    content += '\n';
  }
  content += adrContent;
  writeAtomic(decPath, content);

  // 更新 index.md 计数
  updateIndexAdrCount(pocketDir, nextAdr);

  return { adrId: nextAdr, success: true };
}

function updateIndexAdrCount(pocketDir, count) {
  setIndexEntry(pocketDir, 'decisions.md', `${count} ADR${count !== 1 ? 's' : ''}`);
}

// ============================================================
// 写入 🔒 absolute.md
// ============================================================

/**
 * 追加一条 🔒 绝对保留条目
 *
 * 为什么需要这个函数：absolute.md 此前**只有读取路径**（parseAbsolute /
 * checkAbsoluteConflicts / handoff 展示），没有任何写入实现。CLI 与 MCP
 * 模式都无法记录红线，而这两种模式又明令"禁止手改 markdown"，导致 🔒
 * 特性在这两个自评最高可靠性的模式里完全不可用。
 *
 * @param {string} pocketDir
 * @param {object} options
 * @param {string} options.text - 用户原话（逐字保存，永不压缩）
 * @param {string} [options.gist] - 短摘要，用于冲突检测的关键词匹配
 * @param {number} [options.createdAt] - 关联的 T 编号，默认当前最新 T
 * @returns {object} { success, tId, count }
 */
function addAbsoluteEntry(pocketDir, options) {
  const absPath = path.join(pocketDir, 'absolute.md');
  const logData = parseLog(pocketDir);
  const tId = options.createdAt || logData.latestT;

  if (!options.text || !String(options.text).trim()) {
    throw new Error('absolute add: text is required (逐字保存的用户原话不能为空)');
  }

  // gist 缺省时，从原话截取首句作为摘要
  let gist = sanitizeInline(options.gist || '');
  if (!gist) {
    gist = sanitizeInline(
      String(options.text).split(/[\n。.!?！？]/)[0].trim().slice(0, 60)
    );
  }

  // absolute.md 可能不存在（lite mode 等），按模板补建
  let content = readFileOrTemplate(pocketDir, 'absolute.md');

  // 去掉模板里的占位示例（`## 🔒 T<n> · <gist>` 那几行），避免被解析成真条目
  content = content
    .replace(/\n##\s+🔒\s+T<n>\s*·\s*<gist>\n(?:>[^\n]*\n)?(?:<[^\n]*\n)?/, '\n');

  if (!content.endsWith('\n')) content += '\n';
  // 正文按 blockquote 存：`> ` 前缀既保留多行原话，又让正文里出现的
  // `## 🔒 T<n>` 不会被 parseAbsolute 误认成新条目（读取时会剥掉前缀还原）
  content += `\n## 🔒 T${tId} · ${gist}\n`;
  content += `${sanitizeBlockquote(options.text)}\n`;

  writeAtomic(absPath, content);

  // 更新 index.md 的 🔒 计数
  const newCount = (require('./parser').parseAbsolute(pocketDir) || {}).count || 0;
  updateIndexAbsoluteCount(pocketDir, newCount);

  return { success: true, tId, count: newCount };
}

function updateIndexAbsoluteCount(pocketDir, count) {
  setIndexEntry(pocketDir, 'absolute.md', `${count} 🔒 ${count !== 1 ? 'entries' : 'entry'}`);
}

// ============================================================
// 生成 handoff
// ============================================================

/**
 * 生成 handoff.md
 * @param {string} pocketDir
 * @returns {object} { success, tId }
 */
/**
 * 解析 code-map.md 的 Structure 目录树
 *
 * 树形如：
 *     ├── docs/ → ⚠️ TODO: add description
 *     │   └── api.md
 *     └── src/
 *         └── core/
 *             ├── auth.ts
 *             └── db.ts
 * 也有手写描述的变体：`└── login.ts → 登录鉴权入口`
 *
 * 深度判定用**缩进宽度**而非 `│` 计数：第 3 层起生成器不再重复 `│`，
 * 而是写成 `│` + 空格（每层固定 4 列），只数 `│` 会把第 3 层误判成第 2 层，
 * 导致 `src/auth.ts` 这类路径丢掉中间目录。
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

function generateHandoff(pocketDir) {
  const data = require('./parser').parseAll(pocketDir);
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
    content += '(empty — run `context-pocket code-map update`)\n';
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
  content += 'Read code-map.md + state.md first. Open log.md / assets/ for detail.\n';
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

// ============================================================
// 归档功能
// ============================================================

/**
 * 归档旧的 T-block 到 log-archive.md
 * @param {string} pocketDir
 * @param {object} options
 * @param {number} [options.keepLast] - 保留最新 N 轮；缺省时取 `config.md` 的 `recent_keep`
 * @param {boolean} [options.dryRun=false] - 只显示计划，不实际写入
 * @returns {object} { archivedCount, keptCount, archivedIds, summary, dryRun }
 */
function archiveLog(pocketDir, options = {}) {
  // recent_keep 在 config.md 模板、README 和 SKILL-advanced 里一直写着"归档时保留最近
  // 多少个完整 T 块"，但旧实现把 20 硬编码在 CLI/MCP 两个入口上，用户改配置从来没有效果。
  const keepLast = intOption(options.keepLast, readConfig(pocketDir).recent_keep);
  if (!(keepLast >= 1)) {
    throw new Error(`archive: keep-last must be a positive integer (got ${options.keepLast})`);
  }
  const dryRun = !!options.dryRun;

  const logPath = path.join(pocketDir, 'log.md');
  const archivePath = path.join(pocketDir, 'log-archive.md');
  const indexPath = path.join(pocketDir, 'index.md');

  // 归档前先跑 verify
  const preVerify = require('./validator').verify(pocketDir);
  if (preVerify.errorCount > 0) {
    throw new Error(`Cannot archive: verify found ${preVerify.errorCount} error(s). Fix errors first.`);
  }

  const logData = parseLog(pocketDir);

  if (logData.blocks.length <= keepLast) {
    return {
      archivedCount: 0,
      keptCount: logData.blocks.length,
      archivedIds: [],
      summary: [],
      dryRun,
      skipped: true,
      reason: `Only ${logData.blocks.length} blocks, no need to archive (keep ${keepLast})`,
    };
  }

  // 确定要归档的 block（前 N 个）
  const archiveCount = logData.blocks.length - keepLast;
  const blocksToArchive = logData.blocks.slice(0, archiveCount);
  const blocksToKeep = logData.blocks.slice(archiveCount);

  const archivedIds = blocksToArchive.map(b => b.id);
  const firstKeptId = blocksToKeep[0].id;
  const lastKeptId = blocksToKeep[blocksToKeep.length - 1].id;
  const firstArchivedId = blocksToArchive[0].id;
  const lastArchivedId = blocksToArchive[archiveCount - 1].id;

  // 生成归档摘要
  const summary = blocksToArchive.map(b => `T${b.id}: ${b.gist}`);

  if (dryRun) {
    return {
      archivedCount: archiveCount,
      keptCount: keepLast,
      archivedIds,
      summary,
      dryRun: true,
      firstArchivedId,
      lastArchivedId,
      firstKeptId,
      lastKeptId,
    };
  }

  // 备份原始文件（用于回滚）
  const logBackup = readTextRequired(logPath);
  const archiveBackup = fileExists(archivePath)
    ? readTextOr(archivePath, '')
    : null;
  const indexBackup = readTextRequired(indexPath);

  try {
    // 1. 将归档块写入/追加到 log-archive.md
    let archiveContent = '';
    if (fileExists(archivePath)) {
      archiveContent = readTextOr(archivePath, '');
      if (!archiveContent.endsWith('\n')) {
        archiveContent += '\n';
      }
    } else {
      archiveContent = '# ContextPocket · LOG ARCHIVE\n\n';
      archiveContent += '> Archived T-blocks. Read-only reference. Do not modify.\n\n';
    }

    // 从 log.md 中提取要归档的原始文本
    const fullLogContent = readTextRequired(logPath);
    const fullLogLines = fullLogContent.split('\n');

    // 找到第一个保留 block 的起始行
    let firstKeepLine = -1;
    for (let i = 0; i < fullLogLines.length; i++) {
      const match = fullLogLines[i].match(/^##\s+T(\d+)\s*·/);
      if (match && parseInt(match[1], 10) === firstKeptId) {
        firstKeepLine = i;
        break;
      }
    }

    if (firstKeepLine === -1) {
      throw new Error(`Could not find T${firstKeptId} in log.md`);
    }

    // 归档内容 = 第一个保留 block 之前的所有内容（去掉 header）
    // 但 `--- SESSION: … ---` 要跟着保留块走：它标记的是"从这一行开始的这批块"属于哪天。
    // 直接从 `## T<firstKept>` 切会把这行送进归档，log.md 里剩下的块从此 session=null
    // （recall 少一行日期，索引里每篇 hash 全变，增量刷新退化成全量重分词）。
    const headerEnd = findLogHeaderEnd(fullLogLines);
    let keepStart = firstKeepLine;
    for (let i = firstKeepLine - 1; i >= headerEnd; i--) {
      if (!fullLogLines[i].trim()) continue;
      if (SESSION_LINE_RE.test(fullLogLines[i])) keepStart = i;
      break;
    }

    let archiveSection = '';
    archiveSection = fullLogLines.slice(headerEnd, keepStart).join('\n').trim();

    if (archiveSection) {
      archiveContent += '\n' + archiveSection + '\n';
    }

    writeAtomic(archivePath, archiveContent);

    // 2. 更新 log.md（只保留最新的 block）
    // 同一天只写一条 SESSION 分隔线（在本轮第一个块之前）。如果它跟着归档块走了，
    // 而保留块前面一条都没有，这些天的记录就丢了（recall 里 session 变 null，
    // 并且索引里每篇 hash 全变，增量刷新退化成全量重分词）。所以把它复制一份留在 log.md，
    // 归档文件里那份继续管它下面那批块 —— 两个文件本来就是各自独立解析的。
    const keptHasSession = fullLogLines.slice(keepStart).some((l) => SESSION_LINE_RE.test(l));
    let carriedSessionLine = '';
    if (!keptHasSession) {
      for (let i = keepStart - 1; i >= headerEnd; i--) {
        if (SESSION_LINE_RE.test(fullLogLines[i])) {
          carriedSessionLine = fullLogLines[i].trim();
          break;
        }
      }
    }

    const newLogHeader = fullLogLines.slice(0, headerEnd).join('\n');
    const keptSection = fullLogLines.slice(keepStart).join('\n').trim();
    const newLogContent = newLogHeader + '\n\n'
      + (carriedSessionLine ? carriedSessionLine + '\n\n' : '')
      + keptSection + '\n';

    writeAtomic(logPath, newLogContent);

    // 3. 更新 index.md
    updateIndexForArchive(pocketDir, firstArchivedId, lastArchivedId, firstKeptId, lastKeptId);

    // 4. 归档后跑 verify
    const postVerify = require('./validator').verify(pocketDir);
    if (postVerify.errorCount > 0) {
      // 回滚
      writeAtomic(logPath, logBackup);
      if (archiveBackup !== null) {
        writeAtomic(archivePath, archiveBackup);
      } else if (fileExists(archivePath)) {
        fs.unlinkSync(archivePath);
      }
      writeAtomic(indexPath, indexBackup);
      throw new Error(`Post-archive verify failed (${postVerify.errorCount} error(s)). Rolled back.`);
    }

    return {
      archivedCount: archiveCount,
      keptCount: keepLast,
      archivedIds,
      summary,
      dryRun: false,
      firstArchivedId,
      lastArchivedId,
      firstKeptId,
      lastKeptId,
    };
  } catch (e) {
    // 失败回滚
    try {
      writeAtomic(logPath, logBackup);
      if (archiveBackup !== null) {
        writeAtomic(archivePath, archiveBackup);
      } else if (fileExists(archivePath)) {
        fs.unlinkSync(archivePath);
      }
      writeAtomic(indexPath, indexBackup);
    } catch (rollbackErr) {
      // 回滚也失败了，抛出原始错误
      throw new Error(`${e.message} (rollback also failed: ${rollbackErr.message})`);
    }
    throw e;
  }
}

function findLogHeaderEnd(lines) {
  // header 是从开头到第一个 T-block 或 SESSION 之前的部分
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+T\d+\s*·/.test(lines[i]) || /^---\s*SESSION:/.test(lines[i])) {
      // 回退到上一个空行
      let end = i;
      while (end > 0 && lines[end - 1].trim() === '') {
        end--;
      }
      return end;
    }
  }
  return lines.length;
}

function updateIndexForArchive(pocketDir, firstArchivedId, lastArchivedId, firstKeptId, lastKeptId) {
  const indexPath = path.join(pocketDir, 'index.md');
  if (!fileExists(indexPath)) return;

  // 一次读、一次写（旧实现把 log.md 行和 log-archive.md 行分两次落盘，
  // 中间崩溃会让 index.md 自相矛盾）
  const lines = readTextOr(indexPath, '').split('\n');

  let logLineIdx = lines.findIndex((l) => l.includes('log.md →'));
  if (logLineIdx !== -1) {
    lines[logLineIdx] = `- log.md → T${firstKeptId}–T${lastKeptId}`;
  } else {
    lines.push(`- log.md → T${firstKeptId}–T${lastKeptId}`);
    logLineIdx = lines.length - 1;
  }

  const archiveLineIdx = lines.findIndex((l) => l.includes('log-archive.md →'));
  // log-archive.md 累积了最早的块，所以范围始终是 T1–T<最后归档的 id>
  const archiveText = `- log-archive.md → T1–T${lastArchivedId}`;
  if (archiveLineIdx === -1) {
    lines.splice(logLineIdx + 1, 0, archiveText);
  } else {
    lines[archiveLineIdx] = archiveText;
  }

  writeAtomic(indexPath, lines.join('\n'));
}

// ============================================================
// state.md 更新
// ============================================================

/**
 * 更新 state.md
 * @param {string} pocketDir
 * @param {object} options
 * @param {string} [options.summary] - 替换/追加状态摘要
 * @param {boolean} [options.appendSummary=false] - 追加而非替换
 * @param {string} [options.nextStep] - 追加下一步
 * @param {string} [options.pitfall] - 追加坑点
 * @returns {object} { success, updatedFields }
 */
function updateState(pocketDir, options = {}) {
  const statePath = path.join(pocketDir, 'state.md');
  const logData = parseLog(pocketDir);
  const latestT = logData.latestT;
  const today = getTodayStr();

  let content = fileExists(statePath)
    ? readTextOr(statePath, '')
    : `# State · T0 · ${today}\n\n## Summary\n- (empty)\n\n## Next Steps\n- (empty)\n\n## Pitfalls\n- (empty)\n`;

  const updatedFields = [];

  // 更新标题行的 T
  content = content.replace(/^# State · T\d+ · .+$/m, `# State · T${latestT} · ${today}`);

  // 更新 Summary
  if (options.summary !== undefined) {
    if (options.appendSummary) {
      // 追加到 Summary 节
      content = appendToSection(content, 'Summary', `- ${options.summary}`);
    } else {
      // 替换 Summary 节内容
      content = replaceSection(content, 'Summary', [`- ${options.summary}`]);
    }
    updatedFields.push('summary');
  }

  // 追加 Next Step
  if (options.nextStep !== undefined) {
    content = appendToSection(content, 'Next Steps', `- ${options.nextStep}`);
    updatedFields.push('nextStep');
  }

  // 追加 Pitfall
  if (options.pitfall !== undefined) {
    content = appendToSection(content, 'Pitfalls', `- ${options.pitfall}`);
    updatedFields.push('pitfall');
  }

  writeAtomic(statePath, content);

  return { success: true, updatedFields, latestT };
}

// ============================================================
// preferences.md 更新
// ============================================================

/**
 * 更新 preferences.md
 * @param {string} pocketDir
 * @param {object} options
 * @param {string} options.key - 偏好项 key
 * @param {string} options.value - 偏好项 value
 * @returns {object} { success, key, value, isNew }
 */
function updatePreferences(pocketDir, options) {
  const prefsPath = path.join(pocketDir, 'preferences.md');
  const logData = parseLog(pocketDir);
  const latestT = logData.latestT;

  let content = fileExists(prefsPath)
    ? readTextOr(prefsPath, '')
    : `# Preferences · T0\n\n`;

  // 更新标题行的 T
  content = content.replace(/^# Preferences · T\d+/m, `# Preferences · T${latestT}`);

  const key = options.key;
  const value = options.value;
  let isNew = true;

  // 查找是否已存在该 key
  const lines = content.split('\n');
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('- ')) {
      const prefText = trimmed.slice(2).trim();
      const colonIdx = prefText.indexOf(':');
      if (colonIdx > -1) {
        const existingKey = prefText.slice(0, colonIdx).trim().toLowerCase();
        if (existingKey === key.toLowerCase()) {
          // 更新已有的偏好
          lines[i] = `- ${key}: ${value}`;
          found = true;
          isNew = false;
          break;
        }
      }
    }
  }

  if (!found) {
    // 追加新偏好
    lines.push(`- ${key}: ${value}`);
  }

  content = lines.join('\n');
  writeAtomic(prefsPath, content);

  // 更新 index.md 的 preferences 计数
  updateIndexPrefCount(pocketDir);

  return { success: true, key, value, isNew, latestT };
}

function updateIndexPrefCount(pocketDir) {
  const prefsData = require('./parser').parsePreferences(pocketDir);
  setIndexEntry(pocketDir, 'preferences.md', `${prefsData.count} prefs`);
}

// ============================================================
// code-map.md 更新（重新扫描）
// ============================================================

/**
 * 重新扫描项目目录，更新 code-map.md
 * @param {string} pocketDir
 * @returns {object} { success, addedCount, removedCount, existingCount }
 */
function updateCodeMap(pocketDir) {
  const codeMapPath = path.join(pocketDir, 'code-map.md');
  const projectRoot = getProjectRoot(pocketDir);
  const logData = parseLog(pocketDir);
  const latestT = logData.latestT;
  const today = getTodayStr();

  if (!fileExists(codeMapPath)) {
    throw new Error('code-map.md not found');
  }

  let content = readTextRequired(codeMapPath);

  // 更新标题行
  content = content.replace(/^# Code Map · T\d+ · .+$/m, `# Code Map · T${latestT} · ${today}`);

  // 解析现有 code-map 中的文件及其描述
  const existingMap = parseCodeMapEntries(content);
  const existingEntries = existingMap.byPath;

  // 重新扫描，但保留已有描述
  const currentFiles = scanProjectFiles(projectRoot, 3);

  // 兼容旧格式：老 code-map 的 key 可能是 basename。
  // 只有该 basename 在当前项目里唯一时才认，避免把 lib/index.js 的描述
  // 错配给 app/index.js。
  const basenameCounts = {};
  for (const f of currentFiles) {
    const bare = f.replace(/\/$/, '').split('/').pop();
    basenameCounts[bare] = (basenameCounts[bare] || 0) + 1;
  }
  const isKnown = (fullPath) => {
    if (Object.prototype.hasOwnProperty.call(existingEntries, fullPath)) return true;
    const bare = fullPath.replace(/\/$/, '').split('/').pop();
    return basenameCounts[bare] === 1
      && Object.prototype.hasOwnProperty.call(existingMap.byName, bare);
  };

  // 对比：新增的、已存在的、删除的
  const currentPaths = new Set(currentFiles);
  const currentBasenames = new Set(
    currentFiles.map((f) => f.replace(/\/$/, '').split('/').pop())
  );

  const added = [];
  const removed = [];
  const existing = [];

  for (const f of currentFiles) {
    if (isKnown(f)) {
      existing.push(f);
    } else {
      added.push(f);
    }
  }

  for (const f of Object.keys(existingEntries)) {
    const bare = f.replace(/\/$/, '').split('/').pop();
    // 旧格式的 basename key 不算"被删除"
    if (!currentPaths.has(f) && !(basenameCounts[bare] === 1 && currentBasenames.has(bare))) {
      removed.push(f);
    }
  }

  // 重建 Structure 节
  const newTree = buildCodeMapTree(currentFiles, existingMap, added);
  content = replaceStructureSection(content, newTree);

  writeAtomic(codeMapPath, content);

  // 更新 index.md 的 code-map 计数
  updateIndexCodeMapCount(pocketDir, currentFiles.length);

  return {
    success: true,
    addedCount: added.length,
    removedCount: removed.length,
    existingCount: existing.length,
    added,
    removed,
  };
}

/**
 * 解析 code-map.md 的 Structure 树，返回 { byPath, byName }
 *
 * 必须按缩进重建完整路径：树里每层只写文件名（`lib/` 下面的 `writer.js`），
 * 而 scanProjectFiles 给出的是 `lib/writer.js`。旧实现直接把行里的名字当
 * key，导致 byPath 全是 basename，与 currentFiles 对不上 —— 每次 update
 * 都把已有文件判成"新增"、丢掉用户写好的描述。
 *
 * byName 用于兼容旧格式（basename key）：只有该 basename 在项目里唯一时
 * 才回退使用，避免 lib/index.js 和 app/index.js 互相覆盖描述。
 *
 * @param {string} content
 * @returns {{byPath: object, byName: object, ambiguousNames: Set<string>}}
 */
function parseCodeMapEntries(content) {
  const byPath = {};
  const nameHits = {};
  const treeMatch = content.match(/## Structure\n```\n([\s\S]*?)```/);
  if (!treeMatch) return { byPath, byName: {}, ambiguousNames: new Set() };

  const lines = treeMatch[1].split('\n');
  const dirsAtDepth = [];

  for (const line of lines) {
    const connIdx = line.search(/[├└]/);
    if (connIdx === -1) {
      if (!line.trim()) continue;
      // 顶层无连接符的行（例如手写的一行条目）按 depth 0 处理
    }
    const depth = connIdx === -1 ? 0 : Math.floor(connIdx / 4);
    const text = (connIdx === -1 ? line : line.slice(connIdx + 4)).trim();
    if (!text) continue;

    const entryMatch = text.match(/^(.+?)\s*→\s*(.+)$/);
    const name = entryMatch ? entryMatch[1].trim() : text;
    const desc = entryMatch ? entryMatch[2].trim().split('\n')[0] : '';

    const isDir = name.endsWith('/');
    const fullPath = dirsAtDepth.slice(0, depth).join('') + name;

    if (desc) {
      byPath[fullPath] = desc;
      const bare = isDir ? name : name;
      nameHits[bare] = nameHits[bare] || [];
      nameHits[bare].push(fullPath);
    }

    if (isDir) {
      dirsAtDepth[depth] = name;
      dirsAtDepth.length = depth + 1;
    }
  }

  const ambiguousNames = new Set(
    Object.keys(nameHits).filter((n) => nameHits[n].length > 1)
  );
  const byName = {};
  for (const n of Object.keys(nameHits)) {
    if (nameHits[n].length === 1) byName[n] = byPath[nameHits[n][0]];
  }

  return { byPath, byName, ambiguousNames };
}

function scanProjectFiles(projectRoot, maxDepth) {
  const ignoreDirs = new Set([
    'node_modules', '.git', '.svn', '.hg',
    'dist', 'build', 'out', '.next', '.nuxt',
    '__pycache__', '.venv', 'venv', 'env',
    '.idea', '.vscode',
    'ContextPocket',
  ]);

  const files = [];

  function scan(dir, depth) {
    if (depth > maxDepth) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (ignoreDirs.has(entry.name)) continue;

        const relPath = path.relative(projectRoot, path.join(dir, entry.name));
        const normalized = relPath.replace(/\\/g, '/');

        if (entry.isDirectory()) {
          files.push(normalized + '/');
          scan(path.join(dir, entry.name), depth + 1);
        } else {
          files.push(normalized);
        }
      }
    } catch (e) {
      // skip
    }
  }

  scan(projectRoot, 1);
  return files.sort();
}

function buildCodeMapTree(files, existingMap, addedFiles) {
  // 构建树形结构字符串
  const lines = [];
  const addedSet = new Set(addedFiles);
  const byPath = existingMap.byPath || {};
  const byName = existingMap.byName || {};

  // 按目录分组
  const tree = {};
  for (const f of files) {
    const parts = f.split('/').filter(Boolean);
    let current = tree;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const isDir = f.endsWith('/') || !isLast;
      const key = isDir ? part + '/' : part;

      if (!current[key]) {
        current[key] = { __dir: isDir, __children: {} };
      }
      current = current[key].__children;
    }
  }

  function render(node, prefix, depth, parentPath) {
    const entries = Object.entries(node).sort((a, b) => {
      const aDir = a[1].__dir ? 0 : 1;
      const bDir = b[1].__dir ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a[0].localeCompare(b[0]);
    });

    for (let i = 0; i < entries.length; i++) {
      const [name, data] = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');

      let line = prefix + connector + name;

      // 完整路径由祖先目录链累积而成（树里只显示本层名字，
      // 但 scanProjectFiles 给的是全路径，两边必须对齐才能保住描述）
      const fullPath = (parentPath || '') + name;
      const desc = byPath[fullPath] !== undefined
        ? byPath[fullPath]
        // 旧格式只有 basename key；byName 已过滤掉重名，不会张冠李戴
        : byName[name];

      if (desc && !desc.startsWith('<') && !desc.includes('待补充')) {
        line += ' → ' + desc.split('\n')[0];
      } else if (addedSet.has(fullPath)) {
        line += ' → ' + CODE_MAP_TODO;
      }

      lines.push(line);

      if (Object.keys(data.__children).length > 0) {
        render(data.__children, nextPrefix, depth + 1, fullPath);
      }
    }
  }

  render(tree, '', 0, '');
  return lines.join('\n');
}

function replaceStructureSection(content, newTree) {
  const match = content.match(/(## Structure\n```\n)([\s\S]*?)(```)/);
  if (match) {
    return content.replace(match[0], match[1] + newTree + '\n' + match[3]);
  }
  return content;
}

function updateIndexCodeMapCount(pocketDir, count) {
  setIndexEntry(pocketDir, 'code-map.md', `${count} files/modules documented`);
}

// ============================================================
// 辅助函数：操作 markdown section
// ============================================================

function appendToSection(content, sectionName, line) {
  const lines = content.split('\n');
  let inSection = false;
  let sectionEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ') && lines[i].slice(3).trim() === sectionName) {
      inSection = true;
      continue;
    }
    if (inSection && lines[i].startsWith('## ')) {
      sectionEnd = i - 1;
      break;
    }
  }

  if (inSection && sectionEnd === -1) {
    sectionEnd = lines.length - 1;
  }

  if (!inSection) {
    // section 不存在，追加到末尾
    lines.push('');
    lines.push(`## ${sectionName}`);
    lines.push(line);
  } else {
    // 找到最后一个列表项后插入
    let insertPos = sectionEnd;
    for (let i = sectionEnd; i >= 0; i--) {
      if (lines[i].startsWith('- ')) {
        insertPos = i + 1;
        break;
      }
    }
    // 如果 section 是空的（只有标题），在标题后插入
    if (insertPos === sectionEnd && lines[insertPos].startsWith('## ')) {
      insertPos = insertPos + 1;
    }
    lines.splice(insertPos, 0, line);
  }

  return lines.join('\n');
}

function replaceSection(content, sectionName, newLines) {
  const lines = content.split('\n');
  let inSection = false;
  let sectionStart = -1;
  let sectionEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ') && lines[i].slice(3).trim() === sectionName) {
      inSection = true;
      sectionStart = i + 1;
      continue;
    }
    if (inSection && lines[i].startsWith('## ')) {
      sectionEnd = i - 1;
      break;
    }
  }

  if (inSection && sectionEnd === -1) {
    sectionEnd = lines.length - 1;
  }

  if (!inSection) {
    // section 不存在，追加
    lines.push('');
    lines.push(`## ${sectionName}`);
    for (const l of newLines) {
      lines.push(l);
    }
  } else {
    // 替换
    lines.splice(sectionStart, sectionEnd - sectionStart + 1, ...newLines);
  }

  return lines.join('\n');
}

// 所有对外写入入口都在 pocket 级互斥锁内执行：
// 两个进程（CLI + MCP server，或多个 agent）同时对 log.md 做
// read-modify-write 时，无锁会让后写者静默覆盖前者的 T-block。
module.exports = {
  // 字段名 → 小节标题的规范表：入口层与测试都读它，避免"加一节只改了一处"
  SECTION_FIELDS: AMENDABLE_SECTIONS,
  appendLogBlock: lockedWrite(appendLogBlock),
  amendLogBlock: lockedWrite(amendLogBlock),
  addRequirement: lockedWrite(addRequirement),
  addDecision: lockedWrite(addDecision),
  addAbsoluteEntry: lockedWrite(addAbsoluteEntry),
  generateHandoff: lockedWrite(generateHandoff),
  updateIndexHeader: lockedWrite(updateIndexHeader),
  archiveLog: lockedWrite(archiveLog),
  updateState: lockedWrite(updateState),
  updatePreferences: lockedWrite(updatePreferences),
  updateCodeMap: lockedWrite(updateCodeMap),
};
