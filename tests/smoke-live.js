'use strict';

/**
 * 发版门禁活测（`npm run smoke-live`）
 *
 * 1.2.0 发版时手工跑过的六项真实 CLI 活测，现在固化在这里：临时目录、临时 hub，
 * 全程走真实 CLI 子进程，不碰用户的 ~/.contextpocket。每一项都钉着一次真实缺陷：
 *
 *   1. 整天区间的 --when 落盘正确、全文件无 undefined        （1.1.0 写坏的 P1）
 *   2. 植入坏行后 verify 退 1，archive --dry-run 也被拦住     （坏数据曾静默通过）
 *   3. 同一行改成 stated: 用户原话就不误报                   （用户原话里可以有 "undefined"）
 *   4. 删掉时间行后 log amend 能补回，recall 显示回来         （amend 只补空、不覆盖）
 *   5. 缺必填小节的追加当场给警告，--json 的 missingSections 准（曾经静默写出坏块）
 *   6. distill --json 报告的窗口数字与实际生效的一致          （曾经报旗标而不是报窗口）
 *
 * 与 tests/run.js 的关系：单元回归在那边天天跑；这里是发版前的整链路门禁，
 * 独立成脚本是因为它慢（真实子进程 × 十几发），不进日常套件。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { assert, test, tmpProject, runAll, cleanup, ROOT } = require('./harness');

const CLI = path.join(ROOT, 'bin', 'context-pocket.js');

function runCli(argv, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...argv], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status === undefined || err.status === null ? -1 : err.status,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || ''),
    };
  }
}

/** --json 的输出取最后一行 JSON */
function parseJsonLine(r) {
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

/** 临时 hub + 临时目录里建一个 pocket（真实 CLI bootstrap），返回项目目录与 pocket 目录 */
function livePocket(tag) {
  const projectDir = tmpProject(tag);
  const r = runCli(['bootstrap'], projectDir);
  assert.strictEqual(r.code, 0, 'bootstrap 失败：' + r.stderr);
  return { projectDir, pocketDir: path.join(projectDir, 'ContextPocket') };
}

const logText = (pocketDir) => fs.readFileSync(path.join(pocketDir, 'log.md'), 'utf-8');

test('live 1: 整天区间 --when 落盘正确，全文件 0 个 undefined', () => {
  const { projectDir, pocketDir } = livePocket('live-when-day-range');
  const r = runCli(['log', 'append', '--gist', '整天区间', '--user', 'u', '--action', 'a',
    '--when', '2026-05-01 → 2026-05-03', '--json'], projectDir);
  assert.strictEqual(r.code, 0, r.stderr);

  const data = parseJsonLine(r);
  assert.strictEqual(data.when, '--- WHEN: 2026-05-01 → 2026-05-03 ---', '回执里的 when 不对：' + JSON.stringify(data));

  const log = logText(pocketDir);
  assert.ok(log.includes('--- WHEN: 2026-05-01 → 2026-05-03 ---'), '落盘行不对：\n' + log);
  assert.ok(!log.includes('undefined'), 'log.md 里出现了 undefined');

  const recall = runCli(['recall', '1'], projectDir);
  assert.strictEqual(recall.code, 0);
  assert.ok(recall.stdout.includes('2026-05-01 → 2026-05-03'), 'recall 没把时间显示回来');
  assert.ok(!recall.stdout.includes('undefined'), 'recall 显示了 undefined');
});

test('live 2: 植入 1.1.0 坏行后 verify 退 1，archive --dry-run 一并被拦', () => {
  const { projectDir, pocketDir } = livePocket('live-bad-line-caught');
  const r = runCli(['log', 'append', '--gist', '坏行', '--user', 'u', '--action', 'a',
    '--when', '2026-05-01 09:00 → 11:30', '--json'], projectDir);
  assert.strictEqual(r.code, 0, r.stderr);
  const whenLine = parseJsonLine(r).when;

  const logPath = path.join(pocketDir, 'log.md');
  const bad = logText(pocketDir).replace(whenLine, '--- WHEN: undefined → 2026-05-03 11:30 ---');
  assert.notStrictEqual(bad, logText(pocketDir), '坏行没植入（时间行锚点没找到）');
  fs.writeFileSync(logPath, bad, 'utf-8');

  const verify = runCli(['verify'], projectDir);
  assert.strictEqual(verify.code, 1, 'verify 该照出坏行并退 1，实际退 ' + verify.code);
  assert.ok(/error/i.test(verify.stdout + verify.stderr), 'verify 没说是 error');

  const archive = runCli(['archive', '--dry-run'], projectDir);
  assert.strictEqual(archive.code, 1, 'archive 该被 verify 的 ERROR 拦住');
  assert.ok(/verify found/i.test(archive.stdout + archive.stderr), 'archive 没提 verify 拦下了它');
});

test('live 3: 同一行换成 stated: 用户原话就不误报', () => {
  const { projectDir, pocketDir } = livePocket('live-stated-verbatim');
  const r = runCli(['log', 'append', '--gist', '原话', '--user', 'u', '--action', 'a', '--json'], projectDir);
  assert.strictEqual(r.code, 0, r.stderr);
  const whenLine = parseJsonLine(r).when;

  const logPath = path.join(pocketDir, 'log.md');
  // 用户原话里真的可能有 "undefined" 这个词 —— 带 stated: 前缀就是他说过的话，不许报
  const text = logText(pocketDir).replace(whenLine, '--- WHEN: stated: undefined → 2026-05-03 11:30 ---');
  assert.notStrictEqual(text, logText(pocketDir), '坏行没植入（时间行锚点没找到）');
  fs.writeFileSync(logPath, text, 'utf-8');

  const verify = runCli(['verify'], projectDir);
  assert.strictEqual(verify.code, 0, '用户原话行不该报错：' + verify.stdout + verify.stderr);
});

test('live 4: 删掉时间行后 log amend 补回，recall 显示回来', () => {
  const { projectDir, pocketDir } = livePocket('live-amend-when');
  const r = runCli(['log', 'append', '--gist', '删行补回', '--user', 'u', '--action', 'a',
    '--when', '2026-05-01 → 2026-05-03', '--json'], projectDir);
  assert.strictEqual(r.code, 0, r.stderr);
  const whenLine = parseJsonLine(r).when;

  const logPath = path.join(pocketDir, 'log.md');
  fs.writeFileSync(logPath, logText(pocketDir).replace(whenLine + '\n', ''), 'utf-8');
  assert.ok(!logText(pocketDir).includes(whenLine), '时间行没删掉');

  const amend = runCli(['log', 'amend', '1', '--when', '2026-05-01 → 2026-05-03'], projectDir);
  assert.strictEqual(amend.code, 0, amend.stderr);
  assert.ok(logText(pocketDir).includes(whenLine), 'amend 没把时间行补回来');

  const recall = runCli(['recall', '1'], projectDir);
  assert.ok(recall.stdout.includes('2026-05-01 → 2026-05-03'), 'recall 没显示补回的时间');
});

test('live 5: 缺必填小节的追加当场给警告，--json 的 missingSections 准', () => {
  const { projectDir } = livePocket('live-missing-sections');

  // 只给 gist：User / Action 两节都缺
  const human = runCli(['log', 'append', '--gist', '缺两节'], projectDir);
  assert.strictEqual(human.code, 0, human.stderr);
  assert.ok(human.stdout.includes('⚠️'), '缺小节该当场警告');
  assert.ok(human.stdout.includes('log amend 1 --user'), '警告里该给出补 User 的命令');
  assert.ok(human.stdout.includes('log amend 1 --action'), '警告里该给出补 Action 的命令');

  const both = parseJsonLine(runCli(['log', 'append', '--gist', '缺两节机器可读', '--json'], projectDir));
  assert.deepStrictEqual(both.missingSections, ['User', 'Action'], JSON.stringify(both));

  // 只缺 Action：警告只提 --action
  const oneHuman = runCli(['log', 'append', '--gist', '缺一节', '--user', 'u'], projectDir);
  assert.ok(oneHuman.stdout.includes('log amend 3 --action'), '缺 Action 该只给 --action 的命令：' + oneHuman.stdout);

  const one = parseJsonLine(runCli(['log', 'append', '--gist', '缺一节机器可读', '--user', 'u', '--json'], projectDir));
  assert.deepStrictEqual(one.missingSections, ['Action'], JSON.stringify(one));

  // 齐全的追加不该报缺
  const full = parseJsonLine(runCli(['log', 'append', '--gist', '齐全', '--user', 'u', '--action', 'a', '--json'], projectDir));
  assert.deepStrictEqual(full.missingSections, [], JSON.stringify(full));
});

test('live 6: distill --json 报告的窗口数字与实际生效的一致', () => {
  const { projectDir, pocketDir } = livePocket('live-distill-window');
  for (let i = 0; i < 6; i++) {
    runCli(['log', 'append', '--gist', '第 ' + i + ' 轮', '--user', 'u', '--action', 'a'], projectDir);
  }
  const cfgPath = path.join(pocketDir, 'config.md');
  fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf-8').replace(/recent_keep:\s*\d+/, 'recent_keep: 2'), 'utf-8');

  const fromConfig = parseJsonLine(runCli(['distill', '--dry-run', '--json'], projectDir));
  assert.strictEqual(fromConfig.recentKeep, 2, '没给旗标时报 config 的生效值：' + JSON.stringify(fromConfig));

  const fromFlag = parseJsonLine(runCli(['distill', '--dry-run', '--recent-keep', '5', '--json'], projectDir));
  assert.strictEqual(fromFlag.recentKeep, 5, '旗标压过 config：' + JSON.stringify(fromFlag));
});

runAll()
  .then((failures) => {
    cleanup();
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    cleanup();
    console.error(err);
    process.exit(1);
  });
