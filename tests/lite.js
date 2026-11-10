'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { assert, test } = require('./harness');

const MAIN_ROOT = path.join(__dirname, '..');

// 把 Lite 套件作为一个用例跑在主套件里，而不是 `process.exit`。
//
// 这里是主包 `node tests/run.js` 的最后一个套件。此前它直接
// `process.exit(result.status)`：Lite 一通过（status 0），整个 runner 就以 0 退出，
// 把前面套件的失败全部吞掉 —— `npm test` 会打出 ALL TESTS PASS，CI 闸门形同虚设。
// 现在失败会被计入主套件的聚合结果；子进程输出仍然原样转发，成功路径的可见性不变。
test('Lite suite passes', () => {
  const result = spawnSync(process.execPath, [path.join(MAIN_ROOT, 'lite', 'tests', 'run.js')], {
    cwd: path.join(MAIN_ROOT, 'lite'),
    env: process.env,
    encoding: 'utf8',
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;

  assert.strictEqual(result.status, 0, `Lite suite exited ${result.status === null ? 'without a status' : result.status}`);
});
