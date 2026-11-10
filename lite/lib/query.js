'use strict';

/**
 * ContextPocket Lite — 查询模块
 *
 * recall / diff / search / why 的读侧，函数体从主包 lib/query.js 逐字搬运；
 * 被裁掉的是 check-conflicts 六维冲突引擎（写时冲突闸与扫描都属 full 能力面）。
 * 保留的每一个函数与主包逐字一致 —— 时间窗口判据、证据分级、
 * 更正闭环的语义不允许两个包各说一套（compat.js 有回归锁）。
 *
 * search 只走现场扫描（lib/search.js 的 scanAll），没有索引缓存。
 * 多跳扩展（--expand）走 links.js 的现场派生图（deriveLinks），同样零缓存：
 * expandTurns 与主包唯一差别是图从 deriveLinks 取，而非主包的 readGraph 缓存。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const path = require('path');
const { parseLogAll, parseAll } = require('./parser');
const { readFileSafe, intOption, extractFilesFromBlock } = require('./core');
const { scanAll } = require('./search');
const { deriveLinks, expandFrom } = require('./links');

// search 一页默认多少条：够一次屏幕，又不至于把 800 轮历史全量打印
const DEFAULT_SEARCH_LIMIT = 50;

// ============================================================
// recall — 查看指定轮次详情
// ============================================================

/**
 * 取某个 T-block 的原始文本：先 log.md，再 log-archive.md。
 *
 * 性能：recall 刚用 parseLogAll 解析过两份文件，块落在哪份、第几行已经知道
 * （block.source / block.startLine）。把这个 hints 收下来，就只读那一份文件、
 * 从已知行切起，省掉旧实现"两份各读一遍 + 从头扫到块头"的重复劳动。
 * 归档轮次因此少读一次 log.md。输出逐字不变：startLine 先按旧判据校验
 * （行首 `## T<tId> ·` 且编号命中），对不上就回落到原来的全文件扫描 ——
 * 畸形编号（块 id 是占位号段、行首却是原始畸形号）仍与旧实现一样取不到 rawText。
 *
 * @param {string} pocketDir
 * @param {number} tId
 * @param {object} [block] parseLogAll 已解析出的块（提供 source/startLine 提示）
 * @returns {{rawText: string|null, source: string|null}}
 */
function rawBlockText(pocketDir, tId, block) {
  const files = block && block.source ? [block.source] : ['log.md', 'log-archive.md'];
  for (const file of files) {
    const content = readFileSafe(path.join(pocketDir, file));
    if (!content) continue;

    const lines = content.split('\n');
    let startLine = -1;
    // 已知行号先验证再用：省掉从头扫描，但绝不信任一个对不上编号的提示
    const hint = block && block.source === file && Number.isInteger(block.startLine) ? block.startLine : -1;
    if (hint >= 0 && hint < lines.length) {
      const hm = lines[hint].match(/^##\s+T(\d+)\s*·/);
      if (hm && parseInt(hm[1], 10) === tId) startLine = hint;
    }
    if (startLine === -1) {
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^##\s+T(\d+)\s*·/);
        if (match && parseInt(match[1], 10) === tId) {
          startLine = i;
          break;
        }
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

  const { rawText, source } = rawBlockText(pocketDir, tId, block);
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
// 文件抽取：实现住在 lib/core.js（extractFilesFromBlock）
// ============================================================
//
// 关联图 links.js 与 diff 都要用它。留在 query 会形成 links → query → links 的
// 循环依赖（query 现在又要从 links 拿 deriveLinks/expandFrom 做多跳扩展），
// 所以与主包一样收敛到叶子模块 core，这里只再导出一次，老调用方不必改。

// ============================================================
// diff — 对比两轮
// ============================================================

/**
 * 对比两个 T-block，输出需求 / 决策 / 文件三个维度的增量。
 * 与主包 lib/query.js 逐字同源：归档轮次照样可比（块取自 parseLogAll），
 * 找不到任一轮抛 `T<n> not found`，由入口层翻译成报错。
 *
 * @param {string} pocketDir
 * @param {number} tA
 * @param {number} tB
 * @returns {object} 差异结果
 */
function diff(pocketDir, tA, tB) {
  const data = parseAll(pocketDir);
  // 块可以来自 log.md 或 log-archive.md：归档不应该让 diff 报 "T<n> not found"
  const blocks = parseLogAll(pocketDir).blocks;
  const blockA = blocks.find(b => b.id === tA);
  const blockB = blocks.find(b => b.id === tB);

  if (!blockA) {
    throw new Error(`T${tA} not found`);
  }
  if (!blockB) {
    throw new Error(`T${tB} not found`);
  }

  const result = {
    tA,
    tB,
    gistA: blockA.gist,
    gistB: blockB.gist,
    requirements: { added: [], completed: [], cancelled: [] },
    decisions: { added: [] },
    files: { added: [], removed: [], modified: [] },
  };

  // 1. 需求变化：在 tA 之后、tB 之前/之内新开 / 完成 / 取消的
  for (const req of data.requirements.items) {
    const openedAt = req.openedAt;
    const completedAt = req.completedAt;
    const cancelledAt = req.cancelledAt;

    if (openedAt > tA && openedAt <= tB) {
      result.requirements.added.push({
        id: req.id,
        text: req.text,
        status: req.status,
        openedAt,
      });
    }
    if (completedAt && completedAt > tA && completedAt <= tB) {
      result.requirements.completed.push({
        id: req.id,
        text: req.text,
        completedAt,
      });
    }
    if (cancelledAt && cancelledAt > tA && cancelledAt <= tB) {
      result.requirements.cancelled.push({
        id: req.id,
        text: req.text,
        cancelledAt,
      });
    }
  }

  // 2. 决策变化（新增 ADR）
  for (const adr of data.decisions.adrs) {
    if (adr.createdAt > tA && adr.createdAt <= tB) {
      result.decisions.added.push({
        id: adr.id,
        title: adr.title,
        createdAt: adr.createdAt,
      });
    }
  }

  // 3. 文件变化（从 Action 节提取）
  const filesA = extractFilesFromBlock(blockA);
  const filesB = extractFilesFromBlock(blockB);

  const setA = new Set(filesA);
  const setB = new Set(filesB);

  for (const f of filesB) {
    if (!setA.has(f)) {
      result.files.added.push(f);
    }
  }
  for (const f of filesA) {
    if (!setB.has(f)) {
      result.files.removed.push(f);
    }
  }
  // 两个都有的视为修改过
  for (const f of filesB) {
    if (setA.has(f)) {
      result.files.modified.push(f);
    }
  }

  return result;
}

// ============================================================
// 多跳扩展（--expand <n>）：why / search 共享的一份实现
// ============================================================

/**
 * 从种子节点出发走 N 跳，把新到达的**轮次**取出来。
 *
 * 只取 turn 节点：文件和 ADR 混进「哪些轮次碰过这个文件」的结果里，语义会变含混
 * （它们不是轮次）。它们在 `graph` 命令里看得到。
 *
 * 与主包唯一差别：图从现场 deriveLinks 取（Lite 零缓存），而非主包 readGraph
 * 的 assets/graph.jsonl。expandFrom 是纯函数，两边对同一份口袋给出同一组节点。
 *
 * @param {string} pocketDir
 * @param {string[]} seedIds 起点节点 id
 * @param {number} depth 跳数（1-3）
 * @returns {Array<{id:number, gist:string, tags:string[], archived:boolean, distance:number, via:string}>}
 */
function expandTurns(pocketDir, seedIds, depth) {
  if (!seedIds || seedIds.length === 0) return [];
  const graph = deriveLinks(pocketDir);
  const res = expandFrom(graph, seedIds, depth);
  const out = [];
  for (const n of res.nodes) {
    if (n.type !== 'turn') continue;
    const id = parseInt(String(n.id).slice(1), 10);
    if (!Number.isFinite(id)) continue;
    out.push({
      id,
      gist: n.label,
      tags: [],
      archived: n.archived,
      distance: n.distance,
      via: n.via,
    });
  }
  return out;
}

/** 索引行 → 图节点 id。认不出来的类型（偏好行）返回 null。 */
function rowToNodeId(row) {
  if (!row) return null;
  if (row.type === 'T') return 'T' + row.id;
  if (row.type === 'FIX') return 'T' + row.targetId + '-fix';
  if (row.type === 'ADR') return 'adr:ADR-' + row.adrId;
  if (row.type === 'R') return 'req:R' + row.rId;
  return null;
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
 * @param {number} [opts.expand=0] - 多跳扩展深度（0 = 不扩展，行为逐字不变；上限 3）
 * @returns {{ results: object[], total: number, offset: number, limit: number|null, hasMore: boolean, viaIndex: boolean, expandedCount: number }}
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

  // 多跳扩展：默认 0 = 行为逐字不变（compat 锁盯着这一点）。扩展出来的轮次
  // **追加在分页之后**，所以 total / hasMore 仍然是关键词命中的口径，不会被撑大。
  // 图走现场 deriveLinks（零缓存），与主包 readGraph 对同一份口袋给出同一组节点。
  const depth = intOption(opts.expand, 0);
  let expanded = [];
  if (depth > 0 && results.length > 0) {
    const seeds = results.map(rowToNodeId).filter(Boolean);
    const seen = new Set(results.filter((r) => r.type === 'T').map((r) => 'T' + r.id));
    expanded = expandTurns(pocketDir, seeds, depth)
      .filter((t) => !seen.has('T' + t.id))
      .map((t) => ({
        type: 'T',
        id: t.id,
        gist: t.gist,
        tags: t.tags,
        archived: t.archived,
        when: null,
        matchCount: 0,
        highlights: [],
        distance: t.distance,
        via: t.via,
        expanded: true,
      }));
  }

  return {
    results: results.concat(expanded),
    total,
    offset,
    limit,
    hasMore: offset + results.length < total,
    viaIndex: false,
    expandedCount: expanded.length,
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
 * @param {number} [opts.expand=0] - 多跳扩展深度（0 = 不扩展；扩展轮次 evidence='linked'）
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
  const direct = changed.concat(mentioned).slice(0, limit);

  // 多跳扩展：默认 0 = 行为逐字不变。扩展出来的轮次追加在后面，
  // evidence 标成 'linked'（不是 changed 也不是 mentioned —— 它没碰过这个文件，
  // 是通过图上的关系连过来的），调用方据此分开显示。
  const depth = intOption(opts.expand, 0);
  if (depth > 0 && direct.length > 0) {
    const seen = new Set(direct.map((r) => 'T' + r.id));
    const extra = expandTurns(pocketDir, [...seen], depth)
      .filter((t) => !seen.has('T' + t.id))
      .map((t) => ({
        id: t.id,
        gist: t.gist,
        tags: t.tags,
        archived: t.archived,
        evidence: 'linked',
        distance: t.distance,
        via: t.via,
        references: [],
      }));
    return direct.concat(extra);
  }
  return direct;
}

module.exports = {
  recall,
  recallWindow,
  diff,
  // 文件抽取的实现已收敛到 core（避免 links → query → links 循环）；这里再导出一次，
  // 老调用方与 compat 测试不必改 import 路径
  extractFilesFromBlock,
  searchAny,
  why,
  // 多跳扩展：why / search 共享。rowToNodeId 把检索行映射成图节点 id
  expandTurns,
  rowToNodeId,
  // searchAny 与 recallWindow 共用的时间窗口过滤层：一个按关键词找，一个按坐标浏览，
  // 但"哪一轮在窗口里"只能有一份判据
  filterByTime,
  parseDateOpt,
  whenDateInt,
};
