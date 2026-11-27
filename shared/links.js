'use strict';

/**
 * 关联图缓存外壳（quan）
 *
 * 纯派生与格式化在 links-core；本文件只负责：
 *   - graph.jsonl 的签名 / 序列化 / 解析
 *   - stale / corrupt 检测与自愈
 *   - migrate / repair 后的缓存刷新
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { writeAtomic } = require('./io');
const linksCore = require('./links-core');
const { deriveLinks } = linksCore;

const GRAPH_SOURCE_FILES = ['code-map.md', 'decisions.md', 'knowledge.md', 'log-archive.md', 'log.md', 'requirements.md'];

/**
 * 缓存格式版本（Node schema v2 的第一版序列化）。派生规则变了
 * （加一种边、改一处归属判定、改字段）就必须 bump：旧缓存据此判
 * schema 不符 → stale → 读取时自动重写，不需要任何手工迁移。
 * graph/3：派生加入 tag / requirement 节点与 tagged / opened-in /
 * completed-in / implements 边（与 Lite 2.5 对齐），requirements.md
 * 进入源签名，节点序列化保留 status。
 * graph/4：knowledge.md 进入源签名；新增 K 节点与 derived-from /
 * covers / supersedes / contradicts / duplicate-of 边。
 */
const GRAPH_SCHEMA = 'graph/4';

const GRAPH_FILE = 'graph.jsonl';

function graphPath(pocketDir) {
  return path.join(pocketDir, 'assets', GRAPH_FILE);
}

/** 五个源文件各自的 sha1。纯函数：同内容同签名，跨平台一致（不受 mtime/行尾影响） */
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
    for (const key of ['archived', 'source', 'status', 'topic', 'kKind', 'confidence', 'date', 'sourceCount', 'recordedAt', 'validFrom', 'validTo']) {
      if (n[key] !== undefined) rec[key] = n[key];
    }
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
      recordedAt: e.recordedAt,
      validFrom: e.validFrom,
      validTo: e.validTo,
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
  // 签名 fresh 只说明「五个源文件没动过」。这里再逐字比对一遍：
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

module.exports = Object.assign({}, linksCore, {
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
});
