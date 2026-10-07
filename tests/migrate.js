'use strict';

/**
 * 套件：格式版本迁移（lib/migrate.js + bin migrate）
 *
 * 这一层管的是"最不能出错"的那类操作：它会重写整个 ContextPocket/。
 * 登记表里现在有两类跳：内置那条 v1 → v1 空跑（验证机制本身），和一条真的
 * v1 → v2（给每个 T-block 补 `--- WHEN: ---` 时间行，见 lib/when.js）。
 *
 * 所以本套件有两层内容：
 * - **真跳**：拿一份手写的 v1 log.md（含归档、CRLF、没有 SESSION 行的块）升上去，
 *   断言内容真的变了、日期来自最近的 SESSION、报不出精度就不编、跑两遍不会插两行。
 * - **机制**：在测试里临时注册假的跳（registerMigration 返回反注册函数），让
 *   v2 → v3 → v4 这样的多跳链真的存在，再看逐跳抬版本、失败整体回滚是不是真的工作。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  assert, test, makePocket, readPocketFile, writePocketFile, v1Block, v1LogBody, makeV1Pocket, ROOT,
} = require('./harness');

const migrate = require(path.join(ROOT, 'lib', 'migrate'));
const writer = require(path.join(ROOT, 'lib', 'writer'));
const { verify } = require(path.join(ROOT, 'lib', 'validator'));
const { parseLog } = require(path.join(ROOT, 'lib', 'parser'));

const CLI_PATH = path.join(ROOT, 'bin', 'context-pocket.js');

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI_PATH].concat(args), {
    cwd: cwd || process.cwd(),
    encoding: 'utf-8',
  });
}

function record(pocketDir, gist, extra) {
  return writer.appendLogBlock(pocketDir, Object.assign({
    gist,
    tags: ['测试'],
    user: ['用户原话：' + gist],
    action: ['创建 test/' + gist.replace(/\s+/g, '-') + '.js'],
  }, extra || {}));
}

/** 造一跳假迁移：往 readme.md 追加一行，好让"这一跳确实跑过"可验证 */
function appendHop(from, to, marker) {
  return migrate.registerMigration({
    from,
    to,
    name: 'test hop ' + from + '→' + to,
    run: (pocketDir) => {
      fs.appendFileSync(path.join(pocketDir, 'readme.md'), '\n' + marker + '\n');
    },
  });
}

function backupsIn(projectDir) {
  return fs.readdirSync(projectDir).filter((n) => n.startsWith('ContextPocket.backup-'));
}

function cleanBackups(projectDir) {
  for (const dir of backupsIn(projectDir)) {
    fs.rmSync(path.join(projectDir, dir), { recursive: true, force: true });
  }
}

/** 一行一个 T-block 的时间，用来把"哪一块拿到了什么日期"直接摊开在断言里 */
function whenLines(content) {
  return content.split(/\r?\n/).filter((l) => /^--- WHEN: /.test(l));
}

/**
 * 时间行不只是"存在"，它必须紧贴自己的标题（下一行）。
 * 归档是按行范围切块的，中间隔一行空白就可能被切到块外面。
 */
function lineAfter(content, heading) {
  const lines = content.split(/\r?\n/);
  const i = lines.indexOf(heading);
  assert.ok(i >= 0, `找不到标题行 ${heading}：` + JSON.stringify(lines.slice(0, 14)));
  return lines[i + 1];
}

// ------------------------------------------------------------
// 登记表本身
// ------------------------------------------------------------

test('the registry ships a v1 self-check plus one real hop, and pockets are born on v2', () => {
  const { pocketDir } = makePocket('migrate-builtin');
  assert.strictEqual(migrate.CURRENT_VERSION, 'v2');
  assert.strictEqual(migrate.latestVersion(), 'v2', '没有额外注册时 latest 就是登记表里最高的 to');
  assert.strictEqual(migrate.detectFormatVersion(pocketDir), 'v2', 'bootstrap 出来的 pocket 要自带最新戳');

  const info = migrate.listMigrations(pocketDir);
  assert.strictEqual(info.isLatest, true);
  assert.deepStrictEqual(info.path, [], '已经是 v2 的 pocket 不该有任何"往前走一步"');
  assert.ok(info.available.some((s) => s.from === 'v1' && s.to === 'v1'), JSON.stringify(info.available));
  assert.ok(info.available.some((s) => s.from === 'v1' && s.to === 'v2' && s.hasRun),
    'v1 → v2 必须是真会改内容的一跳：' + JSON.stringify(info.available));

  // 同一张表在老 pocket 面前就该给出一条可走的路
  const old = makeV1Pocket('migrate-builtin-v1');
  const pending = migrate.listMigrations(old.pocketDir);
  assert.strictEqual(pending.isLatest, false);
  assert.deepStrictEqual(pending.path.map((s) => s.from + '→' + s.to), ['v1→v2'],
    '自环的 v1 → v1 绝不能被当成往前走的一步：' + JSON.stringify(pending.path));
});

// ------------------------------------------------------------
// v1 → v2：这一跳到底改了什么
// ------------------------------------------------------------

test('v1 → v2 gives every T-block a day-precision time line taken from its own SESSION', () => {
  const { projectDir, pocketDir } = makeV1Pocket('migrate-v12');
  const before = readPocketFile(pocketDir, 'log.md');
  assert.deepStrictEqual(whenLines(before), [], '测试前提：v1 的块里不该已经有时间行');

  const done = migrate.runMigration(pocketDir, { to: 'v2' });
  assert.strictEqual(done.success, true);
  assert.deepStrictEqual(done.steps.map((s) => s.from + '→' + s.to), ['v1→v2']);

  const after = readPocketFile(pocketDir, 'log.md');
  assert.deepStrictEqual(whenLines(after), [
    '--- WHEN: 2026-05-01 (day) ---',
    '--- WHEN: 2026-05-02 (day) ---',
    '--- WHEN: 2026-05-02 (day) ---',
  ], '日期必须来自各自上方最近的 SESSION，而不是整份文件共用一个：\n' + after);

  // 紧贴标题才是"这一轮的时间"，隔一行就变成上一块的尾巴（recall/归档切块都按行范围）
  assert.strictEqual(lineAfter(after, '## T1 · 第一天第一轮 · [测试]'), '--- WHEN: 2026-05-01 (day) ---', after);
  assert.strictEqual(lineAfter(after, '## T2 · 第二天第一轮 · [测试]'), '--- WHEN: 2026-05-02 (day) ---', after);
  assert.strictEqual(lineAfter(after, '## T3 · 第二天第二轮 · [测试]'), '--- WHEN: 2026-05-02 (day) ---', after);

  // 宽化不替换：标题行、SESSION 行、小节内容一字不动
  const beforeNoWhen = before.split(/\r?\n/).filter((l) => !/^--- WHEN: /.test(l));
  const afterNoWhen = after.split(/\r?\n/).filter((l) => !/^--- WHEN: /.test(l));
  assert.deepStrictEqual(afterNoWhen, beforeNoWhen, '除了插入的时间行，v1 的每一个字节都要还在');

  assert.strictEqual(migrate.detectFormatVersion(pocketDir), 'v2', '版本号由框架统一盖');
  assert.strictEqual(verify(pocketDir).errorCount, 0, '升上来的 pocket 不能被自己的体检判错');

  // 解析器读得到，且只有"天"的精度不会假装知道钟点
  const parsed = parseLog(pocketDir);
  const t2 = parsed.blocks.find((b) => b.id === 2);
  assert.strictEqual(t2.when.kind, 'day');
  assert.strictEqual(t2.when.date, '2026-05-02');
  assert.strictEqual(t2.when.from, undefined, '只有天时不能凭空造一个 from 时刻');

  cleanBackups(projectDir);
});

test('the v1 → v2 hop covers archived blocks, is idempotent, and re-runs change nothing', () => {
  const { projectDir, pocketDir } = makeV1Pocket('migrate-archive', { base: 3 });
  // 归档里住的是更早的轮次：T1、T2 在同一天，log.md 里是升上来才有的 T3–T5
  writePocketFile(pocketDir, 'log-archive.md', [
    '# ContextPocket · LOG ARCHIVE',
    '',
    '--- SESSION: 2026-04-11 ---',
    '',
    v1Block(1, '归档第一轮', 'arch'),
    v1Block(2, '归档第二轮', 'arch'),
  ].join('\n'));

  const first = migrate.runMigration(pocketDir, { to: 'v2' });
  assert.strictEqual(first.success, true);
  assert.deepStrictEqual(whenLines(readPocketFile(pocketDir, 'log-archive.md')), [
    '--- WHEN: 2026-04-11 (day) ---',
    '--- WHEN: 2026-04-11 (day) ---',
  ], '归档里的历史块同样要有时间，否则升级之后老的轮次反而更模糊');
  assert.strictEqual(whenLines(readPocketFile(pocketDir, 'log.md')).length, 3);

  // 位置也是契约：归档按行范围切块，时间行若没紧贴自己的标题就会被切到块外面
  const archived = readPocketFile(pocketDir, 'log-archive.md');
  for (const id of [1, 2]) {
    assert.strictEqual(lineAfter(archived, `## T${id} · 归档第${id === 1 ? '一' : '二'}轮 · [测试]`),
      '--- WHEN: 2026-04-11 (day) ---', `归档里的 T${id} 时间行必须紧贴标题\n` + archived);
  }

  const logAfterFirst = readPocketFile(pocketDir, 'log.md');
  const archiveAfterFirst = readPocketFile(pocketDir, 'log-archive.md');
  const stats = migrate.migrateV1ToV2(pocketDir);
  assert.strictEqual(stats.added, 0, '重跑时已经升过的块必须被认出来：' + JSON.stringify(stats));
  assert.strictEqual(stats.already, 5, JSON.stringify(stats));
  assert.strictEqual(readPocketFile(pocketDir, 'log.md'), logAfterFirst, '幂等：重复施加一个字都不写');
  assert.strictEqual(readPocketFile(pocketDir, 'log-archive.md'), archiveAfterFirst);

  cleanBackups(projectDir);
});

test('a v1 block with no SESSION date above it is left alone instead of getting an invented date', () => {
  const { projectDir, pocketDir } = makeV1Pocket('migrate-nodate', {
    log: [
      '# ContextPocket · LOG',
      '',
      '## T1 · 没有 session 行的孤块 · [测试]',
      '',
      '### User',
      '- 用户原话：没有 session 行的孤块',
      '',
      '### Action',
      '- 创建 test/orphan.js',
      '',
      '--- SESSION: 2026-05-02 ---',
      '',
      '## T2 · 有日期的块 · [测试]',
      '',
      '### User',
      '- 用户原话：有日期的块',
      '',
      '### Action',
      '- 创建 test/dated.js',
      '',
    ].join('\n'),
  });

  const stats = migrate.migrateV1ToV2(pocketDir);
  assert.strictEqual(stats.noDate, 1, JSON.stringify(stats));
  assert.strictEqual(stats.added, 1, JSON.stringify(stats));

  const after = readPocketFile(pocketDir, 'log.md');
  assert.strictEqual(
    lineAfter(after, '## T1 · 没有 session 行的孤块 · [测试]'),
    '',
    '没有 SESSION 日期，标题下面就不许留下任何痕迹（编一个日期是假信息，会一路抄进后续记录）\n' + after
  );
  assert.ok(!/## T1[^\n]*\n--- WHEN:/.test(after), '孤块不该有时间行：' + after);
  assert.ok(/## T2 · 有日期的块 · \[测试\]\n--- WHEN: 2026-05-02 \(day\) ---/.test(after), after);

  cleanBackups(projectDir);
});

test('a CRLF v1 log.md still migrates block-for-block (and lands on the LF the writer layer promises)', () => {
  const { projectDir, pocketDir } = makeV1Pocket('migrate-crlf');
  writePocketFile(pocketDir, 'log.md', v1LogBody(1).replace(/\n/g, '\r\n'));

  assert.strictEqual(migrate.runMigration(pocketDir, { to: 'v2' }).success, true);
  const after = readPocketFile(pocketDir, 'log.md');
  assert.deepStrictEqual(whenLines(after), [
    '--- WHEN: 2026-05-01 (day) ---',
    '--- WHEN: 2026-05-02 (day) ---',
    '--- WHEN: 2026-05-02 (day) ---',
  ], 'Windows 上手工写出来的历史文件也要一块不落地升上来');
  assert.strictEqual(after.includes('\r'), false,
    'lib/io.js:37 的 normalizeText 是全写入层的行尾约定，迁移不能自己开一个例外');
  assert.strictEqual(verify(pocketDir).errorCount, 0);
  assert.strictEqual(migrate.detectFormatVersion(pocketDir), 'v2');
  assert.strictEqual(parseLog(pocketDir).blocks.length, 3);

  cleanBackups(projectDir);
});

test('cli: upgrading a v1 pocket through the CLI rewrites the log and bumps the stamp', () => {
  const { projectDir, pocketDir } = makeV1Pocket('migrate-cli-v1');

  const dry = runCli(['migrate', '--dry-run', '--json', '--dir', projectDir]);
  assert.strictEqual(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.strictEqual(plan.ok, true, plan.error);
  assert.deepStrictEqual(plan.steps.map((s) => s.from + '→' + s.to), ['v1→v2']);
  assert.strictEqual(readPocketFile(pocketDir, 'log.md').includes('--- WHEN:'), false,
    '--dry-run 只给计划，一个字节都不该写');
  assert.strictEqual(migrate.detectFormatVersion(pocketDir), 'v1');
  assert.deepStrictEqual(backupsIn(projectDir), [], 'dry-run 不该留下备份目录');

  const done = runCli(['migrate', '--json', '--dir', projectDir]);
  assert.strictEqual(done.status, 0, done.stderr);
  const res = JSON.parse(done.stdout);
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.fromVersion, 'v1');
  assert.strictEqual(res.toVersion, 'v2', '不带 --to 就该走到 latest');
  assert.strictEqual(res.steps[0].hasRun, true);
  assert.strictEqual(res.steps[0].run, undefined, '--json 里不该序列化函数');
  assert.strictEqual(whenLines(readPocketFile(pocketDir, 'log.md')).length, 3);
  assert.strictEqual(migrate.detectFormatVersion(pocketDir), 'v2');

  const again = runCli(['migrate', '--json', '--dir', projectDir]);
  const skipped = JSON.parse(again.stdout);
  assert.strictEqual(skipped.skipped, true, JSON.stringify(skipped));
  assert.ok(/Already at v2/.test(skipped.reason), skipped.reason);

  cleanBackups(projectDir);
});

// ------------------------------------------------------------
// 注册表与目标版本
// ------------------------------------------------------------

test('registerMigration validates the hop instead of accepting a broken one silently', () => {
  const { pocketDir } = makePocket('migrate-register');
  const before = migrate.listMigrations(pocketDir).available.length;

  // 干活的东西要么自带 run()，要么用内置类型；两者都没有的注册成功就是个哑弹
  assert.throws(() => migrate.registerMigration({ from: 'v2', to: 'v3', name: 'no worker' }), /run|type/);
  assert.throws(() => migrate.registerMigration({ from: 'v2', to: 'v3', run: 'not a function' }), /run must be a function/);
  assert.throws(() => migrate.registerMigration({ from: 'version-2', to: 'v3', run: () => {} }), /Invalid from/);
  assert.throws(() => migrate.registerMigration({ from: 'v2', to: 'next', run: () => {} }), /Invalid to/);

  assert.strictEqual(migrate.listMigrations(pocketDir).available.length, before,
    '被拒绝的注册绝不能留在表里');

  const unregister = migrate.registerMigration({ from: 'v2', to: 'v3', run: () => {} });
  assert.strictEqual(migrate.listMigrations(pocketDir).available.length, before + 1);
  assert.strictEqual(migrate.latestVersion(), 'v3', '注册进来的跳也要参与 latest 的计算');
  unregister();
  assert.strictEqual(migrate.listMigrations(pocketDir).available.length, before, '反注册要真的把它摘掉');
  assert.strictEqual(migrate.latestVersion(), 'v2');
});

test('--to accepts vN, a bare number and latest; anything else names the problem', () => {
  assert.strictEqual(migrate.resolveTarget(), migrate.CURRENT_VERSION, '省略时就是最新一跳');
  assert.strictEqual(migrate.resolveTarget('latest'), 'v2');
  assert.strictEqual(migrate.resolveTarget('NEWEST'), 'v2');
  assert.strictEqual(migrate.resolveTarget('V3'), 'v3');
  assert.strictEqual(migrate.resolveTarget('2'), 'v2', '"--to 2" 与 "--to v2" 是同一件事');

  assert.throws(() => migrate.resolveTarget('banana'), /Invalid target version/);
  const { pocketDir } = makePocket('migrate-badto');
  assert.throws(() => migrate.runMigration(pocketDir, { to: 'banana' }), /Invalid target version "banana"/);
});

// ------------------------------------------------------------
// 多跳
// ------------------------------------------------------------

test('one command walks a multi-hop chain, bumping the version stamp hop by hop', () => {
  const { projectDir, pocketDir } = makePocket('migrate-chain');
  record(pocketDir, 'chain turn');
  const off1 = appendHop('v2', 'v3', '<!-- hop-to-v3 -->');
  const off2 = appendHop('v3', 'v4', '<!-- hop-to-v4 -->');

  try {
    assert.strictEqual(migrate.latestVersion(), 'v4');
    const info = migrate.listMigrations(pocketDir);
    assert.strictEqual(info.targetVersion, 'v4', '不带 --to 就该走到登记表里最新的一跳');
    assert.deepStrictEqual(info.path.map((s) => s.from + '→' + s.to), ['v2→v3', 'v3→v4'],
      JSON.stringify(info.path));

    // dry-run：计划完整，一个字节都不写，也不留备份
    const dry = migrate.runMigration(pocketDir, { dryRun: true });
    assert.deepStrictEqual(dry.planned.map((s) => s.to), ['v3', 'v4']);
    assert.strictEqual(dry.planned[0].hasRun, true, '--json 里要看得出这一跳是真干活还是空跑');
    assert.strictEqual(migrate.detectFormatVersion(pocketDir), 'v2', 'dry-run 之后版本戳必须没动');
    assert.strictEqual(readPocketFile(pocketDir, 'readme.md').includes('hop-to-v3'), false);
    assert.deepStrictEqual(backupsIn(projectDir), [], 'dry-run 不该留下备份目录');

    const done = migrate.runMigration(pocketDir, {});
    assert.strictEqual(done.toVersion, 'v4');
    assert.deepStrictEqual(done.steps.map((s) => s.from + '→' + s.to), ['v2→v3', 'v3→v4']);
    assert.strictEqual(done.steps[0].run, undefined, '返回给 CLI/--json 的步骤里不该带函数');
    assert.strictEqual(migrate.detectFormatVersion(pocketDir), 'v4', '版本戳要跟着链走到终点');
    const readme = readPocketFile(pocketDir, 'readme.md');
    assert.strictEqual(readme.split('hop-to-v3').length - 1, 1, '每一跳只跑一次');
    assert.strictEqual(readme.split('hop-to-v4').length - 1, 1, '第二跳没跑就等于没升完');
    assert.strictEqual(verify(pocketDir).errorCount, 0, '升完的版本号不能被自己的体检判错');
    assert.ok(fs.existsSync(done.backupPath), '备份要留着给用户对比');

    // 幂等：已经在最新版本，再跑一次不该重复施加任何一跳
    const again = migrate.runMigration(pocketDir, {});
    assert.strictEqual(again.skipped, true, JSON.stringify(again));
    assert.strictEqual(readPocketFile(pocketDir, 'readme.md'), readme, 'skipped 之后不该有任何写入');
    assert.strictEqual(migrate.detectFormatVersion(pocketDir), 'v4');
  } finally {
    off1();
    off2();
    cleanBackups(projectDir);
  }
  assert.strictEqual(migrate.latestVersion(), 'v2', '反注册之后登记表必须回到原样，别污染后面的用例');
});

test('a chain can stop at an intermediate version instead of the newest', () => {
  const { projectDir, pocketDir } = makePocket('migrate-partial');
  record(pocketDir, 'partial turn');
  const off1 = appendHop('v2', 'v3', '<!-- p-v3 -->');
  const off2 = appendHop('v3', 'v4', '<!-- p-v4 -->');
  try {
    const r = migrate.runMigration(pocketDir, { to: 'v3' });
    assert.strictEqual(r.toVersion, 'v3');
    assert.deepStrictEqual(r.steps.map((s) => s.to), ['v3'], '指定终点就不该多走一跳');
    assert.strictEqual(migrate.detectFormatVersion(pocketDir), 'v3');
    assert.strictEqual(readPocketFile(pocketDir, 'readme.md').includes('p-v4'), false);
  } finally {
    off1();
    off2();
    cleanBackups(projectDir);
  }
});

// ------------------------------------------------------------
// 回滚
// ------------------------------------------------------------

test('a hop that fails mid-chain rolls the whole pocket back, not just that hop', () => {
  const { projectDir, pocketDir } = makePocket('migrate-rollback');
  record(pocketDir, 'rollback turn');
  const logBefore = readPocketFile(pocketDir, 'log.md');
  const readmeBefore = readPocketFile(pocketDir, 'readme.md');

  let firstRan = false;
  const off1 = migrate.registerMigration({
    from: 'v2', to: 'v3', name: 'writes something',
    run: (dir) => { firstRan = true; fs.appendFileSync(path.join(dir, 'readme.md'), '\n<!-- ran-v3 -->\n'); },
  });
  const off2 = migrate.registerMigration({
    from: 'v3', to: 'v4', name: 'explodes',
    run: () => { throw new Error('kaboom in the v4 hop'); },
  });

  try {
    assert.throws(
      () => migrate.runMigration(pocketDir, {}),
      (e) => /kaboom in the v4 hop/.test(e.message) && /v3 → v4/.test(e.message),
      '报错必须同时说清是哪一跳炸的：'
    );
  } finally {
    off1();
    off2();
  }

  assert.strictEqual(firstRan, true, '前提：第一跳真的施加过，回滚才有意义');
  assert.strictEqual(readPocketFile(pocketDir, 'readme.md'), readmeBefore,
    '失败的是第二跳，但第一跳的写入也必须一起撤掉');
  assert.strictEqual(readPocketFile(pocketDir, 'log.md'), logBefore);
  assert.strictEqual(migrate.detectFormatVersion(pocketDir), 'v2', '回滚后不能停在半路的 v3');
  assert.strictEqual(verify(pocketDir).errorCount, 0, '回滚之后的 pocket 必须仍然是健康的');
  assert.deepStrictEqual(backupsIn(projectDir), [], '回滚之后不该留一堆备份目录');
});

test('a hop that corrupts data without throwing is still caught and rolled back', () => {
  const { projectDir, pocketDir } = makePocket('migrate-postverify');
  record(pocketDir, 'corrupt turn');
  const logBefore = readPocketFile(pocketDir, 'log.md');

  // 不抛异常，只是把 log.md 写成坏数据 —— 只有迁移后的体检能发现它
  const off = migrate.registerMigration({
    from: 'v2', to: 'v3', name: 'silently corrupts log.md',
    run: (dir) => fs.writeFileSync(path.join(dir, 'log.md'), '# Log\n\n## T99999999999999999 · broken\n\n### User\n- x\n'),
  });
  try {
    assert.throws(() => migrate.runMigration(pocketDir, {}), /Post-migration verify failed.*Rolled back to v2/s);
  } finally {
    off();
  }
  assert.strictEqual(readPocketFile(pocketDir, 'log.md'), logBefore, '坏写入必须被回滚掉');
  assert.strictEqual(migrate.detectFormatVersion(pocketDir), 'v2');
  assert.strictEqual(verify(pocketDir).errorCount, 0);
  assert.deepStrictEqual(backupsIn(projectDir), []);
});

test('migration refuses to start on a pocket that already fails verify, and leaves no backup behind', () => {
  const { projectDir, pocketDir } = makePocket('migrate-dirty');
  record(pocketDir, 'dirty turn');
  // 缺 ### User 的 T-block 是 error（README 明写：这种块会被 hook 拦下提交）
  writePocketFile(pocketDir, 'log.md', readPocketFile(pocketDir, 'log.md').replace(/### User\n[^\n]*\n/, ''));
  assert.ok(verify(pocketDir).errorCount > 0, '测试前提：这个 pocket 必须先真的不健康');

  const off = migrate.registerMigration({
    from: 'v2', to: 'v3', name: 'must never run',
    run: () => { throw new Error('ran on a dirty pocket'); },
  });
  try {
    assert.throws(() => migrate.runMigration(pocketDir, { to: 'v3' }), /Cannot migrate: verify found/);
  } finally {
    off();
  }
  assert.deepStrictEqual(backupsIn(projectDir), [], '什么都没改就别留下备份目录污染项目');
});

// ------------------------------------------------------------
// 找不到路径
// ------------------------------------------------------------

test('an unreachable target lists the registered hops instead of a bare "no path"', () => {
  const { pocketDir } = makePocket('migrate-nopath');
  record(pocketDir, 'island turn');
  const off = migrate.registerMigration({ from: 'v7', to: 'v8', name: 'unrelated island', run: () => {} });
  try {
    const info = migrate.listMigrations(pocketDir, 'v9');
    assert.deepStrictEqual(info.path, []);
    assert.ok(/No migration path from v2 to v9/.test(info.error), info.error);
    assert.ok(/v7 → v8: unrelated island/.test(info.error), '报错要把可注册的跳列出来：' + info.error);

    assert.throws(() => migrate.runMigration(pocketDir, { to: 'v9' }), /v7 → v8: unrelated island/);
  } finally {
    off();
  }
});

// ------------------------------------------------------------
// CLI 契约
// ------------------------------------------------------------

test('cli: migrate --to latest and --list are honest about what the registry can do', () => {
  const { projectDir, pocketDir } = makePocket('migrate-cli');
  record(pocketDir, 'cli turn');

  const listed = runCli(['migrate', '--list', '--json', '--dir', projectDir]);
  assert.strictEqual(listed.status, 0, listed.stderr);
  const info = JSON.parse(listed.stdout);
  assert.strictEqual(info.ok, true);
  assert.strictEqual(info.currentVersion, 'v2');
  assert.strictEqual(info.latestVersion, 'v2');
  assert.strictEqual(info.isLatest, true);
  assert.ok(Array.isArray(info.available) && info.available.length > 0);

  const human = runCli(['migrate', '--list', '--dir', projectDir]);
  assert.strictEqual(human.status, 0, human.stderr);
  assert.ok(/Latest registered: v2/.test(human.stdout), human.stdout);
  assert.ok(/Registered steps:/.test(human.stdout), human.stdout);

  const latest = runCli(['migrate', '--to', 'latest', '--json', '--dir', projectDir]);
  assert.strictEqual(latest.status, 0, latest.stderr);
  const res = JSON.parse(latest.stdout);
  assert.strictEqual(res.skipped, true, JSON.stringify(res));
  assert.ok(/Already at v2/.test(res.reason), res.reason);
  assert.deepStrictEqual(backupsIn(projectDir), [], '跳过时不该留备份');
});

test('cli: a bad target is a JSON error with exit 1, not a stack trace', () => {
  const { projectDir } = makePocket('migrate-cli-bad');
  const r = runCli(['migrate', '--to', 'banana', '--json', '--dir', projectDir]);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.ok, false);
  assert.ok(/Invalid target version "banana"/.test(parsed.error), parsed.error);
});
