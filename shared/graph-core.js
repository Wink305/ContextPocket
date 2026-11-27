'use strict';

/**
 * ContextPocket 工作区时间图 — 纯图原语
 *
 * 单口袋图（shared/links-core.js）的时间轴是口袋内数字 T id，无法跨口袋比较；
 * 这里用 WHEN 日期做工作区级时间轴，并提供：
 *   - 跨口袋限定引用解析（pocket:Tn）
 *   - 按日期判断节点是否活跃
 *   - 确定性、有界的邻接构建与 BFS 扩展
 *
 * 零依赖、零 require；索引布局与缓存仍在各自模块。
 */

const CROSS_REF_RE = /\b([a-z][a-z0-9_-]*):T(\d+)\b/gi;

const DEFAULT_RESULT_TYPES = ['T', 'correction', 'ADR', 'R', 'K'];

/** 与 consolidate / 工作区派生边共用的归一化 key：折叠空白、去首尾、转小写。 */
function normalizeKey(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function dayNumber(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) return null;
  return Math.floor(time / 86400000);
}

/** 两个 YYYY-MM-DD 之间的整天数；任一日期无效时返回 null。 */
function daysBetween(a, b) {
  const left = dayNumber(a);
  const right = dayNumber(b);
  if (left === null || right === null) return null;
  return Math.abs(left - right);
}

/** 与 diagnostics / workspace-graph 共用的块文本：gist + 所有子节。 */
function blockText(block) {
  const parts = [block.gist || ''];
  for (const value of Object.values(block.sections || {})) {
    if (Array.isArray(value)) parts.push(value.join('\n'));
    else if (value) parts.push(String(value));
  }
  return parts.join('\n');
}

/**
 * 从一段文本里提取限定跨口袋引用。
 * - 只认 `pocket:T<n>`；裸 `T5` 不算
 * - pocket 归一为小写；同一目标重复出现只保留一条
 * - 保持首次出现顺序
 *
 * @param {string} text
 * @returns {{pocket: string, tId: number}[]}
 */
function parseCrossRefs(text) {
  const source = String(text || '');
  const re = new RegExp(CROSS_REF_RE.source, CROSS_REF_RE.flags);
  const seen = new Set();
  const refs = [];
  let match;
  while ((match = re.exec(source)) !== null) {
    const pocket = match[1].toLowerCase();
    const tId = Number(match[2]);
    if (!Number.isSafeInteger(tId) || tId < 1) continue;
    const key = pocket + ':T' + tId;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ pocket, tId });
  }
  return refs;
}

/**
 * 节点在某个日期是否可见。
 *
 * @param {object} record 节点/边，至少含 date，可选 dateFrom / dateTo
 * @param {string|null} asOf YYYY-MM-DD 或 null
 * @returns {boolean}
 */
function activeOnDate(record, asOf) {
  if (!asOf) return true;
  if (!record) return false;
  const from = record.dateFrom || record.date || null;
  // 没有日期的节点在 as-of 查询下不可见：不拿 mtime 或“大概时间”猜
  if (!from) return false;
  if (String(from).slice(0, 10) > asOf) return false;
  const to = record.dateTo || null;
  if (to && String(to).slice(0, 10) < asOf) return false;
  return true;
}

/**
 * 构建双向邻接表；每个节点只保留排序后的前 maxDegree 条。
 * 边的 evidence=weak 默认不参与遍历（与 quan expandGraph 一致）。
 *
 * @param {object[]} nodes
 * @param {object[]} edges
 * @param {object} [options]
 * @param {number} [options.maxDegree]
 * @param {boolean} [options.includeWeak] weak 边是否参与遍历（默认 false）
 * @param {(edge: object) => boolean} [options.includeEdge]
 * @returns {Map<string, {id: string, direction: string, edge: object}[]>}
 */
function buildAdjacency(nodes, edges, options = {}) {
  const maxDegree = Number.isInteger(options.maxDegree) && options.maxDegree > 0
    ? options.maxDegree
    : 32;
  const includeWeak = !!options.includeWeak;
  const includeEdge = options.includeEdge || (() => true);
  const byId = new Map((nodes || []).map((node) => [node.id, node]));
  const adjacency = new Map();
  for (const id of byId.keys()) adjacency.set(id, []);

  for (const edge of edges || []) {
    if (!edge) continue;
    if (!includeWeak && edge.evidence === 'weak') continue;
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    if (!includeEdge(edge)) continue;
    adjacency.get(edge.from).push({ id: edge.to, direction: 'outgoing', edge });
    adjacency.get(edge.to).push({ id: edge.from, direction: 'incoming', edge });
  }

  for (const items of adjacency.values()) {
    items.sort((a, b) => a.id.localeCompare(b.id)
      || String(a.edge.type).localeCompare(String(b.edge.type))
      || a.direction.localeCompare(b.direction));
    if (items.length > maxDegree) items.length = maxDegree;
  }
  return adjacency;
}

/**
 * 从种子出发做日期感知的有界 BFS。
 *
 * @param {object} graph {nodes, edges}
 * @param {string[]} seeds 限定 id 列表
 * @param {1|2|3} depth
 * @param {object} [options]
 * @param {string|null} [options.asOf]
 * @param {number} [options.maxNodes=50]
 * @param {number} [options.maxDegree=32]
 * @param {number} [options.maxVisited=5000]
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.resultTypes]
 * @param {string[]} [options.crossOnlyTypes] 只返回跨口袋命中的类型（桥接节点用）
 * @param {boolean} [options.includeWeak]
 * @param {(edge: object) => boolean} [options.includeEdge]
 * @returns {{depth:number, asOf:string|null, results:object[], hasMore:boolean}}
 */
function expandByDate(graph, seeds, depth, options = {}) {
  const asOf = options.asOf || null;
  const maxNodes = Number.isInteger(options.maxNodes) && options.maxNodes > 0
    ? options.maxNodes
    : 50;
  const maxVisited = Number.isInteger(options.maxVisited) && options.maxVisited > 0
    ? options.maxVisited
    : 5000;
  const resultTypes = new Set(options.resultTypes || DEFAULT_RESULT_TYPES);
  const crossOnlyTypes = new Set(options.crossOnlyTypes || []);
  const excluded = new Set(options.exclude || []);
  const userFilter = options.includeEdge || (() => true);
  const nodes = (graph && graph.nodes) || [];
  const edges = (graph && graph.edges) || [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const active = new Set(nodes.filter((node) => activeOnDate(node, asOf)).map((node) => node.id));

  const adjacency = buildAdjacency(nodes, edges, {
    maxDegree: options.maxDegree,
    includeWeak: !!options.includeWeak,
    includeEdge: (edge) => active.has(edge.from) && active.has(edge.to) && userFilter(edge),
  });

  const seedIds = [...new Set(seeds || [])]
    .filter((id) => active.has(id))
    .sort();
  const queue = seedIds.map((id) => ({ id, path: [] }));
  const visited = new Set(seedIds);
  const results = [];
  let hasMore = false;

  for (let cursor = 0; cursor < queue.length; cursor++) {
    if (visited.size >= maxVisited) {
      hasMore = true;
      break;
    }
    const current = queue[cursor];
    if (current.path.length >= depth) continue;
    for (const next of adjacency.get(current.id) || []) {
      if (visited.has(next.id)) continue;
      visited.add(next.id);
      const path = current.path.concat(Object.assign({ direction: next.direction }, next.edge));
      const node = byId.get(next.id);
      if (!node) continue;
      const fromNode = byId.get(next.edge.from);
      const toNode = byId.get(next.edge.to);
      const cross = !!(fromNode && toNode && fromNode.pocket && toNode.pocket
        && fromNode.pocket !== toNode.pocket);
      const typeAllowed = resultTypes.has(node.type)
        && (!crossOnlyTypes.has(node.type) || cross);
      if (typeAllowed && !excluded.has(node.id)) {
        results.push({
          id: node.id,
          type: node.type,
          label: node.label || '',
          archived: !!node.archived,
          date: node.date || null,
          scope: next.edge.scope || (cross ? 'cross' : 'intra'),
          distance: path.length,
          path,
        });
      }
      queue.push({ id: next.id, path });
    }
  }

  results.sort((a, b) => a.distance - b.distance
    || (a.scope === 'cross' ? 0 : 1) - (b.scope === 'cross' ? 0 : 1)
    || String(b.date || '').localeCompare(String(a.date || ''))
    || a.id.localeCompare(b.id));

  if (results.length > maxNodes) hasMore = true;
  return {
    depth,
    asOf,
    results: results.slice(0, maxNodes),
    hasMore,
  };
}

module.exports = {
  CROSS_REF_RE,
  DEFAULT_RESULT_TYPES,
  blockText,
  parseCrossRefs,
  normalizeKey,
  daysBetween,
  activeOnDate,
  buildAdjacency,
  expandByDate,
};
