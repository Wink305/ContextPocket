'use strict';

const path = require('path');
const {
  assert,
  test,
  makeLitePocket,
  writePocketFile,
  readPocketFile,
  ROOT,
  MAIN_ROOT,
} = require('./harness');

const liteParser = require(path.join(ROOT, 'lib', 'parser'));
const mainParser = require(path.join(MAIN_ROOT, 'lib', 'parser'));
const liteQuery = require(path.join(ROOT, 'lib', 'query'));
const mainQuery = require(path.join(MAIN_ROOT, 'lib', 'query'));
const liteLinks = require(path.join(ROOT, 'lib', 'links'));
const mainLinks = require(path.join(MAIN_ROOT, 'lib', 'links'));
const liteWriter = require(path.join(ROOT, 'lib', 'writer'));
const mainWriter = require(path.join(MAIN_ROOT, 'lib', 'writer'));

// 契约：同一份口袋，两包派生出**同一张图**（节点、边、时间字段全部逐字一致）。
// 这里不再有 SHARED_*_TYPES 白名单 —— 白名单会把「一边多派生了一类节点」
// 这种真实漂移悄悄滤掉，2.4/2.5 的 tag/requirement 分叉正是这么漏掉的。

function reachedNodes(nodes) {
  return nodes.map(({ id, type, label, archived, distance }) => ({
    id, type, label, archived, distance,
  }));
}

// 两包 searchAny 的共有形状。主包有索引缓存（expandedCount），Lite 有
// 图扩展截断旗标（expansionTruncated）—— 都是各自的实现细节，不属于契约。
function sharedSearchResult(result) {
  const { expandedCount, expansionTruncated, ...shared } = result;
  return shared;
}

function fixture(tag) {
  const made = makeLitePocket(tag);
  const append = (writer, gist, user, action, decisions = [], uncertain = []) => writer.appendLogBlock(made.pocketDir, {
    gist,
    tags: ['compat'],
    user: [user],
    action: Array.isArray(action) ? action : [action],
    decisions,
    uncertain,
    when: '2026-11-01',
  });
  append(liteWriter, 'fixture first', 'Initial turn', 'Modified src/shared.js');
  append(liteWriter, 'fixture second', 'Follow-up turn', ['Corrects T1: boundary fix', 'Modified src/shared.js']);
  append(liteWriter, 'fixture third', 'Decision turn', 'Modified src/other.js', [], ['要不要一起改 src/extra.js']);
  // 更正块（## T<n>-fix）：覆盖第 6 类节点 correction，它不参与 T 发号
  writePocketFile(made.pocketDir, 'log.md', readPocketFile(made.pocketDir, 'log.md')
    + '\n## T1-fix · boundary correction · [correction]\n\n### Action\n- Corrects T1: closed interval\n');
  writePocketFile(made.pocketDir, 'decisions.md', [
    '# Decisions · T3',
    '',
    '## ADR-1 · Shared schema · T1',
    '- Context: compatibility fixture',
    '- Options: one schema / two schemas',
    '- Decision: one schema',
    '- Consequences: both packages interoperate',
    '- Supersedes: none',
    '',
    '## ADR-2 · Search behavior · T3',
    '- Context: keep scans equivalent',
    '- Options: index / scan',
    '- Decision: scan',
    '- Consequences: same result shape',
    '- Supersedes: ADR-1',
    '',
  ].join('\n'));
  writePocketFile(made.pocketDir, 'code-map.md', [
    '# Code Map · T3 · 2026-11-01',
    '',
    '## Structure',
    '```',
    'src/',
    '├── shared.js → shared implementation',
    '│   T2: follow-up',
    '└── other.js → other implementation',
    '    T3: decision turn',
    '```',
    '',
  ].join('\n'));
  // 规范格式（与 writer.addRequirement 的产出一致）：Open/Done 各一条真需求，
  // 外加一条占位文本 —— 占位不建节点，这条规则两包也必须一致。
  writePocketFile(made.pocketDir, 'requirements.md', [
    '# Requirements · T3',
    '',
    '## Open',
    '- [ ] R1 Shared compatibility search fixture [compat] (opened T1) · impl: src/shared.js',
    '- [ ] R3 <placeholder text> [<tag>] (opened T2)',
    '',
    '## Done',
    '- [x] R2 Retire the first schema [compat] (opened T1, completed T3) · impl: src/other.js',
    '',
  ].join('\n'));
  writePocketFile(made.pocketDir, 'preferences.md', [
    '# Preferences · T3',
    '- Keep the shared schema visible to both packages',
    '',
  ].join('\n'));
  return made;
}

test('links derivation is graph-identical: every node and edge, no whitelist', () => {
  const { pocketDir } = fixture('compat-links');
  const liteGraph = liteLinks.deriveLinks(pocketDir);
  const mainGraph = mainLinks.deriveLinks(pocketDir);
  assert.deepStrictEqual(liteGraph, mainGraph);

  // 一致性不能靠「两边都空」达成：夹具必须真的触发全部 10 类边 / 6 类节点
  const edgeTypes = new Set(mainGraph.edges.map((e) => e.type));
  for (const t of ['modifies', 'mentions', 'references', 'decided-in', 'supersedes', 'last-changed',
    'tagged', 'opened-in', 'completed-in', 'implements']) {
    assert.ok(edgeTypes.has(t), `夹具应产出 ${t} 边，否则整图一致是空转`);
  }
  const nodeTypes = new Set(mainGraph.nodes.map((n) => n.type));
  for (const t of ['turn', 'file', 'decision', 'correction', 'tag', 'requirement']) {
    assert.ok(nodeTypes.has(t), `夹具应产出 ${t} 节点`);
  }
  assert.ok(!mainGraph.nodes.some((n) => n.id === 'req:R3'), '占位文本不建需求节点');

  assert.deepStrictEqual(
    liteLinks.buildContext(pocketDir, 1, { graph: liteGraph, includeWeak: true }),
    mainLinks.buildContext(pocketDir, 1, { graph: mainGraph, includeWeak: true })
  );
  const context = liteLinks.buildContext(pocketDir, 1, { graph: liteGraph, includeWeak: true });
  assert.deepStrictEqual(liteLinks.formatContextLines(context), mainLinks.formatContextLines(context));
});

test('multi-hop expansion is identical on the same full derived graph', () => {
  const { pocketDir } = fixture('compat-expand');
  const liteGraph = liteLinks.deriveLinks(pocketDir);
  const mainGraph = mainLinks.deriveLinks(pocketDir);
  assert.deepStrictEqual(liteGraph, mainGraph);
  for (const depth of [1, 2, 3]) {
    const liteExpansion = liteLinks.expandFrom(liteGraph, ['T1'], depth);
    const mainExpansion = mainLinks.expandGraph(mainGraph, ['T1'], depth);
    assert.deepStrictEqual(
      reachedNodes(liteExpansion.nodes),
      reachedNodes(mainExpansion.results)
    );
    assert.strictEqual(liteExpansion.hasMore, false);
    assert.strictEqual(mainExpansion.hasMore, false);
  }
  // 种子去重 + 过滤图上不存在的 id：两包同一套安全口径
  assert.deepStrictEqual(
    reachedNodes(liteLinks.expandFrom(liteGraph, ['T1', 'T1', 'T999', 'file:nope.js'], 2).nodes),
    reachedNodes(mainLinks.expandGraph(mainGraph, ['T1', 'T1', 'T999', 'file:nope.js'], 2).results)
  );
  assert.strictEqual(liteLinks.MAX_EXPAND_DEPTH, 3);
});

test('expansion truncates at the same 100-node safety cap in both packages', () => {
  const { pocketDir } = makeLitePocket('compat-cap');
  const files = [];
  for (let i = 1; i <= 150; i++) {
    files.push(`Modified src/f${String(i).padStart(3, '0')}.js`);
  }
  liteWriter.appendLogBlock(pocketDir, {
    gist: 'wide turn',
    user: ['cap fixture'],
    action: files,
    when: '2026-11-01',
  });
  const liteGraph = liteLinks.deriveLinks(pocketDir);
  const mainGraph = mainLinks.deriveLinks(pocketDir);
  assert.deepStrictEqual(liteGraph, mainGraph);

  const liteExpansion = liteLinks.expandFrom(liteGraph, ['T1'], 1);
  const mainExpansion = mainLinks.expandGraph(mainGraph, ['T1'], 1);
  assert.strictEqual(liteLinks.MAX_EXPAND_NODES, 100);
  assert.strictEqual(liteExpansion.nodes.length, 100);
  assert.strictEqual(mainExpansion.results.length, 100);
  assert.strictEqual(liteExpansion.hasMore, true);
  assert.strictEqual(mainExpansion.hasMore, true);
  assert.deepStrictEqual(reachedNodes(liteExpansion.nodes), reachedNodes(mainExpansion.results));
});

test('amend writes the same log bytes in both packages', () => {
  const liteFixture = fixture('compat-amend-lite');
  const mainFixture = fixture('compat-amend-main');
  const payload = { decisions: ['compat decision'], pitfalls: ['compat pitfall'] };
  const liteResult = liteWriter.amendLogBlock(liteFixture.pocketDir, 1, payload);
  const mainResult = mainWriter.amendLogBlock(mainFixture.pocketDir, 1, payload);
  assert.deepStrictEqual(liteResult.filled, mainResult.filled);
  assert.deepStrictEqual(liteResult.skipped, mainResult.skipped);
  assert.strictEqual(readPocketFile(liteFixture.pocketDir, 'log.md'), readPocketFile(mainFixture.pocketDir, 'log.md'));
});

test('parser parseAll output is identical on the same Lite-shaped pocket', () => {
  const { pocketDir } = fixture('compat-parser');
  assert.deepStrictEqual(liteParser.parseAll(pocketDir), mainParser.parseAll(pocketDir));
});

test('Lite scan results match the main package forced scan exactly', () => {
  const { pocketDir } = fixture('compat-search');
  assert.deepStrictEqual(
    sharedSearchResult(liteQuery.searchAny(pocketDir, 'shared schema', { limit: 0 })),
    mainQuery.searchAny(pocketDir, 'shared schema', { useIndex: false, limit: 0 })
  );
});

test('Lite exact T-id search matches the full scan for live, archived, padded, and missing ids', () => {
  const { pocketDir } = fixture('compat-search-id');
  writePocketFile(pocketDir, 'log-archive.md', [
    '## T4 · archived turn',
    '',
    '### User',
    '- Archived request',
    '',
    '### Action',
    '- Modified src/archived.js',
    '',
  ].join('\n'));
  for (const keyword of ['T1', 't002', 'T4', 'T99']) {
    assert.deepStrictEqual(
      sharedSearchResult(liteQuery.searchAny(pocketDir, keyword, { limit: 0 })),
      mainQuery.searchAny(pocketDir, keyword, { useIndex: false, limit: 0 })
    );
  }
});

test('Lite-written blocks parse in main and main-written blocks recall in Lite', () => {
  const { pocketDir } = fixture('compat-write');
  const liteAppend = liteWriter.appendLogBlock(pocketDir, {
    gist: 'lite interoperability',
    tags: ['shared'],
    user: ['Lite writer fixture'],
    action: ['Modified src/lite.js'],
    when: '2026-11-02',
  });
  const parsedByMain = mainParser.parseLogAll(pocketDir).blocks.find((block) => block.id === liteAppend.tId);
  assert.strictEqual(parsedByMain.gist, 'lite interoperability');
  assert.deepStrictEqual(parsedByMain.tags, ['shared']);
  assert.strictEqual(parsedByMain.when.date, '2026-11-02');
  assert.deepStrictEqual(parsedByMain.sections.User, ['Lite writer fixture']);
  assert.deepStrictEqual(parsedByMain.sections.Action, ['Modified src/lite.js']);

  const mainAppend = mainWriter.appendLogBlock(pocketDir, {
    gist: 'main interoperability',
    tags: ['shared'],
    user: ['Main writer fixture'],
    action: ['Modified src/main.js'],
    when: '2026-11-03',
  });
  const parsedByLite = liteQuery.recall(pocketDir, mainAppend.tId);
  assert.strictEqual(parsedByLite.gist, 'main interoperability');
  assert.deepStrictEqual(parsedByLite.tags, ['shared']);
  assert.strictEqual(parsedByLite.when.date, '2026-11-03');
  assert.deepStrictEqual(parsedByLite.sections.User, ['Main writer fixture']);
  assert.deepStrictEqual(parsedByLite.sections.Action, ['Modified src/main.js']);
});
