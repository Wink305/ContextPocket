'use strict';

/**
 * ContextPocket Lite — 关联图（运行时派生）
 *
 * 从已有的 log.md / log-archive.md / decisions.md / code-map.md 确定性派生节点与边。
 * 不调用模型、不引入依赖：图是派生品，真值永远在那几份 Markdown 里
 * （见 docs/ROADMAP-2.0.md §3.3）。
 *
 * Lite 与主包共用 Node schema v2：deriveLinks / buildContext / formatContextLines
 * 与主包 lib/links.js 的同名函数逐字一致 —— lite/tests/compat.js 用同一份口袋
 * 跑两边的派生、deepStrictEqual 锁死，两个包对「图长什么样」不可能各说一套。
 *
 * 被裁掉的是主包 Phase 1 的 assets/graph.jsonl 缓存层（序列化 / 签名 / 四态
 * 新鲜度 / 篡改检测 / 自愈重写）：Lite 的图永远是现场派生，零写盘，
 * 也就没有缓存新鲜度这回事 —— `graph` 命令没有 rebuild / verify 子命令。
 *
 * 证据分层直接沿用 lib/parser.js：Action 里的 files 是「这轮动过」（强证据），
 * 其他小节里出现的路径只是「这轮谈到过」（弱证据）。弱边带 evidence:'weak'，
 * 默认不进上下文摘要 —— 否则会和 why / verify 一样把幻影路径当成真实改动。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const path = require('path');
const { parseLogAll, parseDecisions, parseRequirements } = require('./parser');
const { readFileSafe, extractFilesFromBlock } = require('./core');

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

function reqNodeId(rId) {
  return 'req:R' + rId;
}

function tagNodeId(name) {
  return 'tag:' + String(name).trim();
}

/**
 * 模板占位符形态的值（`<entry-file>`、`<req>`、`<files>`）——不是真实内容，
 * 不该变成图里的假节点（与主包 lib/links.js 同一份判据）。
 */
function isPlaceholderValue(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s.length >= 2 && s.startsWith('<') && s.endsWith('>');
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
  // Lite 的口袋没有 requirements.md，parseRequirements 返回空，这里自然不产生节点 ——
  // 派生规则与主包 lib/links.js 同一份（2.5 起主包也已带上同样的规则），
  // 同一份口袋两边派生出同一张图，compat 测试逐字节盯着。
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
 * > 仅仅贴标签（1）；弱证据 `mentions` 一律不参与，与 expandFrom 同一口径。高频共现不
 * 靠手写系数压制——出边按权重归一，枢纽节点的 rank 天然被摊薄（标准 PageRank 行为）。
 *
 * 确定性：节点与邻居按 id 排序遍历、固定迭代轮数、不做浮点提前收敛，两包对同一张图
 * 逐字得到同一串分数。本函数与 lib/links.js 逐字同源，故内联时间谓词、不依赖 activeAt。
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

// ============================================================
// 多跳扩展（--expand <n>）
// ============================================================

/** 深度上限：再深也不会更有用，只会让输出变成一堵墙。 */
const MAX_EXPAND_DEPTH = 3;
// 与主包 expandGraph 的 maxNodes 默认值同一个数：扩展结果的安全上限
const MAX_EXPAND_NODES = 100;

/**
 * 从种子节点出发走 N 跳，返回新到达的节点与走过的边。
 *
 * **方向**：图里的边是有向的（`references` 是「T2 引用了 T1」），但"找相关"这件事
 * 不认方向 —— 从 T1 反着走得到的正是「谁引用了我」，而入向上下文本来就是反着用。
 * 所以邻接按无向构造；命中的每条边仍带着它本来有向的那一侧（from/to），输出里
 * 能说清「谁 → 谁」，不会把方向说反。
 *
 * **防环**：按节点 id 记 visited，一个节点只被展开一次 —— 环不会打转，
 * 菱形关系也不会把同一个节点算成两条路径。
 *
 * 与主包 expandGraph 同一套语义口径（弱边不走、种子去重、(distance, id)
 * 稳定排序、100 节点安全上限 + hasMore），实现是独立的 frontier BFS：
 * 主包带 asOf 时间切片与逐边完整路径，Lite 不做时间切片、只记最后一条边
 * 的 via —— 这是有意的能力裁剪，不是漂移。调用方差别：主包从 readGraph
 * （缓存）取图，Lite 永远现场 deriveLinks，零写盘、零缓存，「更轻」不打折。
 *
 * @param {object} graph deriveLinks() 的结果
 * @param {string[]} seedIds 起点节点 id
 * @param {number} depth 跳数（0 = 不扩展；上限 MAX_EXPAND_DEPTH）
 * @returns {{depth:number, nodes:Array, edges:Array, hasMore:boolean}}
 */
function expandFrom(graph, seedIds, depth, opts) {
  const rank = !!(opts && opts.rank);
  const d = Math.max(0, Math.min(MAX_EXPAND_DEPTH, parseInt(depth, 10) || 0));
  const out = { depth: d, nodes: [], edges: [], hasMore: false };
  if (d === 0 || !seedIds || seedIds.length === 0) return out;

  const nodeById = new Map((graph.nodes || []).map((n) => [n.id, n]));
  // 与主包 expandGraph 同一套安全口径：种子去重、只认图上真实存在的节点
  const seeds = [...new Set(seedIds)].filter((id) => nodeById.has(id));
  if (seeds.length === 0) return out;
  const adj = new Map();
  for (const e of graph.edges || []) {
    if (e.evidence === WEAK) continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from).push({ edge: e, other: e.to });
    adj.get(e.to).push({ edge: e, other: e.from });
  }

  const seen = new Set(seeds);
  const usedEdges = new Set();
  const reached = new Map();

  let frontier = seeds.slice();
  for (let step = 1; step <= d; step++) {
    const next = [];
    for (const id of frontier) {
      for (const link of (adj.get(id) || [])) {
        const e = link.edge;
        const key = [e.from, e.type, e.to].join('\u0000');
        if (!usedEdges.has(key)) {
          usedEdges.add(key);
          out.edges.push(e);
        }
        if (seen.has(link.other)) continue;
        const node = nodeById.get(link.other);
        if (!node) continue;
        seen.add(link.other);
        reached.set(link.other, {
          id: node.id,
          type: node.type,
          label: node.label,
          distance: step,
          via: e.type,
          viaFrom: e.from,
          viaTo: e.to,
          archived: !!node.archived,
        });
        next.push(link.other);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  // 与主包 expandGraph 同一套安全上限：先稳定排序，再截到 MAX_EXPAND_NODES；
  // hasMore 告诉调用方「还有，但被安全阀拦了」，大口袋上不会吐出无上限的扩展结果。
  // --rank：按个性化相关度排序（分值相同再按 id），距离仍保留在结果里。
  const all = [...reached.values()];
  if (rank) {
    const scores = rankNeighbors(graph, seeds);
    for (const node of all) node.rank = scores.get(node.id) || 0;
    all.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
  } else {
    all.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  }
  out.nodes = all.slice(0, MAX_EXPAND_NODES);
  out.hasMore = all.length > MAX_EXPAND_NODES;
  return out;
}

module.exports = {
  deriveLinks,
  buildContext,
  formatContextLines,
  expandFrom,
  rankNeighbors,
  MAX_EXPAND_DEPTH,
  MAX_EXPAND_NODES,
  STRONG,
  WEAK,
};
