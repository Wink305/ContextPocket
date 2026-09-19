'use strict';

/**
 * ContextPocket — 检索索引层
 * 架构借鉴 Basic Memory：Markdown 文件是唯一真相源，索引只是派生缓存。
 *
 * ContextPocket/ 下的 .md 永远先写；本模块在 assets/search-index.json 维护一份
 * 可随时重建的倒排索引，让 T-block 增长到几百上千轮后 search 依然即时。
 *
 * 索引范围：
 *   - log.md + log-archive.md 的所有 T-block（gist / tags / 全部子节）
 *   - decisions.md 的 ADR（title / context / decision / consequences）
 *   - requirements.md 的需求（text）
 *   - preferences.md 的偏好行
 *
 * 分词：拉丁词按非字母数字切分（"parser.js" → parser + js）；CJK 文本取二字组
 * （bigram），中英混合查询均可命中。查询用 AND 语义，命中后再用子串校验去噪。
 *
 * 刷新策略（懒刷新）：search 前对比源文件 mtime+size 签名，变了就自动增量重建；
 * 也可以显式 `context-pocket index --rebuild`。索引损坏 / 缺失 → 调用方回退到全量扫描。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readFileSafe, fileExists } = require('./core');
const {
  parseLogText,
  parseRequirements,
  parseDecisions,
  parsePreferences,
} = require('./parser');

const INDEX_VERSION = 1;
const MAX_DOC_TEXT = 4000; // 单个文档存进索引的最大字符数（用于命中后校验/高亮）
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;

// 参与签名判定的源文件（任一变化即视为索引过期）
const SOURCE_FILES = [
  'log.md',
  'log-archive.md',
  'decisions.md',
  'requirements.md',
  'preferences.md',
];

// ============================================================
// 小工具
// ============================================================

function indexPath(pocketDir) {
  return path.join(pocketDir, 'assets', 'search-index.json');
}

function hashText(text) {
  return crypto.createHash('sha1').update(String(text), 'utf-8').digest('hex');
}

/**
 * 分词：拉丁词 + CJK 二字组
 * @param {string} text
 * @returns {string[]} 去重后的词元
 */
function tokenize(text) {
  const terms = [];
  if (!text) return terms;

  const lower = String(text).toLowerCase().replace(/\\/g, '/');

  // 拉丁/数字词（CJK 字符不算分隔符，混排词也能整体保留）
  const words = lower.split(/[^a-z0-9\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/);
  for (const w of words) {
    if (!w) continue;
    terms.push(w);
    // 拆子词："parser.js" → parser / js，"keep-alive" → keep / alive
    if (/[._\-]/.test(w)) {
      for (const s of w.split(/[._\-]+/)) {
        if (s && s !== w) terms.push(s);
      }
    }
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
  let text = block.gist || '';
  if (block.tags && block.tags.length > 0) {
    text += '\n' + block.tags.join(' ');
  }
  for (const items of Object.values(block.sections || {})) {
    text += '\n' + items.join('\n');
  }
  return {
    type: 'T',
    tId: block.id,
    gist: block.gist || '',
    tags: block.tags || [],
    sections: block.sections || {},
    session: block.session || null,
    text: text.slice(0, MAX_DOC_TEXT),
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
      docs.set(key, blockToDoc(block));
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
// 索引构建（增量 / 全量）
// ============================================================

function sourceSignature(pocketDir) {
  const sig = {};
  for (const f of SOURCE_FILES) {
    const p = path.join(pocketDir, f);
    if (fileExists(p)) {
      try {
        const st = fs.statSync(p);
        sig[f] = `${st.mtimeMs}:${st.size}`;
      } catch (e) {
        sig[f] = 'err';
      }
    }
  }
  return sig;
}

function loadIndex(pocketDir) {
  const p = indexPath(pocketDir);
  if (!fileExists(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!raw || raw.version !== INDEX_VERSION || !raw.docs || !raw.postings) {
      return null;
    }
    return raw;
  } catch (e) {
    return null;
  }
}

function saveIndex(pocketDir, index) {
  const p = indexPath(pocketDir);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(p, JSON.stringify(index), 'utf-8');
}

/**
 * 文档的加权字段：[text, weight]
 * gist / title 命中权重高，普通内容权重 1
 */
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
    case 'R':
      return [[doc.text, 2]];
    default:
      return [[doc.text, 1]];
  }
}

/**
 * 构建（或增量刷新）索引
 * @param {string} pocketDir
 * @param {object} [opts]
 * @param {boolean} [opts.rebuild=false] - 忽略旧索引全量重建
 * @returns {object} { docsCount, termsCount, added, updated, removed, reused, tookMs, path, rebuilt }
 */
function buildIndex(pocketDir, opts = {}) {
  const started = Date.now();
  const old = opts.rebuild ? null : loadIndex(pocketDir);
  const { docs, latestT } = collectDocs(pocketDir);

  let added = 0;
  let updated = 0;
  let removed = 0;
  let reused = 0;

  // 与旧索引对账：hash 相同的直接复用，避免重复分词
  const finalDocs = {};
  for (const [key, doc] of docs) {
    const withHash = { ...doc, hash: hashText(doc.text) };
    const prev = old && old.docs[key];
    if (prev && prev.hash === withHash.hash) {
      finalDocs[key] = prev;
      reused++;
    } else {
      finalDocs[key] = withHash;
      if (prev) updated++;
      else added++;
    }
  }
  if (old) {
    for (const key of Object.keys(old.docs)) {
      if (!docs.has(key)) removed++;
    }
  }

  // postings 全量重建（分词是内存操作，几千文档也在毫秒级）
  const postings = {};
  for (const [key, doc] of Object.entries(finalDocs)) {
    for (const [text, weight] of docFields(doc)) {
      for (const term of tokenize(text)) {
        if (!postings[term]) postings[term] = {};
        if (!postings[term][key] || postings[term][key] < weight) {
          postings[term][key] = weight;
        }
      }
    }
  }

  const index = {
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    latestT,
    sources: sourceSignature(pocketDir),
    docs: finalDocs,
    postings,
  };
  saveIndex(pocketDir, index);

  return {
    docsCount: Object.keys(finalDocs).length,
    termsCount: Object.keys(postings).length,
    added,
    updated,
    removed,
    reused,
    tookMs: Date.now() - started,
    path: indexPath(pocketDir),
    rebuilt: !old,
  };
}

/**
 * 确保索引新鲜：签名一致 → 直接返回；过期/缺失 → 自动增量重建。
 * 任何失败都返回 null（调用方回退到全量扫描，绝不让索引问题阻断搜索）。
 * @param {string} pocketDir
 * @returns {object|null}
 */
function ensureFreshIndex(pocketDir) {
  try {
    const index = loadIndex(pocketDir);
    const sig = sourceSignature(pocketDir);
    if (index && JSON.stringify(index.sources || {}) === JSON.stringify(sig)) {
      return index;
    }
    buildIndex(pocketDir, {});
    return loadIndex(pocketDir);
  } catch (e) {
    return null;
  }
}

// ============================================================
// 索引搜索
// ============================================================

function normText(s) {
  return String(s || '').toLowerCase().replace(/\\/g, '/');
}

/**
 * 用倒排索引搜索（AND 语义 + 子串校验）
 * @param {string} pocketDir
 * @param {string} keyword
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @returns {object[]|null} null = 索引不可用（调用方回退全量扫描）
 */
function searchWithIndex(pocketDir, keyword, opts = {}) {
  const index = ensureFreshIndex(pocketDir);
  if (!index) return null;

  const kw = String(keyword || '').trim();
  if (!kw) return null;

  // 直接按 T-id 命中
  const tIdMatch = kw.match(/^T(\d+)$/i);
  if (tIdMatch) {
    const doc = index.docs['T' + parseInt(tIdMatch[1], 10)];
    return doc ? [formatDocHit(doc, [{ field: 'gist', text: doc.gist || doc.text }], 1)] : [];
  }

  const tokens = tokenize(kw);
  if (tokens.length === 0) return null;

  // AND：每个词元都得命中
  const scores = {}; // docKey -> 累计权重
  const hits = {}; // docKey -> 命中的词元数
  for (const term of tokens) {
    const posting = index.postings[term];
    if (!posting) return []; // 某个词元没有任何文档命中 → 整体为空
    for (const [key, w] of Object.entries(posting)) {
      hits[key] = (hits[key] || 0) + 1;
      scores[key] = (scores[key] || 0) + w;
    }
  }

  let candidates = Object.keys(scores)
    .filter(key => hits[key] === tokens.length)
    .sort((a, b) => {
      if (scores[b] !== scores[a]) return scores[b] - scores[a];
      const da = index.docs[a];
      const db = index.docs[b];
      const ta = da.type === 'T' ? da.tId : 0;
      const tb = db.type === 'T' ? db.tId : 0;
      return tb - ta;
    });

  const limit = opts.limit || 50;
  const results = [];
  for (const key of candidates) {
    if (results.length >= limit) break;
    const doc = index.docs[key];
    if (!doc) continue;

    // 子串校验去噪 + 生成高亮
    const highlights = [];
    let matchCount = 0;
    for (const [text, weight] of docFields(doc)) {
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
      void weight;
    }
    if (highlights.length === 0) continue;

    results.push(formatDocHit(doc, highlights, matchCount));
  }

  return results;
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
      return { ...base, id: doc.tId, gist: doc.gist, tags: doc.tags || [] };
    case 'ADR':
      return { ...base, adrId: doc.adrId, title: doc.title, createdAt: doc.createdAt };
    case 'R':
      return { ...base, rId: doc.rId, text: doc.text, status: doc.status, uncertain: doc.uncertain };
    default:
      return { ...base, line: doc.text };
  }
}

module.exports = {
  buildIndex,
  searchWithIndex,
  ensureFreshIndex,
  tokenize,
  indexPath,
  loadIndex,
};
