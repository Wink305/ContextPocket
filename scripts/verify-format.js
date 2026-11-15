#!/usr/bin/env node
'use strict';

/**
 * ContextPocket T-block 格式一致性校验器（format v2）
 *
 * 刻意不 require 项目自身的 parser —— 用实现验证实现等于没验证。
 * 用法：
 *   node scripts/verify-format.js                     # 跑仓库自带金样本
 *   node scripts/verify-format.js --dir <pocketDir>   # 校验任意口袋
 * 任一规则失败即打印 FAIL 并以非 0 退出。只用 Node 内置模块，Node 14+。
 */

const fs = require('fs');
const path = require('path');

const RE_SESSION = /^--- SESSION: (\d{4}-\d{2}-\d{2}) ---$/;
const RE_TBLOCK = /^##\s+T(\d+)\s*·\s*(.+?)(?:\s*·\s*(.+))?\s*$/;
const RE_FIX = /^##\s+T(\d+)-fix\s*·\s*(.+?)(?:\s*·\s*(.+))?\s*$/;
const RE_WHEN = /^--- WHEN: (.+) ---$/;
const RE_SECTION = /^### (Author|User|Action|Commits|Decisions & Constraints|Pitfalls|Preferences|Conflicts|Attachments|Uncertain)$/;

const args = process.argv.slice(2);
let pocketDir = path.join(__dirname, '..', 'tests', 'fixtures', 'format-conformance');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir' && args[i + 1]) {
    pocketDir = path.resolve(args[i + 1]);
    i++;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log('Usage: node scripts/verify-format.js [--dir <pocketDir>]');
    process.exit(0);
  }
}

const results = [];
function check(label, ok, detail) {
  results.push({ label: label, ok: !!ok, detail: detail || '' });
}

function parseTags(raw) {
  const out = [];
  const re = /\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const parts = m[1].trim().split(/\s+/);
    for (const t of parts) if (t) out.push(t);
  }
  return out;
}

const logPath = path.join(pocketDir, 'log.md');
if (!fs.existsSync(logPath)) {
  console.error('FAIL  log.md not found in ' + pocketDir);
  process.exit(1);
}
const lines = fs.readFileSync(logPath, 'utf8').split('\n');

const sessions = [];
const blocks = [];
const fixes = [];
const badSessionLines = [];
let currentSession = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const sm = line.match(RE_SESSION);
  if (sm) {
    currentSession = sm[1];
    sessions.push({ date: currentSession, line: i + 1 });
    continue;
  }
  if (/^--- SESSION:/.test(line)) {
    badSessionLines.push(i + 1);
    continue;
  }
  const fm = line.match(RE_FIX);
  if (fm) {
    fixes.push({ id: 'T' + fm[1] + '-fix', targetId: Number(fm[1]), session: currentSession, line: i + 1 });
    continue;
  }
  const tm = line.match(RE_TBLOCK);
  if (tm) {
    const wm = (lines[i + 1] || '').match(RE_WHEN);
    blocks.push({
      id: Number(tm[1]),
      gist: tm[2].trim(),
      tags: parseTags(tm[3] || ''),
      session: currentSession,
      when: wm ? wm[1] : null,
      line: i + 1,
    });
  }
}

// 第 2 节：编号从 1 开始、严格递增、不重用；fix 不参与发号
let increasing = blocks.length > 0 && blocks[0].id === 1;
let duplicates = 0;
for (let i = 1; i < blocks.length; i++) {
  if (blocks[i].id !== blocks[i - 1].id + 1) increasing = false;
  if (blocks[i].id === blocks[i - 1].id) duplicates++;
}
check('T 编号从 T1 开始且严格递增', increasing, blocks.map((b) => 'T' + b.id).join(', '));
check('无重复 T 编号', duplicates === 0, 'duplicate pairs: ' + duplicates);

const ids = new Set(blocks.map((b) => b.id));
check('fix 块指向已存在的 T 编号', fixes.every((f) => ids.has(f.targetId)),
  fixes.map((f) => f.id + '→T' + f.targetId).join(', '));

// 第 3 节：词法
check('SESSION 行形状合法', badSessionLines.length === 0,
  badSessionLines.length ? 'lines ' + badSessionLines.join(',') : '');
const placeholder = blocks.filter((b) => /<[^>]+>/.test(b.gist));
check('T-block gist 无模板占位符', placeholder.length === 0,
  placeholder.map((b) => 'T' + b.id).join(', '));

const badWhen = [];
const orphanWhen = [];
for (let i = 0; i < lines.length; i++) {
  if (!/^--- WHEN:/.test(lines[i])) continue;
  if (!RE_WHEN.test(lines[i])) badWhen.push(i + 1);
  const prev = lines[i - 1] || '';
  if (!RE_TBLOCK.test(prev) && !RE_FIX.test(prev)) orphanWhen.push(i + 1);
}
check('WHEN 行形状合法', badWhen.length === 0, badWhen.length ? 'lines ' + badWhen.join(',') : '');
check('WHEN 行紧跟 T-block / fix 标题', orphanWhen.length === 0,
  orphanWhen.length ? 'lines ' + orphanWhen.join(',') : '');

const badSections = lines.filter((l) => /^### /.test(l) && !RE_SECTION.test(l));
check('小节标题在允许集合内', badSections.length === 0, badSections.join(' | '));

// 第 4 节：session 重建
check('至少一条 SESSION 行', sessions.length > 0, sessions.map((s) => s.date).join(', '));
check('每个 T-block 都能找到前置 SESSION', blocks.every((b) => b.session !== null), '');
const dupSession = sessions.filter((s, i) => i > 0 && s.date === sessions[i - 1].date);
check('SESSION 行同日不重复', dupSession.length === 0, '');

// 金样本比对（可选，有 expected.json 才做）
const expectedPath = path.join(pocketDir, 'expected.json');
if (fs.existsSync(expectedPath)) {
  const exp = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const gotSessions = [];
  for (const s of sessions) if (gotSessions.indexOf(s.date) === -1) gotSessions.push(s.date);
  check('金样本 sessions 一致', JSON.stringify(gotSessions) === JSON.stringify(exp.sessions), gotSessions.join(','));
  const gotIds = blocks.map((b) => b.id);
  check('金样本 T 编号一致', JSON.stringify(gotIds) === JSON.stringify(exp.blocks.map((b) => b.id)), gotIds.join(','));
  check('金样本 WHEN 一致',
    JSON.stringify(blocks.map((b) => b.when)) === JSON.stringify(exp.blocks.map((b) => b.when)), '');
  check('金样本 fixBlocks 一致',
    JSON.stringify(fixes.map((f) => f.id)) === JSON.stringify(exp.fixBlocks.map((f) => f.id)), '');
  const latestT = gotIds.length ? Math.max.apply(null, gotIds) : 0;
  check('金样本 latestT 一致', latestT === exp.latestT, 'got ' + latestT);
}

let failed = 0;
for (const r of results) {
  console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.label + (r.detail ? '  · ' + r.detail : ''));
  if (!r.ok) failed++;
}
console.log('');
console.log(failed === 0 ? 'ALL FORMAT CHECKS PASS' : failed + ' FORMAT CHECK(S) FAILED');
process.exit(failed === 0 ? 0 : 1);
