'use strict';

/**
 * 套件：编号修复（lib/repair.js + bin repair）
 *
 * 为什么单独一层：撞号不是"某条记录写坏了"，而是整个 pocket 的坐标系坏了。
 * 写入锁只在一台机器上有效（lib/io.js 的 withPocketLock 把锁放在 os.tmpdir()），
 * 两个 Agent 在两台机器上各算一次 `latestT + 1` 就得到同一个 T 号，合并后
 * log.md 里出现两个 `## T3`。verify 早就看得见它，但给的是一句人话
 * （`Rename or merge duplicate blocks.`）—— 手改 markdown 是 skill 明令禁止的，
 * `git commit --no-verify` 是绕过检查，所以合并后的 pocket 只能靠 repair 收回来。
 *
 * 本套件钉住五件事：
 * - 级联：撞号块**及其之后**的块整体后移（log.md 只追加，编号必须随文件顺序递增）
 * - 诚实：正文逐字保留、引用默认只列不改、归档只报不改、改动本身进历史
 * - 派生值：各文件头行的 `T<n>` 跟着对齐，index.md 重算
 * - 边界：没撞号什么都不做、畸形号不跟着排号、补零的块头也改得动
 * - 失败要整份回去：改完体检更差就把每个文件（含 index.md）放回去
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  assert, test, makePocket, readPocketFile, writePocketFile, ROOT,
} = require('./harness');

const writer = require(path.join(ROOT, 'lib', 'writer'));
const parser = require(path.join(ROOT, 'lib', 'parser'));
const repair = require(path.join(ROOT, 'lib', 'repair'));
const { verify } = require(path.join(ROOT, 'lib', 'validator'));

const CLI = path.join(ROOT, 'bin', 'context-pocket.js');

function record(pocketDir, gist) {
  return writer.appendLogBlock(pocketDir, {
    gist,
    tags: ['测试'],
    user: ['用户原话：' + gist],
    action: ['创建 test/' + gist.replace(/\s+/g, '-') + '.js'],
    conflictCheck: false,
  });
}

/**
 * 造一个"两台机器各写了几轮"的 pocket：本地先写 turns 轮，然后把最后几轮的块头
 * 改成对岸算出来的号（对岸的 latestT 停在更早的位置，所以它重复写过这些号）。
 *
 * @param {string} tag
 * @param {object} [options]
 * @param {number} [options.turns] 一共写几轮（默认 4）
 * @param {object} [options.relabel] 块头改号表，如 {4: 3} = 把 T4 那块改成 T3
 */
function makeCollidedPocket(tag, options = {}) {
  const made = makePocket(tag);
  const turns = options.turns || 4;
  for (let i = 1; i <= turns; i++) record(made.pocketDir, '第 ' + i + ' 轮');
  const relabel = options.relabel || { 4: 3 };
  // 改号必须一次扫完：先 T4→T3 再 T5→T4 会把同一个块挪两次（{4:3,5:4} 就是这种链）
  const log = readPocketFile(made.pocketDir, 'log.md').replace(/^## T(\d+) · /gm,
    (whole, digits) => (relabel[Number(digits)] === undefined
      ? whole
      : '## T' + relabel[Number(digits)] + ' · '));
  writePocketFile(made.pocketDir, 'log.md', log);
  return made;
}

function pocketSnapshot(pocketDir) {
  const out = {};
  for (const name of fs.readdirSync(pocketDir)) {
    const full = path.join(pocketDir, name);
    if (fs.statSync(full).isFile()) out[name] = fs.readFileSync(full, 'utf8');
  }
  return out;
}

/**
 * 去掉块头行的正文行。repair 只许动块头编号，这些行必须原样还在原位。
 * 末尾的空行要去掉：追加记录块时写入层会吃掉文件尾那一个空行，
 * 但那不是"改了正文"，留着它只会把断言变成对换行符的争论。
 */
function bodyLines(text) {
  const lines = text.split('\n').filter((line) => !repair.HEADING_RE.test(line));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const dupErrors = (pocketDir) => verify(pocketDir).results.filter((r) => /Duplicate T-id/.test(r.message));

const errorFindings = (pocketDir) => verify(pocketDir).results.filter((r) => r.severity === 'error');

const ids = (pocketDir) => parser.parseLog(pocketDir).blocks.map((b) => b.id);

test('verify 的撞号修法直接指向 repair（不再是一句"自己动手改 markdown"）', () => {
  const { pocketDir } = makeCollidedPocket('verify-points-at-repair');

  const dup = dupErrors(pocketDir)[0];

  assert.match(dup.fix, /context-pocket repair/, JSON.stringify(dup));
  assert.match(dup.fix, /context_pocket_repair/, 'MCP 那条入口也要在同一句话里');
  assert.match(dup.fix, /--dry-run/, '先出方案这件事必须写在修法里，不是在文档里');
});

// ============================================================
// 库层
// ============================================================

test('repair: the colliding block shifts up, prose stays verbatim, and the move is recorded', () => {
  const { pocketDir } = makeCollidedPocket('repair-cascade');

  // 前提：verify 确实看得见这个坏状态（repair 存在的理由）
  assert.strictEqual(dupErrors(pocketDir).length, 1, JSON.stringify(dupErrors(pocketDir)));

  const before = readPocketFile(pocketDir, 'log.md');
  const result = repair.repairLogIds(pocketDir, {});

  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.duplicates, 1);
  assert.deepStrictEqual(result.renumbered.map((c) => c.from + '→' + c.to), ['3→4'],
    JSON.stringify(result.renumbered));
  assert.strictEqual(result.latestTBefore, 3);

  const log = parser.parseLog(pocketDir);
  assert.deepStrictEqual(ids(pocketDir), [1, 2, 3, 4, 5], JSON.stringify(ids(pocketDir)));
  // 被挪走的是文件里靠后的那块：它才是"对岸那一份"，本地那份保留原号
  assert.deepStrictEqual(log.blocks.slice(0, 4).map((b) => b.gist),
    ['第 1 轮', '第 2 轮', '第 3 轮', '第 4 轮']);

  // 逐字保留：原文件的每一行正文，在新文件的同一位置（末尾只多了记录块）
  const after = bodyLines(readPocketFile(pocketDir, 'log.md'));
  const old = bodyLines(before);
  assert.deepStrictEqual(after.slice(0, old.length), old,
    'repair 只许改块头编号，不许动任何一行正文');

  assert.match(log.blocks[4].gist, /repair/);
  assert.ok(log.blocks[4].tags.includes('auto'), '记录块要标明这是工具做的，不是用户的一轮');
  assert.strictEqual(result.recordTId, 5);
  assert.strictEqual(result.verifyAfter.errorCount, 0, JSON.stringify(errorFindings(pocketDir)));
  assert.strictEqual(verify(pocketDir).errorCount, 0, JSON.stringify(errorFindings(pocketDir)));
});

test('repair: a merge where BOTH machines kept writing cascades two blocks at once', () => {
  // A 写了 T3，B 的副本写了 T3 又写了 T4：合并后文件顺序是 1,2,3,3,4。
  // 只把重复那块丢到一个凭空的大号上，会得到 1,2,4,…,3 —— 顺序检查接着报错；
  // 整体后移（3→4、4→5）才是这段历史本来的读法。
  const { pocketDir } = makeCollidedPocket('repair-both-kept-writing', { turns: 5, relabel: { 4: 3, 5: 4 } });

  const result = repair.repairLogIds(pocketDir, {});

  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.deepStrictEqual(result.renumbered.map((c) => c.from + '→' + c.to), ['3→4', '4→5'],
    JSON.stringify(result.renumbered));
  assert.strictEqual(result.latestTBefore, 4);
  assert.strictEqual(result.latestTAfter, 6, '记录块写完之后的最新轮次');
  assert.deepStrictEqual(ids(pocketDir), [1, 2, 3, 4, 5, 6]);
  assert.strictEqual(verify(pocketDir).errorCount, 0, JSON.stringify(errorFindings(pocketDir)));
});

test('repair dry-run: the plan is complete, not one byte is written', () => {
  const { pocketDir } = makeCollidedPocket('repair-dryrun');
  const snapshot = pocketSnapshot(pocketDir);

  const result = repair.repairLogIds(pocketDir, { dryRun: true });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.dryRun, true);
  assert.deepStrictEqual(result.renumbered.map((c) => c.from + '→' + c.to), ['3→4']);
  // 块头行是定义不是引用：撞号里保留原号的那一块也在映射表里，
  // 把它当引用报出来，就等于让用户去改一块根本没动的历史。
  assert.deepStrictEqual(result.references, [], JSON.stringify(result.references));
  assert.strictEqual(result.latestTBefore, 3);
  assert.strictEqual(result.latestTAfter, 4, '没写盘也要报出改完之后的号');
  assert.match(result.message, /dry-run/);
  assert.deepStrictEqual(pocketSnapshot(pocketDir), snapshot,
    'dry-run 之后目录里每个文件都必须一字不变');
});

test('repair: nothing colliding means nothing happens — no renumbering on the side, no record block', () => {
  const { pocketDir } = makePocket('repair-clean');
  record(pocketDir, '第 1 轮');
  record(pocketDir, '第 2 轮');
  const snapshot = pocketSnapshot(pocketDir);

  const result = repair.repairLogIds(pocketDir, {});

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.changed, false, JSON.stringify(result));
  assert.deepStrictEqual(result.renumbered, []);
  assert.strictEqual(result.duplicates, 0);
  assert.strictEqual(result.recordTId, undefined, '无事可做就不该占一轮历史');
  assert.match(result.message, /没有撞号/);
  assert.deepStrictEqual(pocketSnapshot(pocketDir), snapshot);
});

test('repair: references are listed, not rewritten — and the derived header is aligned anyway', () => {
  const { pocketDir } = makeCollidedPocket('repair-refs-listed');
  // "沿用 T3" 可能指留下的那块，也可能指被挪走的那块：只有读的人知道是哪一个，
  // 所以 repair 默认只把清单交出来。
  writePocketFile(pocketDir, 'log.md',
    readPocketFile(pocketDir, 'log.md').replace('创建 test/第-4-轮.js', '按 T3 的结论收尾'));
  writePocketFile(pocketDir, 'decisions.md',
    readPocketFile(pocketDir, 'decisions.md')
      .replace(/^# Decisions · T\S*/, '# Decisions · T3')
      + '\n## ADR-1 · 用 Vite · T3\n- Context: 见 T3\n- Decision: Vite\n- Consequences: 无\n');

  const plan = repair.repairLogIds(pocketDir, { dryRun: true });
  assert.ok(plan.references.length >= 3, JSON.stringify(plan.references));
  assert.ok(plan.references.every((r) => r.rewritten === false), '默认不许改写任何引用');
  assert.ok(plan.references.some((r) => r.file === 'decisions.md' && /ADR-1/.test(r.text)),
    JSON.stringify(plan.references));
  // 头行的 T 号是"截至第几轮"的派生值，不是引用：它总是被对齐，不进清单
  assert.ok(!plan.references.some((r) => r.file === 'decisions.md' && r.line === 1),
    JSON.stringify(plan.references));

  const result = repair.repairLogIds(pocketDir, {});
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.references.length, plan.references.length);
  assert.ok(/按 T3 的结论收尾/.test(readPocketFile(pocketDir, 'log.md')), '列出来了，但一个字没改');
  assert.ok(/## ADR-1 · 用 Vite · T3/.test(readPocketFile(pocketDir, 'decisions.md')));
  // 派生头行不管 applyRefs 与否都对齐到新最新轮（记录块之后是 T5）
  assert.match(readPocketFile(pocketDir, 'decisions.md').split('\n')[0], /^# Decisions · T[45]\b/,
    readPocketFile(pocketDir, 'decisions.md').split('\n')[0]);
});

test('repair --apply-refs: block bodies, ADR lines and every stale T-n follow the map', () => {
  const { pocketDir } = makeCollidedPocket('repair-refs-applied');
  writePocketFile(pocketDir, 'log.md',
    readPocketFile(pocketDir, 'log.md').replace('创建 test/第-4-轮.js', '按 T3 的结论收尾'));
  writePocketFile(pocketDir, 'decisions.md',
    readPocketFile(pocketDir, 'decisions.md')
      .replace(/^# Decisions · T\S*/, '# Decisions · T3')
      + '\n## ADR-1 · 用 Vite · T3\n- Context: 见 T3\n- Decision: Vite\n- Consequences: 无\n');

  const result = repair.repairLogIds(pocketDir, { applyRefs: true });

  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.applyRefs, true);
  assert.ok(result.references.length >= 3, JSON.stringify(result.references));
  assert.ok(result.references.every((r) => r.rewritten), JSON.stringify(result.references));
  assert.match(readPocketFile(pocketDir, 'log.md'), /按 T4 的结论收尾/);
  const decisions = readPocketFile(pocketDir, 'decisions.md');
  assert.match(decisions, /## ADR-1 · 用 Vite · T4/);
  assert.match(decisions, /^- Context: 见 T4$/m);
  assert.ok(!/T3/.test(decisions.replace(/## ADR-1[^\n]*/, '')), '旧号不该还剩着：' + decisions);
  assert.strictEqual(verify(pocketDir).errorCount, 0, JSON.stringify(errorFindings(pocketDir)));
});

test('repair: a cascading map rewrites each reference ONCE (3→4 and 4→5 simultaneously)', () => {
  const { pocketDir } = makeCollidedPocket('repair-ref-cascade', { turns: 5, relabel: { 4: 3, 5: 4 } });
  writePocketFile(pocketDir, 'log.md',
    readPocketFile(pocketDir, 'log.md').replace('创建 test/第-5-轮.js', '按 T3 定，又被 T4 推翻'));

  const result = repair.repairLogIds(pocketDir, { applyRefs: true });

  assert.deepStrictEqual(result.renumbered.map((c) => c.from + '→' + c.to), ['3→4', '4→5']);
  // 逐条 replace 的话：先 3→4 再 4→5，"按 T3 定"会被挪成 T5
  assert.match(readPocketFile(pocketDir, 'log.md'), /按 T4 定，又被 T5 推翻/);
});

test('repair: derived header counters follow the renumbering and index.md is recomputed', () => {
  const { pocketDir } = makeCollidedPocket('repair-derived');
  writePocketFile(pocketDir, 'state.md',
    readPocketFile(pocketDir, 'state.md').replace(/^# State · T\S*/, '# State · T3'));

  const result = repair.repairLogIds(pocketDir, {});

  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.match(readPocketFile(pocketDir, 'index.md').split('\n')[0], /^# Index · T5 · /,
    'index.md 的头行与 log.md 范围是派生值：重算之后必须指着最新的真实轮次');
  assert.match(readPocketFile(pocketDir, 'index.md'), /log\.md → T1–T5/);
  assert.strictEqual(verify(pocketDir).errorCount, 0, JSON.stringify(errorFindings(pocketDir)));
});

test('repair: log-archive.md is read-only by its own declaration — reported, never touched', () => {
  const { pocketDir } = makeCollidedPocket('repair-archive');
  // 归档里已经有 T4：重排把 live 的号挪到 4 之后，同一个名字在两边都有块
  writePocketFile(pocketDir, 'log-archive.md',
    '# Log Archive\n\n## T4 · 归档的一轮 · [测试]\n\n### Action\n- 早就归档掉的改动，正文里提到 T3\n');
  const archiveBefore = readPocketFile(pocketDir, 'log-archive.md');

  const result = repair.repairLogIds(pocketDir, { applyRefs: true });

  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(readPocketFile(pocketDir, 'log-archive.md'), archiveBefore,
    '归档文件自己写着 "Read-only reference. Do not modify."，repair 不许替它改号');
  const inArchive = result.references.filter((r) => r.file === 'log-archive.md');
  assert.ok(inArchive.length > 0, JSON.stringify(result.references));
  assert.ok(inArchive.every((r) => r.rewritten === false), JSON.stringify(inArchive));
  assert.ok(inArchive.every((r) => r.text.includes('T3')), JSON.stringify(inArchive));
  assert.deepStrictEqual(result.stillShadowed, [4], JSON.stringify(result));
});

test('repair: a zero-padded heading is renumbered too (substitution is by line, not by old digits)', () => {
  // parser 的块头正则吃 `T03`（lib/parser.js:170），于是它和 T3 撞号。
  // 如果 repair 用旧号去拼匹配串，"## T03" 一行都匹配不上，就会安静地什么都没改。
  const { pocketDir } = makeCollidedPocket('repair-zero-pad', { relabel: { 4: '03' } });

  const result = repair.repairLogIds(pocketDir, {});

  assert.strictEqual(result.success, true, JSON.stringify(result));
  const log = readPocketFile(pocketDir, 'log.md');
  assert.ok(!/## T03 ·/.test(log), '补零的块头必须被改成新号：' + log.split('\n').filter((l) => /^## T/.test(l)).join('\n'));
  assert.match(log, /## T4 · 第 4 轮/);
  assert.deepStrictEqual(ids(pocketDir).slice(0, 4), [1, 2, 3, 4]);
  assert.strictEqual(verify(pocketDir).errorCount, 0, JSON.stringify(errorFindings(pocketDir)));
});

test('repair: malformed T-ids stay exactly where they are', () => {
  // 超大号由 verify 的 implausible-id 检查管，它的修法不是挪号 ——
  // repair 要是顺手给它排号，就是凭空造了一段历史。
  const { pocketDir } = makeCollidedPocket('repair-malformed');
  writePocketFile(pocketDir, 'log.md',
    readPocketFile(pocketDir, 'log.md').replace('## T2 · 第 2 轮', '## T99999999999999 · 手改出来的怪号'));

  const result = repair.repairLogIds(pocketDir, {});

  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.match(readPocketFile(pocketDir, 'log.md'), /## T99999999999999 · 手改出来的怪号/);
  assert.deepStrictEqual(result.renumbered.map((c) => c.from + '→' + c.to), ['3→4'],
    JSON.stringify(result.renumbered));
});

test('repair: when the pocket ends up worse it rolls every file back, index.md included', () => {
  // 真实输入下这条 net 不该触发：级联方案本身不会让 verify 变差。所以只能把
  // verify 换成"写前说没事、写后说 5 个 error"的替身，来检查失败分支真的动手放回。
  // 用 require.cache 注入，而不是给 repair 留一个"假装体检失败"的生产开关。
  const { pocketDir } = makeCollidedPocket('repair-rollback');
  const snapshot = pocketSnapshot(pocketDir);

  const validatorPath = require.resolve(path.join(ROOT, 'lib', 'validator'));
  const repairPath = require.resolve(path.join(ROOT, 'lib', 'repair'));
  const realValidator = require.cache[validatorPath];
  const realRepair = require.cache[repairPath];
  let calls = 0;
  require.cache[validatorPath] = {
    id: validatorPath,
    filename: validatorPath,
    loaded: true,
    children: [],
    paths: [],
    exports: Object.assign({}, realValidator.exports, {
      verify: () => ({
        results: [],
        errorCount: calls++ === 0 ? 0 : 5,
        warningCount: 0,
        infoCount: 0,
      }),
    }),
  };
  delete require.cache[repairPath];

  try {
    const result = require(repairPath).repairLogIds(pocketDir, {});
    assert.strictEqual(result.success, false, JSON.stringify(result));
    assert.match(result.error, /rolled back/, JSON.stringify(result));
    assert.ok(calls >= 2, '回滚判据要写前写后各跑一次体检：' + calls);
    assert.deepStrictEqual(pocketSnapshot(pocketDir), snapshot,
      '回滚必须把改过的每个文件放回原样，含重算过的 index.md 和那条记录块');
  } finally {
    require.cache[validatorPath] = realValidator;
    delete require.cache[repairPath];
    require(repairPath);
  }
});

// ============================================================
// CLI 层
// ============================================================

function runCli(projectDir, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--dir', projectDir], { encoding: 'utf-8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('cli: repair --dry-run --json hands over the plan without touching files', () => {
  const { projectDir, pocketDir } = makeCollidedPocket('cli-repair-dry');
  const snapshot = pocketSnapshot(pocketDir);

  const run = runCli(projectDir, ['repair', '--dry-run', '--json']);

  assert.strictEqual(run.status, 0, run.out);
  const json = JSON.parse(run.out);
  assert.strictEqual(json.ok, true, run.out);
  assert.strictEqual(json.changed, true);
  assert.strictEqual(json.dryRun, true);
  assert.deepStrictEqual(json.renumbered.map((c) => c.from + '→' + c.to), ['3→4'], run.out);
  assert.strictEqual(json.applyRefs, false);
  assert.deepStrictEqual(pocketSnapshot(pocketDir), snapshot, 'dry-run 之后文件必须一字不变');
});

test('cli: repair renumbers, prints the plan, signs the record, and cleans verify', () => {
  const { projectDir, pocketDir } = makeCollidedPocket('cli-repair-run');

  const run = runCli(projectDir, ['repair', '--author', 'agent-A']);

  assert.strictEqual(run.status, 0, run.out);
  assert.match(run.out, /Repair completed/);
  assert.match(run.out, /T3 → T4/);
  assert.match(run.out, /记录块：T5/);
  assert.deepStrictEqual(ids(pocketDir), [1, 2, 3, 4, 5]);
  assert.match(readPocketFile(pocketDir, 'log.md'), /### Author\n- agent-A/,
    '谁跑的 repair 也要进历史');
  assert.strictEqual(verify(pocketDir).errorCount, 0, JSON.stringify(errorFindings(pocketDir)));

  // 第二次跑不该有事可做，更不该又占一轮历史
  const again = runCli(projectDir, ['repair']);
  assert.strictEqual(again.status, 0, again.out);
  assert.match(again.out, /Nothing to repair/);
  assert.strictEqual(parser.parseLog(pocketDir).blocks.length, 5, again.out);
});

test('cli: repair --json lists stale references and --apply-refs rewrites them', () => {
  const { projectDir, pocketDir } = makeCollidedPocket('cli-repair-refs');
  writePocketFile(pocketDir, 'log.md',
    readPocketFile(pocketDir, 'log.md').replace('创建 test/第-4-轮.js', '按 T3 的结论收尾'));

  const listed = JSON.parse(runCli(projectDir, ['repair', '--json']).out);
  assert.strictEqual(listed.applyRefs, false);
  assert.ok(listed.references.some((r) => r.file === 'log.md' && r.rewritten === false),
    JSON.stringify(listed.references));
  assert.match(readPocketFile(pocketDir, 'log.md'), /按 T3 的结论收尾/);

  // 旧号还留在正文里：第二次跑已经没有撞号可修了，所以改写必须在第一次就带上 flag
  const { projectDir: p2, pocketDir: pocket2 } = makeCollidedPocket('cli-repair-apply');
  writePocketFile(pocket2, 'log.md',
    readPocketFile(pocket2, 'log.md').replace('创建 test/第-4-轮.js', '按 T3 的结论收尾'));
  const applied = JSON.parse(runCli(p2, ['repair', '--apply-refs', '--json']).out);
  assert.strictEqual(applied.applyRefs, true);
  assert.ok(applied.references.every((r) => r.rewritten), JSON.stringify(applied.references));
  assert.match(readPocketFile(pocket2, 'log.md'), /按 T4 的结论收尾/);
});

// ------------------------------------------------------------
// 文件名与"长在词里的 T 号"：这两类都不是引用，改写会把 pocket 改坏
// ------------------------------------------------------------

test('repair: GPT4 is not a reference and attachment names are never rewritten (--apply-refs included)', () => {
  // map = {4→5}：把第 5 块改成 T4，与真的 T4 撞号。这一步故意让 4 进映射表 ——
  // 只有 4 在表里，才能验出"正文里的 GPT4"有没有被当成引用挪走。
  const { projectDir, pocketDir } = makeCollidedPocket('repair-files', { turns: 5, relabel: { 5: 4 } });
  const injected = '结构图见 T4-diagram.png: assets/T04-diagram.png，模型换成 GPT4，编码走 UTF8';
  writePocketFile(pocketDir, 'log.md',
    readPocketFile(pocketDir, 'log.md').replace('创建 test/第-5-轮.js', injected));

  const plan = JSON.parse(runCli(projectDir, ['repair', '--dry-run', '--json']).out);
  assert.ok(!plan.references.some((r) => /GPT4|UTF8/.test(r.text)),
    '词里的 T4 不能算引用：\n' + JSON.stringify(plan.references));
  const names = plan.fileNames.filter((f) => /diagram/.test(f.name));
  assert.strictEqual(names.length, 2, 'label 与 assets 路径都要列出来：\n' + JSON.stringify(plan.fileNames));
  assert.ok(names.every((f) => f.command.startsWith('mv "')), JSON.stringify(names));
  assert.ok(names.some((f) => f.renamed === 'assets/T05-diagram.png'),
    '改名建议必须保住零填充宽度：\n' + JSON.stringify(names));

  runCli(projectDir, ['repair', '--apply-refs', '--json']);
  const after = readPocketFile(pocketDir, 'log.md');
  // 文本原样：只改文本不改文件就是一条断链，所以 repair 两半都不碰
  assert.match(after, /结构图见 T4-diagram\.png: assets\/T04-diagram\.png，模型换成 GPT4，编码走 UTF8/);
  // 而 mv 命令进了那块 [auto] 记录块，下一个人查得到该改哪个文件
  assert.match(after, /mv "assets\/T04-diagram\.png" "assets\/T05-diagram\.png"/);
});

test('cli: repair --json output shape is machine-readable end to end', () => {
  const { projectDir } = makeCollidedPocket('cli-repair-json-shape');

  const run = runCli(projectDir, ['repair', '--json']);

  assert.strictEqual(run.status, 0, run.out);
  const json = JSON.parse(run.out);
  for (const key of ['ok', 'success', 'changed', 'dryRun', 'renumbered', 'references',
    'fileNames', 'duplicates', 'latestTBefore', 'latestTAfter', 'filesWritten', 'recordTId',
    'stillShadowed', 'applyRefs', 'verifyBefore', 'verifyAfter', 'message']) {
    assert.ok(Object.prototype.hasOwnProperty.call(json, key), '缺字段 ' + key + '：' + run.out);
  }
  assert.strictEqual(json.verifyAfter.errorCount, 0, run.out);
  // 撞号的 pocket 从来不只坏一处：index.md 是最后一次正常追加时写的，于是它还指着
  // 旧的最新轮（两条 index-consistency error）。repair 把派生值一起算回去，
  // 所以体检项数只会减少，不会留下一句"改完了但别处又红了"。
  assert.ok(json.verifyBefore.errorCount > json.verifyAfter.errorCount,
    JSON.stringify({ before: json.verifyBefore, after: json.verifyAfter }));
  assert.strictEqual(json.changed, true);
  assert.strictEqual(json.duplicates, 1);
});

test('cli: repair on a clean pocket succeeds with a plain no-op', () => {
  const { projectDir, pocketDir } = makePocket('cli-repair-clean');
  record(pocketDir, '第 1 轮');

  const run = runCli(projectDir, ['repair', '--json']);

  assert.strictEqual(run.status, 0, run.out);
  const json = JSON.parse(run.out);
  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.changed, false, run.out);
  assert.strictEqual(json.duplicates, 0);
});
