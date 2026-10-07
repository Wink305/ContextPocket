#!/usr/bin/env node
'use strict';

/**
 * 测试入口：node tests/run.js
 *
 * 用法：
 *   npm test                 全部
 *   node tests/run.js unit   只跑某个套件（文件名前缀匹配）
 *
 * 零依赖：断言用 node 自带 assert，临时目录用 os.tmpdir()。
 */

const path = require('path');
const { runAll, cleanup } = require('./harness');

const SUITES = ['unit.js', 'pocket.js', 'hooks.js', 'importer.js', 'migrate.js', 'repair.js', 'cli.js', 'mcp.js'];

const filter = process.argv[2];
const selected = SUITES.filter((f) => !filter || f.startsWith(filter));

if (selected.length === 0) {
  console.error('no test suite matches "' + filter + '" — available: ' + SUITES.join(', '));
  process.exit(2);
}

(async () => {
  let failed = 0;
  for (const file of selected) {
    console.log('');
    console.log('── ' + file + ' ' + '─'.repeat(Math.max(0, 58 - file.length)));
    try {
      require(path.join(__dirname, file));
    } catch (e) {
      console.log('  FAIL loading ' + file);
      console.log((e && e.stack) || String(e));
      failed++;
      continue;
    }
    failed += await runAll();
  }

  cleanup();
  console.log('');
  console.log(failed === 0 ? '  ALL TESTS PASS' : '  ' + failed + ' TEST(S) FAILED');
  process.exit(failed === 0 ? 0 : 1);
})();
