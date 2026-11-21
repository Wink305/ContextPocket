'use strict';

/**
 * ContextPocket — 关联图的纯派生层（quan / yuan 共用）
 *
 * 只做 derive / context / expansion / formatting，不读写缓存、不碰文件系统。
 * 缓存版本在 lib/links.js：它在这里的结果上加 graph.jsonl 签名与自愈。
 * xi 保留自己的运行时派生实现，不引入缓存层。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const path = require('path');
const { parseLogAll, parseDecisions, parseRequirements } = require('./parser');
const { readText } = require('./io');
const { extractFilesFromBlock } = require('./files');

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

function reqNodeId(rId) {
  return 'req:R' + rId;
}

function tagNodeId(name) {
  return 'tag:' + String(name).trim();
}

/**
 * 模板占位符形态的值（`<entry-file>`、`<req>`、`<files>`）——不是真实内容，
 * 不该变成图里的假节点。注意与 secrets.js 的同名函数不是一回事：那边是
 * 敏感信息启发式（短串也算占位），这里只认尖括号包裹，短的真实需求名
 * （比如「修 bug」）绝不能被误杀。与 lite/lib/links.js 同一份判据。
 */
function isPlaceholderValue(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s.length >= 2 && s.startsWith('<') && s.endsWith('>');
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
    const recordedAt = e.recordedAt === undefined
      ? (turnNum(e.from) === null ? e.tId : turnNum(e.from))
      : e.recordedAt;
    edges.set(key, {
      from: e.from,
      to: e.to,
      type: e.type,
      evidence: e.evidence || STRONG,
      source: e.source,
      tId: e.tId === undefined ? null : e.tId,
      recordedAt,
      validFrom: recordedAt,
      validTo: null,
      via: e.via || null,
    });
  };

  const logData = parseLogAll(pocketDir);

  for (const block of logData.blocks) {
    const from = turnNodeId(block.id);
    const source = block.source || 'log.md';
    addNode(from, 'turn', block.gist, { archived: !!block.archived, source });

    // 轮次自带的标签 → tag 节点（强证据：标签是块标题里显式写着的）
    for (const tag of (block.tags || [])) {
      const to = tagNodeId(tag);
      addNode(to, 'tag', String(tag).trim());
      addEdge({ from, to, type: 'tagged', source, tId: block.id });
    }

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
    addNode(fix.fixId, 'correction', fix.gist, { source: 'log.md', recordedAt: null, validFrom: null, validTo: null });
    addEdge({ from: fix.fixId, to: turnNodeId(fix.targetId), type: 'references', source: 'log.md', tId: fix.targetId, recordedAt: null, via: 'fix' });
    for (const target of (fix.corrects || [])) {
      addEdge({ from: fix.fixId, to: turnNodeId(target), type: 'references', source: 'log.md', tId: target, recordedAt: null, via: 'corrects' });
    }
  }

  for (const adr of parseDecisions(pocketDir).adrs) {
    const from = adrNodeId(adr.id);
    addNode(from, 'decision', adr.title, {
      recordedAt: adr.createdAt,
      validFrom: adr.createdAt,
      validTo: null,
    });
    addEdge({ from, to: turnNodeId(adr.createdAt), type: 'decided-in', source: 'decisions.md', tId: adr.createdAt });
    const sup = /ADR-(\d+)/i.exec(String(adr.supersedes || ''));
    if (sup) {
      addEdge({ from, to: adrNodeId(sup[1]), type: 'supersedes', source: 'decisions.md', tId: adr.createdAt });
      const superseded = nodes.get(adrNodeId(sup[1]));
      if (superseded && (superseded.validTo === null || adr.createdAt < superseded.validTo)) {
        superseded.validTo = adr.createdAt;
      }
    }
  }

  for (const node of nodes.values()) {
    if (node.type !== 'turn') continue;
    const tId = turnNum(node.id);
    node.recordedAt = tId;
    node.validFrom = tId;
    node.validTo = null;
  }

  // A later T-block that explicitly corrects an earlier one closes the earlier
  // turn's factual edges. The reference itself remains as permanent history.
  for (const edge of edges.values()) {
    if (edge.type !== 'references' || edge.via !== 'corrects' ||
        turnNum(edge.from) === null || turnNum(edge.to) === null) continue;
    const correctedTurn = edge.to;
    const correctedAt = edge.recordedAt;
    for (const fact of edges.values()) {
      if (fact.from !== correctedTurn || fact.type === 'references' || correctedAt === null) continue;
      if (fact.validTo === null || correctedAt < fact.validTo) fact.validTo = correctedAt;
    }
  }

  // 需求节点：条目里明确写着 opened T<n> / completed T<m> / impl: <files>，全是强证据。
  // lite 口袋没有 requirements.md，parseRequirements 返回空，这里自然不产生节点 ——
  // 派生规则与 lite/lib/links.js 同一份，两边对同一份口袋给出同一张图。
  for (const req of parseRequirements(pocketDir).items) {
    if (isPlaceholderValue(req.text)) continue;
    const from = reqNodeId(req.id);
    addNode(from, 'requirement', req.text, { source: 'requirements.md', status: req.status });

    if (req.openedAt) {
      addEdge({ from, to: turnNodeId(req.openedAt), type: 'opened-in', source: 'requirements.md', tId: req.openedAt });
    }
    if (req.completedAt) {
      addEdge({ from, to: turnNodeId(req.completedAt), type: 'completed-in', source: 'requirements.md', tId: req.completedAt });
    }
    for (const f of req.impl || []) {
      if (isPlaceholderValue(f)) continue;
      const to = fileNodeId(f);
      addNode(to, 'file', normFile(f));
      addEdge({ from, to, type: 'implements', source: 'requirements.md', tId: req.openedAt });
    }
    for (const tag of req.tags || []) {
      if (isPlaceholderValue(tag)) continue;
      const to = tagNodeId(tag);
      addNode(to, 'tag', String(tag).trim());
      addEdge({ from, to, type: 'tagged', source: 'requirements.md', tId: req.openedAt });
    }
  }

  // code-map 的 `T<n>: <last change>` 行按最近的文件条目归属。
  // 尽力而为：手写格式解析不到就不建边，绝不猜 —— 无来源的边一律不建。
  const codeMap = readText(path.join(pocketDir, 'code-map.md')) || '';
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
      // 模板里的 `<entry-file>` / `<subdir-1>/` 是占位，不是真路径。
      // 目录占位带尾斜杠，先剥掉再判，否则 `<subdir-1>/` 会漏进目录前缀
      if (isPlaceholderValue(name.replace(/\/$/, ''))) continue;
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

  // --rank：以本轮回种子跑个性化 PageRank，让「最相关」而非「最早/最字典序」靠前。
  // 关掉时完全不走这条路径，输出与旧版逐字一致。
  const ranked = opts.rank ? rankNeighbors(graph, [id]) : null;
  const relOf = (nid) => (ranked ? (ranked.get(nid) || 0) : 0);

  const referencedBy = graph.edges
    .filter((e) => e.type === 'references' && e.to === id)
    .map((e) => ({ ref: e.from, tId: turnNum(e.from), gist: gistOf(e.from), via: e.via || 'corrects' }))
    .sort(ranked
      ? (a, b) => relOf(b.ref) - relOf(a.ref) || String(a.ref).localeCompare(String(b.ref))
      : (a, b) => String(a.ref).localeCompare(String(b.ref)));

  const myFiles = new Set(
    graph.edges.filter((e) => e.type === 'modifies' && e.from === id).map((e) => e.to)
  );
  const laterChanges = graph.edges
    .filter((e) => e.type === 'modifies' && myFiles.has(e.to) && e.from !== id && turnNum(e.from) > tId)
    .map((e) => ({ file: e.to.slice(5), tId: turnNum(e.from), gist: gistOf(e.from) }))
    .sort(ranked
      ? (a, b) => relOf(turnNodeId(b.tId)) - relOf(turnNodeId(a.tId)) || a.tId - b.tId || a.file.localeCompare(b.file)
      : (a, b) => a.tId - b.tId || a.file.localeCompare(b.file))
    .slice(0, limit < 0 ? Infinity : limit);

  const decisions = graph.edges
    .filter((e) => e.type === 'decided-in' && e.to === id)
    .map((e) => ({ adr: e.from.slice(4), title: gistOf(e.from) }))
    .sort(ranked
      ? (a, b) => relOf('adr:' + b.adr) - relOf('adr:' + a.adr) || a.adr.localeCompare(b.adr)
      : (a, b) => a.adr.localeCompare(b.adr));

  const lastChanged = graph.edges.filter((e) => e.type === 'last-changed');
  const relatedFiles = [...myFiles].map((f) => {
    const turns = lastChanged.filter((e) => e.from === f && e.tId !== null).map((e) => e.tId);
    return { file: f.slice(5), lastChangedT: turns.length ? Math.max(...turns) : null };
  }).sort(ranked
    ? (a, b) => relOf('file:' + b.file) - relOf('file:' + a.file) || a.file.localeCompare(b.file)
    : (a, b) => a.file.localeCompare(b.file));

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

function graphQueryOptions(expand, asOf) {
  let depth = 0;
  if (expand !== undefined && expand !== null && expand !== false) {
    depth = expand === true ? 2 : Number(expand);
    if (!Number.isInteger(depth) || depth < 1 || depth > 3) {
      return { error: 'expand must be an integer from 1 to 3' };
    }
  }
  if (asOf !== undefined && asOf !== null) {
    asOf = Number(asOf);
    if (!Number.isInteger(asOf) || asOf < 0) {
      return { error: 'asOf must be a non-negative integer T-id' };
    }
    if (depth === 0) return { error: 'asOf requires expand' };
  }
  return { depth, asOf: asOf === undefined ? null : asOf };
}

function activeAt(record, asOf) {
  if (asOf === null) return true;
  if (record.recordedAt !== null && record.recordedAt !== undefined && record.recordedAt > asOf) return false;
  if (record.validFrom !== null && record.validFrom !== undefined && record.validFrom > asOf) return false;
  return record.validTo === null || record.validTo === undefined || asOf < record.validTo;
}

// ============================================================
// 个性化排名（--rank）
// ============================================================

/**
 * 从种子出发算「谁跟我有关」，而不是「谁离我近」。
 *
 * 借 Aider `repomap.py` 的 Personalized PageRank：给当前轮 / 本次查询命中的节点
 * 一个 personalization 向量，在无向强证据边上跑带阻尼的幂迭代；dangling 质量回流
 * 到 personalization（对齐 Aider 的 `dangling=personalization`），孤点锚回起点而非乱漂。
 *
 * 边权按关系分层：显式引用 / 决策 / 取代（3）> 实际改动 / 代码地图 / 需求生命周期（2）
 * > 仅仅贴标签（1）；弱证据 `mentions` 一律不参与，与 expandGraph 同一口径。高频共现不
 * 靠手写系数压制——出边按权重归一，枢纽节点的 rank 天然被摊薄（标准 PageRank 行为）。
 *
 * 确定性：节点与邻居按 id 排序遍历、固定迭代轮数、不做浮点提前收敛，两包对同一张图
 * 逐字得到同一串分数。本函数与 lite/lib/links.js 逐字同源，故内联时间谓词、不依赖 activeAt。
 */
const PPR_ALPHA = 0.85;
const PPR_ITERS = 40;
const EDGE_TYPE_WEIGHT = {
  'references': 3, 'decided-in': 3, 'supersedes': 3,
  'modifies': 2, 'last-changed': 2, 'opened-in': 2, 'completed-in': 2, 'implements': 2,
  'tagged': 1,
};

/**
 * @param {object} graph deriveLinks() 的结果
 * @param {string[]} seedIds personalization 种子节点 id
 * @param {{asOf?: number|null}} [opts]
 * @returns {Map<string, number>} 节点 id → 相关度分值
 */
function rankNeighbors(graph, seedIds, opts) {
  const options = opts || {};
  const asOf = options.asOf === undefined ? null : options.asOf;
  const active = (rec) => {
    if (asOf === null) return true;
    if (rec.recordedAt !== null && rec.recordedAt !== undefined && rec.recordedAt > asOf) return false;
    if (rec.validFrom !== null && rec.validFrom !== undefined && rec.validFrom > asOf) return false;
    return rec.validTo === null || rec.validTo === undefined || asOf < rec.validTo;
  };
  const nodeById = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const ids = [...nodeById.keys()].filter((id) => active(nodeById.get(id))).sort();
  const idSet = new Set(ids);
  const adj = new Map(ids.map((id) => [id, new Map()]));
  for (const e of graph.edges || []) {
    if (e.evidence === WEAK) continue;
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
    if (!active(e)) continue;
    const w = EDGE_TYPE_WEIGHT[e.type] || 1;
    adj.get(e.from).set(e.to, (adj.get(e.from).get(e.to) || 0) + w);
    adj.get(e.to).set(e.from, (adj.get(e.to).get(e.from) || 0) + w);
  }
  const seeds = [...new Set(seedIds || [])].filter((id) => idSet.has(id));
  const pers = new Map(ids.map((id) => [id, 0]));
  const share = seeds.length ? 1 / seeds.length : (ids.length ? 1 / ids.length : 0);
  if (seeds.length) {
    for (const s of seeds) pers.set(s, share);
  } else {
    for (const id of ids) pers.set(id, share);
  }
  const outList = new Map();
  const outTotal = new Map();
  for (const id of ids) {
    const nbrs = [...adj.get(id).entries()].sort((a, b) => a[0].localeCompare(b[0]));
    outList.set(id, nbrs);
    let total = 0;
    for (const pair of nbrs) total += pair[1];
    outTotal.set(id, total);
  }
  let r = new Map(pers);
  const next = new Map(ids.map((id) => [id, 0]));
  for (let it = 0; it < PPR_ITERS; it++) {
    for (const id of ids) next.set(id, 0);
    let dangling = 0;
    for (const id of ids) {
      const rid = r.get(id);
      if (rid === 0) continue;
      const total = outTotal.get(id);
      if (total === 0) { dangling += rid; continue; }
      for (const pair of outList.get(id)) next.set(pair[0], next.get(pair[0]) + rid * (pair[1] / total));
    }
    const tele = (1 - PPR_ALPHA) + PPR_ALPHA * dangling;
    for (const id of ids) r.set(id, PPR_ALPHA * next.get(id) + tele * pers.get(id));
  }
  return r;
}

/**
 * Expand graph neighbors from matching nodes without changing the source result
 * order. Edges are traversable in either direction, but retain their direction
 * and provenance in each path step.
 */
function expandGraph(graph, seeds, depth, opts = {}) {
  const asOf = opts.asOf === undefined ? null : opts.asOf;
  const maxNodes = opts.maxNodes === undefined ? 100 : opts.maxNodes;
  const excluded = new Set(opts.exclude || []);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const seedIds = [...new Set(seeds)].filter((id) => byId.has(id) && activeAt(byId.get(id), asOf)).sort();
  const adjacency = new Map();
  const addAdjacent = (id, item) => {
    if (!adjacency.has(id)) adjacency.set(id, []);
    adjacency.get(id).push(item);
  };

  for (const edge of graph.edges) {
    if (edge.evidence === WEAK || !activeAt(edge, asOf)) continue;
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to || !activeAt(from, asOf) || !activeAt(to, asOf)) continue;
    addAdjacent(edge.from, { id: edge.to, direction: 'outgoing', edge });
    addAdjacent(edge.to, { id: edge.from, direction: 'incoming', edge });
  }
  for (const items of adjacency.values()) {
    items.sort((a, b) => a.id.localeCompare(b.id) ||
      a.edge.type.localeCompare(b.edge.type) ||
      a.direction.localeCompare(b.direction));
  }

  const queue = seedIds.map((id) => ({ id, path: [] }));
  const visited = new Set(seedIds);
  const results = [];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    if (current.path.length >= depth) continue;
    for (const next of adjacency.get(current.id) || []) {
      if (visited.has(next.id)) continue;
      visited.add(next.id);
      const step = Object.assign({ direction: next.direction }, next.edge);
      const path = current.path.concat(step);
      const node = byId.get(next.id);
      if (!excluded.has(node.id)) {
        results.push({
          id: node.id,
          type: node.type,
          label: node.label,
          archived: !!node.archived,
          distance: path.length,
          path,
        });
      }
      queue.push({ id: next.id, path });
    }
  }
  if (opts.rank) {
    const scores = rankNeighbors(graph, seedIds, { asOf });
    for (const node of results) node.rank = scores.get(node.id) || 0;
    // 相关度优先，分值相同再按 id 定序 —— 距离/路径仍在结果里，只是不再决定顺序。
    results.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
  } else {
    results.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  }
  return { depth, asOf, results: results.slice(0, maxNodes), hasMore: results.length > maxNodes };
}

function searchNodeIds(results) {
  const ids = [];
  for (const result of results) {
    if (result.type === 'T') ids.push(turnNodeId(result.id));
    else if (result.type === 'FIX') ids.push(result.fixId);
    else if (result.type === 'ADR') ids.push(adrNodeId(result.adrId));
    else if (result.type === 'R') ids.push(reqNodeId(result.rId));
  }
  return ids;
}

function formatExpansionLines(expansion) {
  const lines = [];
  if (expansion.results.length === 0) return ['- (no graph neighbors found)'];
  for (const node of expansion.results) {
    const archived = node.archived ? ' (archived)' : '';
    const label = node.label ? ` · ${node.label}` : '';
    lines.push(`- ${node.id}${label}${archived} (${node.distance} hop${node.distance === 1 ? '' : 's'})`);
    lines.push(`  Path: ${node.path.map((edge) => {
      const arrow = edge.direction === 'outgoing' ? '→' : '←';
      const anchor = `${edge.source}${edge.tId === null ? '' : ` T${edge.tId}`}`;
      const interval = edge.validTo === null ? '' : `, valid until T${edge.validTo}`;
      return `${edge.from} ${arrow} ${edge.type} ${edge.to} [${anchor}${interval}]`;
    }).join(' ; ')}`);
  }
  if (expansion.hasMore) lines.push('- (additional graph context omitted at the 100-node safety limit)');
  return lines;
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

module.exports = {
  deriveLinks,
  buildContext,
  graphQueryOptions,
  expandGraph,
  rankNeighbors,
  searchNodeIds,
  formatExpansionLines,
  formatContextLines,
  STRONG,
  WEAK,
  normFile,
  turnNodeId,
  fileNodeId,
  adrNodeId,
  reqNodeId,
  tagNodeId,
  turnNum,
};
