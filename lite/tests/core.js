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
const { appendLogBlock, amendLogBlock, generateHandoff } = require(path.join(ROOT, 'lib', 'writer'));
const { recall, recallWindow, searchAny, why, diff } = require(path.join(ROOT, 'lib', 'query'));
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

test('search and why expand walk the runtime graph and leave the direct results untouched', () => {
  const { pocketDir } = makeLitePocket('expand');
  // T1/T2 共用 src/shared.js（两跳可达）；T3 只碰 src/noise.js
  append(pocketDir, 'alpha shared', { action: ['Modified src/shared.js'] });
  append(pocketDir, 'beta shared', { action: ['Modified src/shared.js'] });
  append(pocketDir, 'gamma noise', { action: ['Modified src/noise.js'] });
  // why 的种子：T4 只在 Uncertain 里提到 src/target.js，同时改了 src/shared.js，
  // 于是 why target 的扩展经过 file:src/shared.js 才到达 T1/T2
  append(pocketDir, 'delta mentions target', {
    action: ['Modified src/shared.js'],
    uncertain: ['Check src/target.js later'],
  });

  const plain = searchAny(pocketDir, 'alpha', {});
  assert.strictEqual(plain.expandedCount, 0);
  assert.deepStrictEqual(plain.results.map((r) => r.id), [1]);

  const expanded = searchAny(pocketDir, 'alpha', { expand: 2 });
  // T2 与 T4 都经 file:src/shared.js 在第二跳到达
  assert.strictEqual(expanded.expandedCount, 2);
  assert.strictEqual(expanded.total, 1);
  assert.strictEqual(expanded.results[0].id, 1);
  const linked = expanded.results.filter((r) => r.expanded);
  assert.deepStrictEqual(linked.map((r) => r.id).sort(), [2, 4]);
  assert.ok(linked.every((r) => r.distance === 2 && r.via === 'modifies'));

  // 一跳只够到 file 节点，不产生 linked 轮次
  assert.strictEqual(searchAny(pocketDir, 'alpha', { expand: 1 }).expandedCount, 0);

  const whyPlain = why(pocketDir, 'src/target.js');
  assert.deepStrictEqual(whyPlain.map((r) => r.id), [4]);
  const whyExpanded = why(pocketDir, 'src/target.js', { expand: 2 });
  const whyLinked = whyExpanded.filter((r) => r.evidence === 'linked');
  assert.deepStrictEqual(whyLinked.map((r) => r.id).sort(), [1, 2]);
  assert.ok(whyLinked.every((r) => r.distance === 2 && r.references.length === 0));

  // CLI 的 --expand 与库层同一条路径
  const cli = runCliJson(['search', 'alpha', '--expand', '2', '--json'], path.dirname(pocketDir));
  assert.strictEqual(cli.json.expand, 2);
  assert.strictEqual(cli.json.expandedCount, 2);
});

test('graph expansion ignores weak mention edges', () => {
  const { pocketDir } = makeLitePocket('expand-weak');
  append(pocketDir, 'direct hit', { action: ['Modified src/shared.js'] });
  append(pocketDir, 'weak mention', {
    action: ['Modified src/other.js'],
    uncertain: ['Check src/shared.js later'],
  });

  const expanded = searchAny(pocketDir, 'direct hit', { expand: 2 });
  assert.deepStrictEqual(expanded.results.filter((result) => result.expanded), []);
});

test('expansion truncates at 100 nodes and the flag reaches library, CLI, and MCP', () => {
  const { projectDir, pocketDir } = makeLitePocket('expand-cap');
  const files = [];
  for (let i = 1; i <= 150; i++) files.push(`Modified src/f${String(i).padStart(3, '0')}.js`);
  appendLogBlock(pocketDir, { gist: 'wide turn', user: ['cap fixture'], action: files, when: '2026-11-01' });
  append(pocketDir, 'narrow turn', { action: ['Modified src/f001.js'] });

  // 库层：150 个文件节点把 100 位占满，第二跳的 T2 被截掉 —— 旗标必须如实说
  const expanded = searchAny(pocketDir, 'wide turn', { expand: 2 });
  assert.strictEqual(expanded.expansionTruncated, true);
  assert.strictEqual(expanded.expandedCount, 0, '被截掉的轮次不能冒充扩展结果');
  assert.strictEqual(searchAny(pocketDir, 'wide turn', {}).expansionTruncated, false);

  const whyRows = why(pocketDir, 'src/f001.js', { expand: 1 });
  assert.strictEqual(whyRows.expansionTruncated, true);
  assert.deepStrictEqual(whyRows.map((r) => r.id).sort(), [1, 2], '直接命中不受截断影响');

  // CLI：--json 带旗标，人读输出带提示
  const cliJson = runCliJson(['search', 'wide turn', '--expand', '2', '--json'], projectDir);
  assert.strictEqual(cliJson.json.expansionTruncated, true);
  const cliHuman = runCli(['search', 'wide turn', '--expand', '2'], projectDir);
  assert.ok(cliHuman.stdout.includes('100-node safety limit'), cliHuman.stdout);
  const whyJson = runCliJson(['why', 'src/f001.js', '--expand', '1', '--json'], projectDir);
  assert.strictEqual(whyJson.json.expanded.truncated, true);

  // MCP：两个工具的人读输出都要提示
  const mcp = runMcp(projectDir, [
    { name: 'context_pocket_search', arguments: { keyword: 'wide turn', expand: 2 } },
    { name: 'context_pocket_why', arguments: { filePath: 'src/f001.js', expand: 1 } },
  ]);
  for (const call of mcp.calls) {
    assert.ok(!call.isError, JSON.stringify(call));
    assert.ok(call.content[0].text.includes('100-node safety limit'), call.content[0].text);
  }

  // 小口袋不截断：旗标与提示都不出现
  const small = makeLitePocket('expand-cap-small');
  append(small.pocketDir, 'tiny', { action: ['Modified src/tiny.js'] });
  assert.strictEqual(searchAny(small.pocketDir, 'tiny', { expand: 2 }).expansionTruncated, false);
  const smallCli = runCli(['search', 'tiny', '--expand', '2'], small.projectDir);
  assert.ok(!smallCli.stdout.includes('100-node safety limit'), smallCli.stdout);
});

test('log amend fills only missing sections, preserves WHEN, and diff/handoff round-trip', () => {
  const { projectDir, pocketDir } = makeLitePocket('amend-diff-handoff');
  append(pocketDir, 'first', { when: '2026-11-01', action: ['Modified src/a.js'] });
  append(pocketDir, 'second', { action: ['Modified src/b.js'] });

  const amend = amendLogBlock(pocketDir, 1, { decisions: ['chose A'] });
  assert.strictEqual(amend.success, true);
  assert.deepStrictEqual(amend.filled, ['Decisions & Constraints']);
  let log = readPocketFile(pocketDir, 'log.md');
  assert.match(log, /^--- WHEN: 2026-11-01 \(day\) ---$/m);
  assert.match(log, /### Decisions & Constraints\n- chose A/);

  // amend 从不覆盖已有小节
  const again = amendLogBlock(pocketDir, 1, { decisions: ['chose B'], user: ['hijack'] });
  assert.strictEqual(again.success, true);
  assert.strictEqual(again.unchanged, true);
  assert.deepStrictEqual(again.skipped.sort(), ['Decisions & Constraints', 'User']);
  log = readPocketFile(pocketDir, 'log.md');
  assert.doesNotMatch(log, /chose B/);

  const d = diff(pocketDir, 1, 2);
  assert.strictEqual(d.tA, 1);
  assert.strictEqual(d.gistB, 'second');
  assert.deepStrictEqual(d.files.added, ['src/b.js']);
  assert.deepStrictEqual(d.files.removed, ['src/a.js']);

  const handoff = generateHandoff(pocketDir);
  assert.strictEqual(handoff.tId, 2);
  assert.ok(fs.existsSync(path.join(pocketDir, 'handoff.md')));
  assert.match(readPocketFile(pocketDir, 'handoff.md'), /T2/);
  assert.strictEqual(verify(pocketDir).errorCount, 0);

  // MCP 面：同样的 3 个工具都在
  const mcp = runMcp(projectDir, [
    { name: 'context_pocket_diff', arguments: { tA: 1, tB: 2 } },
    { name: 'context_pocket_log_amend', arguments: { tId: 2, pitfalls: 'none' } },
    { name: 'context_pocket_handoff' },
  ]);
  assert.strictEqual(mcp.calls[0].isError, undefined);
  assert.match(mcp.calls[0].content[0].text, /## Diff: T1 → T2/);
  assert.match(mcp.calls[1].content[0].text, /T2 amended/);
  assert.match(mcp.calls[2].content[0].text, /Handoff generated/);
});

test('recall raw text is byte-identical through the block-hint fast path', () => {
  const { pocketDir } = makeLitePocket('recall-raw');
  append(pocketDir, 'one', { action: ['Modified src/one.js'] });
  append(pocketDir, 'two', { action: ['Modified src/two.js'] });

  const log = readPocketFile(pocketDir, 'log.md');
  const first = recall(pocketDir, 1);
  const second = recall(pocketDir, 2);
  assert.ok(log.includes(first.rawText));
  assert.ok(log.includes(second.rawText));
  assert.match(first.rawText, /^## T1 · one/m);
  assert.doesNotMatch(first.rawText, /## T2 · two/);
  assert.match(second.rawText, /^## T2 · two/m);

  // 块头 id 与请求不一致时退回全文扫描，而不是切错块（T1 不匹配 T10）
  const fromCli = runCliJson(['recall', '2', '--json'], path.dirname(pocketDir));
  assert.strictEqual(fromCli.json.t.rawText, second.rawText);
});

test('CLI help, MCP tool list, version, unknown commands, and command-specific help stay in contract', () => {
  const { projectDir } = makeLitePocket('surface');
  const help = runCliJson(['help', '--json'], projectDir).json;
  const commandCount = help.groups.reduce((sum, group) => sum + group.commands.length, 0);
  const mcp = runMcp(projectDir);
  assert.strictEqual(commandCount, 11);
  assert.strictEqual(mcp.tools.length, 11);
  assert.strictEqual(mcp.initialize.serverInfo.name, 'context-pocket-lite');
  assert.strictEqual(mcp.initialize.protocolVersion, '2025-06-18');

  const version = runCli(['--version'], projectDir);
  assert.strictEqual(version.status, 0);
  assert.match(version.stdout, /2\.6-Lite-preview2/);
  const versionJson = runCliJson(['version', '--json'], projectDir).json;
  assert.strictEqual(versionJson.version, '2.6-Lite-preview2');
  assert.strictEqual(versionJson.display, '2.6-Lite-preview2');

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
