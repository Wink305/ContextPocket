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
 * 刷新策略：search 前对比源文件 mtime+size 签名，变了就增量重建——只有内容真正
 * 变化的那几篇会重新分词，其余文档的词元直接续用；`context-pocket index --rebuild`
 * 强制全量。索引缺失 / 坏 JSON / INDEX_VERSION 对不上 / 签名过期 → ensureFreshIndex
 * 当场重建，搜索仍然走索引；只有重建本身失败（只读盘、索引路径被占位）才回退到
 * scanAll（现场分词）。两条路径的匹配与排序是同一份实现，结果完全一致。
 *
 * 常驻进程（MCP server）另有一层进程内缓存：签名一致时直接复用上一次的解析结果，
 * 不再读盘 + JSON.parse 整份 JSON；见下面的 indexMemo。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const fs = require('fs');
const path = require('path');
const { writeAtomic, readTextOr } = require('./io');
const crypto = require('crypto');
const { readFileSafe, fileExists } = require('./core');
const {
  parseLogText,
  parseRequirements,
  parseDecisions,
  parsePreferences,
} = require('./parser');

// v3：T 文档不再重复存整段 text（内容由 gist/tags/sections 承载），
// 检索语义也统一到"分词 AND + 同一份命中整形"，旧缓存必须整体作废重建
// v4：含 CJK 的整串词元（"给搜索加时间分页"）不再入库——它只在查询与文档那一串
// 逐字相同时才命中，`search 时间分页` 会被判为不命中。词元集合变了，旧缓存同样作废。
const INDEX_VERSION = 4;
const MAX_DOC_TEXT = 4000; // 非 T 文档存进索引的最大字符数（用于命中后校验/高亮）
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

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
  };
}

/**
 * 文档指纹：决定"这篇要不要重新分词"。
 * T 文档按结构化字段算，其余类型按 text —— 两者都不再需要额外存一份全文 text。
 */
function docHash(doc) {
  const parts = doc.type === 'T'
    ? [doc.gist, (doc.tags || []).join('\n'), JSON.stringify(doc.sections || {}), doc.session || '', doc.archived ? '1' : '0']
    : [String(doc.text || '')];
  return hashText(parts.join('\u0000'));
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
    const raw = JSON.parse(readTextOr(p, ''));
    if (!raw || raw.version !== INDEX_VERSION || !raw.docs || !raw.postings) {
      return null;
    }
    return raw;
  } catch (e) {
    return null;
  }
}

// ============================================================
// 进程内索引缓存
// ============================================================
//
// MCP server 是常驻进程：每次 search 都 loadIndex() 就要把整个
// assets/search-index.json（800 轮约 1 MB）读进来再 JSON.parse 一遍，
// 实测 ~60ms 全花在这一步，而内容往往一个字都没变。
// 这里按 pocketDir 记住"上次解析结果 + 当时的源文件签名"，签名一致就直接复用。
//
// 为什么这不会读到旧数据：索引内容完全由 SOURCE_FILES 派生，签名就是这些文件的
// mtime+size。签名变了 → 缓存作废 → 重新读盘并增量重建。签名没变而只有 json 文件
// 被别的进程重写，那份内容同样是从同一批源文件派生出来的，结果等价。
// 本进程自己写索引时（saveIndex）顺手更新缓存，所以刚 append 完再搜也不用再读盘。

const MEMO_LIMIT = 8; // 一个进程同时服务的项目数上限，超出按插入顺序淘汰最旧的
const indexMemo = new Map();

function memoKey(pocketDir) {
  return path.resolve(pocketDir);
}

function rememberIndex(pocketDir, index, sig) {
  const key = memoKey(pocketDir);
  if (!indexMemo.has(key) && indexMemo.size >= MEMO_LIMIT) {
    indexMemo.delete(indexMemo.keys().next().value);
  }
  indexMemo.set(key, { sig, index });
}

/**
 * 丢掉进程内缓存（测试用；也可用于显式让某个 pocket 重新读盘）。
 * @param {string} [pocketDir] 省略时清空全部
 */
function resetIndexMemo(pocketDir) {
  if (pocketDir === undefined) {
    indexMemo.clear();
    return indexMemo.size;
  }
  indexMemo.delete(memoKey(pocketDir));
  return indexMemo.size;
}

function saveIndex(pocketDir, index) {
  const p = indexPath(pocketDir);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  writeAtomic(p, JSON.stringify(index));
  rememberIndex(pocketDir, index, index.sources || {});
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

/** 把一篇文档的词元并进入 postings（同一 term 命中多字段时取最大权重） */
function addPostings(postings, key, doc) {
  for (const [text, weight] of docFields(doc)) {
    if (!text) continue;
    for (const term of tokenize(text)) {
      const cell = postings[term] || (postings[term] = {});
      if (!cell[key] || cell[key] < weight) cell[key] = weight;
    }
  }
}

/**
 * 从 postings 里摘掉若干篇文档的贡献（原地修改）。
 *
 * 摘除需要知道这些文档贡献过哪些词元 —— 现场把它们**旧内容**重新分词即可，
 * 一次 append 通常只有 1 篇变化，成本是"1 篇的分词"，而不是"全库的分词"，
 * 也不需要为每篇文档在索引里额外存一份词表（那会让文件体积 +50%，
 * 反而拖慢每次 search 的 JSON.parse）。
 */
function dropPostings(postings, stale) {
  for (const entry of stale) {
    for (const [text] of docFields(entry.doc)) {
      if (!text) continue;
      for (const term of tokenize(text)) {
        const cell = postings[term];
        if (!cell) continue;
        delete cell[entry.key];
        if (Object.keys(cell).length === 0) delete postings[term];
      }
    }
  }
  return postings;
}

/**
 * 构建（或增量刷新）索引
 * @param {string} pocketDir
 * @param {object} [opts]
 * @param {boolean} [opts.rebuild=false] - 忽略旧索引全量重建
 * @returns {object} { docsCount, termsCount, added, updated, removed, reused, retokenized, tookMs, path, rebuilt, unchanged? }
 */
function buildIndex(pocketDir, opts = {}) {
  const started = Date.now();
  const old = opts.rebuild ? null : loadIndex(pocketDir);
  const { docs, latestT } = collectDocs(pocketDir);

  let added = 0;
  let updated = 0;
  let removed = 0;
  let reused = 0;

  // 与旧索引对账：hash 相同的直接复用；只有新增/变化的文档需要重新分词
  const finalDocs = {};
  const fresh = [];   // [{key, doc}] 需要写入 postings 的
  const stale = [];   // [{key, doc}] 需要从 postings 摘掉的（旧内容）
  for (const [key, doc] of docs) {
    const withHash = { ...doc, hash: docHash(doc) };
    const prev = old && old.docs[key];
    if (prev && prev.hash === withHash.hash) {
      finalDocs[key] = prev;
      reused++;
      continue;
    }
    finalDocs[key] = withHash;
    fresh.push({ key, doc: withHash });
    if (prev) {
      updated++;
      stale.push({ key, doc: prev });
    } else {
      added++;
    }
  }
  if (old) {
    for (const key of Object.keys(old.docs)) {
      if (docs.has(key)) continue;
      removed++;
      stale.push({ key, doc: old.docs[key] });
    }
  }

  // 没有任何一篇变化（例如索引刚建好又跑了一次 index / append 被 --no-index 跳过）：
  // 原文件已经是正确答案，就别再花 30ms 序列化 + 写一遍 1MB，也别刷新 builtAt。
  if (old && old.postings && added === 0 && updated === 0 && removed === 0) {
    return {
      docsCount: Object.keys(finalDocs).length,
      termsCount: Object.keys(old.postings).length,
      added: 0,
      updated: 0,
      removed: 0,
      reused,
      retokenized: 0,
      tookMs: Date.now() - started,
      path: indexPath(pocketDir),
      rebuilt: false,
      unchanged: true,
    };
  }

  // postings：能续用就续用（先摘掉变化/删除文档的贡献，再补上新文档的），
  // 否则整体重建。分词是全量重建里最贵的一段（800 轮约 55ms），
  // 一次 append 只改 1 篇时不该为剩下的 799 篇再付一次。
  let postings;
  if (old && old.postings) {
    postings = dropPostings(old.postings, stale);
    for (const f of fresh) addPostings(postings, f.key, f.doc);
  } else {
    postings = {};
    for (const [key, doc] of Object.entries(finalDocs)) addPostings(postings, key, doc);
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
    // 本次真正重新分词的篇数：增量是否生效就看它是不是只等于变化的那几篇
    retokenized: fresh.length,
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
    const sig = sourceSignature(pocketDir);

    const memo = indexMemo.get(memoKey(pocketDir));
    if (memo && sameSig(memo.sig, sig)) return memo.index;

    const index = loadIndex(pocketDir);
    if (index && sameSig(index.sources, sig)) {
      rememberIndex(pocketDir, index, sig);
      return index;
    }
    buildIndex(pocketDir, {});
    const rebuilt = loadIndex(pocketDir);
    if (rebuilt) rememberIndex(pocketDir, rebuilt, rebuilt.sources || sig);
    return rebuilt;
  } catch (e) {
    return null;
  }
}

function sameSig(a, b) {
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}

// ============================================================
// 索引搜索
// ============================================================

function normText(s) {
  return String(s || '').toLowerCase().replace(/\\/g, '/');
}

/**
 * `T7` 这样的查询直接命中那一轮，与走不走索引无关
 * @returns {object[]|null} null 表示这不是 id 形式的查询；命中不到该轮时返回空数组
 */
function idShortcutHit(docs, kw) {
  const m = kw.match(/^T(\d+)$/i);
  if (!m) return null;
  const key = 'T' + parseInt(m[1], 10); // T007 归一到 T7，与文档 key 的写法一致
  const doc = docs[key];
  if (!doc || doc.type !== 'T') return [];
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
    const ta = da && da.type === 'T' ? da.tId : -1;
    const tb = db && db.type === 'T' ? db.tId : -1;
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

/**
 * 用倒排索引搜索（分词 AND + 子串校验）
 *
 * 不在这里截断结果：截断会让"命中多少条"变成"至少这么多"的猜测，
 * 而分页与 --json 都需要真实总数。limit / offset 由 lib/query.js 的 searchAny 统一施加。
 *
 * @param {string} pocketDir
 * @param {string} keyword
 * @returns {object[]|null} null = 索引或查询不可用（调用方回退全量扫描）
 */
function searchWithIndex(pocketDir, keyword) {
  const index = ensureFreshIndex(pocketDir);
  if (!index) return null;

  const kw = String(keyword || '').trim();
  if (!kw) return null;

  const shortcut = idShortcutHit(index.docs, kw);
  if (shortcut !== null) return shortcut;

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

  const candidates = Object.keys(scores)
    .filter(key => hits[key] === tokens.length)
    .map(key => ({ key, score: scores[key] }));

  return shapeHits(index.docs, candidates, tokens);
}

/**
 * 全量扫描：不读索引文件，直接从 markdown 真相源现场分词。
 *
 * 与 searchWithIndex 严格同一套语义（同一个 tokenize、同样的分词 AND、
 * 同一份 shapeHits 与排序），所以 `--no-index` 与走索引必然给出数量、顺序、
 * 形状都相同的结果。旧实现这里是另一套"子串包含"匹配，多词查询会与索引路径互相矛盾。
 *
 * @param {string} pocketDir
 * @param {string} keyword
 * @returns {object[]}
 */
function scanAll(pocketDir, keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];

  const { docs } = collectDocs(pocketDir);
  const byKey = {};
  for (const [key, doc] of docs) byKey[key] = doc;

  const shortcut = idShortcutHit(byKey, kw);
  if (shortcut !== null) return shortcut;

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
      return { ...base, id: doc.tId, gist: doc.gist, tags: doc.tags || [], archived: !!doc.archived };
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
  scanAll,
  ensureFreshIndex,
  resetIndexMemo,
  tokenize,
  indexPath,
  loadIndex,
};
