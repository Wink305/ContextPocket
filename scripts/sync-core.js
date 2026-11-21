#!/usr/bin/env node
'use strict';

/**
 * 同源核心同步 / 漂移检查
 *
 *   node scripts/sync-core.js            检查各版本 lib/ 是否与 shared/ 逐字一致
 *   node scripts/sync-core.js --write    把 shared/ 覆盖到各版本 lib/
 *
 * shared/ 是唯一真值；lib/ 与 lite/lib/ 是分发副本，必须逐字一致。
 * 只同步 manifest 里列出的文件；命令层与模式层不进 shared/。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHARED = path.join(ROOT, 'shared');
const manifest = JSON.parse(fs.readFileSync(path.join(SHARED, 'manifest.json'), 'utf8'));
const write = process.argv.includes('--write');

const drift = [];
const written = [];

function targetsFor(file) {
  return (manifest.targetsByFile && manifest.targetsByFile[file]) || manifest.targets;
}

let totalPairs = 0;
for (const file of manifest.files) {
  for (const target of targetsFor(file)) {
    totalPairs += 1;
    const src = path.join(SHARED, file);
    const dst = path.join(ROOT, target, file);
    if (!fs.existsSync(src)) {
      drift.push('shared/' + file + ' 不存在（manifest 写错了）');
      continue;
    }
    if (!fs.existsSync(dst)) {
      if (write) {
        fs.copyFileSync(src, dst);
        written.push(target + '/' + file + ' (created)');
      } else {
        drift.push(target + '/' + file + ' 不存在');
      }
      continue;
    }
    if (fs.readFileSync(src).equals(fs.readFileSync(dst))) continue;
    if (write) {
      fs.copyFileSync(src, dst);
      written.push(target + '/' + file);
    } else {
      drift.push(target + '/' + file + ' 与 shared 漂开');
    }
  }
}

if (write) {
  console.log(written.length === 0
    ? 'sync-core: already in sync (' + manifest.files.length + ' files, ' + totalPairs + ' copies)'
    : 'sync-core: updated ' + written.length + ' file(s)\n  ' + written.join('\n  '));
  process.exit(0);
}

if (drift.length > 0) {
  console.error('sync-core: shared core drifted');
  for (const line of drift) console.error('  - ' + line);
  console.error('Run `node scripts/sync-core.js --write` after editing shared/.');
  process.exit(1);
}

console.log('sync-core: ok (' + manifest.files.length + ' files, ' + totalPairs + ' copies)');
