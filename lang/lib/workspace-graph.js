'use strict';

/**
 * ContextPocket yuan — 工作区时间图（阶段 A）
 *
 * 把各口袋的单口袋图合并成一张限定 id 的工作区图，并补上显式跨口袋引用边：
 *   api:T5 --x-ref--> web:T9
 *
 * 时间轴用 WHEN 日期（不是数字 T id）：数字 T 只在同一口袋内可比。
 * 缓存放工作区 .contextpocket/workspace-graph.json，按口袋签名增量重建；
 * 不写任何口袋文件，也不改 format v2。
 */

const fs = require('fs');
const path = require('path');

const { readManifest, resolvePocket, parsePocketAll, cacheDir } = require('./workspace');
const { deriveLinks, GRAPH_SOURCE_FILES } = require('./links');
const { whenDate } = require('./recap');
const {
  DEFAULT_RESULT_TYPES,
  blockText,
  parseCrossRefs,
  normalizeKey,
  daysBetween,
  expandByDate,
} = require('./graph-core');
const { writeAtomic } = require('./io');
const { readKnowledgeBase, knowledgeSignature } = require('./workspace-knowledge');

const WORKSPACE_GRAPH_VERSION = 3;
const WORKSPACE_GRAPH_FILE = 'workspace-graph.json';

// 工作区图比 quan 的单口袋图多一个 preferences.md：偏好节点参与 duplicate-pref。
const WORKSPACE_GRAPH_SOURCE_FILES = GRAPH_SOURCE_FILES.concat(['preferences.md']);

const GRAPH_EDGE_GROUPS = ['duplicate', 'shared-file', 'tag', 'near'];
const EDGE_TYPES_BY_GROUP = {
  duplicate: ['duplicate-adr', 'duplicate-req', 'duplicate-pref', 'updated-in'],
  'shared-file': ['shared-file'],
  tag: ['same-tag'],
  near: ['temporal-near'],
};
// 这些节点本身不是内容结果，只在跨口袋命中时作为桥接显示。
const BRIDGE_TYPES_BY_GROUP = {
  duplicate: ['pref'],
  'shared-file': ['file'],
  tag: ['tag'],
};

// 同一个 key 在太多口袋出现时只取字典序前 N 个口袋，避免 package.json 这类枢纽爆炸。
const MAX_GROUP = 5;
const MAX_NEAR_PER_KEY = 20;
const MAX_NEAR_PAIRS = 400;
const MAX_DERIVED_EDGES = 2000;

const NODE_TYPE = {
  turn: 'T',
  decision: 'ADR',
  requirement: 'R',
  correction: 'correction',
  file: 'file',
  tag: 'tag',
};

function workspaceGraphPath(root) {
  return path.join(cacheDir(root), WORKSPACE_GRAPH_FILE);
}

/**
 * 只 stat，不读正文：mtime + size 足以判断图的五个源文件有没有变。
 */
function pocketSignature(pocketDir) {
  const signature = {};
  for (const name of WORKSPACE_GRAPH_SOURCE_FILES) {
    try {
      const stat = fs.statSync(path.join(pocketDir, name));
      signature[name] = stat.mtimeMs + ':' + stat.size;
    } catch (e) {
      signature[name] = 'missing';
    }
  }
  return signature;
}

function sameSignature(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

function sameKnowledgeSignature(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

function readWorkspaceGraph(root) {
  const file = workspaceGraphPath(root);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!data || data.version !== WORKSPACE_GRAPH_VERSION
      || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function qualifyNode(node, pocket, dateByT, requirementDates) {
  const type = NODE_TYPE[node.type] || node.type;
  let date = null;
  if (node.type === 'requirement') {
    date = requirementDates.get(node.id) || null;
  }
  if (!date && node.validFrom !== null && node.validFrom !== undefined) {
    date = dateByT.get(node.validFrom) || null;
  }
  if (!date && node.recordedAt !== null && node.recordedAt !== undefined) {
    date = dateByT.get(node.recordedAt) || null;
  }
  return {
    id: pocket + ':' + node.id,
    pocket,
    type,
    rawId: node.id,
    label: node.label || '',
    archived: !!node.archived,
    status: node.status,
    date,
    dateFrom: date,
    dateTo: null,
    validFrom: node.validFrom === undefined ? null : node.validFrom,
    validTo: node.validTo === undefined ? null : node.validTo,
  };
}

function qualifyEdge(edge, pocket) {
  return Object.assign({}, edge, {
    from: pocket + ':' + edge.from,
    to: pocket + ':' + edge.to,
    pocket,
    scope: 'intra',
  });
}

/**
 * 偏好节点：preferences.md 只有文件级 `# Preferences · T<n>`，没有逐行时间。
 * 节点日期取该文件最后更新的轮次日期；`updated-in` 边也指向那个轮次。
 */
function buildPreferenceNodes(data, pocket, dateByT) {
  const latestT = (data.preferences && data.preferences.latestT) || 0;
  const latestDate = latestT > 0 ? (dateByT.get(latestT) || null) : null;
  const nodes = [];
  const edges = [];
  const seen = new Map();

  for (const text of (data.preferences && data.preferences.items) || []) {
    const colon = text.indexOf(':');
    const key = normalizeKey(colon > -1 ? text.slice(0, colon) : text);
    const value = colon > -1 ? normalizeKey(text.slice(colon + 1)) : '';
    if (!key) continue;

    const base = 'pref:' + key;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    const rawId = count === 1 ? base : base + '#' + count;
    const id = pocket + ':' + rawId;
    nodes.push({
      id,
      pocket,
      type: 'pref',
      rawId,
      label: key + (value ? ': ' + value : ''),
      prefKey: key,
      prefValue: value,
      archived: false,
      status: undefined,
      date: latestDate,
      dateFrom: latestDate,
      dateTo: null,
      validFrom: latestT || null,
      validTo: null,
    });
    if (latestT > 0) {
      edges.push({
        from: id,
        to: pocket + ':T' + latestT,
        type: 'updated-in',
        evidence: 'weak',
        basis: 'preferences-header',
        scope: 'intra',
        date: latestDate,
        source: 'preferences.md',
        tId: latestT,
      });
    }
  }
  return { nodes, edges };
}

function buildPocket(entry, resolved) {
  const graph = deriveLinks(resolved.pocketDir);
  const data = parsePocketAll(resolved.pocketDir);

  const dateByT = new Map();
  for (const block of data.log.blocks) {
    dateByT.set(block.id, whenDate(block) || null);
  }
  const requirementDates = new Map();
  for (const req of data.requirements.items) {
    requirementDates.set('req:R' + req.id, dateByT.get(req.openedAt) || null);
  }

  const preferences = buildPreferenceNodes(data, entry.name, dateByT);
  const nodes = graph.nodes
    .map((node) => qualifyNode(node, entry.name, dateByT, requirementDates))
    .concat(preferences.nodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges
    .map((edge) => qualifyEdge(edge, entry.name))
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .concat(preferences.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)));

  const crossRefs = [];
  for (const block of data.log.blocks) {
    const text = blockText(block);
    if (!text) continue;
    for (const ref of parseCrossRefs(text)) {
      if (ref.pocket === entry.name) continue;
      crossRefs.push({
        fromT: block.id,
        toPocket: ref.pocket,
        toT: ref.tId,
        date: dateByT.get(block.id) || null,
      });
    }
  }

  return {
    ok: true,
    path: entry.path,
    signature: pocketSignature(resolved.pocketDir),
    builtAt: new Date().toISOString(),
    nodes,
    edges,
    crossRefs,
  };
}

function crossEdgesFrom(pockets, nodeIds) {
  const edges = [];
  const seen = new Set();
  let dangling = 0;
  for (const [pocketName, pocket] of Object.entries(pockets)) {
    for (const ref of pocket.crossRefs || []) {
      const from = pocketName + ':T' + ref.fromT;
      const to = ref.toPocket + ':T' + ref.toT;
      if (!nodeIds.has(from) || !nodeIds.has(to)) {
        dangling += 1;
        continue;
      }
      const key = from + '|' + to + '|x-ref';
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from,
        to,
        type: 'x-ref',
        evidence: 'strong',
        basis: 'qualified-ref',
        scope: 'cross',
        date: ref.date || null,
        source: pocketName,
        tId: ref.fromT,
      });
    }
  }
  return { edges, dangling };
}

function summarize(nodes, edges, dangling) {
  const byType = {};
  for (const node of nodes) byType[node.type] = (byType[node.type] || 0) + 1;
  const byEdgeType = {};
  for (const edge of edges) byEdgeType[edge.type] = (byEdgeType[edge.type] || 0) + 1;
  return {
    nodes: nodes.length,
    edges: edges.length,
    intraEdges: edges.filter((edge) => edge.scope === 'intra').length,
    crossPocketEdges: edges.filter((edge) => edge.scope === 'cross').length,
    danglingCrossRefs: dangling,
    byType,
    byEdgeType,
  };
}

function stalePockets(root, manifest, cache) {
  const stale = [];
  const cached = (cache && cache.pockets) || {};
  for (const entry of manifest.pockets) {
    const resolved = resolvePocket(root, entry);
    const signature = resolved.exists ? pocketSignature(resolved.pocketDir) : null;
    const previous = cached[entry.name];
    if (!previous || previous.ok === false || previous.path !== entry.path
      || !sameSignature(previous.signature, signature)) {
      stale.push(entry.name);
    }
  }
  for (const name of Object.keys(cached)) {
    if (!manifest.pockets.some((entry) => entry.name === name)) stale.push(name);
  }
  return [...new Set(stale)].sort();
}

/**
 * 只读检查：不解析、不重建，只 stat 源文件。
 */
function inspectWorkspaceGraph(root) {
  const cache = readWorkspaceGraph(root);
  const file = workspaceGraphPath(root);
  if (!cache) {
    return {
      present: false, fresh: false, path: file,
      nodes: 0, edges: 0, crossPocketEdges: 0,
      knowledgeNodes: 0, knowledgeEdges: 0, staleKnowledge: true,
    };
  }
  let stale = [];
  let staleKnowledge = true;
  try {
    const manifest = readManifest(root);
    stale = stalePockets(root, manifest, cache);
    staleKnowledge = !sameKnowledgeSignature(
      cache.knowledge && cache.knowledge.signature,
      knowledgeSignature(root)
    );
  } catch (e) {
    stale = ['(manifest unavailable)'];
  }
  return {
    present: true,
    fresh: stale.length === 0 && !staleKnowledge,
    path: file,
    nodes: cache.nodes.length,
    edges: cache.edges.length,
    crossPocketEdges: (cache.stats && cache.stats.crossPocketEdges) || 0,
    danglingCrossRefs: (cache.stats && cache.stats.danglingCrossRefs) || 0,
    knowledgeNodes: (cache.knowledge && cache.knowledge.nodes) || 0,
    knowledgeEdges: (cache.knowledge && cache.knowledge.edges) || 0,
    staleKnowledge,
    builtAt: cache.generatedAt || null,
    stalePockets: stale,
  };
}

function knowledgeSourceNodeId(ref) {
  const value = String(ref || '').trim();
  const turn = /^([a-z][a-z0-9_-]*):(T\d+)$/.exec(value);
  if (turn) return turn[1] + ':' + turn[2];
  const adr = /^([a-z][a-z0-9_-]*):ADR-(\d+)$/.exec(value);
  if (adr) return adr[1] + ':adr:ADR-' + adr[2];
  const req = /^([a-z][a-z0-9_-]*):R(\d+)$/.exec(value);
  if (req) return req[1] + ':req:R' + req[2];
  if (/^[a-z][a-z0-9_-]*:(file|tag|pref):/.test(value)) return value;
  return null;
}

function knowledgeRefTurn(ref) {
  const match = /:T(\d+)$/.exec(String(ref || ''));
  return match ? parseInt(match[1], 10) : null;
}

/**
 * knowledge/ → K 节点与 derived-from 边。纯派生，不写缓存。
 * 节点 id 统一 kb:K-0001；来源必须已经限定到口袋。
 */
function buildKnowledgeGraph(root) {
  const kb = readKnowledgeBase(root);
  const nodes = [];
  const edges = [];
  if (!kb.present || kb.notes.length === 0) return { nodes, edges };

  const topics = new Map();
  for (const note of kb.notes) {
    const id = 'kb:' + note.id;
    const sourceIds = [...new Set(note.sources.map(knowledgeSourceNodeId).filter(Boolean))];
    const turns = note.sources.map(knowledgeRefTurn).filter((value) => value !== null);
    const maxT = turns.length > 0 ? Math.max(...turns) : null;
    nodes.push({
      id,
      pocket: 'kb',
      type: 'K',
      rawId: note.id,
      label: note.title,
      topic: note.topic,
      kKind: note.kind,
      status: note.status,
      confidence: note.confidence,
      date: note.updated || null,
      sourceCount: sourceIds.length,
      archived: note.status === 'archived',
      recordedAt: maxT,
      validFrom: maxT,
      validTo: null,
    });
    for (const target of sourceIds) {
      edges.push({
        from: id,
        to: target,
        type: 'derived-from',
        evidence: 'strong',
        basis: 'knowledge-index',
        scope: 'cross',
        date: note.updated || null,
        source: 'knowledge/index.md',
        tId: knowledgeRefTurn(note.sources.find((ref) => knowledgeSourceNodeId(ref) === target) || ''),
        recordedAt: maxT,
        validFrom: maxT,
        validTo: null,
      });
      if (target.includes(':tag:') || target.includes(':file:')) {
        edges.push({
          from: id,
          to: target,
          type: 'covers',
          evidence: 'strong',
          basis: 'knowledge-index',
          scope: 'cross',
          date: note.updated || null,
          source: 'knowledge/index.md',
          tId: null,
          recordedAt: maxT,
          validFrom: maxT,
          validTo: null,
        });
      }
    }
    for (const target of note.supersedes) {
      edges.push({
        from: id,
        to: 'kb:' + target,
        type: 'supersedes',
        evidence: 'strong',
        basis: 'knowledge-index',
        scope: 'cross',
        date: note.updated || null,
        source: 'knowledge/index.md',
        tId: null,
        recordedAt: maxT,
        validFrom: maxT,
        validTo: null,
      });
    }
    for (const target of note.conflicts) {
      edges.push({
        from: id,
        to: 'kb:' + target,
        type: 'contradicts',
        evidence: 'weak',
        basis: 'knowledge-index',
        scope: 'cross',
        date: note.updated || null,
        source: 'knowledge/index.md',
        tId: null,
        recordedAt: maxT,
        validFrom: maxT,
        validTo: null,
      });
    }
    const key = note.topic;
    if (key) {
      if (!topics.has(key)) topics.set(key, []);
      topics.get(key).push(id);
    }
  }
  for (const ids of topics.values()) {
    const sorted = ids.slice().sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        edges.push({
          from: sorted[i],
          to: sorted[j],
          type: 'duplicate-of',
          evidence: 'weak',
          basis: 'knowledge-topic',
          scope: 'cross',
          date: null,
          source: 'knowledge/index.md',
          tId: null,
          recordedAt: null,
          validFrom: null,
          validTo: null,
        });
      }
    }
  }
  return { nodes, edges };
}

/**
 * 确保缓存存在且新鲜；只重建 stale 口袋，跨口袋边用缓存的 crossRefs 全量重算。
 *
 * @param {string} root
 * @param {object} [options]
 * @param {boolean} [options.force]
 * @returns {{graph: object, cacheStatus: string, rebuiltPockets: string[], stats: object, path: string}}
 */
function ensureWorkspaceGraph(root, options = {}) {
  const manifest = readManifest(root);
  const cache = options.force ? null : readWorkspaceGraph(root);
  const stale = cache
    ? stalePockets(root, manifest, cache)
    : manifest.pockets.map((entry) => entry.name);
  const knowledgeSig = knowledgeSignature(root);
  const knowledgeStale = !cache || !sameKnowledgeSignature(cache.knowledge && cache.knowledge.signature, knowledgeSig);

  if (cache && stale.length === 0 && !knowledgeStale) {
    return {
      graph: { nodes: cache.nodes, edges: cache.edges, stats: cache.stats },
      cacheStatus: 'fresh',
      rebuiltPockets: [],
      stats: cache.stats,
      path: workspaceGraphPath(root),
    };
  }

  const pockets = {};
  const nodes = [];
  const intraEdges = [];
  const rebuilt = [];

  for (const entry of manifest.pockets) {
    const previous = cache && cache.pockets && cache.pockets[entry.name];
    const resolved = resolvePocket(root, entry);
    const signature = resolved.exists ? pocketSignature(resolved.pocketDir) : null;
    const reusable = previous && previous.ok !== false && previous.path === entry.path
      && sameSignature(previous.signature, signature);

    if (reusable) {
      pockets[entry.name] = previous;
      for (const node of cache.nodes) {
        if (node.pocket === entry.name) nodes.push(node);
      }
      for (const edge of cache.edges) {
        if (edge.scope === 'intra' && edge.pocket === entry.name) intraEdges.push(edge);
      }
      continue;
    }

    rebuilt.push(entry.name);
    if (!resolved.exists) {
      pockets[entry.name] = {
        ok: false,
        error: 'missing ContextPocket/log.md',
        path: entry.path,
        signature,
        builtAt: new Date().toISOString(),
        nodes: 0,
        edges: 0,
        crossRefs: [],
      };
      continue;
    }

    let built;
    try {
      built = buildPocket(entry, resolved);
    } catch (e) {
      pockets[entry.name] = {
        ok: false,
        error: e.message,
        path: entry.path,
        signature,
        builtAt: new Date().toISOString(),
        nodes: 0,
        edges: 0,
        crossRefs: [],
      };
      continue;
    }

    pockets[entry.name] = {
      ok: true,
      path: entry.path,
      signature: built.signature,
      builtAt: built.builtAt,
      nodes: built.nodes.length,
      edges: built.edges.length,
      crossRefs: built.crossRefs,
    };
    nodes.push(...built.nodes);
    intraEdges.push(...built.edges);
  }

  const knowledge = buildKnowledgeGraph(root);
  nodes.push(...knowledge.nodes);

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const knowledgeEdges = knowledge.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const cross = crossEdgesFrom(pockets, nodeIds);
  const edges = intraEdges.concat(knowledgeEdges, cross.edges);
  edges.sort((a, b) => a.from.localeCompare(b.from)
    || a.to.localeCompare(b.to)
    || String(a.type).localeCompare(String(b.type)));

  const stats = summarize(nodes, edges, cross.dangling);
  const data = {
    version: WORKSPACE_GRAPH_VERSION,
    generatedAt: new Date().toISOString(),
    workspace: manifest.name,
    pockets,
    knowledge: {
      signature: knowledgeSig,
      builtAt: new Date().toISOString(),
      nodes: knowledge.nodes.length,
      edges: knowledgeEdges.length,
    },
    nodes,
    edges,
    stats,
  };
  const file = workspaceGraphPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(data, null, 2) + '\n');

  return {
    graph: { nodes, edges, stats },
    cacheStatus: rebuilt.length === manifest.pockets.length ? 'rebuilt' : 'partial',
    rebuiltPockets: rebuilt,
    stats,
    path: file,
  };
}

function laterDate(a, b) {
  if (a && b) return a > b ? a : b;
  return a || b || null;
}

function groupByKey(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

/**
 * 每个口袋只取一个代表节点，再按字典序截断到 maxGroup。
 * 同一口袋内的重复由 consolidate 负责，工作区图只关心跨口袋连接。
 */
function pocketRepresentatives(group, limits) {
  const byPocket = new Map();
  for (const node of group.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    if (!node.pocket || byPocket.has(node.pocket)) continue;
    byPocket.set(node.pocket, node);
  }
  const nodes = [...byPocket.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (nodes.length > limits.maxGroup) {
    limits.truncated = true;
    return nodes.slice(0, limits.maxGroup);
  }
  return nodes;
}

function addPairEdges(out, group, type, basis, limits) {
  const nodes = pocketRepresentatives(group, limits);
  let added = 0;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (out.length >= limits.maxDerived) {
        limits.truncated = true;
        return added;
      }
      const a = nodes[i];
      const b = nodes[j];
      const from = a.id < b.id ? a : b;
      const to = a.id < b.id ? b : a;
      out.push({
        from: from.id,
        to: to.id,
        type,
        evidence: 'weak',
        basis,
        scope: 'cross',
        date: laterDate(from.date, to.date),
        source: 'derived',
        tId: null,
      });
      added += 1;
    }
  }
  return added;
}

function deriveNearEdges(nodes, edges, limits, stats, out) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const turns = new Map(nodes.filter((node) => node.type === 'T').map((node) => [node.id, node]));
  const keysByTurn = new Map();

  const addKey = (turnId, key) => {
    if (!turnId || !key) return;
    if (!keysByTurn.has(turnId)) keysByTurn.set(turnId, new Set());
    keysByTurn.get(turnId).add(key);
  };

  // 只用强证据的 tag / file 关联；mentions 这类弱边不参与时间近邻。
  for (const edge of edges || []) {
    if (!edge || edge.evidence === 'weak') continue;
    if (edge.type !== 'tagged' && edge.type !== 'modifies' && edge.type !== 'last-changed') continue;
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    if (from.type === 'T' && (to.type === 'tag' || to.type === 'file')) {
      addKey(from.id, to.type + ':' + (to.type === 'tag' ? normalizeKey(to.rawId) : to.rawId));
    } else if (to.type === 'T' && (from.type === 'tag' || from.type === 'file')) {
      addKey(to.id, from.type + ':' + (from.type === 'tag' ? normalizeKey(from.rawId) : from.rawId));
    }
  }

  const byKey = new Map();
  for (const [turnId, keys] of keysByTurn) {
    for (const key of keys) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(turnId);
    }
  }

  const seenPairs = new Set();
  for (const key of [...byKey.keys()].sort()) {
    const group = [...new Set(byKey.get(key))]
      .map((id) => turns.get(id))
      .filter((turn) => turn && turn.date)
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    let perKey = 0;
    let stop = false;
    for (let i = 0; i < group.length && !stop; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (perKey >= limits.maxNearPerKey || stats.temporalNear >= limits.maxNearPairs
          || out.length >= limits.maxDerived) {
          limits.truncated = true;
          stop = true;
          break;
        }
        const a = group[i];
        const b = group[j];
        if (!a.pocket || !b.pocket || a.pocket === b.pocket) continue;
        const diff = daysBetween(a.date, b.date);
        if (diff === null || diff > limits.nearDays) continue;
        const pairKey = a.id < b.id ? a.id + '\u0000' + b.id : b.id + '\u0000' + a.id;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        const from = a.id < b.id ? a : b;
        const to = a.id < b.id ? b : a;
        out.push({
          from: from.id,
          to: to.id,
          type: 'temporal-near',
          evidence: 'weak',
          basis: 'temporal-near',
          scope: 'cross',
          date: laterDate(a.date, b.date),
          source: 'derived',
          tId: null,
        });
        stats.temporalNear += 1;
        perKey += 1;
      }
    }
    if (stats.temporalNear >= limits.maxNearPairs || out.length >= limits.maxDerived) break;
  }
}

/**
 * 从已缓存/已构建的限定节点与边派生跨口袋边。
 *
 * 纯函数：不读文件、不写缓存。派生边全部是 weak，只有调用方显式开启对应
 * group 时才参与 BFS；同一 key 只取字典序前 MAX_GROUP 个口袋，near 另有两级上限。
 *
 * @param {object[]} nodes
 * @param {object[]} edges
 * @param {object} [options]
 * @param {string[]} [options.groups] duplicate / shared-file / tag / near
 * @param {number} [options.nearDays=7]
 * @returns {{edges: object[], stats: object}}
 */
function deriveWorkspaceEdges(nodes, edges, options = {}) {
  const groups = new Set((options.groups || []).filter((group) => GRAPH_EDGE_GROUPS.includes(group)));
  const limits = {
    maxGroup: MAX_GROUP,
    nearDays: Number.isInteger(options.nearDays) && options.nearDays > 0 ? options.nearDays : 7,
    maxNearPerKey: MAX_NEAR_PER_KEY,
    maxNearPairs: MAX_NEAR_PAIRS,
    maxDerived: MAX_DERIVED_EDGES,
    truncated: false,
  };
  const out = [];
  const stats = {
    duplicateAdr: 0,
    duplicateReq: 0,
    duplicatePref: 0,
    sharedFile: 0,
    sameTag: 0,
    temporalNear: 0,
    total: 0,
    truncated: false,
  };

  if (groups.has('duplicate')) {
    const adrs = groupByKey(nodes.filter((node) => node.type === 'ADR'),
      (node) => normalizeKey(node.label));
    for (const key of [...adrs.keys()].sort()) {
      stats.duplicateAdr += addPairEdges(out, adrs.get(key), 'duplicate-adr', 'duplicate-title', limits);
    }
    const reqs = groupByKey(nodes.filter((node) => node.type === 'R'),
      (node) => normalizeKey(node.label));
    for (const key of [...reqs.keys()].sort()) {
      stats.duplicateReq += addPairEdges(out, reqs.get(key), 'duplicate-req', 'duplicate-text', limits);
    }
    const prefs = groupByKey(nodes.filter((node) => node.type === 'pref'),
      (node) => node.prefKey + '\u0000' + node.prefValue);
    for (const key of [...prefs.keys()].sort()) {
      stats.duplicatePref += addPairEdges(out, prefs.get(key), 'duplicate-pref', 'duplicate-pref', limits);
    }
  }

  if (groups.has('shared-file')) {
    const files = groupByKey(nodes.filter((node) => node.type === 'file'),
      (node) => node.rawId);
    for (const key of [...files.keys()].sort()) {
      stats.sharedFile += addPairEdges(out, files.get(key), 'shared-file', 'shared-file', limits);
    }
  }

  if (groups.has('tag')) {
    const tags = groupByKey(nodes.filter((node) => node.type === 'tag'),
      (node) => normalizeKey(node.rawId));
    for (const key of [...tags.keys()].sort()) {
      stats.sameTag += addPairEdges(out, tags.get(key), 'same-tag', 'same-tag', limits);
    }
  }

  if (groups.has('near')) deriveNearEdges(nodes, edges, limits, stats, out);

  stats.total = out.length;
  stats.truncated = limits.truncated;
  return { edges: out, stats };
}

function expandWorkspaceGraph(graph, seeds, depth, options = {}) {
  const groups = (options.groups || []).filter((group) => GRAPH_EDGE_GROUPS.includes(group));
  if (groups.length === 0) return expandByDate(graph, seeds, depth, options);

  const derived = deriveWorkspaceEdges(graph.nodes, graph.edges, {
    groups,
    nearDays: options.nearDays,
  });
  const weakTypes = new Set();
  const extraTypes = new Set();
  for (const group of groups) {
    for (const type of EDGE_TYPES_BY_GROUP[group] || []) weakTypes.add(type);
    for (const type of BRIDGE_TYPES_BY_GROUP[group] || []) extraTypes.add(type);
  }
  const resultTypes = [...new Set((options.resultTypes || DEFAULT_RESULT_TYPES).concat([...extraTypes]))];
  const crossOnlyTypes = [...new Set((options.crossOnlyTypes || []).concat([...extraTypes]))];

  const result = expandByDate(
    { nodes: graph.nodes, edges: graph.edges.concat(derived.edges) },
    seeds,
    depth,
    Object.assign({}, options, {
      includeWeak: true,
      includeEdge: (edge) => edge.evidence !== 'weak' || weakTypes.has(edge.type),
      resultTypes,
      crossOnlyTypes,
    })
  );
  result.derivedEdges = derived.edges.length;
  result.derivedStats = derived.stats;
  result.derivedList = derived.edges;
  return result;
}

function seedIdsFromSearch(rows) {
  const ids = [];
  for (const row of rows || []) {
    if (!row || !row.pocket || !row.id) continue;
    if (row.type === 'T' || row.type === 'FIX') ids.push(row.pocket + ':' + row.id);
    else if (row.type === 'ADR') ids.push(row.pocket + ':adr:' + row.id);
    else if (row.type === 'R') ids.push(row.pocket + ':req:' + row.id);
    else if (row.type === 'K') ids.push('kb:' + row.id);
  }
  return ids;
}

function seedIdsFromStatus(status) {
  const ids = [];
  for (const pocket of (status && status.pockets) || []) {
    if (!pocket.ok) continue;
    for (const turn of pocket.recent || []) ids.push(pocket.name + ':T' + turn.id);
    for (const req of pocket.openRequirementTexts || []) ids.push(pocket.name + ':req:' + req.id);
    for (const adr of pocket.adrTitles || []) ids.push(pocket.name + ':adr:' + adr.id);
  }
  return ids;
}

/**
 * `--as-of`：日期原样返回；`pocket:Tn` 用该轮 WHEN 解析；其余形态报错。
 */
function resolveAsOfDate(root, value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const match = /^([a-z][a-z0-9_-]*):T(\d+)$/i.exec(text);
  if (!match) {
    throw new Error('--as-of must be YYYY-MM-DD or pocket:Tn (got ' + text + ')');
  }

  const manifest = readManifest(root);
  const name = match[1].toLowerCase();
  const entry = manifest.pockets.find((pocket) => pocket.name.toLowerCase() === name);
  if (!entry) {
    throw new Error('--as-of: unknown pocket "' + match[1] + '"');
  }
  const resolved = resolvePocket(root, entry);
  if (!resolved.exists) {
    throw new Error('--as-of: pocket "' + entry.name + '" has no ContextPocket/log.md');
  }
  const data = parsePocketAll(resolved.pocketDir);
  const tId = Number(match[2]);
  const block = data.log.blocks.find((item) => item.id === tId);
  if (!block) {
    throw new Error('--as-of: ' + entry.name + ':T' + tId + ' not found');
  }
  const date = whenDate(block);
  if (!date) {
    throw new Error('--as-of ' + entry.name + ':T' + tId
      + ': that turn has no WHEN date; pass a date instead');
  }
  return date;
}

module.exports = {
  WORKSPACE_GRAPH_VERSION,
  WORKSPACE_GRAPH_FILE,
  WORKSPACE_GRAPH_SOURCE_FILES,
  GRAPH_EDGE_GROUPS,
  MAX_GROUP,
  workspaceGraphPath,
  pocketSignature,
  readWorkspaceGraph,
  inspectWorkspaceGraph,
  ensureWorkspaceGraph,
  deriveWorkspaceEdges,
  expandWorkspaceGraph,
  seedIdsFromSearch,
  seedIdsFromStatus,
  resolveAsOfDate,
};
