'use strict';

/**
 * ContextPocket — 关联图（Phase 0 只读原型 + Phase 1 缓存）
 *
 * 从已有的 log.md / log-archive.md / decisions.md / code-map.md 确定性派生节点与边。
 * 不调用模型、不引入依赖：图是派生品，真值永远在那几份 Markdown 里
 * （见 docs/ROADMAP-2.0.md §3.3）。
 *
 * Phase 0：`deriveLinks` 纯运行时派生，零写盘 —— `recall --with-context` 至今走这条路，
 * 保证"同一口袋输出逐字一致"，永不受缓存新鲜度影响。
 * Phase 1：`assets/graph.jsonl` 缓存（一行一条记录，meta 在第一行）。它是**可删的
 * 索引缓存**，与 assets/search-index.json 同一定位：
 *   - 删掉后 `graph rebuild` 从源 Markdown 逐字重建（字节级一致，有回归锁）；
 *   - 每条记录可溯源（source + tId），人可以 grep、git 可以 diff；
 *   - 新鲜度按四个源文件的 sha1 签名判定，源动了缓存自动判 stale，
 *     `graph`（查看）像 search 一样现场自愈重写，`graph verify` 只报不写。
 *
 * 证据分层直接沿用 lib/parser.js：Action 里的 files 是「这轮动过」（强证据），
 * 其他小节里出现的路径只是「这轮谈到过」（弱证据）。弱边带 evidence:'weak'，
 * 默认不进上下文摘要 —— 否则会和 why / verify 一样把幻影路径当成真实改动。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { parseLogAll, parseDecisions } = require('./parser');
const { readFileSafe } = require('./core');
const { writeAtomic } = require('./io');
const { extractFilesFromBlock } = require('./query');

const STRONG = 'strong';
const WEAK = 'weak';

function normFile(p) {
  return String(p).trim().replace(/\\/g, '/');
}

function turnNodeId(tId) {
  return 'T' + tId;
}

function fileNodeId(p) {
  return 'file:' + normFile(p);
}

function adrNodeId(n) {
  return 'adr:ADR-' + n;
}

/** 'T12' → 12；'T7-fix' / 'file:x' / 其它形态 → null */
function turnNum(id) {
  const m = /^T(\d+)$/.exec(String(id));
  return m ? parseInt(m[1], 10) : null;
}

/**
 * 派生整张图。纯函数（只读磁盘），同一份口袋每次调用结果逐字一致。
 * @param {string} pocketDir
 * @returns {{nodes: Array, edges: Array, stats: object}}
 */
function deriveLinks(pocketDir) {
  const nodes = new Map();
  const edges = new Map();

  const addNode = (id, type, label, extra) => {
    if (!nodes.has(id)) nodes.set(id, Object.assign({ id, type, label: label || '' }, extra || {}));
  };

  // 同一对节点、同一种关系只留一条：Action 里同一路径被写两次不该造出两条边。
  const addEdge = (e) => {
    const key = [e.from, e.type, e.to].join('\u0000');
    if (edges.has(key)) return;
    edges.set(key, {
      from: e.from,
      to: e.to,
      type: e.type,
      evidence: e.evidence || STRONG,
      source: e.source,
      tId: e.tId === undefined ? null : e.tId,
      via: e.via || null,
    });
  };

  const logData = parseLogAll(pocketDir);

  for (const block of logData.blocks) {
    const from = turnNodeId(block.id);
    const source = block.source || 'log.md';
    addNode(from, 'turn', block.gist, { archived: !!block.archived, source });

    for (const f of extractFilesFromBlock(block)) {
      const to = fileNodeId(f);
      addNode(to, 'file', normFile(f));
      addEdge({ from, to, type: 'modifies', source, tId: block.id });
    }

    for (const m of (block.mentions || [])) {
      const to = fileNodeId(m.path);
      addNode(to, 'file', normFile(m.path));
      addEdge({ from, to, type: 'mentions', source, tId: block.id, evidence: WEAK, via: m.section });
    }

    // `Corrects T<n>` 是显式引用，普通轮次也可能带 [correction] 标签
    for (const target of (block.corrects || [])) {
      addEdge({ from, to: turnNodeId(target), type: 'references', source, tId: block.id, via: 'corrects' });
    }
  }

  // `## T<n>-fix` 不是 T-block（不参与发号），单独作为更正节点连到被更正的轮次
  for (const fix of (logData.fixBlocks || [])) {
    addNode(fix.fixId, 'correction', fix.gist, { source: 'log.md' });
    addEdge({ from: fix.fixId, to: turnNodeId(fix.targetId), type: 'references', source: 'log.md', tId: fix.targetId, via: 'fix' });
    for (const target of (fix.corrects || [])) {
      addEdge({ from: fix.fixId, to: turnNodeId(target), type: 'references', source: 'log.md', tId: target, via: 'corrects' });
    }
  }

  for (const adr of parseDecisions(pocketDir).adrs) {
    const from = adrNodeId(adr.id);
    addNode(from, 'decision', adr.title);
    addEdge({ from, to: turnNodeId(adr.createdAt), type: 'decided-in', source: 'decisions.md', tId: adr.createdAt });
    const sup = /ADR-(\d+)/i.exec(String(adr.supersedes || ''));
    if (sup) {
      addEdge({ from, to: adrNodeId(sup[1]), type: 'supersedes', source: 'decisions.md', tId: adr.createdAt });
    }
  }

  // code-map 的 `T<n>: <last change>` 行按最近的文件条目归属。
  // 尽力而为：手写格式解析不到就不建边，绝不猜 —— 无来源的边一律不建。
  const codeMap = readFileSafe(path.join(pocketDir, 'code-map.md')) || '';
  const dirsAtDepth = [];
  let currentFile = null;
  for (const line of codeMap.split('\n')) {
    // 与 parser.parseCodeMapEntries 同一套「深度 → 目录前缀」算法，
    // 这样模板里的真实目录树（src/ 下面挂 a.ts）也能拼出完整路径，
    // 不会把 a.ts 和 log 里的 src/a.ts 当成两个不同节点。
    const connIdx = line.search(/[├└]/);
    if (connIdx !== -1) {
      const depth = Math.floor(connIdx / 4);
      const text = line.slice(connIdx + 4).trim();
      const entry = /^(.+?)\s*→\s*(.+)$/.exec(text);
      const name = entry ? entry[1].trim() : text;
      if (name.endsWith('/')) {
        dirsAtDepth[depth] = name;
        dirsAtDepth.length = depth + 1;
      } else if (entry) {
        currentFile = normFile(dirsAtDepth.slice(0, depth).join('') + name);
      }
    }
    const changed = /^\s*[│\s]*T(\d+)\s*:\s*(.*)$/.exec(line);
    if (changed && currentFile) {
      // code-map 树里的条目常只写文件名（src/ 是上一行目录），而 log 里是完整路径。
      // 精确命中优先；否则按 basename 找**唯一**一个已知文件节点，歧义就跳过。
      // 宁可少一条边，也不造幽灵节点 —— 与 writer 的「歧义不配对」同一取舍。
      let target = fileNodeId(currentFile);
      if (!nodes.has(target)) {
        const base = currentFile.split('/').pop();
        const matches = [...nodes.values()].filter(
          (n) => n.type === 'file' && n.id.slice(5).split('/').pop() === base
        );
        if (matches.length === 1) target = matches[0].id;
      }
      if (!nodes.has(target)) continue;
      const tId = parseInt(changed[1], 10);
      addEdge({ from: target, to: turnNodeId(tId), type: 'last-changed', source: 'code-map.md', tId, via: changed[2].trim() });
    }
  }

  // 过滤掉指向幽灵节点的边（例如 decisions.md 引用了一个不存在的 T 号），
  // 再按 (type, from, to) 稳定排序，保证输出可复现、可写回归锁。
  const nodeIds = new Set(nodes.keys());
  const outEdges = [...edges.values()]
    .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
    .sort((a, b) => a.type.localeCompare(b.type) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const outNodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));

  const byType = {};
  for (const e of outEdges) byType[e.type] = (byType[e.type] || 0) + 1;

  return {
    nodes: outNodes,
    edges: outEdges,
    stats: { nodes: outNodes.length, edges: outEdges.length, byType },
  };
}

/**
 * 单轮的「入向上下文」：谁引用了它、它改过的文件后来又被谁改过、它关联到哪些
 * ADR、它碰过哪些文件。全部来自 deriveLinks 的强证据边；弱证据默认折叠。
 *
 * @param {string} pocketDir
 * @param {number} tId
 * @param {{graph?: object, includeWeak?: boolean, limit?: number}} [opts]
 */
function buildContext(pocketDir, tId, opts = {}) {
  const graph = opts.graph || deriveLinks(pocketDir);
  const id = turnNodeId(tId);
  const limit = opts.limit === undefined ? 10 : opts.limit;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const gistOf = (nid) => (byId.get(nid) || {}).label || '';

  const referencedBy = graph.edges
    .filter((e) => e.type === 'references' && e.to === id)
    .map((e) => ({ ref: e.from, tId: turnNum(e.from), gist: gistOf(e.from), via: e.via || 'corrects' }))
    .sort((a, b) => String(a.ref).localeCompare(String(b.ref)));

  const myFiles = new Set(
    graph.edges.filter((e) => e.type === 'modifies' && e.from === id).map((e) => e.to)
  );
  const laterChanges = graph.edges
    .filter((e) => e.type === 'modifies' && myFiles.has(e.to) && e.from !== id && turnNum(e.from) > tId)
    .map((e) => ({ file: e.to.slice(5), tId: turnNum(e.from), gist: gistOf(e.from) }))
    .sort((a, b) => a.tId - b.tId || a.file.localeCompare(b.file))
    .slice(0, limit < 0 ? Infinity : limit);

  const decisions = graph.edges
    .filter((e) => e.type === 'decided-in' && e.to === id)
    .map((e) => ({ adr: e.from.slice(4), title: gistOf(e.from) }))
    .sort((a, b) => a.adr.localeCompare(b.adr));

  const lastChanged = graph.edges.filter((e) => e.type === 'last-changed');
  const relatedFiles = [...myFiles].map((f) => {
    const turns = lastChanged.filter((e) => e.from === f && e.tId !== null).map((e) => e.tId);
    return { file: f.slice(5), lastChangedT: turns.length ? Math.max(...turns) : null };
  }).sort((a, b) => a.file.localeCompare(b.file));

  const weakMentions = opts.includeWeak
    ? graph.edges
      .filter((e) => e.type === 'mentions' && e.from === id)
      .map((e) => ({ file: e.to.slice(5), section: e.via || '' }))
      .sort((a, b) => a.file.localeCompare(b.file))
    : [];

  return {
    tId,
    referencedBy,
    laterChanges,
    decisions,
    relatedFiles,
    weakMentions,
    counts: {
      referencedBy: referencedBy.length,
      laterChanges: laterChanges.length,
      decisions: decisions.length,
      relatedFiles: relatedFiles.length,
      weakMentions: weakMentions.length,
    },
  };
}

/** CLI 与 MCP 共用的一份上下文措辞，避免两个入口各写一套、语义慢慢漂开。 */
function formatContextLines(ctx) {
  const lines = [];
  for (const r of ctx.referencedBy) {
    lines.push(`- Referenced by: ${r.ref}${r.gist ? ' · ' + r.gist : ''} (${r.via === 'fix' ? 'correction block' : 'Corrects T' + ctx.tId})`);
  }
  for (const c of ctx.laterChanges) {
    lines.push(`- Later change: ${c.file} ← T${c.tId}${c.gist ? ' · ' + c.gist : ''}`);
  }
  for (const d of ctx.decisions) {
    lines.push(`- Decision: ${d.adr}${d.title ? ' · ' + d.title : ''}`);
  }
  for (const f of ctx.relatedFiles) {
    lines.push(`- Related file: ${f.file}${f.lastChangedT ? ' (last changed T' + f.lastChangedT + ')' : ''}`);
  }
  for (const w of ctx.weakMentions) {
    lines.push(`- Mentioned (weak): ${w.file} in ${w.section}`);
  }
  if (lines.length === 0) lines.push('- (no inbound links derived yet)');
  return lines;
}

// ============================================================
// Phase 1：assets/graph.jsonl 缓存（Node schema v2 的落盘载体）
// ============================================================

/**
 * 派生这张图会读到的**全部**源文件。签名字段与派生输入必须同源：
 * 这里少列一个文件，缓存就会在「那个文件变了」时仍然自称 fresh；
 * 多列一个（比如 index.md），签名就会在无关写入后误报 stale。
 */
const GRAPH_SOURCE_FILES = ['code-map.md', 'decisions.md', 'log-archive.md', 'log.md'];

/**
 * 缓存格式版本（Node schema v2 的第一版序列化）。派生规则变了
 * （加一种边、改一处归属判定、改字段）就必须 bump：旧缓存据此判
 * schema 不符 → stale → 读取时自动重写，不需要任何手工迁移。
 */
const GRAPH_SCHEMA = 'graph/1';

const GRAPH_FILE = 'graph.jsonl';

function graphPath(pocketDir) {
  return path.join(pocketDir, 'assets', GRAPH_FILE);
}

/** 四个源文件各自的 sha1。纯函数：同内容同签名，跨平台一致（不受 mtime/行尾影响） */
function sourceSignature(pocketDir) {
  const sources = {};
  for (const name of GRAPH_SOURCE_FILES) {
    const p = path.join(pocketDir, name);
    const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
    sources[name] = crypto.createHash('sha1').update(text, 'utf-8').digest('hex');
  }
  return sources;
}

/**
 * 图 → JSONL 文本。第一行 meta，之后一行一个节点、一行一条边。
 * 顺序完全由 deriveLinks 的稳定排序决定，所以同一份口袋永远得到同一串字节
 * （「删缓存能逐字重建」的回归锁盯的就是这个性质）。
 */
function serializeGraph(graph, sources) {
  const lines = [JSON.stringify({ kind: 'meta', schema: GRAPH_SCHEMA, sources })];
  for (const n of graph.nodes) {
    const rec = { kind: 'node', id: n.id, type: n.type, label: n.label };
    if (n.archived !== undefined) rec.archived = n.archived;
    if (n.source !== undefined) rec.source = n.source;
    lines.push(JSON.stringify(rec));
  }
  for (const e of graph.edges) {
    lines.push(JSON.stringify({
      kind: 'edge',
      from: e.from,
      to: e.to,
      type: e.type,
      evidence: e.evidence,
      source: e.source,
      tId: e.tId,
      via: e.via,
    }));
  }
  return lines.join('\n') + '\n';
}

/**
 * JSONL 文本 → { meta, nodes, edges, issues }。issue 非空 = 缓存损坏
 * （非法 JSON / 不认识的记录 / 第一行不是 meta / schema 不符）。
 * 解析器只做形状校验，不猜语义：坏一行记一行，绝不静默跳过。
 */
function parseGraphText(text) {
  const nodes = [];
  const edges = [];
  const issues = [];
  let meta = null;
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === lines.length - 1 && line === '') continue; // 文件尾的换行
    if (!line.trim()) {
      issues.push({ line: i + 1, problem: 'blank line' });
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (e) {
      issues.push({ line: i + 1, problem: 'invalid JSON: ' + e.message });
      continue;
    }
    if (rec.kind === 'meta' && i === 0) {
      meta = rec;
      if (rec.schema !== GRAPH_SCHEMA) {
        issues.push({ line: 1, problem: `schema "${rec.schema}" ≠ "${GRAPH_SCHEMA}" (deriver changed)` });
      }
    } else if (rec.kind === 'node' && typeof rec.id === 'string' && typeof rec.type === 'string') {
      nodes.push(rec);
    } else if (rec.kind === 'edge' && typeof rec.from === 'string' && typeof rec.to === 'string' && typeof rec.type === 'string') {
      edges.push(rec);
    } else {
      issues.push({ line: i + 1, problem: rec.kind === 'meta' ? 'meta record not on line 1' : 'unrecognised record' });
    }
  }
  if (!meta) issues.push({ line: 1, problem: 'first line must be the meta record' });
  return { meta, nodes, edges, issues };
}

/** 从已解析的记录重算 stats（readGraph 从缓存读图时用） */
function statsFromRecords(nodes, edges) {
  const byNodeType = {};
  for (const n of nodes) byNodeType[n.type] = (byNodeType[n.type] || 0) + 1;
  const byType = {};
  for (const e of edges) byType[e.type] = (byType[e.type] || 0) + 1;
  return { nodes: nodes.length, edges: edges.length, byNodeType, byType };
}

/**
 * 强制（重）写缓存：deriveLinks → serialize → writeAtomic。
 * `graph rebuild`、stale/corrupt 自愈、migrate/repair 收尾都走这里。
 * @returns {{path:string, graph:object, stats:object, nodes:number, edges:number, bytes:number}}
 */
function writeGraphCache(pocketDir) {
  const graph = deriveLinks(pocketDir);
  const text = serializeGraph(graph, sourceSignature(pocketDir));
  const p = graphPath(pocketDir);
  writeAtomic(p, text);
  return {
    path: p,
    graph,
    stats: graph.stats,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    bytes: Buffer.byteLength(text, 'utf-8'),
  };
}

/**
 * 只看缓存现状，不写盘。status ∈ missing / corrupt / stale / fresh。
 * corrupt/stale 都带可读的 issues / reason，`graph verify` 原样转述。
 */
function graphCacheStatus(pocketDir) {
  const p = graphPath(pocketDir);
  if (!fs.existsSync(p)) {
    return { status: 'missing', path: p };
  }
  let text;
  try {
    text = fs.readFileSync(p, 'utf-8');
  } catch (e) {
    return { status: 'corrupt', path: p, issues: [{ line: 0, problem: e.message }] };
  }
  const parsed = parseGraphText(text);
  if (parsed.issues.length > 0) {
    return { status: 'corrupt', path: p, issues: parsed.issues };
  }
  const sources = sourceSignature(pocketDir);
  const cached = parsed.meta.sources || {};
  const same = GRAPH_SOURCE_FILES.every((n) => cached[n] === sources[n])
    && Object.keys(cached).length === GRAPH_SOURCE_FILES.length;
  if (!same) {
    return { status: 'stale', path: p, reason: 'source files changed since the cache was written' };
  }
  return { status: 'fresh', path: p, parsed, stats: statsFromRecords(parsed.nodes, parsed.edges) };
}

/**
 * `graph verify`：缓存与源是否一致。missing 算通过（缓存是可选物，recall 不依赖它）；
 * stale / corrupt / 被人手改（签名没动但字节对不上）都是失败。
 */
function verifyGraphCache(pocketDir) {
  const status = graphCacheStatus(pocketDir);
  if (status.status === 'missing') {
    return {
      ok: true,
      status: 'missing',
      path: status.path,
      message: 'No graph cache (it is optional — recall --with-context derives on the fly). Run "context-pocket graph rebuild" to create one.',
    };
  }
  if (status.status === 'corrupt') {
    return { ok: false, status: 'corrupt', path: status.path, issues: status.issues };
  }
  if (status.status === 'stale') {
    return { ok: false, status: 'stale', path: status.path, reason: status.reason };
  }
  // 签名 fresh 只说明「四个源文件没动过」。这里再逐字比对一遍：
  // 挡住「源没动、缓存被人手改」的篡改 —— 图必须与源完全一致，而不是签名一致。
  const fresh = serializeGraph(deriveLinks(pocketDir), sourceSignature(pocketDir));
  const onDisk = fs.readFileSync(status.path, 'utf-8');
  if (onDisk !== fresh) {
    return { ok: false, status: 'tampered', path: status.path, reason: 'cache bytes differ from a fresh derivation of the same sources' };
  }
  return { ok: true, status: 'fresh', path: status.path, stats: status.stats };
}

/**
 * `graph`（查看）的读路径：fresh 就用缓存，否则像 search 一样**现场自愈**
 * （derive → 写回 → 返回派生结果）。返回的 graph 形状与 deriveLinks 相同，
 * buildContext / 后续多跳可以直接吃。
 */
function readGraph(pocketDir) {
  const status = graphCacheStatus(pocketDir);
  if (status.status === 'fresh') {
    const g = status.parsed;
    return {
      graph: { nodes: g.nodes, edges: g.edges, stats: statsFromRecords(g.nodes, g.edges) },
      cacheStatus: 'fresh',
      rebuilt: false,
      previousStatus: 'fresh',
      path: status.path,
    };
  }
  const w = writeGraphCache(pocketDir);
  return {
    graph: w.graph,
    cacheStatus: 'fresh',
    rebuilt: true,
    previousStatus: status.status,
    path: w.path,
  };
}

/**
 * migrate / repair 的收尾钩子：**只在该口袋已经用过 graph 缓存时**才重写。
 * 从没建过缓存的口袋保持零新增文件 —— 「v1 口袋零改动可读」承诺的一部分。
 * @returns {boolean} 是否真的重写了
 */
function refreshGraphCacheIfExists(pocketDir) {
  if (!fs.existsSync(graphPath(pocketDir))) return false;
  writeGraphCache(pocketDir);
  return true;
}

module.exports = {
  deriveLinks,
  buildContext,
  formatContextLines,
  STRONG,
  WEAK,
  // Phase 1：graph.jsonl 缓存
  GRAPH_SOURCE_FILES,
  GRAPH_SCHEMA,
  GRAPH_FILE,
  graphPath,
  sourceSignature,
  serializeGraph,
  parseGraphText,
  writeGraphCache,
  graphCacheStatus,
  verifyGraphCache,
  readGraph,
  refreshGraphCacheIfExists,
};
