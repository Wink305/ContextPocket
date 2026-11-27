'use strict';

/**
 * ContextPocket yuan — 工作区检索索引（阶段 2）
 *
 * 每个口袋各自的 Markdown 仍是唯一真相源；这里在**工作区根**维护一份
 * `.contextpocket/search-index.json`，把所有口袋的轮次、ADR、需求、偏好、
 * 红线合成一个跨口袋倒排索引。它只是派生缓存，删掉随时可重建。
 *
 * 与 quan 的 `assets/search-index.json` 的区别：
 *   - 位置在工作区，覆盖多个口袋，查询一次就能跨口袋排序；
 *   - 用 BM25 打分（quan 是字段权重累加），并叠加短语命中加成与
 *     近期优先的平局规则 —— 这就是 yuan 的"混合检索"；
 *   - 只读命令可以懒重建，也可以 `--no-index` 走现场扫描。
 *
 * 刷新策略：按每个口袋的源文件 mtime+size 做签名；签名不变的口袋直接复用
 * 旧文档（不重新解析、不重新分词），变了的才重建。索引缺失 / 版本不符 /
 * 签名过期都会自动重建。
 */

const fs = require('fs');
const path = require('path');

const { readManifest, resolvePocket, parsePocketAll, cacheDir, searchWorkspace } = require('./workspace');
const { whenDate } = require('./recap');
const { tokenize } = require('./indexer');
const { bm25Score } = require('./rank');
const { writeAtomic } = require('./io');
const { readKnowledgeBase, knowledgeSignature, KNOWLEDGE_DIR } = require('./workspace-knowledge');

// 文档集合/打分规则变了就升版本，旧缓存整体作废
// v2：新增 K（知识）文档；文档集合变了，旧缓存作废。
const INDEX_VERSION = 2;
const INDEX_FILE = 'search-index.json';
const MAX_TEXT = 4000;

// 参与签名的源文件（任一变化即视为该口袋过期）
const SOURCE_FILES = [
  'log.md',
  'log-archive.md',
  'decisions.md',
  'requirements.md',
  'preferences.md',
  'absolute.md',
];

const MEMO_LIMIT = 8;
const memo = new Map();

function indexPath(root) {
  return path.join(cacheDir(root), INDEX_FILE);
}

function sourceSignature(pocketDir) {
  const sig = {};
  for (const file of SOURCE_FILES) {
    const filePath = path.join(pocketDir, file);
    if (!fs.existsSync(filePath)) continue;
    try {
      const stat = fs.statSync(filePath);
      sig[file] = stat.mtimeMs + ':' + stat.size;
    } catch (e) {
      sig[file] = 'err';
    }
  }
  return sig;
}

function currentSignature(root, manifest) {
  return manifest.pockets.map((entry) => {
    const resolved = resolvePocket(root, entry);
    return {
      name: entry.name,
      path: entry.path,
      sources: resolved.exists ? sourceSignature(resolved.pocketDir) : null,
    };
  });
}

// ============================================================
// 文档构建
// ============================================================

function makeDoc(meta, fields) {
  const tf = {};
  const weights = {};
  let length = 0;
  for (const [text, weight] of fields) {
    if (!text) continue;
    for (const term of tokenize(text)) {
      tf[term] = (tf[term] || 0) + 1;
      if (!weights[term] || weights[term] < weight) weights[term] = weight;
      length += 1;
    }
  }
  const content = fields.map(([text]) => text || '').filter(Boolean).join('\n');
  return Object.assign({}, meta, {
    tf,
    weights,
    length,
    text: content.slice(0, MAX_TEXT),
  });
}

function sectionsText(block) {
  return Object.values(block.sections || {})
    .map((value) => (Array.isArray(value) ? value.join('\n') : String(value || '')))
    .filter(Boolean)
    .join('\n');
}

function collectDocs(entry, data) {
  const docs = {};
  const pocket = entry.name;
  const base = { pocket, pocketPath: entry.path };

  for (const block of data.log.blocks) {
    const tags = (block.tags || []).join(' ');
    docs[pocket + ':T' + block.id] = makeDoc(Object.assign({}, base, {
      key: pocket + ':T' + block.id,
      type: 'T',
      id: 'T' + block.id,
      label: block.gist || '',
      when: whenDate(block) || null,
      archived: !!block.archived,
    }), [
      [block.gist, 3],
      [tags, 2],
      [sectionsText(block), 1],
    ]);
  }

  data.log.fixBlocks.forEach((fix, i) => {
    const key = pocket + ':FIX:' + fix.fixId + ':' + i;
    const tags = (fix.tags || []).join(' ');
    docs[key] = makeDoc(Object.assign({}, base, {
      key,
      type: 'FIX',
      id: fix.fixId,
      label: fix.gist || '',
      when: null,
      archived: false,
    }), [
      [fix.gist, 3],
      [tags, 2],
      [(fix.body || []).join('\n') + '\n' + sectionsText(fix), 1],
    ]);
  });

  for (const adr of data.decisions.adrs) {
    const key = pocket + ':ADR-' + adr.id;
    const body = [adr.context, adr.options, adr.decision, adr.consequences].filter(Boolean).join('\n');
    docs[key] = makeDoc(Object.assign({}, base, {
      key,
      type: 'ADR',
      id: 'ADR-' + adr.id,
      label: adr.title || '',
      when: null,
      archived: false,
    }), [
      [adr.title, 3],
      [body, 1],
    ]);
  }

  for (const req of data.requirements.items) {
    const key = pocket + ':R' + req.id;
    docs[key] = makeDoc(Object.assign({}, base, {
      key,
      type: 'R',
      id: 'R' + req.id,
      label: req.text || '',
      status: req.status,
      when: null,
      archived: false,
    }), [
      [req.text, 2],
    ]);
  }

  (data.preferences.items || []).forEach((text, i) => {
    const key = pocket + ':pref:' + i;
    docs[key] = makeDoc(Object.assign({}, base, {
      key,
      type: 'pref',
      id: 'pref',
      label: text,
      when: null,
      archived: false,
    }), [
      [text, 1],
    ]);
  });

  for (const absolute of data.absolute.entries) {
    const key = pocket + ':ABS:T' + absolute.tId;
    docs[key] = makeDoc(Object.assign({}, base, {
      key,
      type: 'absolute',
      id: 'T' + absolute.tId,
      label: absolute.gist || absolute.content || '',
      when: null,
      archived: false,
    }), [
      [absolute.content, 3],
      [absolute.gist, 1],
    ]);
  }

  return docs;
}

// ============================================================
// 构建 / 刷新
// ============================================================

function loadIndex(root) {
  const file = indexPath(root);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!data || data.version !== INDEX_VERSION || !data.docs || !data.postings || !data.df) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function remember(root, signature, index) {
  const key = path.resolve(root);
  if (!memo.has(key) && memo.size >= MEMO_LIMIT) {
    memo.delete(memo.keys().next().value);
  }
  memo.set(key, { signature, index });
}

function buildIndex(root, manifest, signature, old) {
  const started = Date.now();
  const docs = {};
  const pockets = [];
  let rebuiltPockets = 0;
  let reusedPockets = 0;

  for (const entry of manifest.pockets) {
    const resolved = resolvePocket(root, entry);
    if (!resolved.exists) {
      pockets.push({ name: entry.name, path: entry.path, ok: false, error: 'missing ContextPocket/log.md', sources: null });
      continue;
    }

    const sources = sourceSignature(resolved.pocketDir);
    const previous = old && old.pockets.find((p) => p.name === entry.name && p.path === entry.path);
    const reusable = previous && JSON.stringify(previous.sources) === JSON.stringify(sources);
    pockets.push({ name: entry.name, path: entry.path, ok: true, sources });

    if (reusable) {
      reusedPockets += 1;
      for (const [key, doc] of Object.entries(old.docs)) {
        if (doc.pocket === entry.name) docs[key] = doc;
      }
      continue;
    }

    rebuiltPockets += 1;
    try {
      const data = parsePocketAll(resolved.pocketDir);
      Object.assign(docs, collectDocs(entry, data));
    } catch (e) {
      pockets[pockets.length - 1].ok = false;
      pockets[pockets.length - 1].error = e.message;
    }
  }

  const postings = {};
  const df = {};
  let totalLength = 0;
  const kb = readKnowledgeBase(root);
  for (const note of kb.notes) {
    const key = 'kb:' + note.id;
    const body = Object.values(note.sections || {}).flat().join('\n');
    docs[key] = makeDoc({
      key,
      type: 'K',
      pocket: 'kb',
      pocketPath: KNOWLEDGE_DIR,
      id: note.id,
      label: note.title,
      topic: note.topic,
      kind: note.kind,
      status: note.status,
      confidence: note.confidence,
      updated: note.updated || null,
      when: note.updated || null,
      archived: note.status === 'archived',
      sources: note.sources,
      tags: note.tags,
    }, [
      [note.title, 3],
      [note.topic, 2],
      [(note.tags || []).join(' '), 2],
      [(note.sources || []).join(' '), 2],
      [body, 1],
    ]);
  }
  for (const [key, doc] of Object.entries(docs)) {
    totalLength += doc.length;
    for (const term of Object.keys(doc.tf)) {
      if (!postings[term]) postings[term] = [];
      postings[term].push(key);
      df[term] = (df[term] || 0) + 1;
    }
  }

  const totalDocs = Object.keys(docs).length;
  const index = {
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    root,
    signature,
    pockets,
    totalDocs,
    avgLength: totalDocs > 0 ? totalLength / totalDocs : 0,
    knowledgeSignature: knowledgeSignature(root),
    docs,
    postings,
    df,
  };

  // 与旧索引对账：只用于报告，不参与重建决策
  let added = 0;
  let updated = 0;
  let removed = 0;
  const oldDocs = old ? old.docs : {};
  for (const key of Object.keys(docs)) {
    if (!oldDocs[key]) added += 1;
    else if (JSON.stringify(oldDocs[key]) !== JSON.stringify(docs[key])) updated += 1;
  }
  for (const key of Object.keys(oldDocs)) {
    if (!docs[key]) removed += 1;
  }

  return {
    index,
    stats: {
      rebuiltPockets,
      reusedPockets,
      added,
      updated,
      removed,
      tookMs: Date.now() - started,
      unchanged: !!(old && added === 0 && updated === 0 && removed === 0),
    },
  };
}

function writeIndex(root, index) {
  const file = indexPath(root);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeAtomic(file, JSON.stringify(index));
  remember(root, index.signature, index);
  return file;
}

/**
 * 构建或增量刷新工作区索引（显式命令用）。
 * @param {string} root
 * @param {object} [options]
 * @param {boolean} [options.rebuild] 忽略旧索引全量重建
 */
function indexWorkspace(root, options = {}) {
  const started = Date.now();
  const manifest = readManifest(root);
  const signature = JSON.stringify(currentSignature(root, manifest));
  const knowledgeSig = JSON.stringify(knowledgeSignature(root) || null);
  const old = options.rebuild ? null : loadIndex(root);

  let built;
  let unchanged = false;
  if (old && old.signature === signature && JSON.stringify(old.knowledgeSignature || null) === knowledgeSig) {
    remember(root, signature, old);
    built = {
      index: old,
      stats: { rebuiltPockets: 0, reusedPockets: manifest.pockets.length, added: 0, updated: 0, removed: 0, tookMs: Date.now() - started },
    };
    unchanged = true;
  } else {
    built = buildIndex(root, manifest, signature, old);
  }

  const file = unchanged ? indexPath(root) : writeIndex(root, built.index);
  const index = built.index;
  return {
    ok: true,
    root,
    workspace: manifest.name,
    path: file,
    docsCount: index.totalDocs,
    termsCount: Object.keys(index.df).length,
    pockets: index.pockets.length,
    rebuiltPockets: built.stats.rebuiltPockets,
    reusedPockets: built.stats.reusedPockets,
    added: built.stats.added,
    updated: built.stats.updated,
    removed: built.stats.removed,
    unchanged,
    tookMs: built.stats.tookMs,
  };
}

/**
 * 确保索引新鲜：签名一致直接复用，过期就增量重建。
 * 失败时返回 null，调用方回退到现场扫描。
 */
function ensureFreshIndex(root, options = {}) {
  try {
    const manifest = readManifest(root);
    const signature = JSON.stringify(currentSignature(root, manifest));
    const knowledgeSig = JSON.stringify(knowledgeSignature(root) || null);
    const key = path.resolve(root);
    const cached = memo.get(key);
    if (!options.rebuild && cached && cached.signature === signature
      && JSON.stringify((cached.index && cached.index.knowledgeSignature) || null) === knowledgeSig) {
      return cached.index;
    }

    const old = options.rebuild ? null : loadIndex(root);
    if (old && old.signature === signature && JSON.stringify(old.knowledgeSignature || null) === knowledgeSig) {
      remember(root, signature, old);
      return old;
    }

    const built = buildIndex(root, manifest, signature, old);
    writeIndex(root, built.index);
    return built.index;
  } catch (e) {
    return null;
  }
}

// ============================================================
// 查询
// ============================================================

function normalize(value) {
  return String(value === undefined || value === null ? '' : value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function filterSets(options) {
  const split = (value) => (value === undefined || value === null || value === '')
    ? null
    : new Set(String(value).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
  return { pockets: split(options.pockets), types: split(options.types) };
}

function queryIndex(index, keyword, options = {}) {
  const query = String(keyword || '').trim();
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(0, Number(options.limit)) : 20;
  const tokens = tokenize(query);
  const filters = filterSets(options);
  const empty = { total: 0, count: 0, limit, hasMore: false, results: [] };
  if (tokens.length === 0 || index.totalDocs === 0) return empty;

  // 词项 AND：从第一个词项的 posting 开始取交集
  let candidates = null;
  for (const term of tokens) {
    const posting = index.postings[term];
    if (!posting) return empty;
    if (candidates === null) candidates = new Set(posting);
    else candidates = new Set(posting.filter((key) => candidates.has(key)));
    if (candidates.size === 0) return empty;
  }

  const normQuery = normalize(query);
  const rows = [];
  for (const key of candidates) {
    const doc = index.docs[key];
    if (!doc) continue;
    if (filters.pockets && !filters.pockets.has(String(doc.pocket).toLowerCase())) continue;
    if (filters.types && !filters.types.has(String(doc.type).toLowerCase())) continue;

    let score = bm25Score({
      tf: doc.tf,
      length: doc.length,
      avgLength: index.avgLength,
      terms: tokens,
      df: index.df,
      totalDocs: index.totalDocs,
      weights: doc.weights,
    });

    // 短语加成：多词查询整串出现在正文里，说明命中比"词项散落"更可信
    const phrase = tokens.length > 1 && normQuery.length > 0 && normalize(doc.text).includes(normQuery);
    if (phrase) score *= 1.25;

    const highlights = [];
    const normTokens = tokens.map((term) => term);
    for (const line of String(doc.text || '').split('\n')) {
      const normalizedLine = normalize(line);
      if (!normalizedLine) continue;
      if (normTokens.some((term) => normalizedLine.includes(term))) {
        highlights.push({ field: doc.type, text: line.trim() });
        if (highlights.length >= 3) break;
      }
    }

    rows.push({
      pocket: doc.pocket,
      pocketPath: doc.pocketPath,
      type: doc.type,
      id: doc.id,
      label: doc.label,
      status: doc.status,
      when: doc.when || null,
      archived: !!doc.archived,
      topic: doc.topic || null,
      kind: doc.kind || null,
      confidence: doc.confidence || null,
      sources: doc.sources || null,
      score: Math.round(score * 1000) / 1000,
      phrase,
      highlights,
    });
  }

  // 排序：BM25 分数 → 时间（新的在前）→ 口袋 → key，保证分页稳定
  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aw = a.when || '';
    const bw = b.when || '';
    if (aw !== bw) return aw < bw ? 1 : -1;
    if (a.pocket !== b.pocket) return a.pocket < b.pocket ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return {
    total: rows.length,
    count: limit === 0 ? rows.length : Math.min(limit, rows.length),
    limit,
    hasMore: limit > 0 && rows.length > limit,
    results: limit === 0 ? rows : rows.slice(0, limit),
  };
}

/**
 * 工作区检索入口：默认走本地索引（BM25），索引不可用时回退现场扫描。
 *
 * @param {string} root
 * @param {string} keyword
 * @param {object} [options]
 * @param {number} [options.limit]
 * @param {string} [options.pockets] 逗号分隔的口袋名
 * @param {string} [options.types] 逗号分隔的类型（T/ADR/R/pref/absolute/FIX）
 * @param {boolean} [options.noIndex] 强制现场扫描
 * @param {boolean} [options.rebuildIndex] 强制重建索引
 */
function searchWorkspaceIndexed(root, keyword, options = {}) {
  if (!options.noIndex) {
    const index = ensureFreshIndex(root, { rebuild: !!options.rebuildIndex });
    if (index) {
      return Object.assign({ ok: true, root, keyword: String(keyword || '').trim(), mode: 'index' },
        queryIndex(index, keyword, options));
    }
  }
  const scanned = searchWorkspace(root, keyword, options);
  return Object.assign(scanned, { mode: 'scan' });
}

/**
 * 只检查索引是否存在、是否新鲜；不构建、不写盘。
 * @param {string} root
 */
function inspectIndex(root) {
  try {
    const manifest = readManifest(root);
    const signature = JSON.stringify(currentSignature(root, manifest));
    const index = loadIndex(root);
    if (!index) {
      return { present: false, fresh: false, docsCount: 0, termsCount: 0, builtAt: null, path: indexPath(root) };
    }
    return {
      present: true,
      fresh: index.signature === signature,
      docsCount: index.totalDocs,
      termsCount: Object.keys(index.df).length,
      builtAt: index.builtAt,
      path: indexPath(root),
    };
  } catch (e) {
    return { present: false, fresh: false, docsCount: 0, termsCount: 0, builtAt: null, error: e.message };
  }
}

module.exports = {
  INDEX_FILE,
  indexPath,
  indexWorkspace,
  inspectIndex,
  ensureFreshIndex,
  searchWorkspaceIndexed,
};
