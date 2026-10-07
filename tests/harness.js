'use strict';

/**
 * 零依赖测试骨架（Node 14+）。
 *
 * 为什么不用 tape/mocha/jest：ContextPocket 的卖点是零依赖，
 * 测试一旦引入 npm 包，"clone 下来 node 就能跑" 的承诺就失效了。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const cases = [];
const tmpDirs = [];

// 测试绝不能往 ~/.contextpocket/hub.json 里写注册项目：把 hub 重定向到临时目录
// （子进程继承 process.env，所以 CLI/MCP 的 spawn 也一起隔离）
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-hub-'));
if (!process.env.CONTEXTPOCKET_HOME) {
  process.env.CONTEXTPOCKET_HOME = ISOLATED_HOME;
}
tmpDirs.push(ISOLATED_HOME);

function test(name, fn) {
  cases.push({ name, fn });
}

/** 建一个临时项目目录（测试结束后由 cleanup 删除） */
function tmpProject(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cp-test-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

/** 在临时目录里 bootstrap 一个真实 pocket，返回 { projectDir, pocketDir } */
function makePocket(tag, options = {}) {
  const { bootstrap } = require(path.join(ROOT, 'lib', 'bootstrap'));
  const projectDir = tmpProject(tag);
  fs.writeFileSync(
    path.join(projectDir, 'app.js'),
    '// a source file so code-map has something to scan\n'
  );
  const result = bootstrap(projectDir, options);
  return { projectDir, pocketDir: result.pocketDir };
}

function writePocketFile(pocketDir, file, content) {
  fs.writeFileSync(path.join(pocketDir, file), content, 'utf-8');
}

/**
 * 改写 readme.md 的格式戳，把一个新 bootstrap 出来的 pocket 变成"老版本留下来的项目"。
 *
 * 为什么需要：今天的模板出生就是 v2，而迁移测的恰恰是"从 v1 升上来"这条路径。
 * 除了版本号，v1 的 log.md 还要靠调用方自己写成不带 `--- WHEN: ---` 的样子 ——
 * 版本戳 + 内容两者都像 v1，才算真的把时间倒回去。
 *
 * @param {string} pocketDir
 * @param {string} version 例如 'v1'
 */
function setPocketFormat(pocketDir, version) {
  const readmePath = path.join(pocketDir, 'readme.md');
  const content = fs.readFileSync(readmePath, 'utf-8');
  if (!/format:\s*v\d+/i.test(content)) {
    throw new Error('setPocketFormat: readme.md has no "format: v<N>" header');
  }
  fs.writeFileSync(
    readmePath,
    content.replace(/format:\s*v\d+/i, 'format: ' + version),
    'utf-8'
  );
  return pocketDir;
}

function readPocketFile(pocketDir, file) {
  return fs.readFileSync(path.join(pocketDir, file), 'utf-8');
}

/**
 * 一个 v1 形状的 T-block：**没有** `--- WHEN: ---` 行，日期只在它上方的 SESSION 行里。
 * v2 出生即带时间行，所以想测"从 v1 升上来"就必须自己拼出这种老样子。
 */
function v1Block(n, gist, fileTag) {
  return [
    `## T${n} · ${gist} · [测试]`,
    '',
    '### User',
    `- 用户原话：${gist}`,
    '',
    '### Action',
    `- 创建 test/${fileTag}-${n}.js`,
    '',
  ].join('\n');
}

/**
 * 一份"v1 时代写出来的 log.md"：三个块分布在两个 SESSION 之下，T(base+2) 紧跟
 * T(base+1)，用来验证"日期来自它上方最近的那个 SESSION"。
 * 小节都是齐的 —— 缺 User/Action 的块会先被 verify 拦掉，测不到被测的东西。
 */
function v1LogBody(base) {
  const first = base || 1;
  return [
    '# ContextPocket · LOG',
    '',
    '--- SESSION: 2026-05-01 ---',
    '',
    v1Block(first, '第一天第一轮', 'day-one'),
    '--- SESSION: 2026-05-02 ---',
    '',
    v1Block(first + 1, '第二天第一轮', 'day-two'),
    v1Block(first + 2, '第二天第二轮', 'day-two'),
  ].join('\n');
}

/**
 * bootstrap 一个 pocket，再把它整体倒回 v1 的样子：版本戳降回 v1 + log.md 换成不带
 * 时间行的老块。index.md 会跟着抬到正确的 T 号，否则 verify 的 index-consistency
 * 会先报错，把要测的迁移/写入路径挡在门外。
 *
 * @param {string} tag 临时目录前缀
 * @param {object} [options]
 * @param {string} [options.log] 自定义 log.md 内容（默认 `v1LogBody()`）
 * @param {number} [options.base] 默认 log 的起始 T 号
 */
function makeV1Pocket(tag, options = {}) {
  const path2 = require('path');
  const made = makePocket(tag);
  setPocketFormat(made.pocketDir, 'v1');
  const content = options.log || v1LogBody(options.base);
  writePocketFile(made.pocketDir, 'log.md', content);

  const { parseLog } = require(path2.join(ROOT, 'lib', 'parser'));
  const writer = require(path2.join(ROOT, 'lib', 'writer'));
  const data = parseLog(made.pocketDir);
  const last = data.blocks[data.blocks.length - 1];
  writer.updateIndexHeader(made.pocketDir, data.latestT, last ? last.session : '2026-05-02');
  return made;
}

function cleanup() {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync ? fs.rmSync(dir, { recursive: true, force: true })
        : rimraf(dir);
    } catch (e) { /* 临时目录交给 OS 回收，不能让清理步骤把测试搞红 */ }
  }
}

// Node 14 没有 fs.rmSync，退化成手动递归
function rimraf(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) rimraf(full);
    else fs.unlinkSync(full);
  }
  fs.rmdirSync(dir);
}

async function runAll() {
  let passed = 0;
  const failures = [];
  // 每个套件跑完就清空，否则下一个套件会把前面的用例再跑一遍
  const list = cases.splice(0);

  for (const item of list) {
    try {
      await item.fn();
      passed++;
      console.log(`  ok   ${item.name}`);
    } catch (e) {
      failures.push({ name: item.name, error: e });
      console.log(`  FAIL ${item.name}`);
    }
  }

  console.log('');
  if (failures.length === 0) {
    console.log(`  ${passed} passed · 0 failed`);
  } else {
    console.log(`  ${passed} passed · ${failures.length} FAILED`);
    console.log('');
    for (const f of failures) {
      console.log(`--- ${f.name} ---`);
      console.log((f.error && f.error.stack) || String(f.error));
      console.log('');
    }
  }
  return failures.length;
}

module.exports = {
  assert,
  test,
  tmpProject,
  tmpDirs,
  makePocket,
  writePocketFile,
  readPocketFile,
  setPocketFormat,
  v1Block,
  v1LogBody,
  makeV1Pocket,
  cleanup,
  runAll,
  ROOT,
};
