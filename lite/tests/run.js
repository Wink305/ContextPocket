#!/usr/bin/env node
'use strict';

const path = require('path');
const { runAll, cleanup } = require('./harness');

const SUITES = ['core.js', 'metrics.js', 'compat.js'];
const filter = process.argv[2];
const selected = SUITES.filter((file) => !filter || file.startsWith(filter));

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
    } catch (error) {
      console.log('  FAIL loading ' + file);
      console.log((error && error.stack) || String(error));
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
