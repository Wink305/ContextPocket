'use strict';

/**
 * CLI 契约测试：以子进程方式跑真实入口，重点验证 --json 的承诺
 * （SKILL.md 写着 "Use --json for machine-readable output"，那就必须成立）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { assert, test, makePocket, makeV1Pocket, tmpProject, ROOT } = require('./harness');

const CLI = path.join(ROOT, 'bin', 'context-pocket.js');
const { HELP_COL } = require(path.join(ROOT, 'bin', 'context-pocket.js'));

function runCli(args, dir) {
  const argv = [...args];
  if (dir) argv.push('--dir', dir);
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...argv], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

/** --json 的输出必须是"一行能 JSON.parse 的东西"，不能混进排版 */
function parseJsonLine(result) {
  const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.strictEqual(lines.length, 1, '--json 只应输出一行，实际：\n' + result.stdout);
  return JSON.parse(lines[0]);
}

test('cli: status --json is one parseable line', () => {
  const { pocketDir } = makePocket('cli-status');
  const r = runCli(['status', '--json'], pocketDir);
  assert.strictEqual(r.code, 0, r.stderr);
  const data = parseJsonLine(r);
  assert.strictEqual(data.ok, true);
  assert.strictEqual(typeof data.latestT, 'number');
  assert.strictEqual(typeof data.requirements.open, 'number');
});

test('cli: human output is untouched by --json support', () => {
  const { pocketDir } = makePocket('cli-human');
  const r = runCli(['status'], pocketDir);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(/ContextPocket · Status/.test(r.stdout));
  assert.ok(!/^\{/.test(r.stdout.trim()));
});

test('cli: log append --json reports the id the next status uses', () => {
  const { pocketDir } = makePocket('cli-append');
  const before = parseJsonLine(runCli(['status', '--json'], pocketDir)).latestT;
  const appended = parseJsonLine(runCli(['log', 'append', '--gist', 'cli probe', '--user', 'u', '--action', 'a', '--json'], pocketDir));
  assert.strictEqual(appended.ok, true);
  assert.strictEqual(appended.tId, before + 1);
  assert.strictEqual(parseJsonLine(runCli(['status', '--json'], pocketDir)).latestT, before + 1);
});

test('cli: missing T-id is a JSON error with exit 1', () => {
  const { pocketDir } = makePocket('cli-recall-missing');
  const r = runCli(['recall', '--json'], pocketDir);
  assert.strictEqual(r.code, 1);
  const data = parseJsonLine(r);
  assert.strictEqual(data.ok, false);
  assert.ok(/T-id/.test(data.error));
});

test('cli: unknown command is a JSON error, not a stack trace', () => {
  const { pocketDir } = makePocket('cli-unknown');
  const r = runCli(['such', 'command', '--json'], pocketDir);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(parseJsonLine(r).ok, false);
});

test('cli: no pocket is a JSON error with exit 1', () => {
  const projectDir = tmpProject('cli-nopocket');
  const r = runCli(['status', '--json'], projectDir);
  assert.strictEqual(r.code, 1);
  const data = parseJsonLine(r);
  assert.strictEqual(data.ok, false);
  assert.ok(/ContextPocket/.test(data.error));
});

test('cli: verify --json keeps the non-zero exit code', () => {
  const { pocketDir } = makePocket('cli-verify');
  // 直接造一个缺 User 段的块，让 verify 报错
  const logPath = path.join(pocketDir, 'log.md');
  fs.appendFileSync(logPath, '\n## T900 · broken block\n\n### Action\n- touched x.js\n\n', 'utf-8');
  const r = runCli(['verify', '--json'], pocketDir);
  assert.strictEqual(r.code, 1, '有 error 时 verify 必须返回 1：' + r.stdout);
  const data = parseJsonLine(r);
  assert.strictEqual(data.ok, false);
  assert.ok(data.errorCount > 0);
});

test('cli: search --json count matches the result list', () => {
  const { pocketDir } = makePocket('cli-search');
  runCli(['log', 'append', '--gist', 'uniquekw turn', '--user', 'u', '--json'], pocketDir);
  const data = parseJsonLine(runCli(['search', 'uniquekw', '--json'], pocketDir));
  assert.strictEqual(data.ok, true);
  assert.strictEqual(data.count, data.results.length);
  assert.ok(data.count >= 1);
});

const rowKey = (r) => (r.type === 'T' ? 'T' + r.id
  : r.type === 'ADR' ? 'ADR' + r.adrId
    : r.type === 'R' ? 'R' + r.rId
      : 'pref:' + r.line);

test('cli: index vs --no-index search return the same hits in the same order', () => {
  const { pocketDir } = makePocket('cli-search-parity');
  for (let i = 1; i <= 3; i++) {
    runCli(['log', 'append', '--gist', 'parity turn ' + i, '--user', 'u', '--no-index', '--json'], pocketDir);
  }
  runCli(['decision', 'add', '--title', 'parity decision', '--json'], pocketDir);
  runCli(['req', 'add', 'parity requirement', '--json'], pocketDir);

  const viaIndex = parseJsonLine(runCli(['search', 'parity', '--json'], pocketDir));
  const scanned = parseJsonLine(runCli(['search', 'parity', '--no-index', '--json'], pocketDir));

  // 不只是数量一致：顺序也要一致，否则 --offset 翻页会随路径丢条或重条
  assert.deepStrictEqual(viaIndex.results.map(rowKey), scanned.results.map(rowKey),
    '两条搜索路径的命中序列必须完全相同');
  assert.strictEqual(viaIndex.total, scanned.total);
  assert.ok(viaIndex.results.some((r) => r.type === 'ADR'), 'ADR 应可被搜到');
  assert.ok(viaIndex.results.some((r) => r.type === 'R'), '需求应可被搜到');
});

test('cli: search --limit/--offset page without hiding the total', () => {
  const { pocketDir } = makePocket('cli-search-page');
  for (let i = 1; i <= 5; i++) {
    runCli(['log', 'append', '--gist', 'paged turn ' + i, '--user', 'u', '--no-index', '--json'], pocketDir);
  }

  const page1 = parseJsonLine(runCli(['search', 'paged', '--limit', '2', '--json'], pocketDir));
  assert.strictEqual(page1.total, 5, 'total 必须是全量命中数，不是本页条数');
  assert.strictEqual(page1.count, 2);
  assert.strictEqual(page1.offset, 0);
  assert.strictEqual(page1.limit, 2);
  assert.strictEqual(page1.hasMore, true);

  const page3 = parseJsonLine(runCli(['search', 'paged', '--limit', '2', '--offset', '4', '--json'], pocketDir));
  assert.strictEqual(page3.count, 1);
  assert.strictEqual(page3.hasMore, false);

  // 逐页拼起来 = 一次全量：分页不能引入重条或漏条
  const all = parseJsonLine(runCli(['search', 'paged', '--limit', '0', '--json'], pocketDir));
  assert.strictEqual(all.count, 5, '--limit 0 应返回全部');
  assert.strictEqual(all.hasMore, false);
  const paged = [];
  for (let off = 0; off < all.total; off += 2) {
    const p = parseJsonLine(runCli(['search', 'paged', '--limit', '2', '--offset', String(off), '--json'], pocketDir));
    paged.push(...p.results.map(rowKey));
  }
  assert.deepStrictEqual(paged, all.results.map(rowKey));

  // 扫描路径翻的是同一份结果
  const scanPage = parseJsonLine(runCli(['search', 'paged', '--limit', '2', '--offset', '2', '--no-index', '--json'], pocketDir));
  assert.deepStrictEqual(scanPage.results.map(rowKey), all.results.slice(2, 4).map(rowKey));
});

test('cli: bootstrap surfaces what it could not do instead of staying silent', () => {
  const dir = tmpProject('cli-init-warn');
  fs.writeFileSync(path.join(dir, 'package.json'), '{ this is not valid json', 'utf-8');

  const data = parseJsonLine(runCli(['bootstrap', '--json'], dir));
  assert.strictEqual(data.ok, true);
  assert.ok(Array.isArray(data.warnings), 'warnings 要进 JSON：' + JSON.stringify(data));
  assert.ok(data.warnings.some((w) => /package\.json/.test(w)),
    '坏掉的 package.json 必须留下话，否则项目类型是猜的却看不出来：' + JSON.stringify(data.warnings));

  // 人读输出同样要说，否则只有 --json 的调用方知道有问题
  const dir2 = tmpProject('cli-init-warn-human');
  fs.writeFileSync(path.join(dir2, 'package.json'), '{ nope', 'utf-8');
  const human = runCli(['bootstrap'], dir2);
  assert.strictEqual(human.code, 0, '有 warning 不该让 bootstrap 失败');
  assert.ok(/warning/i.test(human.stdout), human.stdout);
});

test('cli: past-the-end offset is an empty page, not an error', () => {
  const { pocketDir } = makePocket('cli-search-overshoot');
  runCli(['log', 'append', '--gist', 'only turn', '--user', 'u', '--no-index', '--json'], pocketDir);
  const data = parseJsonLine(runCli(['search', 'only', '--offset', '99', '--json'], pocketDir));
  assert.strictEqual(data.ok, true);
  assert.strictEqual(data.total, 1);
  assert.strictEqual(data.count, 0);
  assert.strictEqual(data.hasMore, false);
});

test('cli: a second bootstrap is a no-op, not an error', () => {
  // 激活是全自动的（SKILL.md：用户永远不需要执行命令）。用户说「开始记一下」时
  // 项目往往已经有 ContextPocket/：旧实现在这里退 1，--json 还会吐出带 emoji 的
  // 人读文本，Agent 于是以为"初始化失败"，转而放弃记录或去手改 markdown。
  const { projectDir, pocketDir } = makePocket('cli-init-twice');
  runCli(['log', 'append', '--gist', 'real turn', '--user', 'u', '--action', '修改 src/a.ts — x', '--json'], pocketDir);
  const before = fs.readFileSync(path.join(pocketDir, 'log.md'), 'utf-8');

  const human = runCli(['bootstrap'], projectDir);
  assert.strictEqual(human.code, 0, '已有 pocket 时 bootstrap 不该失败：\n' + human.stdout + human.stderr);
  assert.ok(/already exists/i.test(human.stdout), human.stdout);

  const data = parseJsonLine(runCli(['bootstrap', '--json'], projectDir));
  assert.strictEqual(data.ok, true);
  assert.strictEqual(data.alreadyExists, true, JSON.stringify(data));

  // 幂等的真正含义：一个字节都不能动
  assert.strictEqual(fs.readFileSync(path.join(pocketDir, 'log.md'), 'utf-8'), before);
  const status = parseJsonLine(runCli(['status', '--json'], pocketDir));
  assert.strictEqual(status.latestT, 1, '重跑 bootstrap 不该把历史清零');
});

test('cli: bootstrap --no-hub keeps the user hub clean while the default still registers', () => {
  // bootstrap 唯一的家目录副作用就是往 hub.json 里加一行。脚本试跑、临时目录、CI
  // 每跑一次都会在用户的项目清单里留下一条永久记录，而用户从没要求过这件事。
  const hubFile = path.join(process.env.CONTEXTPOCKET_HOME, 'hub.json');
  const key = (dir) => path.resolve(dir).replace(/\\/g, '/');
  const hubKeys = () => {
    try {
      return Object.keys(JSON.parse(fs.readFileSync(hubFile, 'utf-8')).projects || {});
    } catch (e) {
      return [];
    }
  };

  const plain = tmpProject('cli-hub-default');
  const dataPlain = parseJsonLine(runCli(['bootstrap', '--json'], plain));
  assert.strictEqual(dataPlain.ok, true, JSON.stringify(dataPlain));
  assert.strictEqual(dataPlain.hubSkipped, false, JSON.stringify(dataPlain));
  assert.ok(dataPlain.hub && dataPlain.hub.key === key(plain), '默认仍要注册：' + JSON.stringify(dataPlain));
  assert.ok(hubKeys().indexOf(key(plain)) >= 0, 'hub.json 里应有一条：' + JSON.stringify(hubKeys()));

  const skipped = tmpProject('cli-hub-skip');
  const dataSkip = parseJsonLine(runCli(['bootstrap', '--json', '--no-hub'], skipped));
  assert.strictEqual(dataSkip.ok, true, JSON.stringify(dataSkip));
  assert.ok(fs.existsSync(path.join(skipped, 'ContextPocket')), '--no-hub 只关注册，pocket 照样要建出来');
  assert.strictEqual(dataSkip.hub, null, JSON.stringify(dataSkip));
  assert.strictEqual(dataSkip.hubSkipped, true, JSON.stringify(dataSkip));
  assert.ok(hubKeys().indexOf(key(skipped)) < 0, '--no-hub 之后 hub.json 不该多这一条：' + JSON.stringify(hubKeys()));
  assert.ok(hubKeys().indexOf(key(plain)) >= 0, '跳过一条不该把别的项目清掉');

  // 人类输出必须说清"没写"，不然调用方以为已经进了项目清单
  const humanSkip = runCli(['bootstrap', '--no-hub'], tmpProject('cli-hub-skip-human'));
  assert.strictEqual(humanSkip.code, 0, humanSkip.stdout + humanSkip.stderr);
  assert.ok(/Hub: skipped \(--no-hub\)/.test(humanSkip.stdout), humanSkip.stdout);

  // 已有 pocket 的幂等分支同样认这个开关（它也会注册）
  const existing = tmpProject('cli-hub-existing');
  parseJsonLine(runCli(['bootstrap', '--json'], existing));
  assert.ok(hubKeys().indexOf(key(existing)) >= 0);
  const again = parseJsonLine(runCli(['bootstrap', '--json', '--no-hub'], existing));
  assert.strictEqual(again.alreadyExists, true, JSON.stringify(again));
  assert.strictEqual(again.hub, null, JSON.stringify(again));
  assert.strictEqual(again.hubSkipped, true, JSON.stringify(again));
  assert.ok(hubKeys().indexOf(key(existing)) >= 0, '跳过注册不等于删掉已有条目');

  // 幂等分支的人类输出也要把 hub 这件事说出来：README/SKILL 教用户"去掉 --no-hub 重跑就
  // 能补登记"，而这条分支原本一句话都不提 hub，重跑之后屏幕上找不到任何证据。
  const humanExistingSkip = runCli(['bootstrap', '--no-hub'], existing);
  assert.ok(/already exists/i.test(humanExistingSkip.stdout), humanExistingSkip.stdout);
  assert.ok(/Hub: skipped \(--no-hub\)/.test(humanExistingSkip.stdout), '幂等分支要说清没写：\n' + humanExistingSkip.stdout);
  const humanExistingReg = runCli(['bootstrap'], existing);
  assert.ok(/Hub: registered in /.test(humanExistingReg.stdout), '补登记要在屏幕上看得见：\n' + humanExistingReg.stdout);
  assert.ok(hubKeys().indexOf(key(existing)) >= 0);

  // --no-hub 是开关，绝不吞掉后面的裸词（parseArgs 的老毛病）
  const swallowed = tmpProject('cli-hub-flag-eats');
  const parsed = runCli(['bootstrap', '--json', '--no-hub', '--mode', 'lite'], swallowed);
  assert.strictEqual(parseJsonLine(parsed).mode, 'lite', '--no-hub 不能把 --mode 挤掉：' + parsed.stdout);
});

test('cli: one T id has one meaning — positional / --t-id / --t / --id all land', () => {
  // 一个 T 号曾有三种拼写：recall 只认 --id、log amend 只认 --t、absolute add 只认 --t-id。
  // 三个名字都在 VALUE_OPTIONS 里，所以猜错的那一种会被 parseArgs 正常解析、再被命令丢掉，
  // 报错于是谎称"你没传"——而用户明明传了。这里把四种写法钉住。
  const { pocketDir } = makePocket('cli-tid-alias');
  for (const gist of ['第一轮', '第二轮', '第三轮']) {
    const r = runCli(['log', 'append', '--gist', gist, '--user', '原话', '--action', '新增 a.js', '--json'], pocketDir);
    assert.strictEqual(r.code, 0, r.stderr);
  }
  const logText = () => fs.readFileSync(path.join(pocketDir, 'log.md'), 'utf-8');

  // recall：三种选项写法都要取到同一块
  const byPos = runCli(['recall', '2'], pocketDir);
  assert.strictEqual(byPos.code, 0, byPos.stderr);
  assert.ok(byPos.stdout.includes('第二轮'), byPos.stdout);
  for (const argv of [['recall', '--t-id', '2'], ['recall', '--t', '2'], ['recall', '--id', '2']]) {
    const r = runCli(argv, pocketDir);
    assert.strictEqual(r.code, 0, argv.join(' ') + ' 该和位置参数等价：\n' + (r.stderr || r.stdout));
    assert.strictEqual(r.stdout, byPos.stdout, argv.join(' ') + ' 取到的不是同一块');
  }

  // diff：位置一对，或按 MCP 的 tA / tB 写成 --t-a / --t-b
  const diffPos = runCli(['diff', '1', '2'], pocketDir);
  assert.strictEqual(diffPos.code, 0, diffPos.stderr);
  const diffOpt = runCli(['diff', '--t-a', '1', '--t-b', '2'], pocketDir);
  assert.strictEqual(diffOpt.code, 0, diffOpt.stderr);
  assert.strictEqual(diffOpt.stdout, diffPos.stdout, '--t-a/--t-b 必须与位置参数同解');

  // log amend：别名不再谎称"没传"
  const amendAlias = runCli(['log', 'amend', '--id', '3', '--pitfalls', '别名写法'], pocketDir);
  assert.strictEqual(amendAlias.code, 0, amendAlias.stderr + amendAlias.stdout);
  assert.ok(/别名写法/.test(logText()), 'amend 得真的写进 T3：\n' + logText());

  // absolute add：--t 1 把红线盖在 T1 上，而不是默认的 latest T（3）
  const abs = runCli(['absolute', 'add', '--text', '绝不允许改 /api/v1 的响应字段', '--t', '1', '--json'], pocketDir);
  assert.strictEqual(abs.code, 0, abs.stderr);
  assert.strictEqual(parseJsonLine(abs).absolute.tId, 1, JSON.stringify(parseJsonLine(abs)));
  assert.ok(/## 🔒 T1 ·/.test(fs.readFileSync(path.join(pocketDir, 'absolute.md'), 'utf-8')), '🔒 条目的号要跟传进来的一致');

  // 只写 flag 不给值 = 真的没传，这时报"required"才是实话
  const noValue = runCli(['recall', '--t'], pocketDir);
  assert.strictEqual(noValue.code, 1);
  assert.ok(/T-id is required/.test(noValue.stderr), '缺值应如实报 required：\n' + noValue.stderr);

  // 无效值不会被别名口径吞掉
  const bad = runCli(['recall', '--t-id', 'abc'], pocketDir);
  assert.strictEqual(bad.code, 1);
  assert.ok(/Invalid T-id/.test(bad.stderr), bad.stderr);

  // absolute add 指名的号如果不成数字，过去会被 intOption 静默丢掉、盖到最新 T 上
  const badAbs = runCli(['absolute', 'add', '--text', '不许动这条', '--t', 'abc', '--json'], pocketDir);
  assert.strictEqual(badAbs.code, 1, '非法 T 号必须报错：\n' + badAbs.stdout + badAbs.stdout);
  assert.ok(/Invalid T-id/.test(badAbs.stderr + badAbs.stdout), badAbs.stderr + badAbs.stdout);
  assert.ok(!/## 🔒 T3 · 不许动这条/.test(fs.readFileSync(path.join(pocketDir, 'absolute.md'), 'utf-8')),
    '报错的那条不能被悄悄盖到最新 T 上：\n' + fs.readFileSync(path.join(pocketDir, 'absolute.md'), 'utf-8'));
  // 带 T 前缀的写法与 recall 同一判据（toTId），能落到指名的那一轮
  const prefixed = runCli(['absolute', 'add', '--text', '带前缀的写法', '--t', 'T2', '--json'], pocketDir);
  assert.strictEqual(prefixed.code, 0, prefixed.stderr);
  assert.strictEqual(parseJsonLine(prefixed).absolute.tId, 2, JSON.stringify(parseJsonLine(prefixed)));

  // migrate 的 --list-only 是 --list 的别名，帮助里必须教、行为必须同
  const listHelp = runCli(['migrate', '--help'], pocketDir);
  assert.ok(/--list-only/.test(listHelp.stdout), 'migrate --help 没教 --list-only：\n' + listHelp.stdout);
  const listOnly = runCli(['migrate', '--list-only', '--json'], pocketDir);
  assert.strictEqual(listOnly.code, 0, listOnly.stderr);
  assert.deepStrictEqual(parseJsonLine(listOnly), parseJsonLine(runCli(['migrate', '--list', '--json'], pocketDir)),
    '--list-only 与 --list 必须同解');

  // 帮助文本得教这几种写法，否则下一个人照样猜错
  const helps = [
    [['recall', '--help'], '--t-id'],
    [['diff', '--help'], '--t-a'],
    [['log', 'amend', '--help'], '--t-id'],
    [['absolute', 'add', '--help'], '--t <n>'],
  ];
  for (const [argv, needle] of helps) {
    const h = runCli(argv, pocketDir);
    assert.strictEqual(h.code, 0, h.stderr);
    assert.ok(h.stdout.includes(needle), argv.join(' ') + ' 的帮助里没教 "' + needle + '"：\n' + h.stdout);
  }
});

test('cli: one file path has one meaning — positional / --file-path / --file / -f all land', () => {
  // "文件路径"在 MCP 叫 filePath、在 CLI 只认 --file：写成 --file-path 会被 parseArgs
  // 正常解析再丢掉，why 于是谎称"你没传"。三种写法 + 位置参数必须同解，且缺值仍要报错。
  const { projectDir, pocketDir } = makePocket('cli-filepath-alias');
  const r = runCli(['log', 'append', '--gist', '改了鉴权', '--user', '原话', '--action', '新增 src/auth.js', '--json'], projectDir);
  assert.strictEqual(r.code, 0, r.stderr);

  const byPos = runCli(['why', 'src/auth.js'], pocketDir);
  assert.strictEqual(byPos.code, 0, byPos.stderr);
  assert.ok(byPos.stdout.includes('src/auth.js'), byPos.stdout);
  for (const argv of [['why', '--file-path', 'src/auth.js'], ['why', '--file', 'src/auth.js'], ['why', '-f', 'src/auth.js']]) {
    const hit = runCli(argv, pocketDir);
    assert.strictEqual(hit.code, 0, argv.join(' ') + ' 该和位置参数等价：\n' + (hit.stderr || hit.stdout));
    assert.strictEqual(hit.stdout, byPos.stdout, argv.join(' ') + ' 查的不是同一个路径');
  }

  // 只写 flag 不给值 = 真的没传，报 required 才是实话
  const whyNoValue = runCli(['why', '--file-path'], pocketDir);
  assert.strictEqual(whyNoValue.code, 1);
  assert.ok(/file path is required/.test(whyNoValue.stderr), whyNoValue.stderr);

  // import 的会话文件同理：--file-path 要与 --file 同解，缺值要报错且一个字都不写
  const session = path.join(tmpProject('cli-filepath-session'), 'sess.jsonl');
  fs.writeFileSync(session, JSON.stringify({
    type: 'user', timestamp: '2026-09-01T08:00:00.000Z', message: { role: 'user', content: '把导入路径的写法钉住' },
  }) + '\n' + JSON.stringify({
    type: 'assistant', timestamp: '2026-09-01T08:01:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
  }) + '\n', 'utf-8');
  const logBefore = fs.readFileSync(path.join(pocketDir, 'log.md'), 'utf-8');
  const byFile = runCli(['import', '--file', session, '--dry-run', '--json'], projectDir);
  assert.strictEqual(byFile.code, 0, byFile.stderr);
  for (const flag of ['--file-path', '-f']) {
    const alt = runCli(['import', flag, session, '--dry-run', '--json'], projectDir);
    assert.strictEqual(alt.code, 0, flag + ' 该与 --file 同解：\n' + (alt.stderr || alt.stdout));
    assert.strictEqual(alt.stdout, byFile.stdout, flag + ' 读到的不是同一个会话文件');
  }
  const importNoValue = runCli(['import', '--file-path'], projectDir);
  assert.strictEqual(importNoValue.code, 1);
  assert.ok(/session file is required/.test(importNoValue.stderr), importNoValue.stderr);
  assert.strictEqual(fs.readFileSync(path.join(pocketDir, 'log.md'), 'utf-8'), logBefore, '报错的 import 不能写任何东西');

  // 帮助文本得教这几种写法
  for (const [argv, needle] of [[['why', '--help'], '--file-path'], [['import', '--help'], '--file-path']]) {
    const h = runCli(argv, pocketDir);
    assert.strictEqual(h.code, 0, h.stderr);
    assert.ok(h.stdout.includes(needle), argv.join(' ') + ' 的帮助里没教 "' + needle + '"：\n' + h.stdout);
  }
});

test('cli: a flag with no value is "not given" — never a literal true in the record', () => {
  // parseArgs 把 `--summary --json` 解析成 summary === true。这些值型选项全在
  // VALUE_OPTIONS 里，所以 true 会一路走到写入层，在 markdown 里留下一句谎话。
  // 22 个命令 × 全部带值选项扫过的结果：absolute add --gist、req add --status、
  // decision add 的五节、state update 的三个字段曾经都会落盘 "true"。这里全钉住。
  const { projectDir, pocketDir } = makePocket('cli-bare-flag');
  const r = runCli(['log', 'append', '--gist', '基准轮', '--user', '原话', '--action', '新增 a.js', '--json'], projectDir);
  assert.strictEqual(r.code, 0, r.stderr);
  const pocketFile = (f) => fs.readFileSync(path.join(pocketDir, f), 'utf-8');

  const cases = [
    [['absolute', 'add', '--text', '红线一条', '--gist'], 'absolute.md'],
    [['req', 'add', '一条需求', '--status'], 'requirements.md'],
    [['decision', 'add', '--title', '用 A 不用 B', '--context'], 'decisions.md'],
    [['decision', 'add', '--title', '用 A 不用 B', '--options'], 'decisions.md'],
    [['decision', 'add', '--title', '用 A 不用 B', '--decision'], 'decisions.md'],
    [['decision', 'add', '--title', '用 A 不用 B', '--consequences'], 'decisions.md'],
    [['decision', 'add', '--title', '用 A 不用 B', '--supersedes'], 'decisions.md'],
    [['state', 'update', '--summary'], 'state.md'],
    [['state', 'update', '--next-step'], 'state.md'],
    [['state', 'update', '--pitfall'], 'state.md'],
    [['state', 'update', '--pitfalls'], 'state.md'],
  ];
  for (const [argv, file] of cases) {
    const before = pocketFile(file);
    const run = runCli(argv, projectDir);
    const text = pocketFile(file);
    const added = text.split('\n').filter((l, i) => before.split('\n').indexOf(l) < 0);
    assert.ok(!added.some((l) => /(^|[\s:>-])true(\s|$)/.test(l)),
      argv.join(' ') + ' 不该往 ' + file + ' 里写下 true（exit=' + run.code + '）：\n' + added.join('\n'));
  }

  // state update 三个字段全空 = 什么都没打算改，报错而不是"成功"
  const nothing = runCli(['state', 'update', '--summary'], projectDir);
  assert.strictEqual(nothing.code, 1, nothing.stdout);
  assert.ok(/At least one option is required/.test(nothing.stderr + nothing.stdout), nothing.stderr);
  // --json 下也不能留字面量 true：判据在 lib/fields.js textOption，两个入口共用
  const asJson = runCli(['log', 'append', '--gist', 'true 的字符串值', '--json'], projectDir);
  assert.strictEqual(asJson.code, 0, asJson.stderr);
  assert.ok(/## T\d+ · true 的字符串值/.test(pocketFile('log.md')), '文本 "true" 是合法内容，别误伤：\n' + pocketFile('log.md'));
});

test('cli: status --json reports the archive threshold it reads', () => {
  const { pocketDir } = makePocket('cli-status-archive');
  // 刚 bootstrap 的 log.md 只有表头（6 行），阈值压到 3 才算"已过阈值"
  fs.writeFileSync(path.join(pocketDir, 'config.md'), '# Config\n\n- archive_at: 3\n', 'utf-8');
  const data = parseJsonLine(runCli(['status', '--json'], pocketDir));
  assert.strictEqual(typeof data.logLines, 'number', JSON.stringify(data));
  assert.ok(data.logLines >= 3, 'logLines 要能对上阈值：' + JSON.stringify(data));
  assert.strictEqual(data.archiveAt, 3);
  const human = runCli(['status'], pocketDir);
  assert.ok(/archive is due/.test(human.stdout), '超阈值要在状态里看得见：\n' + human.stdout);
});

test('cli: help --json lists every command, and the docs list them too', () => {
  const json = parseJsonLine(runCli(['help', '--json']));
  const commands = json.groups.reduce((acc, g) => acc.concat(g.commands.map((c) => c.command)), []);
  assert.strictEqual(commands.length, 27, 'help 与 main() 分发的命令数必须一致：\n' + commands.join(', '));
  assert.ok(!commands.some((c) => c === 'help'), 'help 自己不进清单');

  // 人类版与 JSON 版由同一张表渲染，两者不能漂移
  const human = runCli(['help']).stdout;
  for (const c of commands) {
    assert.ok(human.includes('    ' + c.padEnd(HELP_COL)), '人类帮助里缺 ' + c + '：\n' + human);
  }

  // README（中英）的 CLI 表是用户/Agent 找命令的第一入口，漏一条就等于没实现
  for (const readme of ['README.md', 'README.zh-CN.md']) {
    const text = fs.readFileSync(path.join(ROOT, readme), 'utf-8');
    for (const c of commands) {
      const name = c.replace(/<[^>]*>/g, '').trim();
      assert.ok(text.includes('context-pocket ' + name + ' '), `${readme} 的 CLI 表里没有 "${name}"`);
    }
  }
});

// ------------------------------------------------------------
// --when（v2 的每轮时间）
// ------------------------------------------------------------

test('cli: log append --when puts the line in the file and one sentence on the screen', () => {
  const { pocketDir } = makePocket('cli-when');
  const json = parseJsonLine(runCli([
    'log', 'append', '--gist', '时间入档', '--user', 'u', '--action', 'a',
    '--when', '2026-05-01 09:00 → 11:30', '--json',
  ], pocketDir));
  assert.strictEqual(json.ok, true, JSON.stringify(json));
  // 右边只继承左边的日期，不做跨天算术
  assert.strictEqual(json.when, '--- WHEN: 2026-05-01 09:00 → 2026-05-01 11:30 ---', JSON.stringify(json));
  const log = fs.readFileSync(path.join(pocketDir, 'log.md'), 'utf-8');
  assert.ok(log.includes(json.when), '--json 报的行必须就是落盘的那一行：\n' + log);
  assert.ok(!/\\---/.test(log), '转义过的结构行解析器读不到：\n' + log);

  // 不带 --when：默认"此刻记下的"，精确到分钟
  const stamped = parseJsonLine(runCli([
    'log', 'append', '--gist', '默认时间', '--user', 'u', '--action', 'a', '--json',
  ], pocketDir));
  assert.ok(/^\--- WHEN: \d{4}-\d{2}-\d{2} \d{2}:\d{2} ---$/.test(stamped.when), JSON.stringify(stamped));

  // 人类可读的输出讲时间，不讲格式
  const human = runCli([
    'log', 'append', '--gist', '另一轮', '--user', 'u', '--action', 'a', '--when', '上周三下午',
  ], pocketDir);
  assert.strictEqual(human.code, 0, human.stderr);
  assert.ok(/⏱\s+“上周三下午” \(as stated\)/.test(human.stdout), '⏱ 要说人话：\n' + human.stdout);
  assert.ok(!/⏱.*---/.test(human.stdout), '不该把结构行原样打给用户：\n' + human.stdout);
});

test('cli: recall prints the recorded time next to the session date', () => {
  const { pocketDir } = makePocket('cli-when-recall');
  const appended = parseJsonLine(runCli([
    'log', 'append', '--gist', '要回读的一轮', '--user', 'u', '--action', 'a',
    '--when', '2026-06-07', '--json',
  ], pocketDir));
  assert.strictEqual(appended.when, '--- WHEN: 2026-06-07 (day) ---', JSON.stringify(appended));

  const human = runCli(['recall', String(appended.tId)], pocketDir);
  assert.ok(/When:\s+2026-06-07 \(day only\)/.test(human.stdout), '只有天的精度不能假装知道钟点：\n' + human.stdout);

  const json = parseJsonLine(runCli(['recall', String(appended.tId), '--json'], pocketDir));
  assert.deepStrictEqual(json.t.when, { kind: 'day', date: '2026-06-07' }, JSON.stringify(json));
});

test('cli: log amend --when reports the note in --json and on screen', () => {
  const { pocketDir } = makePocket('cli-when-amend');
  const first = parseJsonLine(runCli([
    'log', 'append', '--gist', '先记一轮', '--user', 'u', '--action', 'a', '--json',
  ], pocketDir));

  // 刚写下的时间是历史，第二次 amend 只能给一句话说明，不能改文件
  const logBefore = fs.readFileSync(path.join(pocketDir, 'log.md'), 'utf-8');
  const human = runCli(['log', 'amend', String(first.tId), '--when', '2026-05-01 23:00'], pocketDir);
  assert.strictEqual(human.code, 0, human.stderr);
  assert.ok(/⏱/.test(human.stdout), 'amend 要把时间上的处理结果说回来：\n' + human.stdout);
  assert.ok(/不覆盖历史/.test(human.stdout), JSON.stringify(human.stdout));
  assert.strictEqual(fs.readFileSync(path.join(pocketDir, 'log.md'), 'utf-8'), logBefore, '拒绝就等于真的不改');

  // "unchanged" 不等于"什么也没说"：只有时间说明的一轮也必须打印出来
  assert.ok(!/already has those sections/.test(human.stdout),
    '不能把 --when 的说明当成空请求吞掉：\n' + human.stdout);

  const json = parseJsonLine(runCli([
    'log', 'amend', String(first.tId), '--when', '2026-05-01 23:00', '--json',
  ], pocketDir));
  assert.deepStrictEqual(json.filled, [], JSON.stringify(json));
  assert.ok(/不覆盖历史/.test(json.whenNote), JSON.stringify(json));
});

test('cli: --when on a v1 pocket is reported, not swallowed', () => {
  const { pocketDir } = makeV1Pocket('cli-when-v1');

  const human = runCli([
    'log', 'append', '--gist', '在 v1 里给了时间', '--user', 'u', '--action', 'a',
    '--when', '2026-05-01 09:00 → 11:30',
  ], pocketDir);
  assert.strictEqual(human.code, 0, human.stderr);
  assert.ok(/⚠️/.test(human.stdout), '没落盘的时间必须说一声：\n' + human.stdout);
  assert.ok(/v1/.test(human.stdout) && /migrate/.test(human.stdout), JSON.stringify(human.stdout));
  assert.ok(!/⏱/.test(human.stdout), '⏱ 只说真的记下的时间：\n' + human.stdout);
  assert.ok(!/^--- WHEN: /m.test(fs.readFileSync(path.join(pocketDir, 'log.md'), 'utf-8')),
    'v1 的内容不能超出它自己声明的格式版本');

  const json = parseJsonLine(runCli([
    'log', 'append', '--gist', '再来一轮', '--user', 'u', '--action', 'a',
    '--when', '上周三下午', '--json',
  ], pocketDir));
  assert.strictEqual(json.ok, true, JSON.stringify(json));
  assert.strictEqual(json.when, null, JSON.stringify(json));
  assert.ok(/v1 格式/.test(json.whenSkipped), JSON.stringify(json));

  // 没给 --when 就不该有话说：默认时间是写入时刻，v1 本来也不写这一行
  const quiet = parseJsonLine(runCli([
    'log', 'append', '--gist', '没给时间', '--user', 'u', '--action', 'a', '--json',
  ], pocketDir));
  assert.strictEqual(quiet.whenSkipped, null, JSON.stringify(quiet));
});

test('cli: --author signs the block and the write-time conflict gate says what it found', () => {
  const { pocketDir } = makePocket('cli-author-gate');
  runCli(['log', 'append', '--gist', '第一轮', '--user', 'u', '--action', 'a', '--json'], pocketDir);
  // decision add 把自己盖在 `latestT + 1` 上，也就是"紧接着要记的那一轮"，
  // 所以撞它的块必须是再往后一轮：这里 T2 记下决定，T3 才可能与之冲突。
  const adr = runCli(['decision', 'add', '--title', 'use react for the frontend',
    '--context', '选型', '--options', 'react / vue', '--decision', 'react',
    '--consequences', '生态统一', '--json'], pocketDir);
  assert.strictEqual(adr.code, 0, adr.stderr);
  runCli(['log', 'append', '--gist', '定了前端框架', '--user', 'u', '--action', 'a', '--json'], pocketDir);

  const json = parseJsonLine(runCli(['log', 'append', '--gist', '首页改用 vue',
    '--user', 'u', '--action', 'a', '--author', 'qoder-agent-a', '--json'], pocketDir));
  assert.strictEqual(json.conflictsWritten, 1, JSON.stringify(json.autoConflicts));
  assert.strictEqual(json.autoConflicts[0].category, '技术栈 / Tech Stack');
  assert.strictEqual(json.conflictCheckSkipped, false);
  assert.strictEqual(json.conflictCheckError, null);

  const log = () => fs.readFileSync(path.join(pocketDir, 'log.md'), 'utf-8');
  assert.ok(/### Author\n- qoder-agent-a\n/.test(log()), '--author 必须落成 Author 节');
  assert.ok(/\[auto\] ADR-1/.test(log()), '检出的冲突要进 log.md，不能只在屏幕上闪过');

  // 不看 --json 的人同样要看得见：两个入口说同一件事
  const human = runCli(['log', 'append', '--gist', '又一次改用 vue', '--user', 'u', '--action', 'a'], pocketDir);
  assert.strictEqual(human.code, 0, human.stderr);
  assert.ok(/⚔️/.test(human.stdout), '冲突要在输出里说一声：\n' + human.stdout);
  assert.ok(/技术栈|Tech Stack|ADR-1/.test(human.stdout), JSON.stringify(human.stdout));

  // 关掉扫描：块照写，且不出现任何 [auto] 项
  const off = parseJsonLine(runCli(['log', 'append', '--gist', '第三次 vue', '--user', 'u',
    '--action', 'a', '--no-conflict-check', '--json'], pocketDir));
  assert.strictEqual(off.conflictCheckSkipped, true);
  assert.strictEqual(off.conflictsWritten, 0);
  assert.ok(!/\[auto\]/.test(log().split('## T' + off.tId)[1]), '关掉了就不该写检出项');
});

test('cli: --no-index on a write means "do not refresh the cache", and the next search heals it', () => {
  // 代码在 log append / log amend 里读这个开关（bin:1098 / :1166），可过去只有
  // search --help 教过它 —— 写入侧等于不存在：想省掉每轮一次刷新的人找不到入口，
  // 而在帮助里读到它的人又只会往"跳过索引"那个方向理解。
  const { pocketDir } = makePocket('cli-no-index-write');
  const indexFile = path.join(pocketDir, 'assets', 'search-index.json');
  const dropIndex = () => { if (fs.existsSync(indexFile)) fs.unlinkSync(indexFile); };

  for (const argv of [['log', 'append', '--help'], ['log', 'amend', '--help']]) {
    const h = runCli(argv, pocketDir);
    assert.strictEqual(h.code, 0, h.stderr);
    assert.ok(/--no-index/.test(h.stdout), argv.join(' ') + ' 没教 --no-index：\n' + h.stdout);
  }

  dropIndex();
  const appended = parseJsonLine(runCli(['log', 'append', '--gist', 'bulk turn 自愈', '--user', 'u',
    '--action', 'a', '--no-index', '--json'], pocketDir));
  assert.strictEqual(appended.ok, true, JSON.stringify(appended));
  assert.ok(/bulk turn 自愈/.test(fs.readFileSync(path.join(pocketDir, 'log.md'), 'utf-8')),
    '跳过刷索引不能跳过记录本身');
  assert.ok(!fs.existsSync(indexFile), '--no-index 的那次写入不该把缓存建回来（省下的就是这一次）');

  // 自愈：下一次 search 必须搜得到那一轮，并把缓存重建出来
  const found = parseJsonLine(runCli(['search', '自愈', '--json'], pocketDir));
  assert.strictEqual(found.total, 1, JSON.stringify(found));
  assert.strictEqual(found.results[0].gist, 'bulk turn 自愈', JSON.stringify(found.results));
  assert.strictEqual(found.viaIndex, true, '索引重建后应走索引路径：' + JSON.stringify(found));
  assert.ok(fs.existsSync(indexFile), 'search 之后 search-index.json 要回到磁盘上');

  // amend 走同一条路：补写的小节照样搜得到
  dropIndex();
  const amended = runCli(['log', 'amend', String(appended.tId), '--pitfalls', 'amend 自愈坑', '--no-index'], pocketDir);
  assert.strictEqual(amended.code, 0, amended.stderr + amended.stdout);
  assert.ok(!fs.existsSync(indexFile), 'log amend --no-index 也不该刷缓存');
  const foundAmend = parseJsonLine(runCli(['search', '自愈坑', '--json'], pocketDir));
  assert.strictEqual(foundAmend.total, 1, JSON.stringify(foundAmend));
  assert.ok(fs.existsSync(indexFile), 'amend 之后也是由 search 重建缓存');

  // 省掉刷新不改变结果：索引路径与全量扫描给同一批命中
  const scanned = parseJsonLine(runCli(['search', '自愈', '--no-index', '--json'], pocketDir));
  assert.deepStrictEqual(scanned.results.map((r) => 'T' + r.id), found.results.map((r) => 'T' + r.id));
  assert.strictEqual(scanned.total, found.total);
});

test('cli: a missing, corrupt or stale index rebuilds itself instead of falling back to the scan', () => {
  // SKILL.md / docs/FAQ.md / lib/indexer.js 的头注释过去都写成"索引损坏或缺失 →
  // 回退全量扫描"。实测三种情况（缺失、坏 JSON、INDEX_VERSION 对不上）走的都是
  // 现场重建 + 仍然用索引这条路，viaIndex 一直是 true；只有连重建都做不成才是 false。
  // 行为是有意的（ensureFreshIndex 的注释就是这么写的），所以修的是口径，并在
  // 这里把它钉住：谁再改这条路径，测试会指出是哪一面漂了。
  const { pocketDir } = makePocket('cli-index-selfheal');
  const indexFile = path.join(pocketDir, 'assets', 'search-index.json');
  runCli(['log', 'append', '--gist', 'selfheal 索引', '--user', 'u', '--no-index', '--json'], pocketDir);

  const search = () => parseJsonLine(runCli(['search', 'selfheal', '--json'], pocketDir));

  assert.ok(!fs.existsSync(indexFile), '前置条件：--no-index 那轮没建缓存');
  const rebuilt = search();
  assert.strictEqual(rebuilt.viaIndex, true, '缺失时应现场重建后仍走索引：' + JSON.stringify(rebuilt));
  assert.strictEqual(rebuilt.total, 1);

  fs.writeFileSync(indexFile, '{ this is not json', 'utf-8');
  assert.strictEqual(search().viaIndex, true, '坏 JSON 应被重建掉，不是退回扫描');

  const stale = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
  stale.version -= 1;
  fs.writeFileSync(indexFile, JSON.stringify(stale), 'utf-8');
  const viaVersion = search();
  assert.strictEqual(viaVersion.viaIndex, true, 'INDEX_VERSION 对不上同样要重建');
  assert.strictEqual(viaVersion.total, 1);

  // 唯一真的走扫描的情况：索引根本写不成（这里用目录把那个路径占住）
  fs.unlinkSync(indexFile);
  fs.mkdirSync(indexFile);
  try {
    const blocked = search();
    assert.strictEqual(blocked.viaIndex, false, '重建失败时才该回退全量扫描：' + JSON.stringify(blocked));
    assert.strictEqual(blocked.total, 1, '回退扫描也必须搜到同一轮');
    assert.deepStrictEqual(blocked.results.map(rowKey), viaVersion.results.map(rowKey),
      '两条路径的命中与顺序必须一致');
  } finally {
    fs.rmdirSync(indexFile);
  }
});

/** 对着指定 cwd 跑一次（runCli 只会加 --dir，这里要的是"当前目录本身没有 pocket"） */
function runRaw(args, cwd) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    }) };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

test('cli: --version answers with the number from package.json instead of the whole help', () => {
  // 在此之前 `context-pocket --version` / `-v` / `version` 全都掉进 main() 的默认分支
  // （`args.command || 'help'`），输出整页 help、退出 0：要问的号码被帮助盖掉。
  // 现在三种写法同解，值取自 package.json —— MCP initialize 回包读的是同一处（tests/mcp.js 钉住）。
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  const empty = tmpProject('cli-version-cwd');

  const byFlag = {};
  for (const argv of [['--version'], ['-v'], ['version']]) {
    const r = runRaw(argv, empty);
    assert.strictEqual(r.code, 0, argv.join(' ') + ' 应当退出 0：' + r.stderr);
    assert.ok(r.stdout.includes(pkg.version), argv.join(' ') + ' 要报 package.json 里的号：' + r.stdout);
    assert.ok(!/Usage:/.test(r.stdout), argv.join(' ') + ' 不该再吐整页帮助：\n' + r.stdout);
    byFlag[argv.join(' ')] = r.stdout;
  }
  assert.strictEqual(byFlag['--version'], byFlag['-v'], '-v 与 --version 必须同解');
  assert.strictEqual(byFlag['--version'], byFlag['version'], 'version 命令与 flag 必须同解');

  const json = parseJsonLine(runRaw(['--version', '--json'], empty));
  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.version, pkg.version);
  assert.strictEqual(json.source, 'package.json', '仓库里跑就该从 package.json 读到，而不是兜底值');

  // 只读操作：不该要求 pocket，也不该在 cwd 留下任何东西
  assert.deepStrictEqual(fs.readdirSync(empty), [], '问版本跑完，空目录还得是空的');

  // 全局优先：命令后面带 --version 也按"就是要问版本"处理，此时一个字都不写
  const { pocketDir } = makePocket('cli-version-precedence');
  const logBefore = fs.readFileSync(path.join(pocketDir, 'log.md'), 'utf-8');
  const afterFlag = runCli(['log', 'append', '--gist', '这轮不该被写进去', '--version'], pocketDir);
  assert.strictEqual(afterFlag.code, 0, afterFlag.stderr);
  assert.ok(afterFlag.stdout.includes(pkg.version), afterFlag.stdout);
  assert.strictEqual(fs.readFileSync(path.join(pocketDir, 'log.md'), 'utf-8'), logBefore,
    '--version 不许顺手追加一轮');

  // 代码读了这个开关，帮助就得教
  assert.match(runRaw(['help'], empty).stdout, /--version/, '全局 Options 要列出 --version');
});
