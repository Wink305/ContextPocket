'use strict';

/**
 * ContextPocket Lite — 查询模块
 *
 * recall / search / why 的读侧，函数体从主包 lib/query.js 逐字搬运；
 * 被裁掉的是 diff（两轮对比，读 requirements/decisions 的增量）、
 * check-conflicts 六维冲突引擎（写时冲突闸与扫描都属 full 能力面）。
 * 保留的每一个函数与主包逐字一致 —— 时间窗口判据、证据分级、
 * 更正闭环的语义不允许两个包各说一套（compat.js 有回归锁）。
 *
 * search 只走现场扫描（lib/search.js 的 scanAll），没有索引缓存。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const path = require('path');
const { parseLogAll } = require('./parser');
const { readFileSafe, intOption } = require('./core');
const { scanAll } = require('./search');

// search 一页默认多少条：够一次屏幕，又不至于把 800 轮历史全量打印
const DEFAULT_SEARCH_LIMIT = 50;

// ============================================================
// recall — 查看指定轮次详情
// ============================================================

/**
 * 取某个 T-block 的原始文本：先 log.md，再 log-archive.md。
 * @returns {{rawText: string|null, source: string|null}}
 */
function rawBlockText(pocketDir, tId) {
  for (const file of ['log.md', 'log-archive.md']) {
    const content = readFileSafe(path.join(pocketDir, file));
    if (!content) continue;

    const lines = content.split('\n');
    let startLine = -1;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^##\s+T(\d+)\s*·/);
      if (match && parseInt(match[1], 10) === tId) {
        startLine = i;
        break;
      }
    }
    if (startLine === -1) continue;

    let endLine = lines.length;
    for (let i = startLine + 1; i < lines.length; i++) {
      if (/^##\s+T\d+\s*·/.test(lines[i]) || /^---\s*SESSION:/.test(lines[i])) {
        endLine = i;
        break;
      }
    }

    return { rawText: lines.slice(startLine, endLine).join('\n').trim(), source: file };
  }

  return { rawText: null, source: null };
}

/**
 * 查看指定 T-block 的完整内容（含已归档轮次）
 * @param {string} pocketDir
 * @param {number} tId
 * @returns {object|null} { id, gist, tags, sections, session, rawText, source, corrections }
 */
function recall(pocketDir, tId) {
  const logData = parseLogAll(pocketDir);
  const block = logData.blocks.find(b => b.id === tId);
  if (!block) return null;

  const { rawText, source } = rawBlockText(pocketDir, tId);
  return { ...block, rawText, source, archived: source === 'log-archive.md', corrections: correctionsFor(logData, tId) };
}

/**
 * 指向某一轮的更正：`## T<n>-fix` 块（targetId 命中，或正文 `Corrects T<n>` 命中）
 * 与带 [correction] 标签且 `Corrects T<n>` 命中的轮次。
 *
 * recall 把"这轮后来被更正过"直接摆出来：只读旧轮不看更正，等于拿着作废的原话
 * 当事实 —— 查询侧必须把更正闭环回来（--json 的 t.corrections 机器可读）。
 *
 * @param {object} logData parseLogAll() 的结果
 * @param {number} tId
 * @returns {Array<{id: string, kind: 'fix'|'correction', gist: string, text: string}>}
 */
function correctionsFor(logData, tId) {
  const out = [];
  for (const fix of (logData.fixBlocks || [])) {
    if (!(fix.targetId === tId || (fix.corrects || []).includes(tId))) continue;
    out.push({
      id: fix.fixId,
      kind: 'fix',
      gist: fix.gist || '',
      text: [fix.gist, ...(fix.body || []), ...Object.values(fix.sections || {}).flat()].join('\n').trim(),
    });
  }
  for (const block of logData.blocks) {
    if (block.id === tId) continue;
    const isCorrection = (block.tags || []).some((t) => String(t).toLowerCase() === 'correction');
    if (!isCorrection || !(block.corrects || []).includes(tId)) continue;
    out.push({
      id: 'T' + block.id,
      kind: 'correction',
      gist: block.gist || '',
      text: [block.gist, ...Object.values(block.sections || {}).flat()].join('\n').trim(),
    });
  }
  return out;
}

/**
 * 按时间 / T 号窗口列出轮次 —— `recall` 不带 T 号时的形态。
 *
 * 为什么不能只是"给 search 加个空关键词"：search 必须给关键词，而"上周三到周五
 * 都记了什么"这种问题没有关键词可给。缺的是一条**按坐标浏览时间线**的通道，
 * 而不是另一种匹配。所以这里不碰分词，直接读 parseLogAll 的块，
 * 把每一轮整成 filterByTime 认得的 T 行，交给与 search 完全同一份窗口判据 ——
 * 日期窗口排除没有 WHEN 的块、T 号窗口不看 WHEN、闭区间、无效日期当没传，
 * 两条命令对这些边界的理解因此不可能漂移。
 *
 * 只列 T-block：`T<n>-fix` / [correction] 更正块没有自己的时间结构行，
 * 它们跟随被更正的那一轮，用 `recall T<n>` 的 corrections 字段读到，
 * 在这里单列只会把同一段历史数两遍。归档轮次（log-archive.md）照常列入并标 archived。
 *
 * 顺序固定为 T 号升序：这是时间线，不是相关度排序；归档把旧块搬走后
 * 两份文件的拼接顺序仍可能让列表看起来跳号，所以显式按 id 排一次。
 * 分页口径与 searchAny 一致（过滤之后、分页之前算 total；limit 0 = 全量）。
 *
 * @param {string} pocketDir
 * @param {object} [opts] { sinceT, untilT, fromDate, toDate, limit, offset }
 * @returns {{ turns: object[], total: number, offset: number, limit: number|null, hasMore: boolean }}
 */
function recallWindow(pocketDir, opts = {}) {
  const logData = parseLogAll(pocketDir);
  const rows = logData.blocks.map((b) => ({
    type: 'T',
    id: b.id,
    gist: b.gist || '',
    tags: b.tags || [],
    session: b.session || null,
    when: b.when || null,
    archived: !!b.archived,
  }));

  const filtered = filterByTime(rows, {
    sinceT: opts.sinceT,
    untilT: opts.untilT,
    fromDate: opts.fromDate,
    toDate: opts.toDate,
  }).sort((a, b) => a.id - b.id);

  const total = filtered.length;
  const offset = Math.max(0, intOption(opts.offset, 0));
  const wanted = intOption(opts.limit, DEFAULT_SEARCH_LIMIT);
  const limit = wanted > 0 ? wanted : null;
  const turns = limit === null ? filtered.slice(offset) : filtered.slice(offset, offset + limit);

  return { turns, total, offset, limit, hasMore: offset + turns.length < total };
}

// ============================================================
// 文件抽取（关联图派生也用这一份：Action 里「这轮动过哪些文件」全项目只有一个判据）
// ============================================================

function extractFilesFromBlock(block) {
  const files = [];
  if (block.actions) {
    for (const action of block.actions) {
      if (!action) continue;
      // 优先用 files（含自然语言 Action 里提到的所有路径），回落 file
      if (action.files && action.files.length > 0) {
        files.push(...action.files);
      } else if (action.file) {
        files.push(action.file);
      }
    }
  }
  return files;
}

// ============================================================
// search — 时间窗口过滤 + 分页（扫描路径）
// ============================================================

/**
 * 把 `2026-11-05` 这种日期字符串转成可比较的整数（yyyymmdd）。
 * 无效输入一律返回 null，让调用方按"没给过滤条件"处理，而不是报错。
 */
function parseDateOpt(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1] + m[2] + m[3], 10);
}

/**
 * 把 when 对象（parseWhenLine 返回值）转成"可比较的日期整数"。
 * kind='day' 取 when.date；kind='range'/'instant' 取 from 里的日期部分。
 * kind='text' 或 when=null → null（没法判断在不在窗口里）。
 */
function whenDateInt(when) {
  if (!when) return null;
  if (when.kind === 'day') return parseDateOpt(when.date);
  if (when.kind === 'range' || when.kind === 'instant') {
    // '2026-11-05 14:47' → 取前 10 个字符的日期部分
    const from = String(when.from || '').slice(0, 10);
    return parseDateOpt(from);
  }
  return null; // text kind 或未知形状
}

/**
 * 根据时间 / T 号窗口过滤搜索结果。
 *
 * 过滤窗口来自四组参数，两两等价：
 *   sinceUntilT  —— T 号窗口（闭区间，>= since && <= until）
 *   fromDate / toDate —— 日期窗口（闭区间，>= from && <= to）
 *
 * ADR / R / pref 等非 T / FIX 文档没有时间字段：如果指定了时间窗口（from/to），
 * 直接排除 —— 它们本身不产生时间语义；但指定 T 号窗口时，ADR 有 createdAt，
 * R 有 openedAt/completedAt，pref 就只保留（它没有时间）。
 *
 * FIX 文档用 targetId（它更正的那轮）的时间和 T 号过滤 —— FIX 没有自己的 WHEN 结构行，
 * 过滤语义就是"这轮的更正跟它更正的原话一起进出时间窗口"。
 *
 * @param {object[]} rows - shapeHits 的结果
 * @param {object} opts - { sinceT, untilT, fromDate, toDate }
 */
function filterByTime(rows, opts = {}) {
  const sinceT = typeof opts.sinceT === 'number' ? opts.sinceT : null;
  const untilT = typeof opts.untilT === 'number' ? opts.untilT : null;
  const fromInt = parseDateOpt(opts.fromDate);
  const toInt = parseDateOpt(opts.toDate);
  if (sinceT === null && untilT === null && fromInt === null && toInt === null) return rows;

  return rows.filter((row) => {
    let tId = null;
    let dateInt = null;

    if (row.type === 'T') {
      tId = row.id;
      dateInt = whenDateInt(row.when);
    } else if (row.type === 'FIX') {
      tId = row.targetId;
      dateInt = whenDateInt(row.when);
    } else if (row.type === 'ADR') {
      tId = row.createdAt || null;
      // ADR 没有日期字符串，不参与日期窗口过滤
    } else if (row.type === 'R') {
      tId = row.openedAt || null;
    } else {
      // pref 等：既没有 tId 也没有 when；如果有过滤条件就排除
      if (sinceT !== null || untilT !== null || fromInt !== null || toInt !== null) return false;
      return true;
    }

    // T 号窗口
    if (sinceT !== null && (tId === null || tId < sinceT)) return false;
    if (untilT !== null && (tId === null || tId > untilT)) return false;

    // 日期窗口：没有 when 的 T/FIX 轮次直接排除（它的结构行就是没写时间）
    if (fromInt !== null) {
      if (dateInt === null || dateInt < fromInt) return false;
    }
    if (toInt !== null) {
      if (dateInt === null || dateInt > toInt) return false;
    }

    return true;
  });
}

/**
 * 搜索的统一入口：现场扫描 + 时间窗口过滤 + 分页。
 *
 * Lite 没有索引缓存（那是 full 模式的性能层），所以这里的 useIndex 参数
 * 只保留形状兼容（收下、忽略、如实报 viaIndex:false）—— 两个包的 CLI/MCP
 * 不必为"有没有索引"长出两套参数表。
 *
 * 时间窗口过滤在拿到 rows 之后、分页之前施加：分页在过滤后的结果上算，
 * 不出现"过滤掉 3 条但 total 还是原始总数"的口径漂移。
 * 截断不是静默的：结果带 total / hasMore，`--limit 0` 明确取全量。
 *
 * @param {string} pocketDir
 * @param {string} keyword
 * @param {object} [opts]
 * @param {number} [opts.limit=50] - 本页条数；0 或负数 = 不限
 * @param {number} [opts.offset=0] - 跳过前 N 条
 * @param {number} [opts.sinceT] - T 号下界（闭区间），与 untilT 组合成 T 号窗口
 * @param {number} [opts.untilT] - T 号上界（闭区间）
 * @param {string} [opts.fromDate] - 日期下界 yyyy-mm-dd（闭区间）
 * @param {string} [opts.toDate] - 日期上界 yyyy-mm-dd（闭区间）
 * @returns {{ results: object[], total: number, offset: number, limit: number|null, hasMore: boolean, viaIndex: boolean }}
 */
function searchAny(pocketDir, keyword, opts = {}) {
  const rows = scanAll(pocketDir, keyword);

  // 时间窗口过滤在分页之前施加，保证 total 和分页口径都是过滤后的真实总数
  const filtered = filterByTime(rows, opts);

  const total = filtered.length;
  const offset = Math.max(0, intOption(opts.offset, 0));
  const wanted = intOption(opts.limit, DEFAULT_SEARCH_LIMIT);
  const limit = wanted > 0 ? wanted : null;
  const results = limit === null ? filtered.slice(offset) : filtered.slice(offset, offset + limit);

  return {
    results,
    total,
    offset,
    limit,
    hasMore: offset + results.length < total,
    viaIndex: false,
  };
}

// ============================================================
// why — 反向检索：按文件路径找相关 T-block（借鉴 ThoughtDAG）
// ============================================================

/**
 * 给定文件路径，找出提到该文件的所有 T-block，并区分证据强度。
 * 适用于回答"这个文件为什么被改"、"什么时候被引入"
 *
 * 证据分级（一个文件"出现在一轮里"不等于"这一轮改了它"）：
 * - `evidence: 'changed'`  —— Action 小节里有这个路径：这一轮确实动了它。
 * - `evidence: 'mentioned'` —— 只在别的小节里出现（Attachments 挂的截图、
 *   Uncertain 里待查的路径、Conflicts 点名的模块、Pitfalls 举的例子……）。
 * 返回值按 changed 在前、mentioned 在后排序，各组内最近的在前面，所以截断到
 * limit 时先掉的是"只提到过"的轮次，不会把真正的改动记录挤掉。
 *
 * @param {string} pocketDir
 * @param {string} filePath - 完整或部分文件路径
 * @param {object} [opts]
 * @param {number} [opts.limit=10] - 最多返回 N 条
 * @returns {object[]} 匹配的 T-block 列表（改过的在前面，组内最近的在前面）
 */
function why(pocketDir, filePath, opts = {}) {
  if (!filePath || typeof filePath !== 'string') {
    return [];
  }

  const logData = parseLogAll(pocketDir);
  const limit = opts.limit || 10;
  // 统一路径分隔符（Windows/Unix 兼容）
  const needle = filePath.toLowerCase().replace(/\\/g, '/');
  const changed = [];
  const mentioned = [];

  // 文件引用在任何一节都可能出现：Action 改的文件、Attachments 挂的截图、
  // Uncertain 里待查的路径、Conflicts 里点名的模块……所以直接扫 constants 里那份
  // 唯一的节名清单。
  const SEARCHABLE = require('./constants').TBLOCK_SECTIONS;

  for (const block of logData.blocks) {
    const references = [];

    for (const section of SEARCHABLE) {
      const items = block.sections[section] || [];
      for (const item of items) {
        const lower = item.toLowerCase().replace(/\\/g, '/');
        if (lower.includes(needle)) {
          references.push({ section, text: item });
        }
      }
    }

    if (references.length === 0) continue;

    // Action 里的引用排前面，读的人先看到"这轮改了什么"
    references.sort((a, b) => (a.section === 'Action' ? -1 : 0) - (b.section === 'Action' ? -1 : 0));
    const match = {
      id: block.id,
      gist: block.gist,
      tags: block.tags,
      archived: !!block.archived,
      evidence: references.some((r) => r.section === 'Action') ? 'changed' : 'mentioned',
      references: references.slice(0, 5),
      refCount: references.length,
    };
    (match.evidence === 'changed' ? changed : mentioned).push(match);
  }

  // 组内倒序（最近的在前面），strong 组整体优先，最后截断到 limit
  changed.reverse();
  mentioned.reverse();
  return changed.concat(mentioned).slice(0, limit);
}

module.exports = {
  recall,
  recallWindow,
  // 关联图派生也用这一份文件抽取：Action 里「这轮动过哪些文件」全项目只能有一个判据
  extractFilesFromBlock,
  searchAny,
  why,
  // searchAny 与 recallWindow 共用的时间窗口过滤层：一个按关键词找，一个按坐标浏览，
  // 但"哪一轮在窗口里"只能有一份判据
  filterByTime,
  parseDateOpt,
  whenDateInt,
};
