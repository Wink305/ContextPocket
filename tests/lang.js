'use strict';

/**
 * lang workspace / repo map / context 预览契约
 *
 * 只锁预览版已经承诺的九件事：
 *   - workspace 清单 + 跨口袋限定 id
 *   - repo map 扫描、缓存与漂移
 *   - context build 的分层与预算裁剪
 *   - forget 的默认计划与归档前缀
 *   - consolidate 的重复检测与安全 apply
 *   - merge 的默认 dry-run 与按口袋名合并
 *   - audit 的健康 / 活动窗口 / 待办汇总
 *   - decay 的冷轮次前缀与 forget 建议
 *   - capture 的摘要提取、默认计划与凭据拒绝
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { assert, test, tmpProject, ROOT } = require('./harness');

const writer = require(path.join(ROOT, 'lib', 'writer'));
const { bootstrap } = require(path.join(ROOT, 'lib', 'bootstrap'));
const capture = require(path.join(ROOT, 'lang', 'lib', 'capture'));
const CLI = path.join(ROOT, 'lang', 'bin', 'context-pocket-yuan.js');
const MCP = path.join(ROOT, 'lang', 'mcp-server-yuan.js');

function runLang(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function parseJson(result) {
  const lines = String(result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  assert.strictEqual(lines.length, 1, '--json 只应输出一行：\n' + result.stdout + result.stderr);
  return JSON.parse(lines[0]);
}

function makePocketIn(root, name) {
  const projectDir = path.join(root, name);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'app.js'), '// fixture\n', 'utf-8');
  const result = bootstrap(projectDir, {});
  return { projectDir, pocketDir: result.pocketDir };
}

function addTurn(pocketDir, gist, extra = {}) {
  return writer.appendLogBlock(pocketDir, Object.assign({
    gist,
    user: ['u'],
    action: ['Changed src/' + gist.replace(/\s+/g, '-') + '.js'],
    conflictCheck: false,
  }, extra));
}

test('yuan: workspace manifest registers pockets by relative path and qualified ids', () => {
  const workspace = tmpProject('yuan-ws');
  const api = makePocketIn(workspace, 'api');
  const web = makePocketIn(workspace, 'web');
  addTurn(api.pocketDir, 'login flow needle');
  addTurn(web.pocketDir, 'web layout');

  const version = parseJson(runLang(['version', '--json'], workspace));
  assert.strictEqual(version.version, '3.1');
  assert.strictEqual(version.display, '3.1-yuan');
  assert.strictEqual(version.edition, 'yuan');

  assert.strictEqual(parseJson(runLang(['workspace', 'init', '--name', 'payments', '--json'], workspace)).name, 'payments');
  assert.strictEqual(parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace)).path, 'api/ContextPocket');
  assert.strictEqual(parseJson(runLang(['workspace', 'add', 'web', web.projectDir, '--json'], workspace)).path, 'web/ContextPocket');

  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, 'contextpocket.workspace.json'), 'utf-8'));
  assert.strictEqual(manifest.version, 1);
  assert.deepStrictEqual(manifest.pockets.map((p) => p.name), ['api', 'web']);
  assert.ok(manifest.pockets.every((p) => !path.isAbsolute(p.path) && !p.path.includes('\\')),
    '清单只存正斜杠相对路径：' + JSON.stringify(manifest.pockets));

  const list = parseJson(runLang(['workspace', 'list', '--json'], workspace));
  assert.strictEqual(list.count, 2);
  assert.ok(list.pockets.every((p) => p.ok && p.latestT === 1), JSON.stringify(list.pockets));

  const search = parseJson(runLang(['workspace', 'search', 'needle', '--json'], workspace));
  assert.strictEqual(search.total, 1, JSON.stringify(search));
  assert.strictEqual(search.results[0].pocket, 'api');

  const recall = parseJson(runLang(['workspace', 'recall', 'api:T1', '--json'], workspace));
  assert.strictEqual(recall.pocket, 'api');
  assert.strictEqual(recall.block.gist, 'login flow needle');

  const bare = runLang(['workspace', 'recall', 'T1', '--json'], workspace);
  assert.strictEqual(bare.code, 1, '跨口袋 recall 必须拒绝裸 T 号');
  assert.match(parseJson(bare).error, /qualified id/);
});

test('yuan: workspace index builds a BM25 cache and search filters by pocket/type', () => {
  const workspace = tmpProject('yuan-index');
  const api = makePocketIn(workspace, 'api');
  const web = makePocketIn(workspace, 'web');
  addTurn(api.pocketDir, 'login needle');
  addTurn(web.pocketDir, 'web layout');
  writer.addDecision(api.pocketDir, { title: 'Use JWT', decision: 'JWT for API auth' });

  parseJson(runLang(['workspace', 'init', '--name', 'indexws', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'web', web.projectDir, '--json'], workspace));

  const built = parseJson(runLang(['workspace', 'index', '--json'], workspace));
  assert.ok(built.docsCount >= 3, JSON.stringify(built));
  assert.ok(built.termsCount > 0, JSON.stringify(built));
  assert.ok(fs.existsSync(path.join(workspace, '.contextpocket', 'search-index.json')));

  const search = parseJson(runLang(['workspace', 'search', 'needle', '--json'], workspace));
  assert.strictEqual(search.mode, 'index', JSON.stringify(search));
  assert.strictEqual(search.total, 1, JSON.stringify(search));
  assert.strictEqual(search.results[0].pocket, 'api');
  assert.ok(search.results[0].score > 0, JSON.stringify(search.results[0]));

  const wrongType = parseJson(runLang(['workspace', 'search', 'JWT', '--type', 'T', '--json'], workspace));
  assert.strictEqual(wrongType.total, 0, JSON.stringify(wrongType));
  const adr = parseJson(runLang(['workspace', 'search', 'JWT', '--type', 'ADR', '--json'], workspace));
  assert.strictEqual(adr.total, 1, JSON.stringify(adr));
  assert.strictEqual(adr.results[0].id, 'ADR-1');

  const otherPocket = parseJson(runLang(['workspace', 'search', 'needle', '--pocket', 'web', '--json'], workspace));
  assert.strictEqual(otherPocket.total, 0, JSON.stringify(otherPocket));

  const scan = parseJson(runLang(['workspace', 'search', 'needle', '--no-index', '--json'], workspace));
  assert.strictEqual(scan.mode, 'scan');
  assert.strictEqual(scan.total, 1, JSON.stringify(scan));

  addTurn(api.pocketDir, 'fresh otter');
  const fresh = parseJson(runLang(['workspace', 'search', 'otter', '--json'], workspace));
  assert.strictEqual(fresh.mode, 'index');
  assert.strictEqual(fresh.total, 1, '索引过期必须按签名自动重建：' + JSON.stringify(fresh));
});

test('yuan: repo map scans JS/TS/Python, skips ignored dirs and reports drift', () => {
  const workspace = tmpProject('yuan-map');
  const api = makePocketIn(workspace, 'api');
  addTurn(api.pocketDir, 'map seed');
  parseJson(runLang(['workspace', 'init', '--name', 'mapws', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));

  fs.mkdirSync(path.join(api.projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(api.projectDir, 'src', 'login.js'),
    'export function login() {}\nexport class Session {}\n', 'utf-8');
  fs.writeFileSync(path.join(api.projectDir, 'src', 'app.py'),
    'def serve():\n  pass\n\nclass App:\n  pass\n', 'utf-8');
  fs.mkdirSync(path.join(api.projectDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(api.projectDir, 'node_modules', 'ignored.js'),
    'export function nope() {}\n', 'utf-8');

  const updated = parseJson(runLang(['map', 'update', '--json'], workspace));
  assert.ok(updated.count >= 2, JSON.stringify(updated));
  assert.ok(fs.existsSync(path.join(workspace, '.contextpocket', 'repo-map.json')));

  const view = parseJson(runLang(['map', 'view', '--json'], workspace));
  const paths = view.rows.map((row) => row.path);
  assert.ok(paths.includes('api/src/login.js'), JSON.stringify(paths));
  assert.ok(paths.includes('api/src/app.py'), JSON.stringify(paths));
  assert.ok(!paths.some((p) => p.includes('node_modules')), 'node_modules 必须被跳过：' + JSON.stringify(paths));
  const login = view.rows.find((row) => row.path === 'api/src/login.js');
  assert.deepStrictEqual(login.symbols.sort(), ['Session', 'login']);

  const verified = parseJson(runLang(['map', 'verify', '--json'], workspace));
  assert.strictEqual(verified.ok, true, JSON.stringify(verified));

  fs.appendFileSync(path.join(api.projectDir, 'src', 'login.js'), 'export const x = 1;\n', 'utf-8');
  const drift = runLang(['map', 'verify', '--json'], workspace);
  assert.strictEqual(drift.code, 1, '漂移必须退 1');
  const driftJson = parseJson(drift);
  assert.strictEqual(driftJson.ok, false);
  assert.ok(driftJson.changed.includes('api/src/login.js'), JSON.stringify(driftJson));
});

test('yuan: context build keeps section 0, cites sources and reports budget trims', () => {
  const workspace = tmpProject('yuan-context');
  const api = makePocketIn(workspace, 'api');
  addTurn(api.pocketDir, 'context needle turn', {
    uncertain: ['要确认 token 刷新策略'],
  });
  writer.addAbsoluteEntry(api.pocketDir, { text: '不要改 /api/v1 的响应结构', gist: 'API 形状' });
  writer.updateState(api.pocketDir, { summary: '登录已通', nextStep: '补 token 刷新' });

  parseJson(runLang(['workspace', 'init', '--name', 'ctxws', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));
  parseJson(runLang(['map', 'update', '--json'], workspace));

  const full = parseJson(runLang(['context', 'build', '--max-tokens', '50000', '--query', 'needle', '--json'], workspace));
  assert.ok(full.content.includes('## 0 · Start here'), full.content);
  assert.ok(full.content.includes('不要改 /api/v1 的响应结构'), full.content);
  assert.ok(full.content.includes('要确认 token 刷新策略'), full.content);
  assert.ok(full.content.includes('## 1 · Facts'), full.content);
  assert.ok(full.content.includes('## 2 · Related'), full.content);
  assert.ok(full.content.includes('api:T1'), '检索命中必须带口袋来源：' + full.content);
  assert.deepStrictEqual(full.sources.pockets.map((p) => p.name), ['api']);

  const tight = parseJson(runLang(['context', 'build', '--max-tokens', '120', '--query', 'needle', '--json'], workspace));
  assert.ok(tight.content.includes('## 0 · Start here'), '固定层永不裁：' + tight.content);
  assert.ok(tight.content.includes('不要改 /api/v1 的响应结构'), '红线永不裁：' + tight.content);
  assert.ok(tight.trimmed.length > 0, JSON.stringify(tight));
  assert.match(tight.content, /token budget: ~\d+ \/ 120 tokens/);

  const explain = parseJson(runLang(['context', 'explain', '--max-tokens', '50000', '--query', 'needle', '--json'], workspace));
  assert.strictEqual(explain.trimmed.length, 0, JSON.stringify(explain));
  assert.ok(explain.sections.startHere.redLines >= 1, JSON.stringify(explain.sections));
  assert.strictEqual(explain.sections.related.searchHits, 1, JSON.stringify(explain.sections.related));
  assert.strictEqual(explain.sections.related.repoMap.present, true);
  assert.deepStrictEqual(explain.budgets.map((b) => b.maxTokens), [2000, 6000, 12000]);
  assert.ok(explain.content.includes('## Budget simulation'), explain.content);

  const tightExplain = parseJson(runLang(['context', 'explain', '--max-tokens', '120', '--query', 'needle', '--json'], workspace));
  assert.ok(tightExplain.trimmed.length > 0, JSON.stringify(tightExplain));
  assert.strictEqual(tightExplain.overBudget, tight.overBudget);
});

test('yuan: edition modes provide defaults without overriding explicit flags', () => {
  const workspace = tmpProject('yuan-modes');
  const api = makePocketIn(workspace, 'api');
  addTurn(api.pocketDir, 'mode needle');
  parseJson(runLang(['workspace', 'init', '--name', 'modews', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));

  const focus = parseJson(runLang(['context', 'explain', '--edition-mode', 'focus', '--json'], workspace));
  assert.strictEqual(focus.maxTokens, 1500);
  assert.strictEqual(focus.sections.related.repoMap.enabled, false);

  const explicit = parseJson(runLang([
    'context', 'explain', '--edition-mode', 'focus', '--max-tokens', '9000', '--json',
  ], workspace));
  assert.strictEqual(explicit.maxTokens, 9000, '显式预算必须压过模式预设');

  const auditMode = parseJson(runLang(['context', 'explain', '--edition-mode', 'audit', '--json'], workspace));
  assert.strictEqual(auditMode.maxTokens, 12000);
  assert.strictEqual(auditMode.sections.related.repoMap.enabled, true);

  const search = parseJson(runLang(['workspace', 'search', 'needle', '--edition-mode', 'focus', '--json'], workspace));
  assert.strictEqual(search.limit, 5);

  const recap = parseJson(runLang(['recap', '--edition-mode', 'focus', '--json'], workspace));
  assert.strictEqual(recap.maxTokens, 1500);

  const bad = runLang(['context', 'explain', '--edition-mode', 'nope', '--json'], workspace);
  assert.strictEqual(bad.code, 1);
  assert.match(parseJson(bad).error, /unknown edition mode/);
});

test('yuan: verify --deep checks cross-pocket refs and repair only applies safe fixes', () => {
  const workspace = tmpProject('yuan-verify');
  const api = makePocketIn(workspace, 'api');
  const web = makePocketIn(workspace, 'web');
  addTurn(api.pocketDir, 'api calls web', { action: ['Changed src/api.js — depends on web:T1'] });
  addTurn(web.pocketDir, 'web endpoint');
  parseJson(runLang(['workspace', 'init', '--name', 'verifyws', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'web', web.projectDir, '--json'], workspace));

  const ok = parseJson(runLang(['workspace', 'verify', '--deep', '--json'], workspace));
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.ok(ok.warnings.some((w) => /repo map/.test(w)), '缺 repo map 应是 warning：' + JSON.stringify(ok.warnings));

  parseJson(runLang(['workspace', 'index', '--json'], workspace));
  addTurn(api.pocketDir, 'index drift turn');
  const staleIndex = parseJson(runLang(['workspace', 'verify', '--deep', '--json'], workspace));
  assert.ok(staleIndex.warnings.some((w) => /index is stale/.test(w)),
    '过期索引应被 verify --deep 报出来：' + JSON.stringify(staleIndex.warnings));
  assert.strictEqual(staleIndex.checks.index.fresh, false);

  addTurn(api.pocketDir, 'api points at missing turn', { action: ['Changed src/api.js — depends on web:T99'] });
  const missingTurn = parseJson(runLang(['workspace', 'verify', '--deep', '--json'], workspace));
  assert.strictEqual(missingTurn.ok, true, '缺失的跨口袋轮次是 warning，不是 error');
  assert.ok(missingTurn.checks.crossRefWarnings.some((w) => w.ref === 'web:T99'), JSON.stringify(missingTurn.checks));

  fs.rmSync(web.projectDir, { recursive: true, force: true });
  const broken = runLang(['workspace', 'verify', '--deep', '--json'], workspace);
  assert.strictEqual(broken.code, 1, '口袋缺失必须退 1');
  const brokenJson = parseJson(broken);
  assert.ok(brokenJson.checks.missingPockets.includes('web'));
  assert.ok(brokenJson.checks.crossRefErrors.some((e) => e.ref === 'web:T1' || e.ref === 'web:T99'));

  const plan = parseJson(runLang(['workspace', 'repair', '--json'], workspace));
  assert.ok(plan.actions.some((a) => a.id === 'rebuild-repo-map' && a.safe));
  assert.ok(plan.actions.some((a) => a.id === 'remove-pocket-web' && !a.safe));

  const applied = parseJson(runLang(['workspace', 'repair', '--apply', '--json'], workspace));
  assert.ok(applied.applied.some((a) => a.id === 'rebuild-repo-map'), JSON.stringify(applied));
  assert.ok(applied.skipped.some((a) => a.id === 'remove-pocket-web'), '删除口袋不能自动执行');
});

test('yuan: recap filters by T range and pockets, and trims oldest turns first', () => {
  const workspace = tmpProject('yuan-recap');
  const api = makePocketIn(workspace, 'api');
  const web = makePocketIn(workspace, 'web');
  addTurn(api.pocketDir, 'one', { when: '2026-11-01' });
  addTurn(api.pocketDir, 'two', { when: '2026-11-02' });
  addTurn(api.pocketDir, 'three', { when: '2026-11-03' });
  addTurn(web.pocketDir, 'web one', { when: '2026-11-02' });

  parseJson(runLang(['workspace', 'init', '--name', 'recapws', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'web', web.projectDir, '--json'], workspace));

  const range = parseJson(runLang(['recap', '--since', '2', '--until', '3', '--json'], workspace));
  const apiRecap = range.pockets.find((p) => p.name === 'api');
  assert.deepStrictEqual(apiRecap.turns.map((t) => t.id), [2, 3], JSON.stringify(range));
  assert.ok(range.content.includes('T3'), range.content);
  assert.ok(!/T1 ·/.test(range.content), 'T1 不应出现在 2–3 区间：' + range.content);

  const onlyApi = parseJson(runLang(['recap', '--pockets', 'api', '--json'], workspace));
  assert.deepStrictEqual(onlyApi.pockets.map((p) => p.name), ['api']);

  const dateRange = parseJson(runLang(['recap', '--from', '2026-11-02', '--to', '2026-11-02', '--json'], workspace));
  assert.deepStrictEqual(dateRange.pockets.find((p) => p.name === 'api').turns.map((t) => t.id), [2]);

  const tight = parseJson(runLang(['recap', '--max-tokens', '80', '--json'], workspace));
  assert.ok(tight.droppedTurns > 0 || tight.overBudget, JSON.stringify(tight));
  assert.match(tight.content, /recap budget:/);
});

test('yuan: forget plans by default and archives the oldest prefix with --apply', () => {
  const workspace = tmpProject('yuan-forget');
  const api = makePocketIn(workspace, 'api');
  for (let i = 1; i <= 5; i++) addTurn(api.pocketDir, 'turn ' + i, { when: '2026-11-0' + i });
  parseJson(runLang(['workspace', 'init', '--name', 'forgetws', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));

  const logPath = path.join(api.pocketDir, 'log.md');
  const archivePath = path.join(api.pocketDir, 'log-archive.md');

  const plan = parseJson(runLang(['forget', '--before', 'T3', '--json'], workspace));
  assert.strictEqual(plan.mode, 'plan');
  assert.strictEqual(plan.totals.plannedArchived, 2);
  assert.deepStrictEqual(plan.pockets[0].archivedIds, [1, 2]);
  assert.match(fs.readFileSync(logPath, 'utf-8'), /## T1 ·/);
  assert.ok(!fs.existsSync(archivePath), 'plan 不能写归档文件');

  const applied = parseJson(runLang(['forget', '--before', 'T3', '--apply', '--json'], workspace));
  assert.strictEqual(applied.mode, 'apply');
  assert.strictEqual(applied.totals.archived, 2);
  const log = fs.readFileSync(logPath, 'utf-8');
  assert.ok(!/## T1 ·/.test(log), '已归档的轮次必须离开 log.md');
  assert.ok(/## T3 ·/.test(log), '未归档的轮次必须原地保留');
  const archive = fs.readFileSync(archivePath, 'utf-8');
  assert.ok(/## T1 ·/.test(archive) && /## T2 ·/.test(archive), archive);
  assert.ok(!/## T3 ·/.test(archive), '归档只搬最旧的前缀：' + archive);

  const byDate = parseJson(runLang(['forget', '--before-date', '2026-11-05', '--json'], workspace));
  assert.deepStrictEqual(byDate.pockets[0].archivedIds, [3, 4]);

  const keep = parseJson(runLang(['forget', '--keep-last', '5', '--json'], workspace));
  assert.strictEqual(keep.totals.plannedArchived, 0);
  assert.strictEqual(keep.pockets[0].skipped, true);

  const none = runLang(['forget', '--json'], workspace);
  assert.strictEqual(none.code, 1);
  assert.match(parseJson(none).error, /needs one selector/);

  const both = runLang(['forget', '--before', 'T2', '--keep-last', '1', '--json'], workspace);
  assert.strictEqual(both.code, 1, '两个选区必须被拒绝');
  assert.match(parseJson(both).error, /only one selector/);

  const unknown = parseJson(runLang(['forget', '--before', 'T2', '--pockets', 'api,ghost', '--json'], workspace));
  assert.strictEqual(unknown.ok, false);
  assert.ok(unknown.pockets.some((p) => p.name === 'ghost' && !p.ok), JSON.stringify(unknown.pockets));

  const archivedRecall = parseJson(runLang(['recap', '--since', '1', '--until', '2', '--json'], workspace));
  assert.deepStrictEqual(archivedRecall.pockets[0].turns.map((t) => t.id), [1, 2],
    '归档后的轮次仍然可读：' + JSON.stringify(archivedRecall));
});

test('yuan: consolidate reports duplicates and only applies safe preference cleanup', () => {
  const workspace = tmpProject('yuan-consolidate');
  const api = makePocketIn(workspace, 'api');
  addTurn(api.pocketDir, 'consolidate seed');

  writer.addDecision(api.pocketDir, { title: 'Use JWT', decision: 'JWT for API auth' });
  writer.addDecision(api.pocketDir, { title: 'Use JWT', decision: 'JWT for API auth' });
  writer.addRequirement(api.pocketDir, { text: '支持 token 刷新' });
  writer.addRequirement(api.pocketDir, { text: '支持 token 刷新' });

  writer.updatePreferences(api.pocketDir, { key: 'style', value: 'tabs' });
  const prefsPath = path.join(api.pocketDir, 'preferences.md');
  fs.appendFileSync(prefsPath, '\n- Style:   tabs\n- Style: spaces\n- reviewer: alice\n- reviewer: alice\n', 'utf-8');
  writer.updateIndexPrefCount(api.pocketDir);

  parseJson(runLang(['workspace', 'init', '--name', 'cws', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));

  const plan = parseJson(runLang(['consolidate', '--json'], workspace));
  assert.strictEqual(plan.mode, 'plan');
  assert.strictEqual(plan.totals.adrGroups, 1);
  assert.strictEqual(plan.totals.duplicateAdrs, 1);
  assert.strictEqual(plan.totals.requirementGroups, 1);
  assert.strictEqual(plan.totals.duplicateRequirements, 1);
  assert.strictEqual(plan.totals.preferenceDuplicates, 2, JSON.stringify(plan.pockets[0].preferences));
  assert.strictEqual(plan.totals.preferenceConflicts, 1);
  assert.match(fs.readFileSync(prefsPath, 'utf-8'), /- Style:   tabs/, 'plan 不能改文件');

  const applied = parseJson(runLang(['consolidate', '--apply', '--json'], workspace));
  assert.strictEqual(applied.totals.removedPreferences, 2);
  assert.strictEqual(applied.totals.duplicateAdrs, 1, 'ADR 永远只报告，不自动删');
  assert.strictEqual(applied.totals.duplicateRequirements, 1);

  const after = fs.readFileSync(prefsPath, 'utf-8');
  const styleLines = after.split('\n').filter((line) => /^-\s*style\s*:/i.test(line.trim()));
  const reviewerLines = after.split('\n').filter((line) => /^-\s*reviewer\s*:/i.test(line.trim()));
  assert.strictEqual(styleLines.length, 2, '同 key 不同 value 是冲突，必须保留：' + after);
  assert.strictEqual(reviewerLines.length, 1, '完全重复的行只留第一条：' + after);

  const verify = parseJson(runLang(['workspace', 'verify', '--json'], workspace));
  assert.strictEqual(verify.ok, true, 'index.md 的偏好计数必须同步：' + JSON.stringify(verify));
});

test('yuan: merge plans by default and merges one workspace pocket into another with --apply', () => {
  const workspace = tmpProject('yuan-merge');
  const api = makePocketIn(workspace, 'api');
  const web = makePocketIn(workspace, 'web');
  addTurn(api.pocketDir, 'api base');
  addTurn(web.pocketDir, 'web feature');
  writer.addRequirement(web.pocketDir, { text: 'web 需求' });

  parseJson(runLang(['workspace', 'init', '--name', 'mergews', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'web', web.projectDir, '--json'], workspace));

  const logBefore = fs.readFileSync(path.join(api.pocketDir, 'log.md'), 'utf-8');
  const plan = parseJson(runLang(['merge', 'web', '--into', 'api', '--json'], workspace));
  assert.strictEqual(plan.mode, 'plan');
  assert.strictEqual(plan.merge.dryRun, true, JSON.stringify(plan.merge));
  assert.strictEqual(plan.merge.turns.added, 1);
  assert.strictEqual(fs.readFileSync(path.join(api.pocketDir, 'log.md'), 'utf-8'), logBefore, 'dry run 不能改目标 log');

  const applied = parseJson(runLang(['merge', 'web', '--into', 'api', '--apply', '--json'], workspace));
  assert.strictEqual(applied.mode, 'apply');
  assert.strictEqual(applied.merge.ok, true, JSON.stringify(applied.merge));
  assert.strictEqual(applied.merge.turns.added, 1);
  assert.strictEqual(applied.merge.target.latestTBefore, 1);
  assert.strictEqual(applied.merge.target.latestTAfter, 3, 'T2 = 合入轮次，T3 = 合并记录');

  const status = parseJson(runLang(['workspace', 'status', '--json'], workspace));
  assert.strictEqual(status.pockets.find((p) => p.name === 'api').latestT, 3);
  assert.strictEqual(status.pockets.find((p) => p.name === 'web').latestT, 1, '源口袋只读');

  const verify = parseJson(runLang(['workspace', 'verify', '--json'], workspace));
  assert.strictEqual(verify.ok, true, JSON.stringify(verify));

  const same = runLang(['merge', 'web', '--into', 'web', '--json'], workspace);
  assert.strictEqual(same.code, 1);
  assert.match(parseJson(same).error, /must be different/);

  const unknown = runLang(['merge', 'ghost', '--into', 'api', '--json'], workspace);
  assert.strictEqual(unknown.code, 1);
  assert.match(parseJson(unknown).error, /Pocket not found/);
});

test('yuan: audit reports health, activity window and open items', () => {
  const workspace = tmpProject('yuan-audit');
  const api = makePocketIn(workspace, 'api');
  const web = makePocketIn(workspace, 'web');
  addTurn(api.pocketDir, 'audit first', { when: '2026-11-02', uncertain: ['确认审计口径'] });
  addTurn(api.pocketDir, 'audit second', { when: '2026-11-03' });
  addTurn(web.pocketDir, 'web audit', { when: '2026-11-02' });
  addTurn(web.pocketDir, 'web second', { when: '2026-11-03' });
  writer.addRequirement(api.pocketDir, { text: '未完成需求' });
  writer.addRequirement(api.pocketDir, { text: '已完成需求', status: 'Done' });
  writer.addDecision(api.pocketDir, { title: 'Audit ADR', decision: '审计视图只读' });

  parseJson(runLang(['workspace', 'init', '--name', 'auditws', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'web', web.projectDir, '--json'], workspace));
  parseJson(runLang(['workspace', 'index', '--json'], workspace));
  parseJson(runLang(['map', 'update', '--json'], workspace));

  const audit = parseJson(runLang(['audit', '--json'], workspace));
  assert.strictEqual(audit.ok, true, JSON.stringify(audit.health));
  assert.strictEqual(audit.totals.turns, 4, JSON.stringify(audit.totals));
  assert.strictEqual(audit.totals.openRequirements, 1);
  assert.strictEqual(audit.totals.uncertain, 1);
  assert.strictEqual(audit.totals.adrs, 1);
  assert.strictEqual(audit.health.index.fresh, true, JSON.stringify(audit.health.index));
  assert.ok(audit.health.repoMap && audit.health.repoMap.ok, JSON.stringify(audit.health.repoMap));
  assert.ok(audit.content.includes('## Health'), audit.content);
  assert.ok(audit.content.includes('## Open items'), audit.content);

  const windowed = parseJson(runLang(['audit', '--since', '2', '--until', '2', '--json'], workspace));
  assert.strictEqual(windowed.pockets.find((p) => p.name === 'api').turns, 1, JSON.stringify(windowed.pockets));
  assert.strictEqual(windowed.pockets.find((p) => p.name === 'web').turns, 1);

  const onlyApi = parseJson(runLang(['audit', '--pockets', 'api', '--json'], workspace));
  assert.deepStrictEqual(onlyApi.pockets.map((p) => p.name), ['api']);
});

test('yuan: decay reports cold turns and a prefix-safe forget recommendation', () => {
  const workspace = tmpProject('yuan-decay');
  const api = makePocketIn(workspace, 'api');
  const web = makePocketIn(workspace, 'web');
  for (let i = 1; i <= 5; i++) addTurn(api.pocketDir, 'old turn ' + i, { when: '2026-01-0' + i });
  addTurn(web.pocketDir, 'recent turn', { when: '2026-05-30' });
  writer.addRequirement(api.pocketDir, { text: 'cold requirement', openedAt: 1 });

  parseJson(runLang(['workspace', 'init', '--name', 'decayws', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'web', web.projectDir, '--json'], workspace));

  const result = parseJson(runLang([
    'decay', '--today', '2026-06-01', '--max-age-days', '90',
    '--keep-last', '2', '--min-turns', '1', '--json',
  ], workspace));
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.policy.cutoff, '2026-03-03', JSON.stringify(result.policy));
  assert.strictEqual(result.totals.archiveCandidates, 3, JSON.stringify(result.totals));

  const apiDecay = result.pockets.find((p) => p.name === 'api');
  assert.strictEqual(apiDecay.turns, 5);
  assert.strictEqual(apiDecay.coldTurns, 5);
  assert.strictEqual(apiDecay.candidate.count, 3);
  assert.strictEqual(apiDecay.candidate.fromT, 1);
  assert.strictEqual(apiDecay.candidate.toT, 3);
  assert.strictEqual(apiDecay.candidate.keep, 2);
  assert.strictEqual(apiDecay.coldRequirements.length, 1);
  assert.match(apiDecay.recommendation.command, /forget --before T4 --pockets api --apply/);

  const webDecay = result.pockets.find((p) => p.name === 'web');
  assert.strictEqual(webDecay.candidate.count, 0);
  assert.strictEqual(webDecay.recommendation, null);

  assert.ok(result.content.includes('## Recommendations'), result.content);
});

test('yuan: capture writes a PR summary only with --apply and refuses credentials', () => {
  const workspace = tmpProject('yuan-capture');
  const api = makePocketIn(workspace, 'api');
  const web = makePocketIn(workspace, 'web');
  fs.writeFileSync(path.join(workspace, 'pr.md'), [
    '# Fix login redirect',
    '',
    '- Preserve the returnTo query',
    '- Add regression test',
    '',
    'See https://github.com/acme/app/pull/42 for context.',
    '',
  ].join('\n'), 'utf-8');

  parseJson(runLang(['workspace', 'init', '--name', 'capturews', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'web', web.projectDir, '--json'], workspace));

  const plan = parseJson(runLang(['capture', 'pr.md', '--pocket', 'api', '--json'], workspace));
  assert.strictEqual(plan.mode, 'plan');
  assert.strictEqual(plan.captured, false);
  assert.strictEqual(plan.gist, 'Fix login redirect');
  assert.deepStrictEqual(plan.tags, ['pr']);
  assert.strictEqual(plan.url, 'https://github.com/acme/app/pull/42');
  assert.ok(plan.action.includes('[pr] Fix login redirect'), JSON.stringify(plan.action));
  assert.ok(plan.action.some((line) => line.includes('Preserve the returnTo query')), JSON.stringify(plan.action));

  const before = parseJson(runLang(['workspace', 'status', '--json'], workspace));
  assert.strictEqual(before.pockets.find((p) => p.name === 'api').latestT, 0, 'plan 不能写 T-block');

  const applied = parseJson(runLang(['capture', 'pr.md', '--pocket', 'api', '--apply', '--json'], workspace));
  assert.strictEqual(applied.captured, true);
  assert.strictEqual(applied.tId, 1);
  const recall = parseJson(runLang(['workspace', 'recall', 'api:T1', '--json'], workspace));
  assert.strictEqual(recall.block.gist, 'Fix login redirect');
  assert.deepStrictEqual(recall.block.tags, ['pr']);
  assert.ok(recall.block.sections.Action.some((line) => line.includes('Source: https://github.com/acme/app/pull/42')),
    JSON.stringify(recall.block.sections.Action));

  const ambiguous = runLang(['capture', 'pr.md', '--json'], workspace);
  assert.strictEqual(ambiguous.code, 1, '多口袋时必须显式 --pocket');
  assert.match(parseJson(ambiguous).error, /--pocket/);

  fs.writeFileSync(path.join(workspace, 'secret.md'),
    '# Token leak\n\n- token ghp_abcdefghijklmnopqrstuvwxyz0123456789\n', 'utf-8');
  const refused = runLang(['capture', 'secret.md', '--pocket', 'api', '--apply', '--json'], workspace);
  assert.strictEqual(refused.code, 1);
  assert.match(parseJson(refused).error, /capture refused/);
  const after = parseJson(runLang(['workspace', 'status', '--json'], workspace));
  assert.strictEqual(after.pockets.find((p) => p.name === 'api').latestT, 1, '拒绝时不能写入');
});

test('yuan: workspace status reports index and repo-map health without verify', () => {
  const workspace = tmpProject('yuan-health');
  const api = makePocketIn(workspace, 'api');
  addTurn(api.pocketDir, 'health seed');
  fs.mkdirSync(path.join(api.projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(api.projectDir, 'src', 'health.js'),
    'export function health() {}\n', 'utf-8');

  parseJson(runLang(['workspace', 'init', '--name', 'healthws', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));

  const cold = parseJson(runLang(['workspace', 'status', '--json'], workspace));
  assert.strictEqual(cold.health.index.present, false, JSON.stringify(cold.health));
  assert.strictEqual(cold.health.repoMap.present, false, JSON.stringify(cold.health));

  parseJson(runLang(['workspace', 'index', '--json'], workspace));
  parseJson(runLang(['map', 'update', '--json'], workspace));

  const warm = parseJson(runLang(['workspace', 'status', '--json'], workspace));
  assert.strictEqual(warm.health.index.present, true, JSON.stringify(warm.health));
  assert.strictEqual(warm.health.index.fresh, true, JSON.stringify(warm.health.index));
  assert.ok(warm.health.index.docsCount >= 1, JSON.stringify(warm.health.index));
  assert.strictEqual(warm.health.repoMap.present, true, JSON.stringify(warm.health.repoMap));
  assert.ok(warm.health.repoMap.files >= 1, JSON.stringify(warm.health.repoMap));

  addTurn(api.pocketDir, 'health drift');
  const stale = parseJson(runLang(['workspace', 'status', '--json'], workspace));
  assert.strictEqual(stale.health.index.fresh, false, '新轮次后索引必须报 stale：' + JSON.stringify(stale.health.index));

  const human = runLang(['workspace', 'status'], workspace).stdout;
  assert.match(human, /Health/);
  assert.match(human, /index: stale/);
  assert.match(human, /repo map: 2 file\(s\)/);
});

test('yuan: repo map update reuses unchanged symbols and only rescans changed files', () => {
  const workspace = tmpProject('yuan-incremental');
  const api = makePocketIn(workspace, 'api');
  fs.rmSync(path.join(api.projectDir, 'app.js'), { force: true });
  addTurn(api.pocketDir, 'map seed');
  parseJson(runLang(['workspace', 'init', '--name', 'incws', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));

  fs.mkdirSync(path.join(api.projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(api.projectDir, 'src', 'a.js'), 'export function alpha() {}\n', 'utf-8');
  fs.writeFileSync(path.join(api.projectDir, 'src', 'b.js'), 'export function beta() {}\n', 'utf-8');

  const first = parseJson(runLang(['map', 'update', '--json'], workspace));
  assert.strictEqual(first.count, 2, JSON.stringify(first));
  assert.strictEqual(first.rescanned, 2, JSON.stringify(first));
  assert.strictEqual(first.reused, 0, JSON.stringify(first));

  const second = parseJson(runLang(['map', 'update', '--json'], workspace));
  assert.strictEqual(second.reused, 2, '未变化的文件必须复用旧符号：' + JSON.stringify(second));
  assert.strictEqual(second.rescanned, 0, JSON.stringify(second));

  fs.appendFileSync(path.join(api.projectDir, 'src', 'b.js'), 'export class Gamma {}\n', 'utf-8');
  const third = parseJson(runLang(['map', 'update', '--json'], workspace));
  assert.strictEqual(third.reused, 1, JSON.stringify(third));
  assert.strictEqual(third.rescanned, 1, JSON.stringify(third));

  const view = parseJson(runLang(['map', 'view', '--json'], workspace));
  const b = view.rows.find((row) => row.path === 'api/src/b.js');
  assert.deepStrictEqual(b.symbols.sort(), ['Gamma', 'beta']);

  const verify = parseJson(runLang(['map', 'verify', '--json'], workspace));
  assert.strictEqual(verify.ok, true, JSON.stringify(verify));
});

test('yuan: consolidate reports duplicates that span pockets and never auto-removes them', () => {
  const workspace = tmpProject('yuan-cross');
  const api = makePocketIn(workspace, 'api');
  const web = makePocketIn(workspace, 'web');
  addTurn(api.pocketDir, 'api seed');
  addTurn(web.pocketDir, 'web seed');

  for (const pocket of [api.pocketDir, web.pocketDir]) {
    writer.addDecision(pocket, { title: 'Use JWT', decision: 'JWT for API auth' });
    writer.addRequirement(pocket, { text: '支持 token 刷新' });
    writer.updatePreferences(pocket, { key: 'reviewer', value: 'alice' });
  }
  writer.updatePreferences(api.pocketDir, { key: 'style', value: 'tabs' });
  writer.updatePreferences(web.pocketDir, { key: 'style', value: 'spaces' });

  parseJson(runLang(['workspace', 'init', '--name', 'crossws', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'web', web.projectDir, '--json'], workspace));

  const before = {
    api: fs.readFileSync(path.join(api.pocketDir, 'decisions.md'), 'utf-8'),
    web: fs.readFileSync(path.join(web.pocketDir, 'decisions.md'), 'utf-8'),
  };

  const plan = parseJson(runLang(['consolidate', '--json'], workspace));
  assert.strictEqual(plan.totals.crossPocketAdrGroups, 1, JSON.stringify(plan.totals));
  assert.strictEqual(plan.totals.crossPocketRequirementGroups, 1, JSON.stringify(plan.totals));
  assert.strictEqual(plan.totals.crossPocketPreferenceDuplicates, 1, JSON.stringify(plan.totals));
  assert.strictEqual(plan.totals.crossPocketPreferenceConflicts, 1, JSON.stringify(plan.totals));
  assert.deepStrictEqual(plan.crossPocket.adrs.groups[0].pockets, ['api', 'web']);
  assert.strictEqual(plan.crossPocket.adrs.groups[0].conflict, false, JSON.stringify(plan.crossPocket.adrs));
  assert.deepStrictEqual(plan.crossPocket.preferences.conflicts[0].pockets, ['api', 'web']);

  const applied = parseJson(runLang(['consolidate', '--apply', '--json'], workspace));
  assert.strictEqual(applied.totals.crossPocketAdrGroups, 1, 'apply 不能清掉跨口袋报告');
  assert.strictEqual(fs.readFileSync(path.join(api.pocketDir, 'decisions.md'), 'utf-8'), before.api,
    '跨口袋 ADR 永远只报告');
  assert.strictEqual(fs.readFileSync(path.join(web.pocketDir, 'decisions.md'), 'utf-8'), before.web);
  assert.match(fs.readFileSync(path.join(api.pocketDir, 'preferences.md'), 'utf-8'), /style:\s*tabs/i,
    '跨口袋偏好冲突不能自动选一个');
  assert.match(fs.readFileSync(path.join(web.pocketDir, 'preferences.md'), 'utf-8'), /style:\s*spaces/i);

  const human = runLang(['consolidate'], workspace).stdout;
  assert.match(human, /Cross-pocket/);
  assert.match(human, /cross-pocket group/);
});

test('yuan: decay --apply archives exactly the reported prefix and keeps the newest turns', () => {
  const workspace = tmpProject('yuan-decay-apply');
  const api = makePocketIn(workspace, 'api');
  for (let i = 1; i <= 5; i++) addTurn(api.pocketDir, 'old turn ' + i, { when: '2026-01-0' + i });
  parseJson(runLang(['workspace', 'init', '--name', 'decayapply', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));

  const logPath = path.join(api.pocketDir, 'log.md');
  const archivePath = path.join(api.pocketDir, 'log-archive.md');
  const options = ['--today', '2026-06-01', '--max-age-days', '90', '--keep-last', '2', '--min-turns', '1'];

  const plan = parseJson(runLang(['decay', ...options, '--json'], workspace));
  assert.strictEqual(plan.mode, 'plan');
  assert.strictEqual(plan.totals.archiveCandidates, 3, JSON.stringify(plan.totals));
  assert.strictEqual(plan.totals.archivedNow, 0, JSON.stringify(plan.totals));
  assert.ok(!fs.existsSync(archivePath), 'plan 不能写归档文件');

  const applied = parseJson(runLang(['decay', ...options, '--apply', '--json'], workspace));
  assert.strictEqual(applied.mode, 'apply');
  assert.strictEqual(applied.totals.archivedNow, 3, JSON.stringify(applied.totals));
  assert.strictEqual(applied.pockets[0].applied, true, JSON.stringify(applied.pockets[0]));
  assert.strictEqual(applied.ok, true, JSON.stringify(applied));

  const log = fs.readFileSync(logPath, 'utf-8');
  assert.ok(!/## T1 ·/.test(log) && !/## T3 ·/.test(log), log);
  assert.ok(/## T4 ·/.test(log) && /## T5 ·/.test(log), log);
  const archive = fs.readFileSync(archivePath, 'utf-8');
  assert.ok(/## T1 ·/.test(archive) && /## T3 ·/.test(archive), archive);
  assert.ok(!/## T4 ·/.test(archive), archive);

  const again = parseJson(runLang(['decay', ...options, '--apply', '--json'], workspace));
  assert.strictEqual(again.totals.archivedNow, 0, '已归档的轮次不能被二次归档：' + JSON.stringify(again.totals));
});

test('yuan: context facts and repo map lines name their pocket', () => {
  const workspace = tmpProject('yuan-sources');
  const api = makePocketIn(workspace, 'api');
  const web = makePocketIn(workspace, 'web');
  addTurn(api.pocketDir, 'source needle', { when: '2026-11-02' });
  addTurn(web.pocketDir, 'web turn', { when: '2026-11-02' });
  writer.addRequirement(api.pocketDir, { text: '支持 token 刷新' });
  writer.addDecision(api.pocketDir, { title: 'Use JWT', decision: 'JWT for API auth' });
  writer.updateState(api.pocketDir, { summary: '登录已通', nextStep: '补 token 刷新' });
  fs.mkdirSync(path.join(api.projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(api.projectDir, 'src', 'login.js'), 'export function login() {}\n', 'utf-8');

  parseJson(runLang(['workspace', 'init', '--name', 'srcws', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'web', web.projectDir, '--json'], workspace));
  parseJson(runLang(['map', 'update', '--json'], workspace));

  const built = parseJson(runLang([
    'context', 'build', '--max-tokens', '50000', '--query', 'needle', '--json',
  ], workspace));

  assert.ok(built.content.includes('api — State: 登录已通'), built.content);
  assert.ok(built.content.includes('api:R1 — 支持 token 刷新'), built.content);
  assert.ok(built.content.includes('api:ADR-1 — Use JWT'), built.content);
  assert.ok(built.content.includes('api:T1 — source needle'), built.content);
  assert.ok(built.content.includes('web:T1 — web turn'), built.content);
  assert.ok(built.content.includes('[api] api/src/login.js'), built.content);
  assert.ok(built.content.includes('api:T1 [T] source needle'), built.content);
});

test('yuan: capture accepts gh PR / CI summaries and validates the source choice', () => {
  const pr = capture.summarizePrJson(JSON.stringify({
    number: 42,
    title: 'Fix login redirect',
    body: '- Preserve the returnTo query\n- Add regression test',
    url: 'https://github.com/acme/app/pull/42',
    state: 'MERGED',
  }));
  assert.strictEqual(pr.gist, 'PR #42 · Fix login redirect (merged)');
  assert.strictEqual(pr.url, 'https://github.com/acme/app/pull/42');
  assert.match(pr.text, /Preserve the returnTo query/);

  const log = [
    '2026-11-22T10:00:00.1234567Z ##[group]Run npm test',
    '2026-11-22T10:00:01.1234567Z FAIL src/login.test.js',
    '2026-11-22T10:00:02.1234567Z   expected 200, got 500',
    '',
  ].join('\n');
  const failures = capture.extractFailureLines(log);
  assert.deepStrictEqual(failures, ['FAIL src/login.test.js', 'expected 200, got 500'], JSON.stringify(failures));

  const run = capture.summarizeRunOutput(JSON.stringify({
    workflowName: 'CI',
    displayTitle: 'fix: login redirect',
    conclusion: 'failure',
    url: 'https://github.com/acme/app/actions/runs/7',
    headBranch: 'fix-login',
  }), log);
  assert.strictEqual(run.gist, 'CI · fix: login redirect (failure)');
  assert.strictEqual(run.url, 'https://github.com/acme/app/actions/runs/7');
  assert.match(run.text, /- FAIL src\/login\.test\.js/);

  const workspace = tmpProject('yuan-capture-gh');
  const api = makePocketIn(workspace, 'api');
  addTurn(api.pocketDir, 'capture seed');
  parseJson(runLang(['workspace', 'init', '--name', 'ghws', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));

  const noSource = runLang(['capture', '--pocket', 'api', '--json'], workspace);
  assert.strictEqual(noSource.code, 1);
  assert.match(parseJson(noSource).error, /one source/);

  const both = runLang(['capture', 'pr.md', '--pr', '42', '--pocket', 'api', '--json'], workspace);
  assert.strictEqual(both.code, 1);
  assert.match(parseJson(both).error, /only one source/);

  const emptyPr = runLang(['capture', '--pr', '--pocket', 'api', '--json'], workspace);
  assert.strictEqual(emptyPr.code, 1);
  assert.match(parseJson(emptyPr).error, /--pr needs a value/);
});

test('yuan: MCP exposes the workspace tools and serves status over stdio', () => {
  const workspace = tmpProject('yuan-mcp');
  const api = makePocketIn(workspace, 'api');
  addTurn(api.pocketDir, 'mcp seed');
  parseJson(runLang(['workspace', 'init', '--name', 'mcpws', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'context_pocket_workspace', arguments: { action: 'status' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'context_pocket_workspace', arguments: { action: 'index' } } },
  ];
  const child = spawnSync(process.execPath, [MCP], {
    cwd: workspace,
    input: requests.map((r) => JSON.stringify(r)).join('\n') + '\n',
    encoding: 'utf-8',
    timeout: 15000,
  });
  assert.strictEqual(child.status, 0, child.stderr);
  const messages = child.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.strictEqual(messages[0].result.serverInfo.name, 'context-pocket-yuan');
  const tools = messages[1].result.tools.map((t) => t.name).sort();
  assert.deepStrictEqual(tools, [
    'context_pocket_audit',
    'context_pocket_capture',
    'context_pocket_consolidate',
    'context_pocket_context',
    'context_pocket_decay',
    'context_pocket_forget',
    'context_pocket_map',
    'context_pocket_merge',
    'context_pocket_recap',
    'context_pocket_workspace',
  ]);
  const status = JSON.parse(messages[2].result.content[0].text);
  assert.strictEqual(status.pockets[0].name, 'api');
  assert.strictEqual(status.health.index.present, false, 'status 必须同时带缓存健康摘要：' + JSON.stringify(status.health));
  assert.strictEqual(status.health.repoMap.present, false, JSON.stringify(status.health));
  const index = JSON.parse(messages[3].result.content[0].text);
  assert.ok(index.docsCount >= 1, 'MCP action=index 应返回索引计数：' + JSON.stringify(index));
});

test('yuan: context --expand follows cross-pocket x-refs and caches the workspace graph', () => {
  const workspace = tmpProject('yuan-graph');
  const api = makePocketIn(workspace, 'api');
  const web = makePocketIn(workspace, 'web');
  addTurn(api.pocketDir, 'api calls web', {
    when: '2026-11-02',
    action: ['Changed src/api.js — depends on web:T1'],
  });
  addTurn(web.pocketDir, 'web endpoint', { when: '2026-11-01' });
  addTurn(web.pocketDir, 'web followup one', { when: '2026-11-03' });
  addTurn(web.pocketDir, 'web followup two', { when: '2026-11-04' });
  addTurn(web.pocketDir, 'web followup three', { when: '2026-11-05' });

  parseJson(runLang(['workspace', 'init', '--name', 'graphws', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'web', web.projectDir, '--json'], workspace));

  const cachePath = path.join(workspace, '.contextpocket', 'workspace-graph.json');
  const plain = parseJson(runLang([
    'context', 'build', '--max-tokens', '50000', '--query', 'calls', '--json',
  ], workspace));
  assert.ok(!plain.content.includes('### Graph'), '默认 expand=0 不出现 Graph 段：' + plain.content);
  assert.strictEqual(plain.sources.graph.enabled, false);
  assert.ok(!fs.existsSync(cachePath), '默认 context build 不能创建图缓存');

  const plainExplain = parseJson(runLang([
    'context', 'explain', '--max-tokens', '50000', '--query', 'calls', '--json',
  ], workspace));
  assert.strictEqual(plainExplain.sections.related.graph.enabled, false);
  assert.ok(!plainExplain.content.includes('· graph '), '默认 explain 不出现 graph 行：' + plainExplain.content);
  assert.ok(!fs.existsSync(cachePath), '默认 context explain 不能创建图缓存');

  const expanded = parseJson(runLang([
    'context', 'build', '--max-tokens', '50000', '--query', 'calls', '--expand', '1', '--json',
  ], workspace));
  assert.strictEqual(expanded.sources.graph.enabled, true, JSON.stringify(expanded.sources));
  assert.ok(expanded.sources.graph.neighbors >= 1, JSON.stringify(expanded.sources.graph));
  assert.ok(expanded.sources.graph.crossPocketEdges >= 1, JSON.stringify(expanded.sources.graph));
  assert.ok(expanded.content.includes('### Graph'), expanded.content);
  assert.ok(expanded.content.includes('- web:T1 · web endpoint (1 hop, cross)'), expanded.content);
  assert.ok(expanded.content.includes('Path: api:T1 → x-ref → web:T1 [api:T1 · 2026-11-02]'),
    expanded.content);

  assert.ok(fs.existsSync(cachePath), '--expand 必须建立工作区图缓存');
  const expandedExplain = parseJson(runLang([
    'context', 'explain', '--max-tokens', '50000', '--query', 'calls', '--expand', '1', '--json',
  ], workspace));
  assert.strictEqual(expandedExplain.sections.related.graph.enabled, true, JSON.stringify(expandedExplain.sections.related));
  assert.ok(expandedExplain.content.includes('· graph '), expandedExplain.content);

  const tight = parseJson(runLang([
    'context', 'build', '--max-tokens', '120', '--query', 'calls', '--expand', '1', '--json',
  ], workspace));
  assert.ok(tight.trimmed.includes('Related'), JSON.stringify(tight.trimmed));
  assert.ok(!tight.content.includes('### Graph'), 'Graph 必须随 Related 一起被裁掉：' + tight.content);
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  assert.strictEqual(cache.version, 2);
  assert.deepStrictEqual(cache.pockets.api.crossRefs, [
    { fromT: 1, toPocket: 'web', toT: 1, date: '2026-11-02' },
  ]);
  assert.ok(cache.edges.some((edge) => edge.type === 'x-ref'
    && edge.from === 'api:T1' && edge.to === 'web:T1'), JSON.stringify(cache.edges));

  const status = parseJson(runLang(['workspace', 'status', '--json'], workspace));
  assert.strictEqual(status.health.graph.present, true, JSON.stringify(status.health));
  assert.strictEqual(status.health.graph.fresh, true, JSON.stringify(status.health.graph));
  assert.ok(status.health.graph.crossPocketEdges >= 1, JSON.stringify(status.health.graph));
  assert.match(runLang(['workspace', 'status'], workspace).stdout, /graph: fresh/);

  const audit = parseJson(runLang(['audit', '--json'], workspace));
  assert.strictEqual(audit.health.graph.present, true, JSON.stringify(audit.health));
  assert.ok(audit.totals.crossPocketEdges >= 1, JSON.stringify(audit.totals));
  assert.ok(audit.content.includes('- graph: fresh'), audit.content);

  const before = parseJson(runLang([
    'context', 'build', '--max-tokens', '50000', '--query', 'calls',
    '--expand', '1', '--as-of', '2026-10-31', '--json',
  ], workspace));
  assert.strictEqual(before.sources.graph.asOf, '2026-10-31');
  assert.ok(!before.content.includes('web:T1'), 'as-of 之前的节点不能出现：' + before.content);

  const atRef = parseJson(runLang([
    'context', 'build', '--max-tokens', '50000', '--query', 'calls',
    '--expand', '1', '--as-of', 'web:T2', '--json',
  ], workspace));
  assert.strictEqual(atRef.sources.graph.asOf, '2026-11-03', 'pocket:Tn 必须用该轮 WHEN 解析');
  assert.ok(atRef.content.includes('web:T1'), atRef.content);

  const asOfOnly = runLang(['context', 'build', '--as-of', '2026-11-02', '--json'], workspace);
  assert.strictEqual(asOfOnly.code, 1);
  assert.match(parseJson(asOfOnly).error, /requires --expand/);

  const badDepth = runLang(['context', 'build', '--expand', '3', '--json'], workspace);
  assert.strictEqual(badDepth.code, 1);
  assert.match(parseJson(badDepth).error, /must be 1 or 2/);

  const bareDepth = runLang(['context', 'build', '--expand', '--json'], workspace);
  assert.strictEqual(bareDepth.code, 1);
  assert.match(parseJson(bareDepth).error, /needs a depth/);

  const badAsOf = runLang(['context', 'build', '--expand', '1', '--as-of', 'nope', '--json'], workspace);
  assert.strictEqual(badAsOf.code, 1);
  assert.match(parseJson(badAsOf).error, /YYYY-MM-DD or pocket:Tn/);

  addTurn(web.pocketDir, 'web drift', { when: '2026-11-06' });
  const stale = parseJson(runLang(['workspace', 'status', '--json'], workspace));
  assert.strictEqual(stale.health.graph.fresh, false, '源文件变化后图必须报 stale：' + JSON.stringify(stale.health.graph));

  const refreshed = parseJson(runLang([
    'context', 'build', '--max-tokens', '50000', '--query', 'calls', '--expand', '1', '--json',
  ], workspace));
  assert.ok(refreshed.content.includes('### Graph'), refreshed.content);
  const freshAgain = parseJson(runLang(['workspace', 'status', '--json'], workspace));
  assert.strictEqual(freshAgain.health.graph.fresh, true, JSON.stringify(freshAgain.health.graph));
});

test('yuan: workspace graph rebuilds only changed pockets and counts dangling refs', () => {
  const workspace = tmpProject('yuan-graph-inc');
  const api = makePocketIn(workspace, 'api');
  const web = makePocketIn(workspace, 'web');
  addTurn(api.pocketDir, 'api points at web', {
    when: '2026-11-02',
    action: ['depends on web:T1'],
  });
  addTurn(web.pocketDir, 'web target', { when: '2026-11-02' });

  parseJson(runLang(['workspace', 'init', '--name', 'graphinc', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'web', web.projectDir, '--json'], workspace));

  const wg = require(path.join(ROOT, 'lang', 'lib', 'workspace-graph'));

  const first = wg.ensureWorkspaceGraph(workspace);
  assert.strictEqual(first.cacheStatus, 'rebuilt');
  assert.deepStrictEqual(first.rebuiltPockets, ['api', 'web']);
  assert.strictEqual(first.stats.crossPocketEdges, 1, JSON.stringify(first.stats));
  assert.strictEqual(first.stats.danglingCrossRefs, 0, JSON.stringify(first.stats));

  const second = wg.ensureWorkspaceGraph(workspace);
  assert.strictEqual(second.cacheStatus, 'fresh');
  assert.deepStrictEqual(second.rebuiltPockets, []);

  addTurn(web.pocketDir, 'web second', { when: '2026-11-03' });
  const third = wg.ensureWorkspaceGraph(workspace);
  assert.strictEqual(third.cacheStatus, 'partial');
  assert.deepStrictEqual(third.rebuiltPockets, ['web'], '只重建签名变化的口袋');
  assert.strictEqual(third.stats.crossPocketEdges, 1, '跨口袋边用缓存 crossRefs 重算');

  addTurn(api.pocketDir, 'api missing target', {
    when: '2026-11-04',
    action: ['depends on web:T99'],
  });
  const fourth = wg.ensureWorkspaceGraph(workspace);
  assert.strictEqual(fourth.stats.danglingCrossRefs, 1, JSON.stringify(fourth.stats));
  assert.strictEqual(fourth.stats.crossPocketEdges, 1, JSON.stringify(fourth.stats));

  const inspected = wg.inspectWorkspaceGraph(workspace);
  assert.strictEqual(inspected.present, true);
  assert.strictEqual(inspected.fresh, true, JSON.stringify(inspected));
  assert.strictEqual(inspected.danglingCrossRefs, 1, JSON.stringify(inspected));

  const forced = wg.ensureWorkspaceGraph(workspace, { force: true });
  assert.strictEqual(forced.cacheStatus, 'rebuilt');
  assert.deepStrictEqual(forced.rebuiltPockets, ['api', 'web']);
});

test('yuan: --graph-edges traverses duplicate / shared-file / tag / near derived edges', () => {
  const workspace = tmpProject('yuan-graph-derived');
  const api = makePocketIn(workspace, 'api');
  const web = makePocketIn(workspace, 'web');
  addTurn(api.pocketDir, 'api only work', {
    when: '2026-11-01',
    tags: ['auth'],
    action: ['Changed src/shared.js'],
  });
  addTurn(web.pocketDir, 'web shared work', {
    when: '2026-11-03',
    tags: ['auth'],
    action: ['Changed src/shared.js'],
  });
  addTurn(web.pocketDir, 'web recent one', { when: '2026-11-04' });
  addTurn(web.pocketDir, 'web recent two', { when: '2026-11-05' });
  addTurn(web.pocketDir, 'web recent three', { when: '2026-11-06' });

  writer.addDecision(api.pocketDir, { title: 'Use JWT', decision: 'JWT for API auth' });
  writer.addDecision(web.pocketDir, { title: 'Use JWT', decision: 'JWT for API auth' });
  writer.addRequirement(api.pocketDir, { text: '支持 token 刷新' });
  writer.addRequirement(web.pocketDir, { text: '支持 token 刷新' });
  writer.updatePreferences(api.pocketDir, { key: 'reviewer', value: 'alice' });
  writer.updatePreferences(web.pocketDir, { key: 'reviewer', value: 'alice' });

  parseJson(runLang(['workspace', 'init', '--name', 'derivedws', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'web', web.projectDir, '--json'], workspace));

  const wg = require(path.join(ROOT, 'lang', 'lib', 'workspace-graph'));
  const built = wg.ensureWorkspaceGraph(workspace);
  const derived = wg.deriveWorkspaceEdges(built.graph.nodes, built.graph.edges, {
    groups: wg.GRAPH_EDGE_GROUPS.slice(),
    nearDays: 7,
  });
  assert.deepStrictEqual(derived.stats, {
    duplicateAdr: 1,
    duplicateReq: 1,
    duplicatePref: 1,
    sharedFile: 1,
    sameTag: 1,
    temporalNear: 1,
    total: 6,
    truncated: false,
  }, JSON.stringify(derived.stats));
  const types = new Set(derived.edges.map((edge) => edge.type));
  for (const type of ['duplicate-adr', 'duplicate-req', 'duplicate-pref', 'shared-file', 'same-tag', 'temporal-near']) {
    assert.ok(types.has(type), 'missing derived edge ' + type + ': ' + JSON.stringify([...types]));
  }
  assert.ok(derived.edges.every((edge) => edge.evidence === 'weak' && edge.scope === 'cross'));

  const plain = parseJson(runLang([
    'context', 'build', '--max-tokens', '50000', '--query', 'only', '--expand', '2', '--json',
  ], workspace));
  assert.deepStrictEqual(plain.sources.graph.edges, [], '派生边必须显式开启');
  assert.strictEqual(plain.sources.graph.derivedEdges, 0);
  assert.ok(!plain.content.includes('web:file:src/shared.js'), plain.content);
  assert.ok(!plain.content.includes('web:tag:auth'), plain.content);
  assert.ok(!plain.content.includes('web:pref:reviewer'), plain.content);
  assert.ok(!plain.content.includes('web:T1 · web shared work'), plain.content);

  const shared = parseJson(runLang([
    'context', 'build', '--max-tokens', '50000', '--query', 'only',
    '--expand', '2', '--graph-edges', 'shared-file', '--json',
  ], workspace));
  assert.deepStrictEqual(shared.sources.graph.edges, ['shared-file']);
  assert.ok(shared.sources.graph.derivedEdges >= 1, JSON.stringify(shared.sources.graph));
  assert.ok(shared.content.includes('web:file:src/shared.js'), shared.content);
  assert.ok(shared.content.includes('shared-file'), shared.content);
  assert.ok(!shared.content.includes('web:tag:auth'), shared.content);

  const nearOne = parseJson(runLang([
    'context', 'build', '--max-tokens', '50000', '--query', 'only',
    '--expand', '2', '--graph-edges', 'near', '--graph-near-days', '1', '--json',
  ], workspace));
  assert.strictEqual(nearOne.sources.graph.derivedEdges, 0, JSON.stringify(nearOne.sources.graph));
  assert.ok(!nearOne.content.includes('web:T1 · web shared work'), nearOne.content);

  const all = parseJson(runLang([
    'context', 'build', '--max-tokens', '50000', '--query', 'only',
    '--expand', '2', '--graph-edges', 'all', '--json',
  ], workspace));
  assert.deepStrictEqual(all.sources.graph.edges, ['duplicate', 'shared-file', 'tag', 'near']);
  assert.ok(all.sources.graph.derivedEdges >= 6, JSON.stringify(all.sources.graph));
  assert.ok(all.content.includes('web:file:src/shared.js'), all.content);
  assert.ok(all.content.includes('web:tag:auth'), all.content);
  assert.ok(all.content.includes('web:pref:reviewer'), all.content);
  assert.ok(all.content.includes('web:T1 · web shared work'), all.content);
  assert.ok(all.content.includes('same-tag'), all.content);
  assert.ok(all.content.includes('duplicate-pref'), all.content);
  assert.ok(all.content.includes('temporal-near'), all.content);

  const noExpand = runLang(['context', 'build', '--graph-edges', 'tag', '--json'], workspace);
  assert.strictEqual(noExpand.code, 1);
  assert.match(parseJson(noExpand).error, /requires --expand/);

  const unknown = runLang(['context', 'build', '--expand', '1', '--graph-edges', 'nope', '--json'], workspace);
  assert.strictEqual(unknown.code, 1);
  assert.match(parseJson(unknown).error, /unknown --graph-edges/);

  const bare = runLang(['context', 'build', '--expand', '1', '--graph-edges', '--json'], workspace);
  assert.strictEqual(bare.code, 1);
  assert.match(parseJson(bare).error, /needs a list/);

  const badDays = runLang([
    'context', 'build', '--expand', '1', '--graph-edges', 'near', '--graph-near-days', '0', '--json',
  ], workspace);
  assert.strictEqual(badDays.code, 1);
  assert.match(parseJson(badDays).error, /positive integer/);
});

test('yuan: derived edges cap hub keys to five pockets and flag truncation', () => {
  const wg = require(path.join(ROOT, 'lang', 'lib', 'workspace-graph'));
  const nodes = [];
  for (let i = 0; i < 7; i++) {
    nodes.push({
      id: 'p' + i + ':tag:auth',
      pocket: 'p' + i,
      type: 'tag',
      rawId: 'tag:auth',
      label: 'auth',
      date: null,
    });
  }
  const derived = wg.deriveWorkspaceEdges(nodes, [], { groups: ['tag'] });
  assert.strictEqual(derived.stats.sameTag, 10, '5 个口袋两两配对 = 10 条');
  assert.strictEqual(derived.stats.truncated, true, '超过 5 个口袋必须标记截断');
  assert.ok(derived.edges.every((edge) => edge.from < edge.to));
});

test('yuan: MCP context accepts expand/asOf and returns graph neighbors', () => {
  const workspace = tmpProject('yuan-mcp-graph');
  const api = makePocketIn(workspace, 'api');
  const web = makePocketIn(workspace, 'web');
  addTurn(api.pocketDir, 'mcp graph needle', {
    when: '2026-11-02',
    action: ['Changed src/shared.js', 'depends on web:T1'],
  });
  addTurn(web.pocketDir, 'mcp graph target', {
    when: '2026-11-01',
    action: ['Changed src/shared.js'],
  });
  addTurn(web.pocketDir, 'mcp graph recent one', { when: '2026-11-03' });
  addTurn(web.pocketDir, 'mcp graph recent two', { when: '2026-11-04' });
  addTurn(web.pocketDir, 'mcp graph recent three', { when: '2026-11-05' });

  parseJson(runLang(['workspace', 'init', '--name', 'mcpgraph', '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'api', api.projectDir, '--json'], workspace));
  parseJson(runLang(['workspace', 'add', 'web', web.projectDir, '--json'], workspace));

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'context_pocket_context',
        arguments: { query: 'needle', maxTokens: 50000, expand: 1, asOf: '2026-11-03' },
      },
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'context_pocket_context',
        arguments: { query: 'needle', maxTokens: 50000, expand: 2, graphEdges: 'shared-file' },
      },
    },
  ];
  const child = spawnSync(process.execPath, [MCP], {
    cwd: workspace,
    input: requests.map((r) => JSON.stringify(r)).join('\n') + '\n',
    encoding: 'utf-8',
    timeout: 15000,
  });
  assert.strictEqual(child.status, 0, child.stderr);
  const messages = child.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const contextTool = messages[1].result.tools.find((tool) => tool.name === 'context_pocket_context');
  assert.deepStrictEqual(contextTool.inputSchema.properties.expand.enum, [1, 2]);
  assert.strictEqual(contextTool.inputSchema.properties.asOf.type, 'string');
  assert.strictEqual(contextTool.inputSchema.properties.graphEdges.type, 'string');
  assert.strictEqual(contextTool.inputSchema.properties.graphNearDays.type, 'integer');

  const context = JSON.parse(messages[2].result.content[0].text);
  assert.strictEqual(context.sources.graph.enabled, true, JSON.stringify(context.sources));
  assert.strictEqual(context.sources.graph.asOf, '2026-11-03');
  assert.ok(context.content.includes('### Graph'), context.content);
  assert.ok(context.content.includes('web:T1'), context.content);

  const derivedContext = JSON.parse(messages[3].result.content[0].text);
  assert.deepStrictEqual(derivedContext.sources.graph.edges, ['shared-file']);
  assert.ok(derivedContext.sources.graph.derivedEdges >= 1, JSON.stringify(derivedContext.sources.graph));
  assert.ok(derivedContext.content.includes('web:file:src/shared.js'), derivedContext.content);
});
