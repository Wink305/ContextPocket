#!/usr/bin/env node
'use strict';

/**
 * ContextPocket yuan — 大 workspace 基准
 *
 * 生成一个临时工作区（默认 10 个口袋 × 1000 轮 = 1 万轮），量三件常被问到的
 * 操作在真实规模下的延迟：
 *
 *   search   workspace search（跨口袋 BM25 索引）
 *   context  context build（预算组装 + 检索 + repo map）
 *   context  context build --expand（跨口袋图扩展）
 *   audit    workspace audit（健康 / 活动 / 未决事项）
 *   graph    工作区时间图（全量构建 / 增量重建）
 *
 * 输出 cold（本进程第一次）与 warm（同进程后续）两组数字。warm 数字对应
 * MCP 常驻进程的实际体验；CLI 每次都是 cold。脚本只读临时产物，默认跑完删除。
 *
 * 用法：
 *   node scripts/bench-workspace.js [options]
 *
 * Options:
 *   --pockets <n>   口袋数（默认 10）
 *   --turns <n>     每个口袋的轮次数（默认 1000）
 *   --runs <n>      每个操作的计时次数（默认 5，取中位数）
 *   --keep          保留临时工作区（会打印路径）
 *   --json          输出一行 JSON
 *   --help          显示本帮助
 *
 * 这不是单元测试：机器差异很大，脚本只报告数字，不设硬阈值。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');

const { bootstrap } = require(path.join(ROOT, 'lib', 'bootstrap'));
const { initWorkspace, addPocket } = require(path.join(ROOT, 'lang', 'lib', 'workspace'));
const { indexWorkspace, searchWorkspaceIndexed } = require(path.join(ROOT, 'lang', 'lib', 'workspace-index'));
const { updateMap } = require(path.join(ROOT, 'lang', 'lib', 'repomap'));
const { buildContext } = require(path.join(ROOT, 'lang', 'lib', 'context'));
const { auditWorkspace } = require(path.join(ROOT, 'lang', 'lib', 'audit'));
const {
  ensureWorkspaceGraph,
  readWorkspaceGraph,
} = require(path.join(ROOT, 'lang', 'lib', 'workspace-graph'));

// 与 MCP 常驻进程同一配置：cold 是第一次，warm 复用 parseAll 结果
const workspaceParser = require(path.join(ROOT, 'lang', 'lib', 'parser'));
workspaceParser.enableParseCache();

function parseArgs(argv) {
  const flags = {};
  const values = new Set(['pockets', 'turns', 'runs']);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('-')) throw new Error('unexpected argument: ' + token);
    const name = token.replace(/^-+/, '');
    if (name === 'help' || name === 'keep' || name === 'json') {
      flags[name] = true;
      continue;
    }
    if (!values.has(name)) throw new Error('unknown option: --' + name);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('-')) throw new Error('--' + name + ' needs a value');
    flags[name] = next;
    i += 1;
  }
  return {
    pockets: Math.max(1, Number(flags.pockets) || 10),
    turns: Math.max(1, Number(flags.turns) || 1000),
    runs: Math.max(1, Number(flags.runs) || 5),
    keep: !!flags.keep,
    json: !!flags.json,
    help: !!flags.help,
  };
}

function usage() {
  const text = fs.readFileSync(__filename, 'utf-8');
  const start = text.indexOf(' * 用法：');
  const end = text.indexOf(' */', start);
  process.stdout.write(text.slice(start, end).split('\n').map((line) => line.replace(/^ \* ?/, '')).join('\n') + '\n');
}

function timer(fn) {
  const started = performance.now();
  const value = fn();
  return { ms: performance.now() - started, value };
}

function summarizeMs(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function measure(fn, runs, reset) {
  if (reset) reset();
  const cold = timer(fn).ms; // 第一次：进程内缓存 / 解析都是冷的
  const samples = [];
  for (let i = 0; i < runs; i++) samples.push(timer(fn).ms);
  return Object.assign({ cold }, summarizeMs(samples));
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function buildLog(pocketName, turns, refPocket) {
  const lines = ['# ContextPocket · LOG', ''];
  for (let i = 1; i <= turns; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    lines.push(
      '--- SESSION: 2026-01-' + day + ' ---',
      '',
      '## T' + i + ' · turn ' + i + ' ' + pocketName + ' needle token' + (i % 100) + ' · [bench]',
      '--- WHEN: 2026-01-' + day + ' ---',
      '',
      '### User',
      '- user turn ' + i,
      '',
      '### Action',
      '- 修改 src/mod' + (i % 5) + '.js — bench change ' + i,
      i % 50 === 0 && refPocket ? '- 参考 ' + refPocket + ':T1 — cross-pocket bench ref' : null,
      '',
      '### Decisions & Constraints',
      '- bench rule ' + i,
      ''
    );
  }
  return lines.filter((line) => line !== null).join('\n');
}

function buildRequirements(turns) {
  const lines = ['# Requirements · next_id: R101', '', '## Open'];
  for (let i = 1; i <= 100; i++) {
    lines.push('- [ ] R' + i + ' bench requirement ' + i + ' (opened T' + (1 + (i % turns)) + ')');
  }
  return lines.join('\n') + '\n';
}

function buildDecisions(turns) {
  const lines = ['# Decisions · T' + turns, ''];
  for (let i = 1; i <= 30; i++) {
    lines.push(
      '## ADR-' + i + ' · bench decision ' + i + ' · T' + (1 + (i % turns)),
      '- Context: benchmark context ' + i,
      '- Options: option-a / option-b',
      '- Decision: use option-a for module ' + (i % 5),
      '- Consequences: benchmark consequence ' + i,
      ''
    );
  }
  return lines.join('\n');
}

function buildPreferences() {
  const lines = ['# Preferences', ''];
  for (let i = 1; i <= 20; i++) lines.push('- bench-key-' + i + ': value-' + i);
  return lines.join('\n') + '\n';
}

function buildState(pocketName, turns) {
  return [
    '# State · T' + turns,
    '',
    '## Summary',
    '- benchmark pocket ' + pocketName + ' is healthy',
    '',
    '## Next Steps',
    '- keep measuring',
    '',
    '## Pitfalls',
    '- synthetic data only',
    '',
  ].join('\n');
}

function makeFiles(projectDir, pocketName) {
  const src = path.join(projectDir, 'src');
  fs.mkdirSync(src, { recursive: true });
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(src, 'mod' + i + '.js'), [
      '// ' + pocketName + ' module ' + i,
      'export function ' + pocketName + 'Fn' + i + '(value) { return value + ' + i + '; }',
      'export class ' + pocketName + 'Class' + i + ' {}',
      '',
    ].join('\n'), 'utf-8');
  }
}

function buildWorkspace(options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-bench-ws-'));
  initWorkspace(root, { name: 'bench' });

  for (let i = 0; i < options.pockets; i++) {
    const name = 'svc' + i;
    const projectDir = path.join(root, name);
    fs.mkdirSync(projectDir, { recursive: true });
    const boot = bootstrap(projectDir, {});
    const pocketDir = boot.pocketDir;
    const refPocket = options.pockets > 1 ? 'svc' + ((i + 1) % options.pockets) : null;

    fs.writeFileSync(path.join(pocketDir, 'log.md'), buildLog(name, options.turns, refPocket), 'utf-8');
    fs.writeFileSync(path.join(pocketDir, 'requirements.md'), buildRequirements(options.turns), 'utf-8');
    fs.writeFileSync(path.join(pocketDir, 'decisions.md'), buildDecisions(options.turns), 'utf-8');
    fs.writeFileSync(path.join(pocketDir, 'preferences.md'), buildPreferences(), 'utf-8');
    fs.writeFileSync(path.join(pocketDir, 'state.md'), buildState(name, options.turns), 'utf-8');

    makeFiles(projectDir, name);
    addPocket(root, name, projectDir);
  }
  return root;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const root = buildWorkspace(options);
  const totalTurns = options.pockets * options.turns;
  const query = 'needle token42';
  let json;
  try {
    const indexed = timer(() => indexWorkspace(root, { rebuild: true })).ms;
    const mapped = timer(() => updateMap(root)).ms;
    const graphCold = timer(() => ensureWorkspaceGraph(root, { force: true })).ms;
    const graphWarm = timer(() => ensureWorkspaceGraph(root)).ms;
    const graphStats = readWorkspaceGraph(root).stats;

    const search = measure(() => searchWorkspaceIndexed(root, query, { limit: 20 }), options.runs);
    const context = measure(() => buildContext(root, { query, maxTokens: 6000 }), options.runs,
      () => workspaceParser.resetParseCache());
    const contextExpand = measure(() => buildContext(root, { query, maxTokens: 6000, expand: 2 }), options.runs,
      () => workspaceParser.resetParseCache());
    const derivedSample = buildContext(root, { query, maxTokens: 6000, expand: 2, graphEdges: 'all' });
    const contextEdges = measure(() => buildContext(root, { query, maxTokens: 6000, expand: 2, graphEdges: 'all' }), options.runs,
      () => workspaceParser.resetParseCache());
    const audit = measure(() => auditWorkspace(root, {}), options.runs,
      () => workspaceParser.resetParseCache());

    const incrementalPocket = path.join(root, 'svc0', 'ContextPocket');
    fs.appendFileSync(path.join(incrementalPocket, 'log.md'), [
      '',
      '--- SESSION: 2026-02-01 ---',
      '',
      '## T' + (options.turns + 1) + ' · bench incremental turn · [bench]',
      '--- WHEN: 2026-02-01 ---',
      '',
      '### User',
      '- incremental bench',
      '',
      '### Action',
      '- 修改 src/mod0.js — incremental bench',
      '',
    ].join('\n'), 'utf-8');
    const incremental = timer(() => ensureWorkspaceGraph(root));

    json = {
      ok: true,
      root,
      pockets: options.pockets,
      turnsPerPocket: options.turns,
      totalTurns,
      runs: options.runs,
      indexBuildMs: round(indexed),
      repoMapBuildMs: round(mapped),
      graph: {
        nodes: graphStats.nodes,
        edges: graphStats.edges,
        crossPocketEdges: graphStats.crossPocketEdges,
        danglingCrossRefs: graphStats.danglingCrossRefs,
        derivedEdges: derivedSample.sources.graph.derivedEdges,
        coldBuildMs: round(graphCold),
        warmReadMs: round(graphWarm),
        incrementalMs: round(incremental.ms),
        incrementalRebuiltPockets: incremental.value.rebuiltPockets.length,
      },
      search: { coldMs: round(search.cold), medianMs: round(search.median), minMs: round(search.min), maxMs: round(search.max) },
      context: { coldMs: round(context.cold), medianMs: round(context.median), minMs: round(context.min), maxMs: round(context.max) },
      contextExpand: { coldMs: round(contextExpand.cold), medianMs: round(contextExpand.median), minMs: round(contextExpand.min), maxMs: round(contextExpand.max) },
      contextEdges: { coldMs: round(contextEdges.cold), medianMs: round(contextEdges.median), minMs: round(contextEdges.min), maxMs: round(contextEdges.max) },
      audit: { coldMs: round(audit.cold), medianMs: round(audit.median), minMs: round(audit.min), maxMs: round(audit.max) },
    };

    if (options.json) {
      process.stdout.write(JSON.stringify(json) + '\n');
    } else {
      process.stdout.write('\nContextPocket workspace benchmark\n');
      process.stdout.write('  ' + options.pockets + ' pockets · ' + totalTurns + ' turns · '
        + options.runs + ' timed run(s) per operation\n');
      process.stdout.write('  index build: ' + json.indexBuildMs + ' ms · repo map: ' + json.repoMapBuildMs + ' ms\n');
      process.stdout.write('  graph: ' + json.graph.nodes + ' node(s) · '
        + json.graph.crossPocketEdges + ' cross-pocket edge(s) · '
        + json.graph.derivedEdges + ' derived edge(s) · '
        + json.graph.danglingCrossRefs + ' dangling\n');
      process.stdout.write('  graph cold build: ' + json.graph.coldBuildMs + ' ms · fresh read: '
        + json.graph.warmReadMs + ' ms · incremental: ' + json.graph.incrementalMs
        + ' ms (' + json.graph.incrementalRebuiltPockets + ' pocket rebuilt)\n');
      const line = (label, data) => '  ' + label.padEnd(16)
        + 'cold ' + String(data.coldMs).padStart(8) + ' ms · '
        + 'warm median ' + String(data.medianMs).padStart(7) + ' ms '
        + '(min ' + data.minMs + ' / max ' + data.maxMs + ')\n';
      process.stdout.write(line('search', json.search));
      process.stdout.write(line('context build', json.context));
      process.stdout.write(line('context expand', json.contextExpand));
      process.stdout.write(line('context edges', json.contextEdges));
      process.stdout.write(line('audit', json.audit));
      process.stdout.write('\n  warm = same process, parse/index caches warm (MCP-like); CLI is cold each run.\n');
      process.stdout.write('  workspace: ' + root + '\n\n');
    }
  } finally {
    if (!options.keep) fs.rmSync(root, { recursive: true, force: true });
  }
}

try {
  main();
} catch (e) {
  process.stderr.write('bench-workspace: ' + e.message + '\n');
  process.exit(1);
}

module.exports = {
  buildLog,
  buildRequirements,
  buildDecisions,
  buildPreferences,
  measure,
};
