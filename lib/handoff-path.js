'use strict';

/**
 * ContextPocket — 交接节点链（handoff path）
 *
 * 给 handoff.md 用的确定性行走：从「接下来要做的事」出发，沿关联图的边
 * 走到约束 / 来源 / 未决节点，并保留每一步的 direction + source + T-id。
 *
 * 规则是一张死表：不算权重分数、不用向量、不建缓存、不改数据格式。
 * 同一份口袋，任何实现都该走出同一条链（开放格式的前提）。
 * 只依赖两包逐字同源的 deriveLinks()。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const { deriveLinks } = require('./links');

/** 每类边的行走规则；priority 越小越先走，maxHops 是相对种子的跳数上限。 */
const EDGE_RULES = {
  'decided-in':   { priority: 1, maxHops: 2, walk: true },
  'implements':   { priority: 2, maxHops: 2, walk: true },
  'opened-in':    { priority: 3, maxHops: 2, walk: true },
  'completed-in': { priority: 4, maxHops: 2, walk: true },
  'references':   { priority: 5, maxHops: 2, walk: true },
  'modifies':     { priority: 6, maxHops: 1, walk: true },
  'last-changed': { priority: 7, maxHops: 1, walk: true },
  'tagged':       { priority: 8, maxHops: 1, walk: true },
  'mentions':     { priority: 9, maxHops: 1, walk: false },
  'supersedes':   { priority: 0, maxHops: 1, walk: false },
};

const WEAK = 'weak';
const MAX_CHAINS = 8;
const MAX_HOPS = 2;

function shortId(id) {
  return String(id)
    .replace(/^adr:ADR-/, 'ADR-')
    .replace(/^req:/, '')
    .replace(/^tag:/, '')
    .replace(/^file:/, '');
}

/** 与 lib/links.js 的 activeAt 同一套判据（asOf 取最新 T-id）。 */
function activeAt(rec, asOf) {
  if (!rec) return false;
  if (rec.recordedAt !== null && rec.recordedAt !== undefined && rec.recordedAt > asOf) return false;
  if (rec.validFrom !== null && rec.validFrom !== undefined && rec.validFrom > asOf) return false;
  return rec.validTo === null || rec.validTo === undefined || asOf < rec.validTo;
}

/**
 * @param {string} pocketDir
 * @param {object} data parseAll() 的结果
 * @returns {{lines: string[], hasMore: boolean, superseded: object[], seedCount: number, nodeCount: number}}
 */
function buildHandoffChains(pocketDir, data) {
  const latestT = Number(data && data.log && data.log.latestT) || 0;
  let graph;
  try {
    graph = deriveLinks(pocketDir);
  } catch (err) {
    return {
      lines: ['- (graph derivation unavailable: ' + String((err && err.message) || err) + ')'],
      hasMore: false, superseded: [], seedCount: 0, nodeCount: 0,
    };
  }
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // supersedes 边本身不穿行，但要把「已被取代」的事实交回 handoff，
  // 让 Key Decisions 过滤掉旧 ADR，并在链尾如实标注剪枝。
  const superseded = [];
  const seenSup = new Set();
  for (const e of edges) {
    if (e.type !== 'supersedes') continue;
    const key = e.from + '>' + e.to;
    if (seenSup.has(key)) continue;
    seenSup.add(key);
    superseded.push({ id: shortId(e.to), by: shortId(e.from), tId: e.tId });
  }

  // 邻接表：双向可穿行但保留 direction；WEAK 证据边、失效边/节点一律跳过。
  const adj = new Map();
  const addAdjacent = (id, item) => {
    if (!adj.has(id)) adj.set(id, []);
    adj.get(id).push(item);
  };
  for (const e of edges) {
    const rule = EDGE_RULES[e.type];
    if (!rule || !rule.walk || e.evidence === WEAK) continue;
    if (!activeAt(e, latestT)) continue;
    if (!activeAt(byId.get(e.from), latestT) || !activeAt(byId.get(e.to), latestT)) continue;
    addAdjacent(e.from, { id: e.to, direction: 'outgoing', edge: e, rule: rule });
    addAdjacent(e.to, { id: e.from, direction: 'incoming', edge: e, rule: rule });
  }
  for (const items of adj.values()) {
    items.sort((a, b) => a.rule.priority - b.rule.priority ||
      a.direction.localeCompare(b.direction) || a.id.localeCompare(b.id));
  }

  // 种子 = 未完需求 + 最近 3 个 T。不解析自然语言，保证可复现。
  const seeds = [];
  const reqs = (data && data.requirements && data.requirements.items) || [];
  for (const r of reqs) {
    if (r.status !== 'Open' && !r.uncertain) continue;
    const nid = 'req:R' + r.id;
    if (byId.has(nid) && seeds.indexOf(nid) === -1) seeds.push(nid);
    if (seeds.length >= 3) break;
  }
  const blocks = (data && data.log && data.log.blocks) || [];
  for (let i = blocks.length - 1; i >= 0 && seeds.length < 6; i--) {
    const nid = 'T' + blocks[i].id;
    if (byId.has(nid) && seeds.indexOf(nid) === -1) seeds.push(nid);
  }

  // BFS：每到一个新节点就留一条带完整 path 的链，稳定排序后按安全阀截断。
  const results = [];
  for (const seed of seeds) {
    const visited = new Set([seed]);
    const queue = [{ id: seed, hops: 0, path: [] }];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const cur = queue[cursor];
      if (cur.hops >= MAX_HOPS) continue;
      for (const next of (adj.get(cur.id) || [])) {
        if (visited.has(next.id)) continue;
        if (cur.hops + 1 > next.rule.maxHops) continue;
        visited.add(next.id);
        const step = {
          from: cur.id, to: next.id, type: next.edge.type,
          direction: next.direction, tId: next.edge.tId,
          priority: next.rule.priority,
        };
        const path = cur.path.concat(step);
        results.push({ seed: seed, end: next.id, hops: path.length, path: path, priority: step.priority });
        queue.push({ id: next.id, hops: cur.hops + 1, path: path });
      }
    }
  }
  results.sort((a, b) => a.hops - b.hops || a.priority - b.priority ||
    String(a.end).localeCompare(String(b.end)));

  const kept = results.slice(0, MAX_CHAINS);
  const lines = [];
  if (kept.length === 0) {
    lines.push('- (no graph links derived yet — record a few turns first)');
  }
  for (const r of kept) {
    const parts = [shortId(r.seed)];
    const anchors = [];
    for (const step of r.path) {
      const arrow = step.direction === 'outgoing' ? '→' : '←';
      parts.push(arrow + '(' + step.type + ') ' + shortId(step.to));
      if (step.tId !== null && step.tId !== undefined) {
        const a = 'T' + step.tId;
        if (anchors.indexOf(a) === -1) anchors.push(a);
      }
    }
    lines.push('- ' + parts.join(' ') + (anchors.length ? '  [' + anchors.join(' · ') + ']' : ''));
  }

  return {
    lines: lines,
    hasMore: results.length > MAX_CHAINS,
    superseded: superseded,
    seedCount: seeds.length,
    nodeCount: nodes.length,
  };
}

/**
 * 读侧接手视图：给新会话 / 新 Agent 的「开工前读什么」。
 * 与写侧 generateHandoff 是两件事：这里不写任何文件，只校验并摘取。
 * stale 时默认拒绝给出 0 段（那是「可以据此开工」的承诺），--force 才放行。
 */
function readHandoffView(pocketDir, opts) {
  const fs = require('fs');
  const path = require('path');
  const options = opts || {};
  const file = path.join(pocketDir, 'handoff.md');
  if (!fs.existsSync(file)) {
    return {
      ok: false, reason: 'missing', generatedAt: null, latestT: null, stale: false,
      message: 'handoff.md not generated yet — run `handoff` first.',
      lines: [], questions: [],
    };
  }

  const text = fs.readFileSync(file, 'utf8');
  const header = /^> generated-at: T(\d+)/m.exec(text);
  const generatedAt = header ? Number(header[1]) : null;
  let latestT = 0;
  try {
    latestT = Number(require('./parser').parseAll(pocketDir).log.latestT) || 0;
  } catch (err) {
    latestT = generatedAt || 0;
  }
  const stale = generatedAt === null || generatedAt < latestT;

  const start = text.indexOf('## 0 · Start here');
  const next = text.indexOf('## 1 · On demand');
  const section0 = start === -1 ? '' : text.slice(start, next > start ? next : undefined).trimEnd();

  const questions = [];
  const qHead = text.indexOf('### ❓ Must confirm');
  if (qHead !== -1) {
    const qEnd = text.indexOf('\n### ', qHead + 5);
    const block = text.slice(qHead, qEnd > qHead ? qEnd : undefined);
    for (const line of block.split('\n')) {
      if (line.indexOf('- [') === 0) questions.push(line.slice(2));
    }
  }

  const refused = stale && !options.force;
  const body = refused ? [] : (options.full ? text.trimEnd() : section0).split('\n');
  return {
    ok: !refused,
    reason: refused ? 'stale' : (stale ? 'stale-forced' : 'ok'),
    generatedAt: generatedAt,
    latestT: latestT,
    stale: stale,
    message: stale
      ? 'handoff.md is STALE (generated at T' + generatedAt + ', log at T' + latestT + ') — regenerate with `handoff` before relying on it.'
      : '',
    lines: body,
    questions: questions,
  };
}

module.exports = { buildHandoffChains, readHandoffView, EDGE_RULES, shortId, MAX_CHAINS };
