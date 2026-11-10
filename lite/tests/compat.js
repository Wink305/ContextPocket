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

const SHARED_EDGE_TYPES = new Set([
  'modifies',
  'mentions',
  'references',
  'decided-in',
  'supersedes',
  'last-changed',
]);
const SHARED_NODE_TYPES = new Set(['turn', 'file', 'decision', 'correction']);

function sharedGraph(graph) {
  return {
    nodes: graph.nodes.filter((node) => SHARED_NODE_TYPES.has(node.type)),
    edges: graph.edges.filter((edge) => SHARED_EDGE_TYPES.has(edge.type)),
  };
}

function reachedNodes(nodes) {
  return nodes.map(({ id, type, label, archived, distance }) => ({
    id, type, label, archived, distance,
  }));
}

function sharedSearchResult(result) {
  const { expandedCount, ...shared } = result;
  return shared;
}

function fixture(tag) {
  const made = makeLitePocket(tag);
  const append = (writer, gist, user, action, decisions = []) => writer.appendLogBlock(made.pocketDir, {
    gist,
    tags: ['compat'],
    user: [user],
    action: [action],
    decisions,
    when: '2026-11-01',
  });
  append(liteWriter, 'fixture first', 'Initial turn', 'Modified src/shared.js');
  append(liteWriter, 'fixture second', 'Follow-up turn', 'Modified src/shared.js');
  append(liteWriter, 'fixture third', 'Decision turn', 'Modified src/other.js');
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
  writePocketFile(made.pocketDir, 'requirements.md', [
    '# Requirements · T3',
    '',
    '## Open',
    '- R1 · Shared compatibility search fixture',
    '  - Opened: T1',
    '',
  ].join('\n'));
  writePocketFile(made.pocketDir, 'preferences.md', [
    '# Preferences · T3',
    '- Keep the shared schema visible to both packages',
    '',
  ].join('\n'));
  return made;
}

test('links derivation, context, and formatted context lines are schema-identical', () => {
  const { pocketDir } = fixture('compat-links');
  const liteGraph = liteLinks.deriveLinks(pocketDir);
  const mainGraph = mainLinks.deriveLinks(pocketDir);
  assert.deepStrictEqual(sharedGraph(liteGraph), sharedGraph(mainGraph));
  assert.deepStrictEqual(
    liteLinks.buildContext(pocketDir, 1, { graph: liteGraph, includeWeak: true }),
    mainLinks.buildContext(pocketDir, 1, { graph: mainGraph, includeWeak: true })
  );
  const context = liteLinks.buildContext(pocketDir, 1, { graph: liteGraph, includeWeak: true });
  assert.deepStrictEqual(liteLinks.formatContextLines(context), mainLinks.formatContextLines(context));
});

test('multi-hop expansion is identical on the same derived graph', () => {
  const { pocketDir } = fixture('compat-expand');
  const liteGraph = liteLinks.deriveLinks(pocketDir);
  const mainGraph = mainLinks.deriveLinks(pocketDir);
  for (const depth of [1, 2, 3]) {
    const liteExpansion = liteLinks.expandFrom(sharedGraph(liteGraph), ['T1'], depth);
    const mainExpansion = mainLinks.expandGraph(mainGraph, ['T1'], depth);
    assert.deepStrictEqual(
      reachedNodes(liteExpansion.nodes),
      reachedNodes(mainExpansion.results)
    );
  }
  assert.strictEqual(liteLinks.MAX_EXPAND_DEPTH, 3);
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
