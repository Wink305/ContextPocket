'use strict';

const fs = require('fs');
const path = require('path');
const {
  assert,
  test,
  makeLitePocket,
  writePocketFile,
  readPocketFile,
  runCli,
  runCliJson,
  runMcp,
  ROOT,
} = require('./harness');

const { LITE_CORE_FILES } = require(path.join(ROOT, 'lib', 'constants'));
const { appendLogBlock } = require(path.join(ROOT, 'lib', 'writer'));
const { recall, recallWindow, searchAny, why } = require(path.join(ROOT, 'lib', 'query'));
const { verify } = require(path.join(ROOT, 'lib', 'validator'));
const { deriveLinks } = require(path.join(ROOT, 'lib', 'links'));

function append(pocketDir, gist, fields = {}) {
  return appendLogBlock(pocketDir, {
    gist,
    user: [`Request ${gist}`],
    action: [`Changed src/${gist}.js`],
    ...fields,
  });
}

test('bootstrap creates exactly five markdown files, no config/assets, and refuses overwrite', () => {
  const { projectDir, pocketDir } = makeLitePocket('bootstrap');
  const names = fs.readdirSync(pocketDir).sort();
  assert.deepStrictEqual(names, [...LITE_CORE_FILES].sort());
  assert.strictEqual(names.includes('config.md'), false);
  assert.strictEqual(fs.existsSync(path.join(pocketDir, 'assets')), false);
  assert.throws(() => require(path.join(ROOT, 'lib', 'bootstrap')).bootstrap(projectDir), /refusing to overwrite/i);
});

test('log append numbers turns, writes the schema header and WHEN line, and reports skipped conflict checks', () => {
  const { pocketDir } = makeLitePocket('append');
  const first = append(pocketDir, 'gist', { tags: ['tag'], when: '2026-11-01' });
  const second = append(pocketDir, 'second');
  const log = readPocketFile(pocketDir, 'log.md');
  assert.strictEqual(first.tId, 1);
  assert.strictEqual(second.tId, 2);
  assert.match(log, /^## T1 · gist · \[tag\]$/m);
  assert.match(log, /^--- WHEN: 2026-11-01 \(day\) ---$/m);
  assert.deepStrictEqual({
    conflictCheckSkipped: first.conflictCheckSkipped,
    autoConflicts: first.autoConflicts,
    conflictsWritten: first.conflictsWritten,
  }, { conflictCheckSkipped: true, autoConflicts: [], conflictsWritten: 0 });
});

test('missing gist fails in CLI and MCP with explicit error shapes', () => {
  const { projectDir } = makeLitePocket('missing-gist');
  const cli = runCli(['log', 'append', '--user', 'test', '--action', 'test', '--json'], projectDir);
  assert.strictEqual(cli.status, 1);
  assert.strictEqual(JSON.parse(cli.stdout).ok, false);
  assert.match(JSON.parse(cli.stdout).error, /gist/i);

  const mcp = runMcp(projectDir, [{
    name: 'context_pocket_log_append',
    arguments: { user: ['test'], action: ['test'] },
  }]);
  assert.strictEqual(mcp.calls[0].isError, true);
  assert.match(mcp.calls[0].content[0].text, /gist is required/i);
});

test('recall supports full turns, T/date windows, pagination, and derived context', () => {
  const { projectDir, pocketDir } = makeLitePocket('recall');
  append(pocketDir, 'window-alpha', { when: '2026-11-01', action: ['Modified src/shared.js'] });
  append(pocketDir, 'window-beta', { when: '2026-11-02', action: ['Modified src/shared.js'] });
  append(pocketDir, 'window-gamma', { when: '2026-11-03', action: ['Modified src/shared.js'] });

  assert.strictEqual(recall(pocketDir, 1).gist, 'window-alpha');
  assert.deepStrictEqual(recallWindow(pocketDir, { sinceT: 2, untilT: 3 }).turns.map((turn) => turn.id), [2, 3]);
  assert.deepStrictEqual(recallWindow(pocketDir, { fromDate: '2026-11-02', toDate: '2026-11-03' }).turns.map((turn) => turn.id), [2, 3]);

  const windowCli = runCliJson(['recall', '--since', '1', '--until', '3', '--limit', '1', '--json'], projectDir);
  assert.strictEqual(windowCli.json.turns.length, 1);
  assert.strictEqual(windowCli.json.total, 3);
  assert.strictEqual(windowCli.json.hasMore, true);

  const contextCli = runCliJson(['recall', '1', '--with-context', '--json'], projectDir);
  assert.ok(contextCli.json.context);
  assert.strictEqual(contextCli.json.context.laterChanges.length, 2);
});

test('search reports scan mode and stable pagination, including limit zero', () => {
  const { pocketDir } = makeLitePocket('search');
  append(pocketDir, 'unique-search-needle');
  append(pocketDir, 'unique-search-needle');
  append(pocketDir, 'unique-search-needle');

  const first = searchAny(pocketDir, 'unique-search-needle', { limit: 1 });
  const second = searchAny(pocketDir, 'unique-search-needle', { limit: 1, offset: 1 });
  const all = searchAny(pocketDir, 'unique-search-needle', { limit: 0 });
  assert.strictEqual(first.viaIndex, false);
  assert.strictEqual(first.total, 3);
  assert.strictEqual(first.results.length, 1);
  assert.strictEqual(first.hasMore, true);
  assert.strictEqual(second.offset, 1);
  assert.strictEqual(second.results.length, 1);
  assert.strictEqual(all.limit, null);
  assert.strictEqual(all.results.length, 3);
  assert.strictEqual(all.hasMore, false);
});

test('why distinguishes changed files from mentioned files', () => {
  const { pocketDir } = makeLitePocket('why');
  append(pocketDir, 'file evidence', {
    action: ['Modified src/changed.js'],
    uncertain: ['Check src/mentioned.js later'],
  });
  assert.strictEqual(why(pocketDir, 'src/changed.js')[0].evidence, 'changed');
  assert.strictEqual(why(pocketDir, 'src/mentioned.js')[0].evidence, 'mentioned');
});

test('verify passes a clean pocket, blocks a credential-shaped key, and detects T gaps', () => {
  const clean = makeLitePocket('verify-clean');
  assert.strictEqual(verify(clean.pocketDir).errorCount, 0);

  const secretPocket = makeLitePocket('verify-secret');
  writePocketFile(secretPocket.pocketDir, 'log.md', readPocketFile(secretPocket.pocketDir, 'log.md') + '\nAKIA1234567890ABCDEF\n');
  const secretResult = verify(secretPocket.pocketDir);
  assert.ok(secretResult.results.some((item) => item.category === 'secret-leak' && item.severity === 'error'));

  const gap = makeLitePocket('verify-gap');
  append(gap.pocketDir, 'gap-one');
  append(gap.pocketDir, 'gap-two');
  const log = readPocketFile(gap.pocketDir, 'log.md').replace('## T2 · gap-two', '## T3 · gap-two');
  writePocketFile(gap.pocketDir, 'log.md', log);
  const gapResult = verify(gap.pocketDir);
  assert.ok(gapResult.results.some((item) => item.category === 't-id-continuity' && item.severity === 'error'));
});

test('graph derives runtime edges without creating files', () => {
  const { pocketDir } = makeLitePocket('graph');
  append(pocketDir, 'graph-test', { action: ['Modified src/graph.js'] });
  const before = fs.readdirSync(pocketDir).sort();
  const graph = deriveLinks(pocketDir);
  const after = fs.readdirSync(pocketDir).sort();
  assert.deepStrictEqual(after, before);
  assert.ok(graph.edges.some((edge) => edge.type === 'modifies' && edge.from === 'T1' && edge.to === 'file:src/graph.js'));
  assert.strictEqual(fs.existsSync(path.join(pocketDir, 'assets')), false);
});

test('CLI help, MCP tool list, version, unknown commands, and command-specific help stay in contract', () => {
  const { projectDir } = makeLitePocket('surface');
  const help = runCliJson(['help', '--json'], projectDir).json;
  const commandCount = help.groups.reduce((sum, group) => sum + group.commands.length, 0);
  const mcp = runMcp(projectDir);
  assert.strictEqual(commandCount, 8);
  assert.strictEqual(mcp.tools.length, 8);
  assert.strictEqual(mcp.initialize.serverInfo.name, 'context-pocket-lite');
  assert.strictEqual(mcp.initialize.protocolVersion, '2025-06-18');

  const version = runCli(['--version'], projectDir);
  assert.strictEqual(version.status, 0);
  assert.match(version.stdout, /2\.1-Lite-preview/);
  const versionJson = runCliJson(['version', '--json'], projectDir).json;
  assert.strictEqual(versionJson.version, '2.1-Lite-preview');
  assert.strictEqual(versionJson.display, '2.1-Lite-preview');

  assert.strictEqual(runCli(['unknown-command'], projectDir).status, 1);
  const commandHelp = runCli(['status', '--help'], projectDir);
  assert.strictEqual(commandHelp.status, 0);
  assert.match(commandHelp.stdout, /Usage: context-pocket-lite status/);
  assert.doesNotMatch(commandHelp.stdout, /No ContextPocket\/ directory found/i);
});

test('lite version copies stay aligned: package.json, lib/version.js, SKILL.md', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const { FALLBACK_VERSION, DISPLAY_VERSION } = require(path.join(ROOT, 'lib', 'version'));
  assert.strictEqual(FALLBACK_VERSION, pkg.version, 'lite FALLBACK_VERSION drifted from lite/package.json');
  // 展示规则与主包同一条（ROADMAP §12 + hotfix 追加）：prerelease 显示完整串，稳定版两位加 -lite。
  const expectedDisplay = pkg.version.includes('-')
    ? pkg.version
    : pkg.version.split('.').slice(0, 2).join('.') + '-lite';
  assert.strictEqual(DISPLAY_VERSION, expectedDisplay, 'lite DISPLAY_VERSION violates the display rule');
  const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  const stamped = skill.match(/^version:\s*(\S+)\s*$/m);
  assert.ok(stamped, 'lite SKILL.md frontmatter needs a version: line');
  assert.strictEqual(stamped[1], pkg.version, 'lite SKILL.md version drifted from lite/package.json');
});
