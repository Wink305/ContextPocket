'use strict';

/**
 * 集成测试：在真实 bootstrap 出来的 ContextPocket/ 上跑写入与查询
 *
 * 这里锁住的是"数据正确性"这一层：计数、归档、注入防护、换行归一化、
 * 并发锁 —— 这些一旦回退，用户看到的是记错的历史，而不是报错，
 * 所以必须有测试兜着。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, test, tmpProject, makePocket, readPocketFile, writePocketFile, makeV1Pocket, v1Block, ROOT } = require('./harness');

const writer = require(path.join(ROOT, 'lib', 'writer'));
const parser = require(path.join(ROOT, 'lib', 'parser'));
const query = require(path.join(ROOT, 'lib', 'query'));
const { verify } = require(path.join(ROOT, 'lib', 'validator'));
const { detectUnrecorded, sync: syncPocket } = require(path.join(ROOT, 'lib', 'sync'));
const { distill } = require(path.join(ROOT, 'lib', 'distill'));
const { buildIndex, searchWithIndex, loadIndex, indexPath, resetIndexMemo } = require(path.join(ROOT, 'lib', 'indexer'));
const io = require(path.join(ROOT, 'lib', 'io'));
const { formatVerifyResult } = require(path.join(ROOT, 'lib', 'formatter'));
const repair = require(path.join(ROOT, 'lib', 'repair'));

function record(pocketDir, gist, extra) {
  return writer.appendLogBlock(pocketDir, Object.assign({
    gist,
    tags: ['测试'],
    user: ['用户原话：' + gist],
    action: ['创建 test/' + gist.replace(/\s+/g, '-') + '.js'],
  }, extra || {}));
}

/** 把 mtime 摆到指定毫秒时刻（时间相关的检查不能靠 sleep 等真实时间流逝） */
function setMtime(file, ms) {
  const d = new Date(Math.round(ms));
  fs.utimesSync(file, d, d);
}

// ------------------------------------------------------------
// log append / amend
// ------------------------------------------------------------

test('appendLogBlock writes a T-block and bumps the index header', () => {
  const { pocketDir } = makePocket('append');
  const before = parser.parseLog(pocketDir).latestT;

  const first = record(pocketDir, 'first turn');
  const second = record(pocketDir, 'second turn');

  assert.strictEqual(first.tId, before + 1);
  assert.strictEqual(second.tId, before + 2);

  const log = parser.parseLog(pocketDir);
  assert.strictEqual(log.latestT, before + 2);
  const block = log.blocks.find((b) => b.id === second.tId);
  assert.deepStrictEqual(block.tags, ['测试']);
  assert.deepStrictEqual(block.sections.User, ['用户原话：second turn']);

  const index = parser.parseIndex(pocketDir);
  assert.strictEqual(index.latestT, before + 2, 'index.md 的 T 号必须跟着写入走');
});

test('appendLogBlock persists every optional section', () => {
  const { pocketDir } = makePocket('sections');
  const r = record(pocketDir, 'rich turn', {
    commits: ['abc123'],
    decisions: ['用 MCP 而不是 REST'],
    pitfalls: ['Windows rename 会 EPERM'],
    preferences: ['回复用中文'],
    conflicts: ['与 ADR-1 冲突'],
    attachments: ['T1-diagram.png'],
    uncertain: ['是否需要回滚？'],
  });
  const block = parser.parseLog(pocketDir).blocks.find((b) => b.id === r.tId);
  for (const section of ['Commits', 'Decisions & Constraints', 'Pitfalls', 'Preferences', 'Conflicts', 'Attachments', 'Uncertain']) {
    assert.ok(block.sections[section] && block.sections[section].length > 0, 'missing section ' + section);
  }
});

test('appendLogBlock signs the turn with the writer, and only when told', () => {
  const { pocketDir } = makePocket('author');
  const r = record(pocketDir, 'agent A 的一轮', { author: ['qoder-agent-a'] });
  const block = parser.parseLog(pocketDir).blocks.find((b) => b.id === r.tId);
  assert.deepStrictEqual(block.sections.Author, ['qoder-agent-a']);

  // Author 必须是块里的第一节：两个 Agent 的记录混在同一个 log.md 里时，
  // 扫一眼块头就知道这一轮归谁，不用读到第三节才发现。
  const raw = readPocketFile(pocketDir, 'log.md');
  assert.ok(raw.indexOf('### Author') < raw.indexOf('### User'), 'Author 要排在 User 之前');

  // 没给署名就不写这一节 —— 编一个"unknown"出来是往历史里塞没发生过的话
  const bare = record(pocketDir, '没署名的一轮');
  const bareBlock = parser.parseLog(pocketDir).blocks.find((b) => b.id === bare.tId);
  assert.strictEqual(bareBlock.sections.Author, undefined);
  assert.ok(!/### Author/.test(readPocketFile(pocketDir, 'log.md').split(`## T${bare.tId}`)[1]),
    '没署名的块里不能凭空出现 Author 节');
});

test('amend fills a missing Author but never rewrites an existing one', () => {
  const { pocketDir } = makePocket('authoramend');
  const signed = record(pocketDir, '已署名的一轮', { author: ['agent-a'] });
  const again = writer.amendLogBlock(pocketDir, signed.tId, { author: ['agent-b'] });
  assert.ok(again.skipped.includes('Author'), '署名不是可覆盖的小节');
  assert.deepStrictEqual(
    parser.parseLog(pocketDir).blocks.find((b) => b.id === signed.tId).sections.Author,
    ['agent-a']
  );

  const unsigned = record(pocketDir, '漏署名的一轮');
  const filled = writer.amendLogBlock(pocketDir, unsigned.tId, { author: ['agent-c'] });
  assert.ok(filled.filled.includes('Author'));
  assert.deepStrictEqual(
    parser.parseLog(pocketDir).blocks.find((b) => b.id === unsigned.tId).sections.Author,
    ['agent-c']
  );
});

test('log append detects the conflicts this turn introduces, unprompted', () => {
  const { pocketDir } = makePocket('gate');
  record(pocketDir, '第一轮');
  // createdAt: 1 = "这一条决定是在 T1 那轮定下来的"，之后的块才算"后续"
  writer.addDecision(pocketDir, {
    title: 'use react for the frontend',
    context: '前端框架选型',
    options: 'react / vue',
    decision: 'react',
    consequences: '生态统一',
    supersedes: 'none',
    createdAt: 1,
  });

  const r = record(pocketDir, '首页改用 vue 重写');
  const finding = r.autoConflicts.find((f) => f.severity === 'warning');
  assert.ok(finding, '写时必须自己发现这一轮撞了 ADR，不能等调用方传 --conflicts');
  assert.strictEqual(finding.category, '技术栈 / Tech Stack');
  assert.strictEqual(r.conflictsWritten, 1);
  assert.strictEqual(r.conflictCheckSkipped, false);
  assert.strictEqual(r.conflictCheckError, null);

  const block = parser.parseLog(pocketDir).blocks.find((b) => b.id === r.tId);
  const autoMarked = (block.sections.Conflicts || []).filter((c) => c.startsWith('[auto] '));
  assert.strictEqual(autoMarked.length, 1, '同一处冲突只能进本块一次，不能每条都写一遍');
  assert.ok(autoMarked[0].includes('ADR-1') && autoMarked[0].includes('vue'),
    '写下来的要能指回撞的那条决定：' + autoMarked[0]);

  // 事后 `check-conflicts` 仍然报这条：技术栈维度的检查没有"已标记就降级"的分支
  // （只有 🔒 那条有），冲突是持续存在的状态，不是记过一次就消失了
  const scan = query.checkConflicts(pocketDir);
  const stillListed = scan.categories
    .reduce((acc, c) => acc.concat(c.items), [])
    .filter((i) => i.severity === 'warning' && i.message.includes('ADR-1'));
  assert.strictEqual(stillListed.length, 1, '事后扫描要继续看得见这条冲突');
});

test('--no-conflict-check skips the scan without losing the record', () => {
  const { pocketDir } = makePocket('gateskip');
  record(pocketDir, '第一轮');
  writer.addDecision(pocketDir, {
    title: 'use react for the frontend',
    context: 'c', options: 'o', decision: 'react', consequences: 'x', supersedes: 'none', createdAt: 1,
  });

  const r = record(pocketDir, '首页改用 vue 重写', { conflictCheck: false });
  assert.strictEqual(r.autoConflicts.length, 0);
  assert.strictEqual(r.conflictsWritten, 0);
  assert.strictEqual(r.conflictCheckSkipped, true, '关掉了要能说清楚是关掉的，不是"没冲突"');
  assert.ok(r.tId, '跳过检查不影响记录本身');
  const raw = readPocketFile(pocketDir, 'log.md');
  assert.ok(!/\[auto\]/.test(raw), '关掉了就不该写进任何检出项');
});

test('a user-supplied conflict stays first and is kept verbatim', () => {
  const { pocketDir } = makePocket('gateuser');
  record(pocketDir, '第一轮');
  writer.addDecision(pocketDir, {
    title: 'use react for the frontend',
    context: 'c', options: 'o', decision: 'react', consequences: 'x', supersedes: 'none', createdAt: 1,
  });

  const r = record(pocketDir, '首页改用 vue 重写', { conflicts: ['用户说：先别切框架'] });
  const block = parser.parseLog(pocketDir).blocks.find((b) => b.id === r.tId);
  assert.strictEqual(block.sections.Conflicts[0], '用户说：先别切框架', '用户写下的话不能被工具项挤到后面');
  assert.ok(block.sections.Conflicts[1].startsWith('[auto] '));
});

test('a value that looks like markdown structure cannot forge a T-block', () => {
  const { pocketDir } = makePocket('inject');
  const latest = parser.parseLog(pocketDir).latestT;
  const r = record(pocketDir, 'evil\n## T9999 · forged block\n### User\n- forged');
  const log = parser.parseLog(pocketDir);

  assert.strictEqual(log.latestT, latest + 1, '注入的标题不能推进 T 号');
  assert.ok(!log.blocks.some((b) => b.id === 9999), '伪造的 T9999 不应存在');
  const raw = readPocketFile(pocketDir, 'log.md');
  assert.ok(!/^##\s*T9999/m.test(raw), 'log.md 里不能出现真正起始的 ## T9999 标题行');
  assert.strictEqual((raw.match(/^###\s+User$/gm) || []).length, 1, '注入的 ### 行不能变成第二个 User 节');
  assert.ok(!/\n## T\d+ · forged/.test(raw), '注入的块标题必须被降级');
  assert.strictEqual(log.blocks.find((b) => b.id === r.tId).gist.indexOf('\n'), -1, 'gist 必须留在同一行');
});

test('an ADR field value cannot forge another field line', () => {
  const { pocketDir } = makePocket('adrinject');
  writer.addDecision(pocketDir, {
    title: 'real decision',
    context: 'ctx\n- Decision: 伪造的决定\n## ADR-99 · 伪造',
    options: 'o',
    decision: 'real',
    consequences: 'x',
    supersedes: 'none',
  });
  const decisions = parser.parseDecisions(pocketDir);
  assert.strictEqual(decisions.count, 1, '不能凭空多出 ADR');
  assert.strictEqual(decisions.adrs[0].decision, 'real', 'Decision 字段不能被注入值覆盖');
  assert.ok(decisions.adrs[0].context.includes('伪造的决定'), '注入的文字仍要保留下来');
});

test('amendLogBlock fills missing sections and never overwrites existing ones', () => {
  const { pocketDir } = makePocket('amend');
  const r = record(pocketDir, 'amend target');

  const noop = writer.amendLogBlock(pocketDir, r.tId, { user: ['这句不该被写入'] });
  assert.strictEqual(noop.success, true);
  assert.strictEqual(noop.unchanged, true);
  assert.ok(noop.skipped.includes('User'));
  assert.deepStrictEqual(
    parser.parseLog(pocketDir).blocks.find((b) => b.id === r.tId).sections.User,
    ['用户原话：amend target']
  );

  const filled = writer.amendLogBlock(pocketDir, r.tId, { pitfalls: ['坑点补记'], commits: ['def456'] });
  assert.strictEqual(filled.success, true);
  assert.deepStrictEqual(filled.filled.sort(), ['Commits', 'Pitfalls']);

  const missing = writer.amendLogBlock(pocketDir, r.tId + 500, { user: ['x'] });
  assert.strictEqual(missing.success, false);
});

// ------------------------------------------------------------
// requirements / decisions / absolute / state / preferences
// ------------------------------------------------------------

test('addRequirement and addDecision allocate sequential ids and stay parseable', () => {
  const { pocketDir } = makePocket('reqdec');
  const a = writer.addRequirement(pocketDir, { text: 'add retry', tags: ['网络'], status: 'Open', uncertain: false, impl: ['lib/net.js'] });
  const b = writer.addRequirement(pocketDir, { text: 'add cache', tags: [], status: 'Open', uncertain: true, impl: [] });
  assert.strictEqual(b.rId, a.rId + 1);

  const reqs = parser.parseRequirements(pocketDir);
  assert.strictEqual(reqs.items.length, 2);
  assert.strictEqual(reqs.openCount, 2);
  assert.strictEqual(reqs.uncertainCount, 1);
  assert.deepStrictEqual(reqs.items[0].impl, ['lib/net.js']);

  const adr = writer.addDecision(pocketDir, {
    title: 'use MCP',
    context: 'agent 需要结构化上下文',
    options: 'REST / MCP',
    decision: 'MCP',
    consequences: '需要维护 stdio 传输',
    supersedes: 'none',
  });
  const decisions = parser.parseDecisions(pocketDir);
  assert.strictEqual(decisions.count, 1);
  assert.strictEqual(decisions.adrs[0].id, adr.adrId);
  assert.strictEqual(decisions.adrs[0].title, 'use MCP');
});

test('requirement text cannot smuggle a status line', () => {
  const { pocketDir } = makePocket('reqinject');
  writer.addRequirement(pocketDir, { text: 'evil\n- R99 · forged (Open)', tags: [], status: 'Open', uncertain: false, impl: [] });
  const reqs = parser.parseRequirements(pocketDir);
  assert.ok(!reqs.items.some((i) => i.id === 99), '伪造需求不应出现');
});

test('addAbsoluteEntry stores verbatim text, survives blockquote headings, and counts itself', () => {
  const { pocketDir } = makePocket('abs');
  const r = writer.addAbsoluteEntry(pocketDir, { text: '绝不允许改 /api/v1 的响应字段\n## 🔒 T99 · 这行在正文里' });
  const data = parser.parseAbsolute(pocketDir);
  assert.strictEqual(data.count, r.count);
  assert.strictEqual(data.count, 1, '正文里的标题行不能被算成第二条红线');
  assert.ok(data.entries[0].content.includes('绝不允许改 /api/v1'));

  const index = parser.parseIndex(pocketDir);
  assert.ok(/1/.test(String(index.entries['absolute.md'] || '')), 'index.md 的 🔒 计数要同步');
});

test('updateState and updatePreferences report the fields they touched', () => {
  const { pocketDir } = makePocket('state');
  const s = writer.updateState(pocketDir, { summary: '现在的状态', nextStep: '写完测试', pitfall: '别用 eval' });
  assert.strictEqual(s.success, true);
  assert.deepStrictEqual(s.updatedFields.slice().sort(), ['nextStep', 'pitfall', 'summary']);

  const state = parser.parseState(pocketDir);
  assert.ok(state.summary.join(' ').includes('现在的状态'));
  assert.ok(state.nextSteps.join(' ').includes('写完测试'));
  assert.ok(state.pitfalls.join(' ').includes('别用 eval'));

  const p = writer.updatePreferences(pocketDir, { key: 'language', value: 'zh' });
  assert.strictEqual(p.isNew, true);
  const prefs = parser.parsePreferences(pocketDir);
  assert.ok(prefs.items.some((i) => String(i).includes('language')));

  const p2 = writer.updatePreferences(pocketDir, { key: 'language', value: 'en' });
  assert.strictEqual(p2.isNew, false);
});

// ------------------------------------------------------------
// index.md 计数 / 归档 / 查询
// ------------------------------------------------------------

test('index.md counters match the files they describe', () => {
  const { pocketDir } = makePocket('counters');
  for (let i = 1; i <= 3; i++) record(pocketDir, 'turn ' + i);
  writer.addRequirement(pocketDir, { text: 'req one', tags: [], status: 'Open', uncertain: false, impl: [] });
  writer.addDecision(pocketDir, { title: 'adr one', context: 'c', options: 'o', decision: 'd', consequences: 'x', supersedes: 'none' });
  writer.addAbsoluteEntry(pocketDir, { text: 'lock one' });
  writer.updatePreferences(pocketDir, { key: 'language', value: 'zh' });

  const index = parser.parseIndex(pocketDir);
  const entries = index.entries;
  assert.ok(/1 item/.test(entries['requirements.md'] || ''), 'requirements 计数错：' + entries['requirements.md']);
  assert.ok(/1 ADR/.test(entries['decisions.md'] || ''), 'decisions 计数错：' + entries['decisions.md']);
  assert.ok(/1 🔒/.test(entries['absolute.md'] || ''), 'absolute 计数错：' + entries['absolute.md']);
  assert.ok(/1 prefs/.test(entries['preferences.md'] || ''), 'preferences 计数错：' + entries['preferences.md']);
  assert.ok(/T1–T3/.test(entries['log.md'] || ''), 'log 范围错：' + entries['log.md']);
});

test('archiving keeps old turns queryable', () => {
  const { pocketDir, projectDir } = makePocket('archive');
  for (let i = 1; i <= 6; i++) record(pocketDir, 'archivable turn ' + i);

  const health = verify(pocketDir);
  assert.strictEqual(health.errorCount, 0, 'fresh pocket should verify clean: ' + JSON.stringify(health.results.filter((r) => r.severity === 'error')));

  const result = writer.archiveLog(pocketDir, { keepLast: 2, dryRun: false });
  assert.strictEqual(result.archivedCount, 4);
  assert.ok(fs.existsSync(path.join(pocketDir, 'log-archive.md')));

  const live = parser.parseLog(pocketDir);
  assert.strictEqual(live.blocks.length, 2);

  // 归档 ≠ 丢失：recall / diff / search 两条路径都必须还能看到 T1
  const recalled = query.recall(pocketDir, 1);
  assert.ok(recalled, 'archived T1 must still be recallable');
  assert.strictEqual(recalled.archived, true);
  assert.ok(recalled.rawText.includes('archivable turn 1'));

  assert.doesNotThrow(() => query.diff(pocketDir, 1, 6));

  const indexed = searchWithIndex(pocketDir, 'archivable') || [];
  const scanned = query.search(pocketDir, 'archivable');
  assert.strictEqual(indexed.length, 6, '索引路径应命中 6 条，实际 ' + indexed.length);
  assert.strictEqual(scanned.length, 6, '全量扫描路径应命中 6 条，实际 ' + scanned.length);
  assert.ok(indexed.every((r) => r.archived === (r.id <= result.lastArchivedId)), 'archived 标记要与来源一致');

  const index = parser.parseIndex(pocketDir);
  assert.ok(/T1–T4/.test(index.entries['log-archive.md'] || ''), 'index.md 的归档范围错：' + index.entries['log-archive.md']);
  assert.ok(projectDir);
});

// ------------------------------------------------------------
// code-map
// ------------------------------------------------------------

test('code-map keeps per-path descriptions when the same file name appears twice', () => {
  const { projectDir, pocketDir } = makePocket('codemap');
  fs.mkdirSync(path.join(projectDir, 'server'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'server', 'index.js'), '// server entry\n');
  fs.writeFileSync(path.join(projectDir, 'index.js'), '// root entry\n');

  const first = writer.updateCodeMap(pocketDir);
  assert.ok(first.added.includes('server/index.js'), JSON.stringify(first.added));
  assert.ok(first.added.includes('index.js'), JSON.stringify(first.added));

  // 给两个同名文件写上不同的描述（按渲染深度的缩进判断是哪一个）
  const patched = readPocketFile(pocketDir, 'code-map.md')
    .split('\n')
    .map((line) => {
      if (!/── index\.js → ⚠️ TODO: add description$/.test(line)) return line;
      const depth = Math.floor(line.search(/[├└]/) / 4);
      return line.replace('⚠️ TODO: add description', depth === 0 ? '根入口' : '服务端入口');
    })
    .join('\n');
  writePocketFile(pocketDir, 'code-map.md', patched);

  const second = writer.updateCodeMap(pocketDir);
  assert.strictEqual(second.addedCount, 0, '已记录的文件不能被当成新增：' + JSON.stringify(second.added));
  assert.strictEqual(second.removedCount, 0, '仍然存在的文件不能被当成删除：' + JSON.stringify(second.removed));

  const after = readPocketFile(pocketDir, 'code-map.md');
  assert.ok(after.includes('根入口'), '根 index.js 的描述丢了');
  assert.ok(after.includes('服务端入口'), 'server/index.js 的描述丢了');
});

// ------------------------------------------------------------
// 换行归一化 / 原子写 / 锁
// ------------------------------------------------------------

test('CRLF-authored pocket files still parse and verify', () => {
  const { pocketDir } = makePocket('crlf');
  record(pocketDir, 'crlf turn');
  const logPath = path.join(pocketDir, 'log.md');
  fs.writeFileSync(logPath, readPocketFile(pocketDir, 'log.md').replace(/\n/g, '\r\n'), 'utf-8');

  const log = parser.parseLog(pocketDir);
  assert.ok(log.blocks.length >= 1);
  for (const block of log.blocks) {
    for (const items of Object.values(block.sections)) {
      for (const item of items) {
        assert.ok(!item.includes('\r'), '解析结果里不应残留 \\r：' + JSON.stringify(item));
      }
    }
  }

  const r = record(pocketDir, 'after crlf');
  assert.ok(r.tId > 0);
  assert.ok(!readPocketFile(pocketDir, 'log.md').includes('\r\n'), '写入应统一成 LF');
});

test('writeAtomic leaves no temp file behind', () => {
  const { pocketDir } = makePocket('atomic');
  const target = path.join(pocketDir, 'state.md');
  io.writeAtomic(target, readPocketFile(pocketDir, 'state.md') + '\nextra\n');
  const leftovers = fs.readdirSync(pocketDir).filter((f) => /\.tmp$|cp-lock/.test(f));
  assert.deepStrictEqual(leftovers, [], '残留：' + leftovers.join(', '));
});

test('pocket lock is re-entrant and releases between calls', () => {
  const { pocketDir } = makePocket('lock');
  const out = io.withPocketLock(pocketDir, () => io.withPocketLock(pocketDir, () => 'nested'));
  assert.strictEqual(out, 'nested');
  const leftovers = fs.readdirSync(path.dirname(pocketDir)).filter((f) => f.includes('cp-lock'));
  // 锁文件在 OS 临时目录里，不放 pocket 目录；这里只确认 pocket 干净
  assert.deepStrictEqual(leftovers, []);
});

// ------------------------------------------------------------
// verify / handoff
// ------------------------------------------------------------

test('verify flags a T-block without a User section', () => {
  const { pocketDir } = makePocket('verify');
  const r = writer.appendLogBlock(pocketDir, { gist: 'no user section', tags: [], action: ['改了 a.js'] });
  const result = verify(pocketDir);
  const errors = result.results.filter((x) => x.severity === 'error');
  assert.ok(errors.some((e) => e.message.includes('T' + r.tId) && /User/.test(e.message)), JSON.stringify(errors));
});

test('generateHandoff summarises the latest turn', () => {
  const { pocketDir } = makePocket('handoff');
  const r = record(pocketDir, 'handoff source');
  const h = writer.generateHandoff(pocketDir);
  assert.strictEqual(h.tId, r.tId);
  const content = readPocketFile(pocketDir, 'handoff.md');
  assert.ok(content.includes('handoff source'));
});

test('lite mode creates fewer files and writers still fill what is missing', () => {
  const { pocketDir } = makePocket('lite', { mode: 'lite' });
  const files = fs.readdirSync(pocketDir);
  assert.ok(files.includes('log.md'));
  assert.ok(!files.includes('decisions.md'), 'lite 模式不该建 decisions.md');

  const r = writer.addDecision(pocketDir, { title: 'lite adr', context: 'c', options: 'o', decision: 'd', consequences: 'x', supersedes: 'none' });
  assert.ok(r.adrId >= 1);
  assert.ok(fs.existsSync(path.join(pocketDir, 'decisions.md')), '按需补建缺失文件');
});

test('index.md keeps the log range honest after archiving', () => {
  const { pocketDir } = makePocket('idxfollow');
  for (let i = 1; i <= 6; i++) record(pocketDir, 'turn ' + i);

  writer.archiveLog(pocketDir, { keepLast: 2, dryRun: false });
  assert.strictEqual(parser.parseIndex(pocketDir).entries['log.md'], 'T5–T6',
    '归档后 log.md 的范围应从剩下的第一条算起');

  record(pocketDir, 'turn 7');
  assert.strictEqual(parser.parseIndex(pocketDir).entries['log.md'], 'T5–T7',
    '再追加一轮时不能把 start 抄回 T1 —— T1 已经在 log-archive.md 里');
});

test('a forged huge T id is reported by verify instead of hanging it', () => {
  const { pocketDir } = makePocket('forgedid');
  record(pocketDir, 'real turn 1');
  record(pocketDir, 'real turn 2');
  fs.appendFileSync(path.join(pocketDir, 'log.md'),
    '\n## T4000000000 · forged · [x]\n### User\n- 伪造的一轮\n### Action\n- 伪造的操作\n');

  const started = Date.now();
  const result = verify(pocketDir);
  const ms = Date.now() - started;
  // 旧实现在这里 for (let i = 2; i <= 4000000000; i++) 建 expected 集合
  assert.ok(ms < 3000, 'verify 花了 ' + ms + 'ms —— 连续性检查又开始展开编号区间了');

  const flagged = result.results.filter((r) => r.category === 'implausible-id');
  assert.strictEqual(flagged.length, 1, JSON.stringify(result.results.map((r) => r.category)));
  assert.ok(/T4000000000/.test(flagged[0].message), flagged[0].message);
  assert.ok(flagged[0].message.includes('log.md'), flagged[0].message);

  // 内容不丢：伪造块照样能被搜到
  assert.ok(query.search(pocketDir, '伪造').length >= 1, '畸形编号的块不能消失');

  // 下一轮编号只由可信的 latestT 决定
  assert.strictEqual(record(pocketDir, 'real turn 3').tId, 3,
    '天文数字不能驱动下一次编号分配');
});

test('an unrecognised section name is reported, not merged into the previous section', () => {
  const { pocketDir } = makePocket('badsection');
  record(pocketDir, 'normal turn');
  fs.appendFileSync(path.join(pocketDir, 'log.md'),
    '\n## T2 · 节名写错的一轮\n### User\n- 用户原话\n### 行动\n- 这一节的文字不该算进 User\n');

  const block = parser.parseLog(pocketDir).blocks.find((b) => b.id === 2);
  assert.deepStrictEqual(block.sections.User, ['用户原话'],
    '认不出的节名底下的内容不能并进上一节');
  assert.deepStrictEqual(block.unknownSections, ['行动']);

  const result = verify(pocketDir);
  const flagged = result.results.filter((r) => /unrecognised section/.test(r.message || ''));
  assert.strictEqual(flagged.length, 1, JSON.stringify(result.results.map((r) => r.message)));
  assert.ok(flagged[0].fix.includes('### User'), '修复建议要列出合法节名');
});

test('verify reports an attachment whose file is not on disk — and only that one', () => {
  const { pocketDir } = makePocket('attach-missing');

  // 出生状态：模板那一行全是占位符，一条都不能报（报了就是每个新 pocket 一出生带 error）
  assert.strictEqual(verify(pocketDir).results.filter((r) => r.category === 'attachment-existence')
    .filter((r) => r.severity === 'error').length, 0, '空模板不该产出附件 error');

  record(pocketDir, '画了结构图', { attachments: ['T1 diagram: assets/T01-diagram.png — 初始结构图'] });

  const hit = verify(pocketDir).results.filter((r) => r.category === 'attachment-existence');
  assert.strictEqual(hit.length, 1, JSON.stringify(hit));
  assert.strictEqual(hit[0].severity, 'error', '断链要拦住 pre-commit，不能只是提示');
  assert.ok(/T1/.test(hit[0].message) && hit[0].message.includes('assets/T01-diagram.png'), hit[0].message);
  // 修法必须是可跑的：写回规范里的 [missing: …] 形态 + 重跑 verify 的命令
  assert.ok(hit[0].fix.includes('[missing: T1 assets/T01-diagram.png]'), hit[0].fix);
  assert.ok(/context-pocket verify/.test(hit[0].fix), hit[0].fix);
  assert.ok(hit[0].fix.includes('ContextPocket/assets/T01-diagram.png'), '要说清找过哪些位置：' + hit[0].fix);

  // 文件真的放进去 → error 消失，换一条 info 说明查过
  fs.writeFileSync(path.join(pocketDir, 'assets', 'T01-diagram.png'), 'fake png');
  const after = verify(pocketDir).results.filter((r) => r.category === 'attachment-existence');
  assert.strictEqual(after.filter((r) => r.severity === 'error').length, 0, JSON.stringify(after));
  assert.ok(after.some((r) => r.severity === 'info' && /found on disk/.test(r.message)), JSON.stringify(after));

  // 按规范标了 missing 的那一条是"这件事被记下来了"的样子，不再报
  record(pocketDir, '图丢了', {
    attachments: ['T2 gone: assets/T02-gone.png [missing: T2 assets/T02-gone.png]'],
  });
  const marked = verify(pocketDir).results.filter((r) => r.category === 'attachment-existence'
    && r.severity === 'error');
  assert.strictEqual(marked.length, 0, JSON.stringify(marked));

  // 归档里的块也扫：块搬进 log-archive.md 之后附件仍然该在 assets/ 下
  fs.appendFileSync(path.join(pocketDir, 'log-archive.md'),
    '\n## T09 · 归档的一轮 · [测试]\n### User\n- 原话\n### Attachments\n- T9 chart: assets/T09-chart.png\n');
  const archived = verify(pocketDir).results.filter((r) => r.category === 'attachment-existence'
    && r.severity === 'error');
  assert.strictEqual(archived.length, 1, JSON.stringify(archived));
  assert.ok(archived[0].message.includes('log-archive.md'), archived[0].message);
  assert.ok(/T9/.test(archived[0].message), archived[0].message);

  // markdown 图片写法：链接目标是路径，alt 文本不是
  record(pocketDir, '截图', {
    attachments: ['![T3 ui](assets/T03-ui.png) — 界面截图，另有 https://cdn.example.com/T03-ui.png 备份'],
  });
  const img = verify(pocketDir).results.filter((r) => r.category === 'attachment-existence'
    && r.severity === 'error');
  assert.strictEqual(img.length, 2, JSON.stringify(img.map((r) => r.message)));
  assert.ok(img.some((r) => r.message.includes('assets/T03-ui.png')), JSON.stringify(img.map((r) => r.message)));
  assert.ok(!img.some((r) => /cdn|example/.test(r.message)), 'URL 不是本地附件');

  // 项目根相对写法（`ContextPocket/assets/...`）也能对上，别报假 error
  record(pocketDir, '路径写全', { attachments: ['T4 map: ContextPocket/assets/T01-diagram.png'] });
  assert.strictEqual(verify(pocketDir).results.filter((r) => r.category === 'attachment-existence'
    && r.severity === 'error' && /T4/.test(r.message)).length, 0, '相对项目根的路径要能解析');
});

test('the scan fallback searches the same sources as the index', () => {
  const { pocketDir } = makePocket('scan-parity');
  record(pocketDir, '接入 redis 做会话缓存', { tags: ['redis'] });
  writer.addDecision(pocketDir, {
    title: '会话缓存用 redis',
    context: '进程内 map 重启即丢',
    options: 'redis / memcached',
    decision: 'redis 单实例，密码走环境变量的红线',
    consequences: '多一次网络往返',
  });
  writer.addRequirement(pocketDir, { text: '会话状态放进 redis' });
  writer.updatePreferences(pocketDir, { key: 'cache', value: 'redis 优先' });
  buildIndex(pocketDir, { rebuild: true });

  const indexed = searchWithIndex(pocketDir, 'redis') || [];
  const scanned = query.search(pocketDir, 'redis');

  const kinds = (rows) => [...new Set(rows.map((r) => r.type))].sort().join(',');
  assert.ok(['ADR', 'R', 'T', 'pref'].every((k) => kinds(indexed).includes(k)),
    '索引路径应覆盖四种来源，实际 ' + kinds(indexed));
  assert.strictEqual(kinds(scanned), kinds(indexed),
    '回退路径必须覆盖同一批真相源，否则"索引缺失"会静默删掉一段历史');

  // 顺序也同一份实现：分页（limit/offset）是在这个序列上切片，
  // 两条路径顺序不同就会翻出重条或漏条
  const rowKey = (r) => (r.type === 'T' ? 'T' + r.id
    : r.type === 'ADR' ? 'ADR' + r.adrId
      : r.type === 'R' ? 'R' + r.rId
        : 'pref:' + r.line);
  assert.deepStrictEqual(indexed.map(rowKey), scanned.map(rowKey),
    '两条路径的命中序列必须完全相同');

  // 两条路径的结果对象同一份 schema：消费方（CLI --json / MCP）无需分支
  for (const r of scanned) {
    assert.ok(r.type, '每条命中都要有 type');
    assert.ok(Array.isArray(r.highlights) && r.highlights.length > 0, JSON.stringify(r));
    assert.ok(typeof r.matchCount === 'number', JSON.stringify(r));
  }
  const t = scanned.find((r) => r.type === 'T');
  assert.ok(t.archived === false && typeof t.gist === 'string', JSON.stringify(t));
  assert.ok(scanned.find((r) => r.type === 'R').status, 'R 命中要带状态');
  assert.ok(scanned.find((r) => r.type === 'ADR').title, 'ADR 命中要带标题');

  // tags 也是索引覆盖的字段，扫描路径不能漏
  const tagOnly = query.search(pocketDir, '会话缓存用');
  assert.ok(tagOnly.some((r) => r.type === 'ADR'), JSON.stringify(tagOnly));
});

test('index refresh re-tokenizes only the documents that changed', () => {
  const { pocketDir } = makePocket('inc-index');
  for (let i = 1; i <= 6; i++) record(pocketDir, 'incremental turn ' + i);

  const full = buildIndex(pocketDir, { rebuild: true });
  assert.strictEqual(full.rebuilt, true);
  assert.strictEqual(full.retokenized, full.docsCount, '全量重建当然每一篇都分词');

  // 一篇都没变：不该把整个索引文件重写一遍（builtAt 保持原样即证明没写）
  const builtAt = loadIndex(pocketDir).builtAt;
  const noop = buildIndex(pocketDir, {});
  assert.strictEqual(noop.unchanged, true, JSON.stringify(noop));
  assert.strictEqual(noop.retokenized, 0);
  assert.strictEqual(loadIndex(pocketDir).builtAt, builtAt, '没变化就不该重写索引文件');

  // 追加一轮：只有这一篇需要分词，其余全部复用
  record(pocketDir, 'incremental turn 7');
  const one = buildIndex(pocketDir, {});
  assert.strictEqual(one.added, 1);
  assert.strictEqual(one.updated, 0);
  assert.strictEqual(one.removed, 0);
  assert.strictEqual(one.retokenized, 1, '一次 append 不该为整库重新分词');

  // 归档：5 篇从 log.md 挪到 log-archive.md，变的只有这 5 篇
  const beforeArchive = parser.parseLog(pocketDir);
  writer.archiveLog(pocketDir, { keepLast: 2, dryRun: false });
  const moved = buildIndex(pocketDir, {});
  assert.strictEqual(moved.retokenized, 5, '归档只动了 5 篇，就只该重分词这 5 篇');
  assert.strictEqual(moved.reused, 2, '留在 log.md 的两篇不该被重算');
  assert.strictEqual(moved.removed, 0, '归档是搬家，不是删除');
  assert.strictEqual(moved.docsCount, one.docsCount, 'docs 总数不该因为归档而变少');

  // 同一天只有一条 SESSION 分隔线；它若跟着归档块走了，保留块就静默丢了日期
  const afterArchive = parser.parseLogAll(pocketDir);
  assert.strictEqual(afterArchive.blocks.length, beforeArchive.blocks.length, '归档不该让任何一轮查不到');
  for (const b of afterArchive.blocks) {
    assert.ok(b.session, `T${b.id} 归档后仍然要知道自己属于哪天：` + JSON.stringify(b.session));
  }

  // 增量刷新的结果必须与全量重建等价
  const hits = searchWithIndex(pocketDir, 'incremental');
  assert.strictEqual(hits.filter((r) => r.type === 'T').length, 7, '增量刷新后命中仍要完整');
  assert.strictEqual(hits.filter((r) => r.archived).length, 5, 'archived 标记要跟上新位置');
  const rebuilt = buildIndex(pocketDir, { rebuild: true });
  assert.strictEqual(rebuilt.termsCount, moved.termsCount, '增量 postings 与全量 postings 的词元集应一致');
});

test('a resident process reuses the parsed index only while the sources are unchanged', () => {
  const { pocketDir } = makePocket('memo');
  resetIndexMemo();
  for (let i = 1; i <= 4; i++) record(pocketDir, 'cached turn ' + i);
  buildIndex(pocketDir, { rebuild: true });

  const first = searchWithIndex(pocketDir, 'cached');
  assert.strictEqual(first.filter((r) => r.type === 'T').length, 4);

  // 索引文件从磁盘上消失：命中缓存就不可能去读盘，也不可能顺手重建文件。
  // 这一条是"缓存真的生效"的机械证据 —— 只比结果字符串永远证明不了这点。
  fs.unlinkSync(indexPath(pocketDir));
  const second = searchWithIndex(pocketDir, 'cached');
  assert.ok(!fs.existsSync(indexPath(pocketDir)), '命中进程内缓存时绝不读盘、绝不重建');
  assert.deepStrictEqual(second, first, '同一批源文件必须给出完全一致的结果与顺序');

  // 但内容一变，缓存立刻作废：新写的那一轮必须查得到
  const fresh = record(pocketDir, 'cached turn 5 新写入');
  const third = searchWithIndex(pocketDir, '新写入');
  assert.strictEqual(third.filter((r) => r.id === fresh.tId).length, 1, '绝不能把新记录留在缓存外面');
  assert.strictEqual(searchWithIndex(pocketDir, 'cached').filter((r) => r.type === 'T').length, 5);
  assert.ok(fs.existsSync(indexPath(pocketDir)), '失效重建后索引文件要回到磁盘上');

  resetIndexMemo(pocketDir);
  assert.strictEqual(searchWithIndex(pocketDir, 'cached').filter((r) => r.type === 'T').length, 5,
    '手动清缓存后从盘上读也必须拿到同一批结果');
});

test('the index memo is per pocket and bounded, never shared across projects', () => {
  resetIndexMemo();
  const a = makePocket('memo-a');
  record(a.pocketDir, '只属于项目 A 的关键词 zzzalpha');
  buildIndex(a.pocketDir, { rebuild: true });

  const b = makePocket('memo-b');
  record(b.pocketDir, '只属于项目 B 的关键词 zzzbravo');
  buildIndex(b.pocketDir, { rebuild: true });

  // 交错查两个项目：缓存按 pocketDir 分键，绝不能把 A 的结果给 B
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(searchWithIndex(a.pocketDir, 'zzzalpha').length, 1, '第 ' + i + ' 次查 A');
    assert.strictEqual(searchWithIndex(b.pocketDir, 'zzzbravo').length, 1, '第 ' + i + ' 次查 B');
    assert.strictEqual(searchWithIndex(a.pocketDir, 'zzzbravo').length, 0, 'A 里绝不该出现 B 的记录');
  }

  // 超过容量上限时按插入顺序淘汰，被淘汰的项目重新读盘即可，结果不变
  const extra = [];
  for (let i = 0; i < 10; i++) {
    const p = makePocket('memo-extra-' + i);
    record(p.pocketDir, '淘汰测试 ' + i);
    buildIndex(p.pocketDir, { rebuild: true });
    extra.push(p.pocketDir);
  }
  assert.strictEqual(searchWithIndex(extra[0], '淘汰测试').length, 1, '被挤出缓存后要能从盘上重读');
  assert.strictEqual(searchWithIndex(a.pocketDir, 'zzzalpha').length, 1);
  assert.ok(resetIndexMemo() === 0, 'resetIndexMemo() 应该清空全部');
});

test('verify --drift catches code modified after the last record, with no git involved', () => {
  const { projectDir, pocketDir } = makePocket('codenewer');
  const logPath = path.join(pocketDir, 'log.md');

  // 这一条检查存在的意义就是"非 git 项目也能查出漏记"：sync 靠 git diff，在这里直接跳过
  assert.ok(!fs.existsSync(path.join(projectDir, '.git')), '样本项目必须没有 .git');

  record(pocketDir, '刚记完一轮');
  const recordedAt = fs.statSync(logPath).mtimeMs;

  const clean = verify(pocketDir, { drift: true }).results.filter((r) => r.category === 'code-newer-than-log');
  assert.strictEqual(clean.length, 1, '启用 drift 后必须有这一项');
  assert.strictEqual(clean[0].severity, 'info', '刚写完记录就 verify 不该报警：' + JSON.stringify(clean[0]));

  // 默认（不带 --drift）绝不扫目录
  assert.strictEqual(
    verify(pocketDir).results.some((r) => r.category === 'code-newer-than-log'),
    false, '目录扫描是显式开销，不该在默认路径里跑'
  );

  // 记完之后又改了代码 → 必须报 WARNING（不是 error，不能拦提交）
  fs.mkdirSync(path.join(projectDir, 'src'));
  fs.writeFileSync(path.join(projectDir, 'src', 'late.js'), '// 漏记的一处改动\n', 'utf-8');
  setMtime(path.join(projectDir, 'src', 'late.js'), recordedAt + 5 * 60 * 1000);

  const flagged = verify(pocketDir, { drift: true }).results.filter((r) => r.category === 'code-newer-than-log');
  assert.strictEqual(flagged[0].severity, 'warning', JSON.stringify(flagged[0]));
  assert.ok(flagged[0].details.includes('src/late.js'), JSON.stringify(flagged[0]));
  assert.match(flagged[0].message, /5 min/, '要给出滞后多久：' + flagged[0].message);
  assert.match(flagged[0].fix, /sync --auto/, 'fix 必须能直接照着做：' + flagged[0].fix);
  assert.strictEqual(verify(pocketDir, { drift: true }).errorCount, 0, '漏记提示绝不能升级成 error 去拦提交');

  // pocket 自己的文件与 node_modules 都不算"代码"
  setMtime(logPath, recordedAt + 20 * 60 * 1000);
  writePocketFile(pocketDir, 'requirements.md', '# Requirements\n\n- R1 · 补记一条需求（晚于代码）\n');
  setMtime(path.join(pocketDir, 'requirements.md'), recordedAt + 30 * 60 * 1000);
  fs.mkdirSync(path.join(projectDir, 'node_modules'));
  fs.writeFileSync(path.join(projectDir, 'node_modules', 'dep.js'), '// 依赖不该被当成漏记\n', 'utf-8');
  setMtime(path.join(projectDir, 'node_modules', 'dep.js'), recordedAt + 40 * 60 * 1000);

  const after = verify(pocketDir, { drift: true }).results.filter((r) => r.category === 'code-newer-than-log');
  assert.strictEqual(after[0].severity, 'info', '补记之后警报要解除，且 pocket 内部文件与依赖不算代码：' + JSON.stringify(after[0]));
});

test('verify --drift treats a wholesale timestamp refresh as clone/checkout, not as a missed log', () => {
  const { projectDir, pocketDir } = makePocket('codenewer-all');
  const logPath = path.join(pocketDir, 'log.md');
  record(pocketDir, '一条记录');
  const recordedAt = fs.statSync(logPath).mtimeMs;

  // 25 个文件全部晚于记录（且 >90% 的工作树）：这是 checkout / 复制进来的项目的形状
  for (let i = 0; i < 25; i++) {
    const f = path.join(projectDir, 'mod' + i + '.js');
    fs.writeFileSync(f, '// ' + i + '\n', 'utf-8');
    setMtime(f, recordedAt + 60 * 1000);
  }

  const hit = verify(pocketDir, { drift: true }).results.find((r) => r.category === 'code-newer-than-log');
  assert.strictEqual(hit.severity, 'info', JSON.stringify(hit));
  assert.match(hit.message, /clone\/checkout/, JSON.stringify(hit));

  // 反过来：只有少数几个文件比记录新，就该是 warning
  for (let i = 0; i < 20; i++) {
    fs.rmSync(path.join(projectDir, 'mod' + i + '.js'), { force: true });
  }
  const warn = verify(pocketDir, { drift: true }).results.find((r) => r.category === 'code-newer-than-log');
  assert.strictEqual(warn.severity, 'warning', JSON.stringify(warn));
});

test('verify --drift names the files in human output, not just a count', () => {
  const { projectDir, pocketDir } = makePocket('drift-text');
  const logPath = path.join(pocketDir, 'log.md');
  record(pocketDir, '一条记录');
  const recordedAt = fs.statSync(logPath).mtimeMs;

  for (const name of ['loose-a.js', 'loose-b.js']) {
    fs.writeFileSync(path.join(projectDir, name), '// ' + name + '\n', 'utf-8');
    setMtime(path.join(projectDir, name), recordedAt + 60 * 1000);
  }

  const result = verify(pocketDir, { drift: true });
  const text = formatVerifyResult(result);
  assert.ok(text.includes('loose-a.js') && text.includes('loose-b.js'),
    '人读的输出必须点名是哪几个文件：\n' + text);

  const quietText = formatVerifyResult(result, { quiet: true });
  assert.ok(quietText.includes('loose-a.js'), 'quiet 模式同样要能照着做：\n' + quietText);
});

test('archiving leaves the SESSION marker in front of the blocks it describes', () => {
  const { pocketDir } = makePocket('archive-session');
  record(pocketDir, 'session carry turn 1');
  record(pocketDir, 'session carry turn 2');

  // append 只会写"今天"的分隔线，跨天的历史得手工造：把第二天的标记插到 T2 前面
  const raw = readPocketFile(pocketDir, 'log.md');
  const cut = raw.indexOf('## T2 ·');
  assert.ok(cut > 0, '测试前提：T2 要在 log.md 里\n' + raw);
  writePocketFile(pocketDir, 'log.md', raw.slice(0, cut) + '--- SESSION: 2026-11-11 ---\n\n' + raw.slice(cut));

  writer.archiveLog(pocketDir, { keepLast: 1, dryRun: false });

  const live = parser.parseLog(pocketDir);
  assert.strictEqual(live.blocks.length, 1);
  // 归档切在 `## T2` 那一行的话，这行标记就被搬进归档文件，log.md 里的 T2 从此不知道自己是哪天
  assert.strictEqual(live.blocks[0].session, '2026-11-11', '保留块的 session 必须留在 log.md 里');

  const all = parser.parseLogAll(pocketDir);
  assert.strictEqual(all.blocks.length, 2, '归档后总量仍是 2 轮，一条都不能丢');
  assert.ok(all.blocks.some((b) => b.gist === 'session carry turn 1'), 'T1 应进了归档文件');
});

test('why finds a file reference in any section, not just the historically listed ones', () => {
  const { pocketDir } = makePocket('why-sections');
  record(pocketDir, 'why section coverage turn', {
    attachments: ['shots/diagram.png'],
    conflicts: ['lib/legacy.js 与新实现的口径不一致'],
    uncertain: ['要不要一起改 server/store.js'],
  });

  for (const [needle, section] of [
    ['diagram.png', 'Attachments'],
    ['lib/legacy.js', 'Conflicts'],
    ['server/store.js', 'Uncertain'],
  ]) {
    const hits = query.why(pocketDir, needle);
    assert.strictEqual(hits.length, 1, `为什么找不到 ${needle}（写在 ${section} 里）`);
    assert.strictEqual(hits[0].references[0].section, section);
  }

  // 反斜杠路径也要能命中 Windows 下写的正斜杠引用
  assert.strictEqual(query.why(pocketDir, 'shots\\diagram.png').length, 1);
});

test('why labels the turns that changed a file apart from the ones that only mention it', () => {
  const { pocketDir } = makePocket('why-evidence');

  // 早的一轮：Action 里真的改了 lib/parser.js
  const changed = record(pocketDir, 'why evidence changed turn', {
    action: ['修改 lib/parser.js — 把路径解析抽出来'],
  });
  // 晚的一轮：lib/parser.js 只出现在 Uncertain 里（不分层的话它会抢答在前面）
  const later = record(pocketDir, 'why evidence mention turn', {
    action: ['修改 lib/query.js — 与本次无关的活'],
    uncertain: ['lib/parser.js 里那条正则要不要一起改'],
  });

  const hits = query.why(pocketDir, 'lib/parser.js');
  assert.strictEqual(hits.length, 2, JSON.stringify(hits));
  assert.strictEqual(hits[0].id, changed.tId, '改过它的那轮要排在只提到它的那轮前面');
  assert.strictEqual(hits[0].evidence, 'changed');
  assert.strictEqual(hits[0].references[0].section, 'Action');
  assert.strictEqual(hits[1].id, later.tId, '弱证据的轮次仍在结果里，不能因为分级就查不到');
  assert.strictEqual(hits[1].evidence, 'mentioned');
  assert.strictEqual(hits[1].references[0].section, 'Uncertain');

  // 截断先掉弱证据：limit=1 时留下的必须是真正改了它的那一轮
  const one = query.why(pocketDir, 'lib/parser.js', { limit: 1 });
  assert.strictEqual(one.length, 1);
  assert.strictEqual(one[0].id, changed.tId, JSON.stringify(one));

  // 只有弱证据的查询也要查得到，并如实标成 mentioned
  const weakOnly = record(pocketDir, 'why evidence weak only', {
    action: ['修改 lib/query.js — 与本次无关的活'],
    attachments: ['shots/diagram.png'],
  });
  const weak = query.why(pocketDir, 'diagram.png');
  assert.strictEqual(weak.length, 1, JSON.stringify(weak));
  assert.strictEqual(weak[0].id, weakOnly.tId);
  assert.strictEqual(weak[0].evidence, 'mentioned');
  for (const hit of query.why(pocketDir, 'lib/query.js')) {
    assert.strictEqual(hit.evidence, 'changed', '写进 Action 的路径不该被降级：' + JSON.stringify(hit));
  }
});

test('parseLog keeps Action paths as strong evidence and other sections as mentions', () => {
  const { pocketDir } = makePocket('mentions-split');
  record(pocketDir, 'mention split turn', {
    action: ['修改 lib/a.js — 顺带确认 lib/b.js 不受影响'],
    attachments: ['shots/diagram.png'],
    uncertain: ['要不要一起改 lib/c.js'],
  });

  const block = parser.parseLog(pocketDir).blocks.slice(-1)[0];
  const strong = [].concat(...block.actions.map((a) => a.files));
  // Action 整行都是强证据：自然语言写法的两个路径都不该被漏掉（否则每次提交多一个 [auto] 块）
  assert.ok(strong.includes('lib/a.js') && strong.includes('lib/b.js'), JSON.stringify(strong));

  const weak = block.mentions.map((m) => m.path + '@' + m.section);
  assert.ok(weak.includes('shots/diagram.png@Attachments'), JSON.stringify(weak));
  assert.ok(weak.includes('lib/c.js@Uncertain'), JSON.stringify(weak));
  assert.ok(!weak.some((w) => w.startsWith('lib/a.js@')), 'Action 的路径不该再进弱证据');
  assert.ok(!weak.some((w) => w.endsWith('@Action')), '弱证据绝不该包含 Action 小节');
});

// 真实的 git 仓库才能测 sync；缺 git 时跳过并说明，不把跳过算成通过
const HAS_GIT = (() => {
  try { return spawnSync('git', ['--version']).status === 0; } catch (e) { return false; }
})();

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
  assert.strictEqual(r.status, 0, 'git ' + args.join(' ') + ' 失败：' + (r.stderr || r.stdout));
  return r.stdout;
}

test('sync counts only Action paths as coverage, and names the section that merely mentioned the file', () => {
  if (!HAS_GIT) { console.log('  (skipped: needs git)'); return; }
  const projectDir = tmpProject('sync-evidence');
  for (const rel of ['lib/a.js', 'lib/c.js', 'lib/d.js']) {
    fs.mkdirSync(path.join(projectDir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(projectDir, rel), '// ' + rel + '\n');
  }
  git(projectDir, ['init', '-q']);
  const { bootstrap } = require(path.join(ROOT, 'lib', 'bootstrap'));
  const pocketDir = bootstrap(projectDir).pocketDir;
  git(projectDir, ['add', '-A']);

  record(pocketDir, 'sync evidence turn', {
    action: ['修改 lib/a.js — 只有它进了 Action'],
    uncertain: ['lib/c.js 可能也要跟着改'],
  });

  const det = detectUnrecorded(pocketDir);
  assert.strictEqual(det.isGit, true);
  assert.ok(det.covered.includes('lib/a.js'), JSON.stringify(det.covered));

  const libUnrecorded = det.unrecorded.filter((c) => c.path.startsWith('lib/'));
  assert.deepStrictEqual(libUnrecorded.map((c) => c.path), ['lib/c.js', 'lib/d.js'],
    '只被 Uncertain 提到的文件仍然算漏记：' + JSON.stringify(libUnrecorded));
  assert.deepStrictEqual(det.mentionedOnly, ['lib/c.js'], JSON.stringify(det.mentionedOnly));
  const c = libUnrecorded.find((x) => x.path === 'lib/c.js');
  assert.strictEqual(c.mentionedIn[0].section, 'Uncertain', JSON.stringify(c.mentionedIn));
  assert.strictEqual(typeof c.mentionedIn[0].tId, 'number');
  assert.ok(!libUnrecorded.find((x) => x.path === 'lib/d.js').mentionedIn, '完全没提过的文件不该有弱证据');

  // 补录后必须幂等，且补录块自己说清"这个文件此前只被提到过"
  const filled = syncPocket(pocketDir, { auto: true });
  assert.strictEqual(filled.filled, true, JSON.stringify(filled));
  const block = parser.parseLog(pocketDir).blocks.slice(-1)[0];
  assert.deepStrictEqual(block.tags, ['auto']);
  assert.ok(block.sections.Action.some((l) => l.includes('lib/c.js') && /只出现在|only mentioned/.test(l)),
    JSON.stringify(block.sections.Action));
  assert.strictEqual(detectUnrecorded(pocketDir).clean, true, '补录之后不该再报同一个文件');
});

test('verify blames the broken index.md header, not the mismatch it produces', () => {
  const { pocketDir } = makePocket('bad-index-header');
  record(pocketDir, 'index header turn');

  const raw = readPocketFile(pocketDir, 'index.md');
  const patched = raw.replace(/^#\s+Index[^\n]*/m, '# Index · T99999999999 · 2026-01-01');
  assert.notStrictEqual(patched, raw, '测试前提：index.md 要有标题行\n' + raw);
  writePocketFile(pocketDir, 'index.md', patched);

  const result = verify(pocketDir);
  const flagged = result.results.filter((r) => /malformed T number/.test(r.message || ''));
  assert.strictEqual(flagged.length, 1, JSON.stringify(result.results.map((r) => r.message)));
  assert.strictEqual(flagged[0].severity, 'error');
  assert.ok(/#\s*Index · T\d+/.test(flagged[0].fix), '修复建议要给出正确的标题行：' + flagged[0].fix);
  // 派生出来的"index 说 T0"不该再报一遍，否则真正的原因被噪音盖住
  assert.ok(!result.results.some((r) => /index.md says latest is T0/.test(r.message || '')),
    JSON.stringify(result.results.map((r) => r.message)));
});

test('archiving reads recent_keep from config.md instead of a hardcoded number', () => {
  const { pocketDir } = makePocket('keep-from-config');
  writePocketFile(pocketDir, 'config.md', '# Config\n\n- recent_keep: 3\n');
  for (let i = 1; i <= 8; i++) record(pocketDir, 'kept turn ' + i);

  const result = writer.archiveLog(pocketDir, { dryRun: false });
  assert.strictEqual(result.archivedCount, 5, 'recent_keep 3 → 归档 8-3=5 轮：' + JSON.stringify(result));
  assert.strictEqual(parser.parseLog(pocketDir).blocks.length, 3);

  // 显式参数优先于配置
  const again = writer.archiveLog(pocketDir, { keepLast: 2, dryRun: false });
  assert.strictEqual(again.archivedCount, 1, '显式 --keep-last 必须压过 recent_keep');

  // 没有写 recent_keep 时按 DEFAULT_CONFIG 的 30，而不是过去那个没人知道的 20
  const plain = makePocket('keep-default');
  for (let i = 1; i <= 32; i++) record(plain.pocketDir, 'default turn ' + i);
  writePocketFile(plain.pocketDir, 'config.md', '# Config\n\n- mode: full\n');
  const dflt = writer.archiveLog(plain.pocketDir, { dryRun: false });
  assert.strictEqual(dflt.archivedCount, 2, '缺省应保留 30 轮：' + JSON.stringify(dflt));

  // 0 / 负数 / 非数字会算出"保留 undefined 轮"并在取 blocksToKeep[0] 时崩掉，必须当场拒绝
  assert.throws(() => writer.archiveLog(pocketDir, { keepLast: 0, dryRun: false }), /positive integer/);
});

test('archive_at is reported instead of being a config key nobody reads', () => {
  const { pocketDir } = makePocket('archive-at');
  for (let i = 1; i <= 3; i++) record(pocketDir, 'sized turn ' + i);

  // 阈值还远：不该出现 log-size 条目
  assert.ok(!verify(pocketDir).results.some((r) => r.category === 'log-size'),
    '未超阈值时不该报警');

  writePocketFile(pocketDir, 'config.md', '# Config\n\n- archive_at: 10\n');
  const over = verify(pocketDir).results.filter((r) => r.category === 'log-size');
  assert.strictEqual(over.length, 1, JSON.stringify(over));
  assert.strictEqual(over[0].severity, 'warning');
  assert.ok(/archive/.test(over[0].fix || ''), '要给出可直接执行的归档命令：' + over[0].fix);

  // 行数得真的数出来（log.md 有内容，且末尾换行不多算一行）
  const written = readPocketFile(pocketDir, 'log.md');
  assert.strictEqual(parser.parseLog(pocketDir).lineCount, written.split('\n').length - 1);

  // 配置写坏了要说清楚是配置坏了，而不是"永远不触发"
  writePocketFile(pocketDir, 'config.md', '# Config\n\n- archive_at: 800 lines\n');
  const broken = verify(pocketDir).results.filter((r) => r.category === 'log-size');
  assert.strictEqual(broken.length, 1);
  assert.ok(/not a usable line count/.test(broken[0].message), JSON.stringify(broken[0]));
});

test('distill only scans turns older than the recent_keep window', () => {
  const { pocketDir } = makePocket('distill-window');
  for (let i = 1; i <= 6; i++) record(pocketDir, 'distill turn ' + i);

  // 全新 pocket：30 轮以内都算"新"，没东西可蒸馏
  assert.strictEqual(distill(pocketDir, { dryRun: true }).nothing, true);

  // recentKeep 0 → 窗口为空，全部 6 轮都是候选（0 必须是合法值，不能被当成"没传"）
  const all = distill(pocketDir, { dryRun: true, recentKeep: 0 });
  assert.strictEqual(all.scannedBlocks, 6, JSON.stringify(all.tRange));

  const win = distill(pocketDir, { dryRun: true, recentKeep: 4 });
  assert.strictEqual(win.scannedBlocks, 2, 'recentKeep 4 → 只看 T1-T2：' + JSON.stringify(win.tRange));
  assert.deepStrictEqual(win.tRange, { min: 1, max: 2 });

  // 不传参数时读 config.md 的 recent_keep
  writePocketFile(pocketDir, 'config.md', '# Config\n\n- mode: full\n- recent_keep: 5\n');
  assert.strictEqual(distill(pocketDir, { dryRun: true }).scannedBlocks, 1);

  // 蒸馏只写报告，绝不动活文档
  const before = readPocketFile(pocketDir, 'decisions.md');
  distill(pocketDir, { recentKeep: 4 });
  assert.strictEqual(readPocketFile(pocketDir, 'decisions.md'), before, 'distill 不得改写 decisions.md');
  assert.ok(fs.existsSync(path.join(pocketDir, fs.readdirSync(pocketDir).find((f) => /^digest-.*\.md$/.test(f)))),
    '应当生成 digest-<date>.md');
});

test('distill coverage check scores each existing entry on its own', () => {
  const { pocketDir } = makePocket('distill-cover');
  const split = '拆分提交策略、归档窗口、回滚顺序';
  const covered = '消息队列选型、幂等重试策略、死信处理';
  record(pocketDir, 'distill source', { decisions: [split, covered] });

  // 分散在两条 ADR 里、每条只命中三分之一的关键词，不构成"已覆盖"；
  // 旧实现跨条目累加命中数，攒够一半就误判，报告会从此不再提任何新东西。
  writer.addDecision(pocketDir, { title: '拆分提交策略', context: 'c', decision: 'd', consequences: 'e' });
  writer.addDecision(pocketDir, { title: '归档窗口', context: 'c', decision: 'd', consequences: 'e' });
  writer.addDecision(pocketDir, { title: '消息队列选型、幂等重试策略与死信处理的约定', context: 'c', decision: 'd', consequences: 'e' });

  const result = distill(pocketDir, { dryRun: true, recentKeep: 0 });
  const byText = {};
  for (const item of result.candidates.decisions) byText[item.text] = item;
  assert.ok(byText[split] && byText[covered], '两条候选都要被扫到：' + JSON.stringify(result.candidates.decisions));
  assert.strictEqual(byText[split].coveredBy, null, '关键词分散在两条 ADR 上不算已覆盖');
  assert.ok(byText[covered].coveredBy, '被单条 ADR 完整提到的候选必须标出"可能已覆盖"');
});

// ------------------------------------------------------------
// verify 的密钥 / PII 闸门（lib/secrets.js）
//
// pocket 是会 `git add` 进仓库的明文目录，Agent 又会把工具输出抄进下一条
// T-block，所以"报错原文里带 key"是最容易沉进历史的输入。这里锁四件事：
// 凭证形状 = error（能拦下 pre-commit），PII = warning（永远不拦），
// 报告里绝不回显完整密钥，config.md 能整块关掉。
// ------------------------------------------------------------

const PASTED_KEY = 'sk-ant-abcdefghijklmnopqrstuvwxyz1234';

test('a credential pasted into a turn is an error naming the file and line', () => {
  const { pocketDir } = makePocket('secret-gate');
  record(pocketDir, '排查报错', {
    user: ['报错原文：401 using ' + PASTED_KEY + ' 调用失败'],
  });

  const result = verify(pocketDir);
  const leak = result.results.filter((r) => r.category === 'secret-leak');
  const error = leak.find((r) => r.severity === 'error');
  assert.ok(error, '凭证必须报成 error：' + JSON.stringify(leak));
  assert.ok(error.details[0].startsWith('log.md:'), error.details.join('\n'));
  assert.ok(/Anthropic API key/.test(error.details[0]), error.details[0]);

  // 定位到行：报错那一行确实是 log.md 的第 9 行（模板头 + session + 标题 + 小节）
  const line = Number(error.details[0].match(/^log\.md:(\d+)/)[1]);
  const logLines = readPocketFile(pocketDir, 'log.md').split('\n');
  assert.ok(logLines[line - 1].includes('报错原文'), '行号要指到真正那一行，取到的是：' + logLines[line - 1]);

  // 工具输出会被 Agent 抄进下一条记录：结果里只能有掩码
  const report = formatVerifyResult(result);
  assert.ok(!report.includes(PASTED_KEY), 'verify 输出绝不能带完整密钥');
  assert.ok(!report.includes(PASTED_KEY.slice(10)), '也不带尾部熵段');

  // error 会经 `verify --quiet` 让 pre-commit 退 1，这正是想要的闸门
  assert.ok(result.errorCount >= 1, 'errorCount 要计入这条，否则拦不住提交');
});

test('personal data is a warning and can never block a commit', () => {
  const { pocketDir } = makePocket('pii-warning');
  record(pocketDir, '回访客户', {
    user: ['客户手机 13800138000 说登录不上了'],
  });

  const result = verify(pocketDir);
  assert.strictEqual(result.errorCount, 0, 'PII 只是提示，不能把提交拦死：' + JSON.stringify(result.results.filter((r) => r.severity === 'error')));
  const warn = result.results.find((r) => r.category === 'secret-leak' && r.severity === 'warning');
  assert.ok(warn, '手机号还是要报出来');
  assert.ok(/CN mobile number/.test(warn.details.join('\n')), warn.details.join('\n'));
  assert.ok(!formatVerifyResult(result).includes('13800138000'), 'PII 同样只出掩码');
});

test('config.md can switch the secret scan off', () => {
  const { pocketDir } = makePocket('secret-off');
  record(pocketDir, '轮换手册', { user: ['手册示例 ' + PASTED_KEY] });
  assert.ok(verify(pocketDir).results.some((r) => r.category === 'secret-leak' && r.severity === 'error'),
    '前提：默认是开着的');

  writePocketFile(pocketDir, 'config.md', readPocketFile(pocketDir, 'config.md') + '\n- secret_scan: false   # 这个 pocket 就是用来存密钥轮换手册的\n');
  const result = verify(pocketDir);
  assert.ok(!result.results.some((r) => r.category === 'secret-leak'),
    '关掉之后一条都不该报：' + JSON.stringify(result.results.filter((r) => r.category === 'secret-leak')));
  assert.strictEqual(result.errorCount, 0, '关掉之后不该有 error，闸门也不能拦提交');
});

test('a fresh pocket with no turns verifies clean so the first commit is not blocked', () => {
  const { pocketDir } = makePocket('pristine-clean');

  // index.md 的出厂标题是 T0（还没有任何一轮），这是正确状态而不是坏标题。
  // 旧实现把 T0 判成 malformed header 报 error，pre-commit 里 `verify --quiet`
  // 于是对新项目的第一个提交直接退 1 —— 用户还没记下任何东西就被拦下。
  const index = parser.parseIndex(pocketDir);
  assert.strictEqual(index.malformedIndexT, false, 'T0 不该被标成坏标题');
  assert.strictEqual(index.latestT, 0);

  const result = verify(pocketDir);
  assert.strictEqual(result.errorCount, 0,
    '干净的新 pocket 不该有 error：' + JSON.stringify(result.results.filter((r) => r.severity === 'error')));
});

test('a genuinely malformed index header is still an error, not swept under the T0 fix', () => {
  const { pocketDir } = makePocket('still-bad-header');
  writePocketFile(pocketDir, 'index.md',
    readPocketFile(pocketDir, 'index.md').replace(/^#\s+Index[^\n]*/m, '# Index · T99999999999 · 2026-01-01'));

  const result = verify(pocketDir);
  assert.ok(result.results.some((r) => r.severity === 'error' && /malformed T number/.test(r.message || '')),
    '超出可信用范围的 T 依旧要报：' + JSON.stringify(result.results.map((r) => r.message)));
  assert.ok(result.errorCount >= 1);
});

// ------------------------------------------------------------
// v2：每一轮的时间（--- WHEN: … ---）
// ------------------------------------------------------------

/** 抽出 log.md 里所有时间行，好把"哪一块带了什么时间"直接摊进断言里 */
function whenLinesOf(content) {
  return content.split(/\r?\n/).filter((l) => /^--- WHEN: /.test(l));
}

test('a v2 pocket stamps every new turn with the moment it was written', () => {
  const { pocketDir } = makePocket('when-default');
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const expect = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
    ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());

  const result = record(pocketDir, '记一轮');
  assert.strictEqual(result.when, '--- WHEN: ' + expect + ' ---');

  const log = readPocketFile(pocketDir, 'log.md');
  assert.ok(
    new RegExp('## T1 · 记一轮 · \\[测试\\]\\n--- WHEN: ' + expect + ' ---').test(log),
    '时间行必须紧跟标题，且就在空行之前：\n' + log
  );
  // 回归防线：sanitizeInline 的 `-{3,}` 规则会把本行逃成 \\--- WHEN:，解析器就再也读不到了
  assert.ok(!log.includes('\\---'), '工具自己产出的结构行不能被自己的注入防护逃掉：\n' + log);

  const block = parser.parseLog(pocketDir).blocks[0];
  assert.strictEqual(block.when.kind, 'instant');
  assert.strictEqual(block.when.date, expect.slice(0, 10));
  assert.strictEqual(verify(pocketDir).errorCount, 0, '带了时间行的块不能把体检弄红');
});

test('the recorded time is only overridden when the user actually said a different one', () => {
  const { pocketDir } = makePocket('when-explicit');
  record(pocketDir, '区间轮', { when: '2026-05-01 09:00 → 11:30' });
  record(pocketDir, '原话轮', { when: '上周三下午' });
  record(pocketDir, '只有天', { when: '2026-05-03' });

  assert.deepStrictEqual(whenLinesOf(readPocketFile(pocketDir, 'log.md')), [
    '--- WHEN: 2026-05-01 09:00 → 2026-05-01 11:30 ---',
    '--- WHEN: stated: 上周三下午 ---',
    '--- WHEN: 2026-05-03 (day) ---',
  ]);

  const blocks = parser.parseLog(pocketDir).blocks;
  assert.strictEqual(blocks[0].when.to, '2026-05-01 11:30', '右端只写钟点时补左端的日期');
  assert.strictEqual(blocks[1].when.kind, 'text', '认不出的说法原样留着，不做任何换算');
  assert.strictEqual(blocks[1].when.text, '上周三下午');
  assert.strictEqual(blocks[2].when.kind, 'day');
});

test('a v1 pocket never grows a time line out of nowhere', () => {
  const { projectDir, pocketDir } = makeV1Pocket('when-v1-append');
  const before = readPocketFile(pocketDir, 'log.md');

  const result = record(pocketDir, '在 v1 里记一轮');
  assert.strictEqual(result.when, null);
  assert.strictEqual(readPocketFile(pocketDir, 'log.md').includes('--- WHEN:'), false,
    '内容超出 pocket 自己声明的格式版本，等于让 migrate 失业');

  // 同一个 pocket 升上来之后，同样的写入立刻带上时间：差别只在版本戳
  spawnSync(process.execPath, [path.join(ROOT, 'bin', 'context-pocket.js'), 'migrate', '--to', 'v2', '--dir', projectDir]);
  const after = record(pocketDir, '升级以后再记一轮');
  assert.ok(after.when && /^--- WHEN: \d{4}-\d{2}-\d{2} \d{2}:\d{2} ---$/.test(after.when),
    JSON.stringify(after));
  assert.strictEqual(whenLinesOf(readPocketFile(pocketDir, 'log.md')).length, 5,
    '迁移补了 4 条（v1 的四个块，含刚写的那一条），新写的一条');
});

test('amend adds a missing time line, upgrades a day-only one, and refuses to rewrite a recorded one', () => {
  const { projectDir, pocketDir } = makeV1Pocket('when-amend');
  const migrate = require(path.join(ROOT, 'lib', 'migrate'));
  assert.strictEqual(migrate.runMigration(pocketDir, { to: 'v2' }).success, true);
  for (const name of fs.readdirSync(projectDir)) {
    if (name.startsWith('ContextPocket.backup-')) {
      fs.rmSync(path.join(projectDir, name), { recursive: true, force: true });
    }
  }

  // 1) v1 迁移留下的粗粒度：允许换成更准的值
  const r1 = writer.amendLogBlock(pocketDir, 1, { when: '2026-05-01 09:00 → 11:30' });
  assert.strictEqual(r1.success, true, JSON.stringify(r1));
  assert.deepStrictEqual(r1.filled, ['When']);
  assert.ok(readPocketFile(pocketDir, 'log.md').includes('--- WHEN: 2026-05-01 09:00 → 2026-05-01 11:30 ---'));

  // 2) 已经记下的时间是历史：第二次 amend 必须拒绝，而且一个字都不改
  const logAfterFirst = readPocketFile(pocketDir, 'log.md');
  const r2 = writer.amendLogBlock(pocketDir, 1, { when: '2026-05-01 23:00' });
  assert.deepStrictEqual(r2.filled, [], JSON.stringify(r2));
  assert.deepStrictEqual(r2.skipped, ['When']);
  assert.ok(/不覆盖历史/.test(r2.when), JSON.stringify(r2));
  assert.strictEqual(readPocketFile(pocketDir, 'log.md'), logAfterFirst, '拒绝就等于真的不改');

  // 3) 块里根本没有时间行（v1 且上方没有 SESSION 日期）→ 补一行
  writePocketFile(pocketDir, 'log.md', [
    '# ContextPocket · LOG',
    '',
    v1Block(1, '没有时间行的块', 'orphan'),
  ].join('\n'));
  const r3 = writer.amendLogBlock(pocketDir, 1, { when: '2026-06-07' });
  assert.strictEqual(r3.success, true, JSON.stringify(r3));
  assert.ok(readPocketFile(pocketDir, 'log.md').includes('--- WHEN: 2026-06-07 (day) ---'),
    readPocketFile(pocketDir, 'log.md'));
});

test('amend keeps every line between the heading and the first section instead of swallowing them', () => {
  const { pocketDir } = makePocket('when-preamble');
  record(pocketDir, '有时间的块');
  const withWhen = readPocketFile(pocketDir, 'log.md');
  // 标题下面、第一个 ### 之前的行以前会被整段丢掉（时间行正是住在这里）
  writePocketFile(pocketDir, 'log.md',
    withWhen.replace('### User\n- 用户原话：有时间的块\n', ''));

  const result = writer.amendLogBlock(pocketDir, 1, { user: ['补上的原话'] });
  assert.strictEqual(result.success, true, JSON.stringify(result));
  const after = readPocketFile(pocketDir, 'log.md');
  assert.ok(/^## T1 · 有时间的块 · \[测试\]\n--- WHEN: \d{4}-\d{2}-\d{2} \d{2}:\d{2} ---$/m.test(after),
    'amend 之后时间行必须还在原位：\n' + after);
  assert.ok(after.includes('- 补上的原话'), after);
});

test('amend --when on a v1 pocket says what to run instead of writing a line the format does not know', () => {
  const { projectDir, pocketDir } = makeV1Pocket('when-v1-amend');
  const before = readPocketFile(pocketDir, 'log.md');

  const run = spawnSync(process.execPath, [
    path.join(ROOT, 'bin', 'context-pocket.js'),
    'log', 'amend', '1', '--when', '2026-05-01 09:00 → 11:30', '--json', '--dir', projectDir,
  ], { encoding: 'utf-8' });
  assert.strictEqual(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.strictEqual(parsed.ok, true, run.stdout);
  assert.deepStrictEqual(parsed.filled, [], 'v1 的 pocket 里什么都没写');
  assert.ok(/migrate/.test(parsed.whenNote), '得告诉用户下一步跑什么：' + parsed.whenNote);
  assert.strictEqual(readPocketFile(pocketDir, 'log.md'), before);
});

test('archiving moves the time line together with its block', () => {
  const { pocketDir } = makePocket('when-archive');
  for (const gist of ['第一轮', '第二轮', '第三轮']) record(pocketDir, gist);
  writer.archiveLog(pocketDir, { keepLast: 1, dryRun: false });

  const live = readPocketFile(pocketDir, 'log.md');
  const archived = readPocketFile(pocketDir, 'log-archive.md');
  assert.strictEqual(whenLinesOf(live).length, 1, '留下的一块自带时间：\n' + live);
  assert.strictEqual(whenLinesOf(archived).length, 2, '搬走的两块也没有丢时间：\n' + archived);
  assert.ok(/## T1 · 第一轮 · \[测试\]\n--- WHEN: /.test(archived),
    '时间行得紧跟标题一起搬走，否则归档切片会把它落在块外：\n' + archived);

  const recalled = query.recall(pocketDir, 1);
  assert.ok(recalled && recalled.when && recalled.when.kind === 'instant',
    '归档后的块依然要能读出时间：' + JSON.stringify(recalled && recalled.when));
  assert.strictEqual(verify(pocketDir).errorCount, 0);
});

test('search stays honest about blocks that carry a time line', () => {
  const { pocketDir } = makePocket('when-search');
  record(pocketDir, '给搜索加时间分页', { when: '2026-05-01 09:00 → 11:30' });
  record(pocketDir, '无关的一轮');

  // 索引是派生缓存：直接调 writer 的测试路径不会刷新它，必须显式重建再搜
  resetIndexMemo();
  buildIndex(pocketDir, { rebuild: true });
  const hits = query.searchAny(pocketDir, '时间分页');
  assert.ok(hits.results.length >= 1, JSON.stringify(hits));
  assert.strictEqual(hits.results[0].id, 1);

  assert.strictEqual(whenLinesOf(readPocketFile(pocketDir, 'log.md')).length, 2);
  assert.strictEqual(verify(pocketDir).errorCount, 0);
});

test('a Chinese phrase query finds the block that contains it', () => {
  const { pocketDir } = makePocket('cjk-search');
  const first = record(pocketDir, '给搜索加上时间分页');
  record(pocketDir, '完全无关的一轮');
  resetIndexMemo();
  buildIndex(pocketDir, { rebuild: true });

  // 二字组 AND；整串 run 曾做词元，于是只有查询与 gist 逐字相同才命中
  const hit = query.searchAny(pocketDir, '时间分页');
  assert.strictEqual(hit.total, 1, JSON.stringify(hit));
  assert.strictEqual(hit.results[0].id, first.tId);

  // 顺序判别没丢：反过来说就不该命中
  assert.strictEqual(query.searchAny(pocketDir, '页时分').total, 0);

  // 两条路径同一套语义（倒排 vs 现场扫描）
  const scanned = query.searchAny(pocketDir, '时间分页', { useIndex: false });
  assert.deepStrictEqual(scanned.results.map((r) => r.id), hit.results.map((r) => r.id));
});

test('an index built by an older tokenizer is discarded, not trusted', () => {
  const { pocketDir } = makePocket('stale-index');
  record(pocketDir, '给搜索加上时间分页');
  resetIndexMemo();
  buildIndex(pocketDir, { rebuild: true });

  const file = indexPath(pocketDir);
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  raw.version = raw.version - 1;
  fs.writeFileSync(file, JSON.stringify(raw), 'utf-8');
  resetIndexMemo();

  // 词元集变了 = 旧 postings 会漏命中，所以过期版本一律当作"没有索引"，
  // 由 ensureFreshIndex 用当前分词器重建；绝不允许拿旧 postings 回答问题。
  assert.strictEqual(loadIndex(pocketDir), null, '过期版本必须当作没有索引');
  const viaScan = query.searchAny(pocketDir, '时间分页', { useIndex: false });
  assert.strictEqual(viaScan.total, 1, JSON.stringify(viaScan));
  assert.strictEqual(viaScan.viaIndex, false);

  const viaIndex = query.searchAny(pocketDir, '时间分页');
  assert.strictEqual(viaIndex.viaIndex, true, '搜索应顺手把过期索引换掉，而不是永久回退扫描');
  assert.deepStrictEqual(viaIndex.results.map((r) => r.id), viaScan.results.map((r) => r.id),
    '重建后两条路径必须给同一条命中');
  assert.ok(loadIndex(pocketDir), '写回的索引必须带上当前版本号，否则每次搜索都要重建');
});

test('a pocket that stays on v1 is still healthy — the upgrade is offered, never forced', () => {
  const { projectDir, pocketDir } = makeV1Pocket('when-v1-healthy');
  const result = verify(pocketDir);
  assert.strictEqual(result.errorCount, 0,
    '没有时间行的 v1 pocket 不该被判错：' + JSON.stringify(result.results.filter((r) => r.severity === 'error')));
  assert.ok(!result.results.some((r) => /WHEN|时间行/.test(r.message || '')),
    'verify 不该拿 v2 的要求去量 v1 的数据：' + JSON.stringify(result.results.map((r) => r.message)));

  // 但"可以升级"必须看得见：v1 的 pocket 里写入层永远不补时间行
  // （formatSupportsWhen 说了算），用户不主动跑 migrate --list 就不知道自己少了这个功能。
  const offer = result.results.filter((r) => r.category === 'format-upgrade');
  assert.strictEqual(offer.length, 1, JSON.stringify(result.results.map((r) => r.category)));
  assert.strictEqual(offer[0].severity, 'warning',
    '升级提示绝不能是 error：pre-commit 拦的是 error，那等于不许提交');
  assert.ok(/v1→v2/.test(offer[0].message), JSON.stringify(offer[0]));
  assert.match(offer[0].fix, /migrate --to v2/, JSON.stringify(offer[0]));
  assert.ok(offer[0].details.some((n) => /v1-to-v2/.test(n)), JSON.stringify(offer[0].details));

  // 升上去之后这条提示要自己消失，否则体检永远在喊一件已经做完的事
  const migrate = require(path.join(ROOT, 'lib', 'migrate'));
  assert.strictEqual(migrate.runMigration(pocketDir, { to: 'v2' }).success, true);
  for (const name of fs.readdirSync(projectDir)) {
    if (name.startsWith('ContextPocket.backup-')) {
      fs.rmSync(path.join(projectDir, name), { recursive: true, force: true });
    }
  }
  const after = verify(pocketDir);
  assert.strictEqual(after.results.filter((r) => r.category === 'format-upgrade').length, 0,
    '已经是最新格式的 pocket 不该再被提示升级：' + JSON.stringify(after.results.map((r) => r.category)));
  assert.strictEqual(after.errorCount, 0);
});
