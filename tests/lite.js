'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const MAIN_ROOT = path.join(__dirname, '..');

const result = spawnSync(process.execPath, [path.join(MAIN_ROOT, 'lite', 'tests', 'run.js')], {
  cwd: path.join(MAIN_ROOT, 'lite'),
  env: process.env,
  encoding: 'utf8',
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  console.error('Failed to launch Lite test suite:', result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
