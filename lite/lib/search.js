'use strict';

/**
 * ContextPocket Lite — 检索（现场扫描路径）
 *
 * 这是从主包 lib/indexer.js 里原样搬出来的「全量扫描」一侧：分词器、文档收集、
 * 命中整形与排序全部逐字一致 —— Lite 没有倒排索引缓存（assets/search-index.json
 * 属于 full 模式），search 永远现场扫描 Markdown 真相源，但匹配语义与主包的
 * `search --no-index` 逐字相同（lite/tests/compat.js 有回归锁盯着这一点）。
 *
 * 被裁掉的另一半（buildIndex / ensureFreshIndex / 索引读写与签名判定）是
 * 「快」的那一侧；Lite 的取舍见 docs/ROADMAP-2.0.md §5。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const path = require('path');
const { parseLogAll, parseLogText, parseDecisions, parseRequirements, parsePreferences } = require('./parser');
const { readFileSafe } = require('./core');

const MAX_DOC_TEXT = 4000; // 非 T 文档存进索引的最大字符数（用于命中后校验/高亮）
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

// ============================================================
// 分词
// ============================================================

/**
 * 分词：拉丁词 + CJK 二字组
 *
 * 中日韩的"整串"不产生词元：一个 run 会被分词器切成 `给搜索加时间分页` 这样一个
 * 不可再分的词元，只有查询与文档里那一串逐字相同时才命中，于是 `search 时间分页`
 * 判为不命中（它的每个二字组都在文档里）。run 的相邻二字组 + 单字 run 足够表达
 * 中文匹配，且仍然保持 AND 语义的连续性判别（查 `分页时间` 需要 `页时`，命不中）。
 * @param {string} text
 * @returns {string[]} 去重后的词元
 */
function tokenize(text) {
  const terms = [];
  if (!text) return terms;

  const lower = String(text).toLowerCase().replace(/\\/g, '/');

  // 拉丁/数字词。分隔符本身（空格、. _ - /）就已经把 "parser.js" 拆成
  // parser + js、"keep-alive" 拆成 keep + alive，所以这里不再二次拆词。
  const words = lower.split(/[^a-z0-9\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/);
  for (const w of words) {
    if (!w) continue;
    if (CJK_CHAR.test(w)) {
      // 中英混排（"索引v2"：汉字和字母之间没有分隔符，会被切成一整串）——
      // 中文部分交给下面的二字组，拉丁/数字片段仍然要单独成词，否则查 v2 命不中
      for (const frag of w.match(/[a-z0-9]+/g) || []) terms.push(frag);
      continue;
    }
    terms.push(w);
  }

  // CJK 二字组："数据库优化" → 数据 / 据库 / 优化 / 库优
  const runs = lower.match(CJK_RUN) || [];
  for (const run of runs) {
    if (run.length === 1) {
      terms.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      terms.push(run.slice(i, i + 2));
    }
  }

  // 去重
  return [...new Set(terms)];
}

// ============================================================
// 文档收集（真相源 → 索引文档）
// ============================================================

function blockToDoc(block) {
  return {
    type: 'T',
    tId: block.id,
    gist: block.gist || '',
    tags: block.tags || [],
    sections: block.sections || {},
    session: block.session || null,
    archived: !!block.archived,
    when: block.when || null,
  };
}

/**
 * 更正块（`## T<n>-fix · …`）→ FIX 文档。
 * text 带上 fixId 与正文全文：更正块就是要被搜出来的"当前事实"，
 * 搜关键词却命不中更正，等于让人继续读作废的原话。
 * when 取它更正的那轮（targetId）的时间：FIX 自己没有 WHEN 结构行，
 * 它的时间语义就是"这轮的更正发生在被更正轮之后的某个会话里"，
 * 过滤时间窗口时应该把 FIX 和它更正的轮一起放进区间。
 */
function fixToDoc(fix, archived, targetWhen) {
  return {
    type: 'FIX',
    fixId: fix.fixId,
    targetId: fix.targetId,
    gist: fix.gist || '',
    tags: fix.tags || [],
    text: [fix.fixId, ...(fix.body || []), ...Object.values(fix.sections || {}).flat()].join('\n').slice(0, MAX_DOC_TEXT),
    archived: !!archived,
    when: targetWhen || null,
  };
}

/**
 * 从各真相源收集全部索引文档
 * @param {string} pocketDir
 * @returns {{docs: Map<string, object>, latestT: number}}
 */
function collectDocs(pocketDir) {
  const docs = new Map();

  // T-block：log.md 优先，log-archive.md 补充（正常互不重叠）
  for (const file of ['log.md', 'log-archive.md']) {
    const content = readFileSafe(path.join(pocketDir, file));
    if (!content) continue;
    const data = parseLogText(content);
    for (const block of data.blocks) {
      const key = 'T' + block.id;
      if (docs.has(key)) continue;
      const doc = blockToDoc(block);
      // 归档块必须带上标记，否则"命中历史"和"命中当前日志"在结果里无法区分
      doc.archived = file === 'log-archive.md';
      docs.set(key, doc);
    }
    // 更正块（T<n>-fix）：key 用 fixId，手写撞名加 @n 后缀，绝不静默丢文档
    // when 取它更正的那轮的时间（targetWhen）：FIX 没有自己的 WHEN 结构行
    const whenByTId = new Map();
    for (const b of data.blocks) if (b.when) whenByTId.set(b.id, b.when);
    for (const fix of data.fixBlocks) {
      let key = fix.fixId;
      let n = 2;
      while (docs.has(key)) key = fix.fixId + '@' + n++;
      docs.set(key, fixToDoc(fix, file === 'log-archive.md', whenByTId.get(fix.targetId)));
    }
  }

  // ADR
  const decisions = parseDecisions(pocketDir);
  for (const adr of decisions.adrs) {
    const text = [
      adr.title,
      adr.context,
      adr.options,
      adr.decision,
      adr.consequences,
    ].filter(Boolean).join('\n');
    docs.set('ADR-' + adr.id, {
      type: 'ADR',
      adrId: adr.id,
      title: adr.title,
      createdAt: adr.createdAt,
      supersedes: adr.supersedes || 'none',
      text: text.slice(0, MAX_DOC_TEXT),
    });
  }

  // 需求
  const reqs = parseRequirements(pocketDir);
  for (const r of reqs.items) {
    docs.set('R' + r.id, {
      type: 'R',
      rId: r.id,
      status: r.status,
      uncertain: r.uncertain,
      text: r.text,
      openedAt: r.openedAt || null,
      completedAt: r.completedAt || null,
      cancelledAt: r.cancelledAt || null,
    });
  }

  // 偏好行
  const prefs = parsePreferences(pocketDir);
  prefs.items.forEach((line, i) => {
    docs.set('pref:' + i, { type: 'pref', idx: i, text: line });
  });

  return { docs, latestT: maxT(docs) };
}

function maxT(docs) {
  let latest = 0;
  for (const [key, doc] of docs) {
    if (doc.type === 'T' && doc.tId > latest) latest = doc.tId;
  }
  return latest;
}

// ============================================================
// 字段权重与命中整形
// ============================================================

function docFields(doc) {
  switch (doc.type) {
    case 'T':
      return [
        [doc.gist, 3],
        [(doc.tags || []).join(' '), 2],
        [Object.values(doc.sections || {}).flat().join('\n'), 1],
      ];
    case 'ADR':
      return [[doc.title, 3], [doc.text, 1]];
    case 'FIX':
      return [
        [doc.gist, 3],
        [(doc.tags || []).join(' '), 2],
        [doc.text, 1],
      ];
    case 'R':
      return [[doc.text, 2]];
    default:
      return [[doc.text, 1]];
  }
}

function normText(s) {
  return String(s || '').toLowerCase().replace(/\\/g, '/');
}

/**
 * `T7` 这样的查询直接命中那一轮，与走不走索引无关
 * @returns {object[]|null} null 表示这不是 id 形式的查询；命中不到该轮时返回空数组
 */
function idShortcutHit(pocketDir, kw) {
  const m = kw.match(/^T(\d+)$/i);
  if (!m) return null;
  const tId = parseInt(m[1], 10); // T007 归一到 T7，与文档 key 的写法一致
  const block = parseLogAll(pocketDir).blocks.find((item) => item.id === tId);
  if (!block) return [];
  const doc = blockToDoc(block);
  return [formatDocHit(doc, [{ field: 'gist', text: doc.gist || '' }], 1)];
}

/**
 * 排序：分数高在前，同分时 T-block 新近在前，再按 key 字典序。
 * 最后一级是必要的——分页的 offset 必须落在稳定的顺序上，否则同分的两批结果
 * 会在两次请求之间漂移，第 2 页里重复出现第 1 页的条目。
 */
function sortCandidates(candidates, docs) {
  return candidates.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = docs[a.key];
    const db = docs[b.key];
    // FIX 文档按它更正的轮号（targetId）参与新近排序：更正要跟着被更正的那轮走
    const turnOf = (d) => (d && d.type === 'T' ? d.tId : d && d.type === 'FIX' ? d.targetId : -1);
    const ta = turnOf(da);
    const tb = turnOf(db);
    if (tb !== ta) return tb - ta;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/**
 * 候选 → 结果行：子串校验去噪、高亮、schema 都在这里，只此一份。
 * 两条检索路径（倒排 / 现场扫描）共用，否则同一个关键词会给出不同数量、
 * 不同顺序、甚至不同形状的结果，分页与 --json 消费方都无法自洽。
 */
function shapeHits(docs, candidates, tokens) {
  const rows = [];
  for (const c of sortCandidates(candidates, docs)) {
    const doc = docs[c.key];
    if (!doc) continue;

    const highlights = [];
    let matchCount = 0;
    for (const [text] of docFields(doc)) {
      if (!text) continue;
      const hay = normText(text);
      if (!tokens.some(t => hay.includes(t))) continue;
      matchCount++;
      for (const line of text.split('\n')) {
        const lineNorm = normText(line);
        if (line && tokens.some(t => lineNorm.includes(t))) {
          highlights.push({ field: fieldOf(doc, text), text: line.trim() });
          break;
        }
      }
    }
    if (highlights.length === 0) continue;

    rows.push(formatDocHit(doc, highlights, matchCount));
  }
  return rows;
}

function fieldOf(doc, text) {
  switch (doc.type) {
    case 'T': {
      if (text === doc.gist) return 'gist';
      if ((doc.tags || []).join(' ') === text) return 'tags';
      for (const [section, items] of Object.entries(doc.sections || {})) {
        if (items.join('\n') === text) return section;
      }
      return 'gist';
    }
    case 'ADR':
      return text === doc.title ? 'title' : 'ADR';
    case 'FIX':
      if (text === doc.gist) return 'gist';
      if ((doc.tags || []).join(' ') === text) return 'tags';
      return 'fix';
    default:
      return 'content';
  }
}

function formatDocHit(doc, highlights, matchCount) {
  const base = {
    type: doc.type,
    matchCount,
    highlights: highlights.slice(0, 5),
  };
  switch (doc.type) {
    case 'T':
      return { ...base, id: doc.tId, gist: doc.gist, tags: doc.tags || [], archived: !!doc.archived, when: doc.when || null };
    case 'FIX':
      return { ...base, fixId: doc.fixId, targetId: doc.targetId, gist: doc.gist, tags: doc.tags || [], archived: !!doc.archived, when: doc.when || null };
    case 'ADR':
      return { ...base, adrId: doc.adrId, title: doc.title, createdAt: doc.createdAt };
    case 'R':
      return { ...base, rId: doc.rId, text: doc.text, status: doc.status, uncertain: doc.uncertain, openedAt: doc.openedAt || null };
    default:
      return { ...base, line: doc.text };
  }
}

// ============================================================
// 全量扫描（Lite 唯一的检索路径）
// ============================================================

/**
 * 全量扫描：不读索引文件，直接从 markdown 真相源现场分词。
 *
 * 与主包 lib/indexer.js 的 scanAll 严格同一套语义（同一个 tokenize、同样的分词
 * AND、同一份 shapeHits 与排序），所以 Lite 的 search 与主包的 `search --no-index`
 * 必然给出数量、顺序、形状都相同的结果 —— compat.js 的回归锁盯的就是这个。
 *
 * @param {string} pocketDir
 * @param {string} keyword
 * @returns {object[]}
 */
function scanAll(pocketDir, keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];

  // Exact T-id lookups only need the turn logs. Avoid parsing unrelated decision,
  // requirement and preference documents for this common shortcut.
  const shortcut = idShortcutHit(pocketDir, kw);
  if (shortcut !== null) return shortcut;

  const { docs } = collectDocs(pocketDir);
  const byKey = {};
  for (const [key, doc] of docs) byKey[key] = doc;

  const tokens = tokenize(kw);
  if (tokens.length === 0) return [];

  const candidates = [];
  for (const [key, doc] of docs) {
    const fields = docFields(doc).map(([text, weight]) => ({
      weight,
      terms: text ? new Set(tokenize(text)) : new Set(),
    }));
    let score = 0;
    let matched = true;
    for (const term of tokens) {
      let best = 0;
      for (const f of fields) {
        if (f.weight > best && f.terms.has(term)) best = f.weight;
      }
      if (best === 0) {
        matched = false;
        break;
      }
      score += best;
    }
    if (matched) candidates.push({ key, score });
  }

  return shapeHits(byKey, candidates, tokens);
}

module.exports = {
  scanAll,
  tokenize,
};
