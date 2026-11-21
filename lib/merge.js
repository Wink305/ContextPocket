'use strict';

/**
 * ContextPocket — 合并另一个口袋（跨机器 / 多 Agent）
 *
 * 单向合并：源口袋只读，目标口袋在锁内写入，失败按快照回滚。
 *
 * 设计要点：
 *   - 轮次按原文切片搬运，不用 appendLogBlock 重建，保留 WHEN / 小节 / 续行；
 *   - T 号按"目标 latestT + 1"连续分配，引用只在复制文本里改写；
 *   - 用内容指纹（编号归一后）判断"这一轮已经合过"，因此支持增量重复合并；
 *   - ADR / 需求 / 红线 / 偏好按内容去重，冲突保留目标并写报告；
 *   - state.md / code-map.md 不自动合并，源内容只进报告；
 *   - 合并后 verify 错误数不得增加，否则整份回滚。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  writeAtomic,
  readTextOr,
  readTextRequired,
  sanitizeInline,
  sanitizeBlockquote,
  ensureDir,
} = require('./io');
const { fileExists, getTodayStr, isPocketDir, getProjectRoot, readConfig } = require('./core');
const {
  parseLog,
  parseLogAll,
  parseLogText,
  parseDecisions,
  parseRequirements,
  parsePreferences,
  parseAbsolute,
  parseState,
  parseCodeMapEntries,
} = require('./parser');
const { HEADING_RE, remapTRefs, collectHeadings, hasDuplicateIds } = require('./repair');
const { verify, attachmentRefs } = require('./validator');
const { refreshGraphCacheIfExists } = require('./links');
const { detectIsolation } = require('./isolate');
const { detectFormatVersion } = require('./migrate');
const { TBLOCK_SECTIONS, SESSION_LINE_RE, SEVERITY } = require('./constants');
const writer = require('./writer');
const mergeReview = require('./merge-review');
const { afterWrite } = require('./lifecycle');

const FIX_HEADING_RE = /^##\s+T(\d+)-fix\s*·/;
const T_REF_RE = /(?<![\w/.\\])T(\d+)(?![\w-])(?!\.\w{2,4}\b)/g;
const ADR_REF_RE = /(?<![\w-])ADR-(\d+)(?!\d)/g;
const R_REF_RE = /(?<![\w/.\\])R(\d+)(?![\w-])(?!\.\w{2,4}\b)/g;

const SNAPSHOT_FILES = [
  'log.md', 'decisions.md', 'requirements.md', 'absolute.md', 'preferences.md',
  'index.md', 'state.md', 'code-map.md', 'handoff.md',
];

// ============================================================
// 小工具
// ============================================================

function versionNumber(v) {
  const m = /^v(\d+)$/.exec(String(v || ''));
  return m ? Number(m[1]) : 0;
}

function maxNumber(values) {
  let max = 0;
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function normalizeTextKey(text) {
  return canonicalText(text).replace(/\s+/g, ' ').trim();
}

/** 把独立 T / ADR / R 引用归一成占位符：内容指纹与去重都要对编号改写免疫 */
function canonicalText(text) {
  return String(text === null || text === undefined ? '' : text)
    // 附件文件名形状（T03-x.png）也要归一：复制时会把文件名改成新 T 号
    .replace(/(?<![\w])T\d+(?=[-.]\w)/g, 'T#')
    .replace(T_REF_RE, 'T#')
    .replace(ADR_REF_RE, 'ADR-#')
    .replace(R_REF_RE, 'R#');
}

function contentKey(parsed, kind, when) {
  const tags = (parsed.tags || []).filter((t) => t !== 'merged');
  const sections = [];
  for (const section of TBLOCK_SECTIONS) {
    if (section === 'Attachments') continue;
    const items = (parsed.sections && parsed.sections[section]) || [];
    sections.push(section + ':' + items.map(canonicalText).join('\u0001'));
  }
  const body = kind === 'fix' ? (parsed.body || []).map(canonicalText).join('\u0001') : '';
  return crypto.createHash('sha1').update(JSON.stringify({
    kind,
    gist: canonicalText(parsed.gist || ''),
    tags,
    when: when ? JSON.stringify(when) : '',
    sections: sections.join('\u0002'),
    body,
  })).digest('hex');
}

function remapAdrText(text, map) {
  return String(text).replace(ADR_REF_RE, (whole, digits) => {
    const n = parseInt(digits, 10);
    return map.has(n) ? 'ADR-' + map.get(n) : whole;
  });
}

function remapRText(text, map) {
  return String(text).replace(R_REF_RE, (whole, digits) => {
    const n = parseInt(digits, 10);
    return map.has(n) ? 'R' + map.get(n) : whole;
  });
}

function remapAllRefs(text, maps) {
  let out = remapTRefs(String(text), maps.t).text;
  out = remapAdrText(out, maps.adr);
  out = remapRText(out, maps.r);
  return out;
}

function verifySummary(result) {
  const errors = (result.results || [])
    .filter((r) => r.severity === SEVERITY.ERROR)
    .slice(0, 8)
    .map((r) => r.message || r.category || 'error');
  return {
    errorCount: result.errorCount,
    warningCount: result.warningCount,
    infoCount: result.infoCount,
    errors,
  };
}

// ============================================================
// 源口袋解析与预检
// ============================================================

function resolveSource(from) {
  if (!from) {
    return { error: '--from is required (path to another ContextPocket/ or its project root)' };
  }
  const base = path.resolve(String(from));
  const candidates = [path.join(base, 'ContextPocket'), base];
  for (const candidate of candidates) {
    if (isPocketDir(candidate)) {
      return { pocketDir: candidate, projectRoot: getProjectRoot(candidate) };
    }
  }
  return { error: 'No ContextPocket/ (index.md + log.md) found at ' + base };
}

function duplicateTIds(pocketDir, file) {
  const p = path.join(pocketDir, file);
  if (!fileExists(p)) return [];
  const headings = collectHeadings(readTextRequired(p).split('\n'));
  const seen = new Set();
  const dup = [];
  for (const h of headings) {
    if (h.id === null) continue;
    if (seen.has(h.id)) dup.push(h.id);
    seen.add(h.id);
  }
  return dup;
}

function preflightSource(sourcePocket, targetPocket) {
  if (path.resolve(sourcePocket) === path.resolve(targetPocket)) {
    return { error: 'Source and target are the same pocket.' };
  }

  const sourceRoot = getProjectRoot(sourcePocket);
  const iso = detectIsolation({ cwd: sourceRoot, pocketDir: sourcePocket });
  if (iso.isolated) {
    return { error: 'Source pocket is isolated (' + iso.source + '): ' + iso.reason };
  }

  const sourceVersion = detectFormatVersion(sourcePocket);
  const targetVersion = detectFormatVersion(targetPocket);
  if (versionNumber(sourceVersion) > versionNumber(targetVersion)) {
    return {
      error: 'Source format ' + sourceVersion + ' is newer than target ' + targetVersion
        + '. Run "context-pocket migrate --to latest" on the target first.',
    };
  }

  const sourceDup = duplicateTIds(sourcePocket, 'log.md')
    .concat(duplicateTIds(sourcePocket, 'log-archive.md'));
  if (sourceDup.length > 0) {
    return {
      error: 'Source has duplicate T-id(s): ' + [...new Set(sourceDup)].map((n) => 'T' + n).join(', ')
        + '. Run "context-pocket repair" on the source pocket first.',
    };
  }

  const targetDup = duplicateTIds(targetPocket, 'log.md');
  if (targetDup.length > 0) {
    return {
      error: 'Target has duplicate T-id(s): ' + [...new Set(targetDup)].map((n) => 'T' + n).join(', ')
        + '. Run "context-pocket repair" on the target first.',
    };
  }

  const sourceVerify = verify(sourcePocket);
  if (sourceVerify.errorCount > 0) {
    return {
      error: 'Source pocket has ' + sourceVerify.errorCount + ' verify error(s); fix it before merging.',
      sourceVerify: verifySummary(sourceVerify),
    };
  }

  return { ok: true, sourceVersion, targetVersion, sourceVerify: verifySummary(sourceVerify) };
}

// ============================================================
// 源 log 切片
// ============================================================

/**
 * 把 log 文本切成原始块：标题行到下一个标题行 / EOF。
 * 只用于搬运，不重建格式。
 * @returns {Array<object>}
 */
function sliceUnits(content, fromArchive) {
  const lines = String(content || '').split('\n');
  const units = [];
  let current = null;

  const close = (endLine) => {
    if (!current) return;
    const rawLines = lines.slice(current.startLine, endLine);
    while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === '') rawLines.pop();
    current.raw = rawLines.filter((line) => !SESSION_LINE_RE.test(line)).join('\n');
    current.endLine = endLine;
    units.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.match(HEADING_RE);
    const f = line.match(FIX_HEADING_RE);
    if (!t && !f) continue;
    close(i);
    if (t) {
      current = {
        kind: 'T',
        id: parseInt(t[1], 10),
        heading: line,
        startLine: i,
        fromArchive: !!fromArchive,
      };
    } else {
      current = {
        kind: 'fix',
        targetId: parseInt(f[1], 10),
        heading: line,
        startLine: i,
        fromArchive: !!fromArchive,
      };
    }
  }
  close(lines.length);
  return units;
}

// ============================================================
// 轮次规划
// ============================================================

function planTurns(targetPocket, sourcePocket, options) {
  const includeArchive = !!options.includeArchive;
  const targetVersion = versionNumber(detectFormatVersion(targetPocket));
  const targetAll = parseLogAll(targetPocket);
  const targetLog = parseLog(targetPocket);

  const targetTKeys = new Map();
  for (const block of targetAll.blocks) {
    const key = contentKey(block, 'T', block.when);
    if (!targetTKeys.has(key)) targetTKeys.set(key, []);
    targetTKeys.get(key).push(block.id);
  }
  const targetFixKeys = new Map();
  for (const fix of targetAll.fixBlocks) {
    const key = contentKey(fix, 'fix', null);
    targetFixKeys.set(key, (targetFixKeys.get(key) || 0) + 1);
  }

  const liveContent = readTextRequired(path.join(sourcePocket, 'log.md'));
  const archivePath = path.join(sourcePocket, 'log-archive.md');
  const archiveContent = fileExists(archivePath) ? readTextRequired(archivePath) : '';
  const liveAllUnits = sliceUnits(liveContent, false);
  const archiveAllUnits = archiveContent ? sliceUnits(archiveContent, true) : [];
  const liveParsed = parseLogText(liveContent);
  const archiveParsed = archiveContent ? parseLogText(archiveContent) : { blocks: [], fixBlocks: [] };

  // 源 live 与 archive 的 T 号不能互撞（预检已查单文件，这里查跨文件）
  const sourceIds = new Set();
  for (const u of liveAllUnits.concat(archiveAllUnits)) {
    if (u.kind !== 'T') continue;
    if (sourceIds.has(u.id)) {
      return { error: 'Source has duplicate T' + u.id + ' across log.md and log-archive.md; fix the source first.' };
    }
    sourceIds.add(u.id);
  }

  const liveTUnits = liveAllUnits.filter((u) => u.kind === 'T');
  const liveFixUnits = liveAllUnits.filter((u) => u.kind === 'fix');
  const archiveTUnits = archiveAllUnits.filter((u) => u.kind === 'T');
  const archiveFixUnits = archiveAllUnits.filter((u) => u.kind === 'fix');

  const selectedT = includeArchive ? liveTUnits.concat(archiveTUnits) : liveTUnits.slice();
  selectedT.sort((a, b) => a.id - b.id);
  const selectedFix = includeArchive ? liveFixUnits.concat(archiveFixUnits) : liveFixUnits;

  // 把 parsed 元数据挂回选中的单位（fix 块按文件内出现顺序一一对应）
  const liveBlocksById = new Map(liveParsed.blocks.map((b) => [b.id, b]));
  const archiveBlocksById = new Map(archiveParsed.blocks.map((b) => [b.id, b]));
  for (const u of selectedT) {
    u.parsed = (u.fromArchive ? archiveBlocksById : liveBlocksById).get(u.id) || null;
  }
  const liveFixList = liveParsed.fixBlocks.slice();
  const archiveFixList = archiveParsed.fixBlocks.slice();
  for (const u of selectedFix) {
    const list = u.fromArchive ? archiveFixList : liveFixList;
    u.parsed = list.shift() || null;
  }

  const liveLatest = targetLog.latestT;
  let nextT = liveLatest + 1;
  const tMap = new Map();
  const newUnits = [];
  const newFixUnits = [];
  let duplicateTurns = 0;
  let duplicateFixes = 0;

  for (const unit of selectedT) {
    if (!unit.parsed) return { error: 'Could not parse source block T' + unit.id + '.' };
    const session = unit.parsed.session || null;
    const derivedWhen = targetVersion >= 2 && !unit.parsed.when && session
      ? { kind: 'day', date: session }
      : null;
    const effectiveWhen = unit.parsed.when || derivedWhen;
    const key = contentKey(unit.parsed, 'T', effectiveWhen);
    const bucket = targetTKeys.get(key);
    if (bucket && bucket.length > 0) {
      tMap.set(unit.id, bucket.shift());
      duplicateTurns += 1;
      continue;
    }
    const targetId = nextT;
    nextT += 1;
    tMap.set(unit.id, targetId);
    newUnits.push({
      kind: 'T',
      sourceId: unit.id,
      targetId,
      raw: unit.raw,
      parsed: unit.parsed,
      session,
      derivedWhen,
      fromArchive: unit.fromArchive,
    });
  }

  for (const unit of selectedFix) {
    if (!unit.parsed) continue;
    const key = contentKey(unit.parsed, 'fix', null);
    const count = targetFixKeys.get(key) || 0;
    if (count > 0) {
      targetFixKeys.set(key, count - 1);
      duplicateFixes += 1;
      continue;
    }
    if (!tMap.has(unit.targetId)) {
      return {
        error: 'Source fix block T' + unit.targetId + '-fix points to a T-block that is not in the merged set.',
      };
    }
    newFixUnits.push({
      kind: 'fix',
      sourceId: unit.targetId,
      targetId: tMap.get(unit.targetId),
      raw: unit.raw,
      parsed: unit.parsed,
      session: unit.parsed.session || null,
      derivedWhen: null,
      fromArchive: unit.fromArchive,
    });
  }

  // 未映射引用：不让合并后的文本指向目标里的同号块，也不让悬空
  const selectedIds = new Set(selectedT.map((u) => u.id));
  const archiveIds = new Set(archiveTUnits.map((u) => u.id));
  for (const unit of newUnits.concat(newFixUnits)) {
    let m;
    T_REF_RE.lastIndex = 0;
    while ((m = T_REF_RE.exec(unit.raw)) !== null) {
      const ref = parseInt(m[1], 10);
      if (selectedIds.has(ref)) continue;
      if (archiveIds.has(ref) && !includeArchive) {
        return {
          error: 'Source block references T' + ref + ' which lives in log-archive.md; '
            + 'rerun with --include-archive.',
        };
      }
      return { error: 'Source block references T' + ref + ' which does not exist in the source log.' };
    }
  }

  const skippedArchive = includeArchive ? 0 : archiveTUnits.length;
  return {
    ok: true,
    tMap,
    newUnits,
    newFixUnits,
    duplicateTurns,
    duplicateFixes,
    skippedArchive,
    archivedMerged: includeArchive ? archiveTUnits.length : 0,
    latestAfterTurns: nextT - 1,
    sourceLatest: parseLog(sourcePocket).latestT,
  };
}

// ============================================================
// 长期文档规划
// ============================================================

function adrKey(adr) {
  return [adr.title, adr.context, adr.options, adr.decision, adr.consequences]
    .map(normalizeTextKey).join('\u0000');
}

function planDecisions(targetPocket, sourcePocket, tMap, fallbackT) {
  const target = parseDecisions(targetPocket);
  const source = parseDecisions(sourcePocket);
  const targetAdrs = target.adrs.filter((a) => !a.implausibleId);
  const sourceAdrs = source.adrs.filter((a) => !a.implausibleId);

  const byKey = new Map();
  const titles = new Set();
  for (const adr of targetAdrs) {
    const key = adrKey(adr);
    if (!byKey.has(key)) byKey.set(key, adr.id);
    titles.add(normalizeTextKey(adr.title));
  }

  let next = maxNumber(targetAdrs.map((a) => a.id)) + 1;
  const adrMap = new Map();
  const newAdrs = [];
  const sameTitle = [];

  for (const adr of sourceAdrs) {
    const key = adrKey(adr);
    if (byKey.has(key)) {
      adrMap.set(adr.id, byKey.get(key));
      continue;
    }
    const id = next;
    next += 1;
    adrMap.set(adr.id, id);
    newAdrs.push({ adr, newId: id });
    if (titles.has(normalizeTextKey(adr.title))) sameTitle.push({ sourceId: adr.id, title: adr.title });
  }

  return { adrMap, newAdrs, sameTitle, nextId: next };
}

function planRequirements(targetPocket, sourcePocket, tMap, fallbackT) {
  const target = parseRequirements(targetPocket);
  const source = parseRequirements(sourcePocket);
  const targetItems = target.items.filter((i) => !i.implausibleId);
  const sourceItems = source.items.filter((i) => !i.implausibleId);

  const byText = new Map();
  for (const item of targetItems) {
    const key = normalizeTextKey(item.text);
    if (!byText.has(key)) byText.set(key, item);
  }

  let next = Math.max(target.nextId, maxNumber(targetItems.map((i) => i.id)) + 1);
  const rMap = new Map();
  const newItems = [];
  const statusConflicts = [];

  for (const item of sourceItems) {
    const key = normalizeTextKey(item.text);
    if (byText.has(key)) {
      const existing = byText.get(key);
      rMap.set(item.id, existing.id);
      if (existing.status !== item.status) {
        statusConflicts.push({
          sourceId: item.id,
          targetId: existing.id,
          text: item.text,
          targetStatus: existing.status,
          sourceStatus: item.status,
        });
      }
      continue;
    }
    const id = next;
    next += 1;
    rMap.set(item.id, id);
    newItems.push({ item, newId: id });
  }

  return { rMap, newItems, statusConflicts, nextId: next };
}

function planAbsolute(targetPocket, sourcePocket, tMap, fallbackT) {
  const target = parseAbsolute(targetPocket);
  const source = parseAbsolute(sourcePocket);
  const existing = new Set(target.entries.map((e) => normalizeTextKey(e.content)));
  const newEntries = [];
  const duplicates = [];
  for (const entry of source.entries) {
    const key = normalizeTextKey(entry.content);
    if (existing.has(key)) {
      duplicates.push(entry);
      continue;
    }
    existing.add(key);
    newEntries.push({
      entry,
      anchor: tMap.get(entry.tId) || fallbackT,
    });
  }
  return { newEntries, duplicates };
}

function parsePreferenceLine(line) {
  const text = String(line || '').replace(/^-\s*/, '').trim();
  const idx = text.indexOf(':');
  if (idx === -1) return null;
  return {
    key: text.slice(0, idx).trim(),
    value: text.slice(idx + 1).trim(),
  };
}

function planPreferences(targetPocket, sourcePocket, maps) {
  const target = parsePreferences(targetPocket);
  const source = parsePreferences(sourcePocket);
  const targetMap = new Map();
  for (const line of target.items) {
    const parsed = parsePreferenceLine(line);
    if (parsed) targetMap.set(parsed.key.toLowerCase(), parsed);
  }

  const newPrefs = [];
  const conflicts = [];
  const skipped = [];
  const seen = new Set();
  for (const line of source.items) {
    const parsed = parsePreferenceLine(line);
    if (!parsed) continue;
    const lower = parsed.key.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const value = remapAllRefs(parsed.value, maps);
    const existing = targetMap.get(lower);
    if (!existing) {
      newPrefs.push({ key: parsed.key, value });
      continue;
    }
    if (normalizeTextKey(existing.value) === normalizeTextKey(parsed.value)) {
      skipped.push(parsed);
      continue;
    }
    conflicts.push({ key: parsed.key, target: existing.value, source: value });
  }
  return { newPrefs, conflicts, skipped };
}

// ============================================================
// 复制块改写
// ============================================================

function addMergedTag(heading) {
  if (/\[merged\]/.test(heading)) return heading;
  const m = heading.match(/^(.*?)(\s·\s)(\[[^\]]+\](?:\s+\[[^\]]+\])*)$/);
  if (m) return m[1] + m[2] + m[3] + ' [merged]';
  return heading + ' · [merged]';
}

function validateDocRefs(units, maps) {
  for (const unit of units) {
    let m;
    ADR_REF_RE.lastIndex = 0;
    while ((m = ADR_REF_RE.exec(unit.raw)) !== null) {
      const id = parseInt(m[1], 10);
      if (!maps.adr.has(id)) {
        return 'Source block references ADR-' + id + ' which does not exist in the source decisions.md.';
      }
    }
    R_REF_RE.lastIndex = 0;
    while ((m = R_REF_RE.exec(unit.raw)) !== null) {
      const id = parseInt(m[1], 10);
      if (!maps.r.has(id)) {
        return 'Source block references R' + id + ' which does not exist in the source requirements.md.';
      }
    }
  }
  return null;
}

function rewriteCopiedUnit(unit, maps, targetVersion) {
  const lines = unit.raw.split('\n');
  if (lines.length === 0) return unit.raw;

  if (unit.kind === 'fix') {
    lines[0] = lines[0].replace(/^(##\s+T)\d+(-fix)/, (whole, prefix, suffix) => prefix + unit.targetId + suffix);
  } else {
    lines[0] = lines[0].replace(/^(##\s+T)\d+/, (whole, prefix) => prefix + unit.targetId);
  }
  lines[0] = addMergedTag(lines[0]);

  if (targetVersion >= 2 && unit.derivedWhen && lines.length > 1 && !/^--- WHEN:/.test(lines[1])) {
    lines.splice(1, 0, `--- WHEN: ${unit.derivedWhen.date} (day) ---`);
  }

  for (let i = 1; i < lines.length; i++) {
    lines[i] = remapAllRefs(lines[i], maps);
  }
  return lines.join('\n');
}

// ============================================================
// 附件
// ============================================================

function attachmentCandidates(sourcePocket, sourceRoot, ref) {
  const normalized = String(ref).replace(/\\/g, '/');
  const out = [
    { file: path.join(sourcePocket, normalized), base: sourcePocket, rel: normalized },
    { file: path.join(sourceRoot, normalized), base: sourceRoot, rel: normalized },
  ];
  if (!normalized.startsWith('assets/') && !normalized.startsWith('ContextPocket/')) {
    out.push({
      file: path.join(sourcePocket, 'assets', normalized),
      base: path.join(sourcePocket, 'assets'),
      rel: normalized,
    });
    out.push({
      file: path.join(sourcePocket, 'assets', 'archive', normalized),
      base: path.join(sourcePocket, 'assets', 'archive'),
      rel: normalized,
    });
  }
  return out;
}

function renameRefToken(ref, tMap) {
  const normalized = String(ref).replace(/\\/g, '/');
  const hits = require('./repair').findFileTokens(normalized, tMap);
  if (hits.length === 0) return normalized;
  return hits[0].renamed;
}

function targetBaseFor(sourceBase, sourcePocket, sourceRoot, targetPocket, targetRoot) {
  if (path.resolve(sourceBase) === path.resolve(sourcePocket)) return targetPocket;
  if (path.resolve(sourceBase) === path.resolve(sourceRoot)) return targetRoot;
  if (path.resolve(sourceBase) === path.resolve(sourcePocket, 'assets')) {
    return path.join(targetPocket, 'assets');
  }
  if (path.resolve(sourceBase) === path.resolve(sourcePocket, 'assets', 'archive')) {
    return path.join(targetPocket, 'assets', 'archive');
  }
  return null;
}

function sameFileContent(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    return crypto.createHash('sha1').update(fs.readFileSync(a)).digest('hex')
      === crypto.createHash('sha1').update(fs.readFileSync(b)).digest('hex');
  } catch (e) {
    return false;
  }
}

function planAttachments(sourcePocket, targetPocket, units, tMap) {
  const sourceRoot = getProjectRoot(sourcePocket);
  const targetRoot = getProjectRoot(targetPocket);
  const copies = [];
  const replacements = [];
  const conflicts = [];
  const missing = [];

  for (const unit of units) {
    const sections = unit.parsed && unit.parsed.sections ? unit.parsed.sections : {};
    for (const item of sections.Attachments || []) {
      for (const ref of attachmentRefs(item)) {
        const candidates = attachmentCandidates(sourcePocket, sourceRoot, ref);
        const found = candidates.find((c) => fileExists(c.file));
        if (!found) {
          missing.push({ ref, sourceId: unit.sourceId });
          continue;
        }
        const renamedRel = renameRefToken(found.rel, tMap);
        const targetBase = targetBaseFor(found.base, sourcePocket, sourceRoot, targetPocket, targetRoot);
        if (!targetBase) {
          missing.push({ ref, sourceId: unit.sourceId, reason: 'outside pocket' });
          continue;
        }
        const dest = path.join(targetBase, renamedRel);
        const destResolved = path.resolve(dest);
        if (!destResolved.startsWith(path.resolve(targetBase) + path.sep) && destResolved !== path.resolve(targetBase)) {
          missing.push({ ref, sourceId: unit.sourceId, reason: 'path escapes target' });
          continue;
        }
        if (renamedRel !== found.rel) {
          replacements.push({ from: found.rel, to: renamedRel });
        }
        if (fileExists(dest)) {
          if (!sameFileContent(found.file, dest)) {
            conflicts.push({ ref, dest, reason: 'target file differs; kept target' });
          }
          continue;
        }
        copies.push({ src: found.file, dest, ref });
      }
    }
  }

  return { copies, replacements, conflicts, missing };
}

function applyAttachmentReplacements(units, replacements) {
  for (const unit of units) {
    for (const rep of replacements) {
      if (unit.raw.indexOf(rep.from) !== -1) {
        unit.raw = unit.raw.split(rep.from).join(rep.to);
      }
    }
  }
}

// ============================================================
// 文档写入
// ============================================================

function ensureTrailingNewline(text) {
  const s = String(text || '');
  return s.endsWith('\n') ? s : s + '\n';
}

function defaultDocContent(file) {
  switch (file) {
    case 'decisions.md':
      return '# Decisions · T0\n\n';
    case 'requirements.md':
      return '# Requirements · T0 · next_id: R1\n\n## Open\n\n## Done\n\n## Cancelled\n';
    case 'preferences.md':
      return '# Preferences · T0\n\n';
    case 'absolute.md':
      return '# 🔒 Absolute\n\n';
    default:
      return '';
  }
}

function formatAdrEntry(adr, newId, maps, fallbackT) {
  const created = maps.t.get(adr.createdAt) || fallbackT;
  const supersedes = adr.supersedes && adr.supersedes !== 'none'
    ? remapAdrText(adr.supersedes, maps.adr)
    : 'none';
  return [
    '',
    `## ADR-${newId} · ${sanitizeInline(adr.title)} · T${created}`,
    `- Context: ${sanitizeInline(adr.context)}`,
    `- Options: ${sanitizeInline(adr.options)}`,
    `- Decision: ${sanitizeInline(adr.decision)}`,
    `- Consequences: ${sanitizeInline(adr.consequences)}`,
    `- Supersedes: ${supersedes}`,
  ].join('\n');
}

function formatRequirementEntry(entry, maps, fallbackT) {
  const item = entry.item;
  const id = entry.newId;
  const opened = maps.t.get(item.openedAt) || fallbackT;
  const completed = item.completedAt ? (maps.t.get(item.completedAt) || fallbackT) : null;
  let line = `- [${item.status === 'Done' ? 'x' : ' '}] `;
  if (item.uncertain) line += '❓ ';
  line += `R${id} ${sanitizeInline(item.text)}`;
  if (item.tags && item.tags.length > 0) line += ` [${item.tags.join(', ')}]`;
  line += ` (opened T${opened}`;
  if (item.status === 'Done') line += `, completed T${completed || opened}`;
  else if (item.status === 'Cancelled') line += `, cancelled T${completed || opened}`;
  line += ')';
  if (item.impl && item.impl.length > 0) line += ` · impl: ${item.impl.join(', ')}`;
  return line;
}

function insertRequirementLines(content, status, lines) {
  if (lines.length === 0) return content;
  const block = lines.join('\n');
  const re = new RegExp('(^## ' + status + '\\s*\\n)', 'm');
  if (re.test(content)) {
    return content.replace(re, (whole, heading) => heading + block + '\n');
  }
  return ensureTrailingNewline(content) + '\n## ' + status + '\n' + block + '\n';
}

function bumpHeaderT(content, latestT, nextR) {
  let out = String(content || '');
  out = out.replace(/^(# [^\n]*?)T\d+/, (whole, prefix) => prefix + 'T' + latestT);
  if (nextR !== undefined && nextR !== null) {
    out = out.replace(/next_id:\s*R\d+/, 'next_id: R' + nextR);
  }
  return out;
}

// ============================================================
// 报告与合并记录
// ============================================================

function mapPairs(map) {
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([from, to]) => ({ from, to }));
}

function composeReport(pocketDir, ctx) {
  const zh = readConfig(pocketDir).language === 'zh';
  const lines = [];
  lines.push('# ContextPocket · MERGE REPORT');
  lines.push('');
  lines.push('- ' + (zh ? '生成时间' : 'Generated') + ': ' + new Date().toISOString());
  lines.push('- ' + (zh ? '源' : 'Source') + ': `' + ctx.sourcePocket + '` (' + ctx.sourceVersion + ', latest T' + ctx.sourceLatest + ')');
  lines.push('- ' + (zh ? '目标' : 'Target') + ': `' + ctx.targetPocket + '` (' + ctx.targetVersion + ', T' + ctx.targetLatestBefore + ' → T' + ctx.targetLatestAfter + ')');
  lines.push('- ' + (zh ? '归档' : 'Archive') + ': ' + (ctx.turns.archivedMerged > 0
    ? (zh ? `已合入 ${ctx.turns.archivedMerged} 轮` : `${ctx.turns.archivedMerged} archived turn(s) merged`)
    : (zh ? `跳过 ${ctx.turns.archivedSkipped} 轮（--include-archive 才合）` : `${ctx.turns.archivedSkipped} archived turn(s) skipped (use --include-archive)`)));
  lines.push('');
  lines.push('## ' + (zh ? '轮次' : 'Turns'));
  lines.push('');
  lines.push('- ' + (zh ? '新增' : 'Added') + ': ' + ctx.turns.added + ' T, ' + ctx.turns.fixesAdded + ' fix');
  lines.push('- ' + (zh ? '已存在' : 'Already present') + ': ' + ctx.turns.duplicates + ' T, ' + ctx.turns.fixesDuplicates + ' fix');
  if (ctx.newTIds.length > 0) {
    lines.push('- ' + (zh ? '新编号' : 'New ids') + ': T' + ctx.newTIds[0] + '–T' + ctx.newTIds[ctx.newTIds.length - 1]);
  }
  lines.push('');
  lines.push('## ' + (zh ? '长期文档' : 'Living docs'));
  lines.push('');
  lines.push('- ADR: ' + ctx.docs.adrsAdded + ' ' + (zh ? '新增' : 'added') + ', ' + ctx.docs.adrsMatched + ' ' + (zh ? '已存在' : 'matched'));
  lines.push('- ' + (zh ? '需求' : 'Requirements') + ': ' + ctx.docs.reqsAdded + ' ' + (zh ? '新增' : 'added') + ', ' + ctx.docs.reqsMatched + ' ' + (zh ? '已存在' : 'matched'));
  lines.push('- 🔒: ' + ctx.docs.absoluteAdded + ' ' + (zh ? '新增' : 'added') + ', ' + ctx.docs.absoluteDuplicates + ' ' + (zh ? '已存在' : 'duplicate'));
  lines.push('- ' + (zh ? '偏好' : 'Preferences') + ': ' + ctx.docs.prefsAdded + ' ' + (zh ? '新增' : 'added') + ', ' + ctx.docs.prefConflicts.length + ' ' + (zh ? '冲突' : 'conflict'));
  lines.push('');
  if (ctx.docs.sameTitle.length > 0) {
    lines.push('## ' + (zh ? '同标题不同内容的 ADR' : 'ADR: same title, different content'));
    for (const item of ctx.docs.sameTitle) lines.push('- ' + item.title + ' (source ADR-' + item.sourceId + ')');
    lines.push('');
  }
  if (ctx.docs.reqStatusConflicts.length > 0) {
    lines.push('## ' + (zh ? '需求状态冲突' : 'Requirement status conflicts'));
    for (const item of ctx.docs.reqStatusConflicts) {
      lines.push('- R' + item.sourceId + ' → R' + item.targetId + ': ' + item.text
        + ' (' + item.targetStatus + ' / source ' + item.sourceStatus + ')');
    }
    lines.push('');
  }
  if (ctx.docs.prefConflicts.length > 0) {
    lines.push('## ' + (zh ? '偏好冲突（保留目标）' : 'Preference conflicts (target kept)'));
    for (const item of ctx.docs.prefConflicts) {
      lines.push('- ' + item.key + ': target = `' + item.target + '`, source = `' + item.source + '`');
    }
    lines.push('');
  }
  if (ctx.attachments.copied.length > 0 || ctx.attachments.conflicts.length > 0 || ctx.attachments.missing.length > 0) {
    lines.push('## ' + (zh ? '附件' : 'Attachments'));
    lines.push('');
    lines.push('- ' + (zh ? '复制' : 'Copied') + ': ' + ctx.attachments.copied.length);
    for (const item of ctx.attachments.conflicts) lines.push('- ' + (zh ? '冲突' : 'Conflict') + ': ' + item.ref + ' — ' + item.reason);
    for (const item of ctx.attachments.missing) lines.push('- ' + (zh ? '未处理' : 'Unresolved') + ': ' + item.ref + (item.reason ? ' — ' + item.reason : ''));
    lines.push('');
  }
  lines.push('## ' + (zh ? '未自动合并（请人工复核）' : 'Not merged automatically (review)'));
  lines.push('');
  if (ctx.sourceState.summary.length || ctx.sourceState.nextSteps.length || ctx.sourceState.pitfalls.length) {
    lines.push('### ' + (zh ? '源 state.md' : 'Source state.md'));
    if (ctx.sourceState.summary.length) lines.push('- Summary: ' + ctx.sourceState.summary.join(' / '));
    if (ctx.sourceState.nextSteps.length) lines.push('- Next: ' + ctx.sourceState.nextSteps.join(' / '));
    if (ctx.sourceState.pitfalls.length) lines.push('- Pitfalls: ' + ctx.sourceState.pitfalls.join(' / '));
    lines.push('');
  }
  if (ctx.sourceCodeMapExists) {
    lines.push('### ' + (zh ? '源 code-map.md' : 'Source code-map.md'));
    const suggestions = ctx.sourceCodeMapSuggestions || [];
    if (suggestions.length === 0) {
      lines.push('- ' + (zh
        ? '没有可直接沿用的描述（目标文件不存在，或描述已一致）。'
        : 'No directly reusable descriptions (target files are missing or already match).'));
    } else {
      for (const item of suggestions) {
        lines.push('- ' + item.path + ' — ' + item.description
          + (item.reason === 'different'
            ? ' (' + (zh ? '目标现有：' : 'target has: ') + '`' + item.current + '`)'
            : ' (' + (zh ? '目标缺失' : 'missing in target') + ')'));
      }
      if (ctx.sourceCodeMapTruncated) {
        lines.push('- … ' + (zh ? '仅列出前 ' : 'first ')
          + CODE_MAP_SUGGESTION_LIMIT + (zh ? ' 条' : ' only'));
      }
    }
  }
  lines.push('');
  lines.push('## ' + (zh ? '编号映射' : 'Id map'));
  lines.push('');
  if (ctx.tMapPairs.length > 0) lines.push('- T: ' + ctx.tMapPairs.map((p) => 'T' + p.from + '→T' + p.to).join(', '));
  if (ctx.adrMapPairs.length > 0) lines.push('- ADR: ' + ctx.adrMapPairs.map((p) => 'ADR-' + p.from + '→ADR-' + p.to).join(', '));
  if (ctx.rMapPairs.length > 0) lines.push('- R: ' + ctx.rMapPairs.map((p) => 'R' + p.from + '→R' + p.to).join(', '));
  lines.push('');
  return lines.join('\n');
}

function appendMergeRecord(pocketDir, ctx) {
  const zh = readConfig(pocketDir).language === 'zh';
  const fields = {
    gist: 'merge: ' + path.basename(ctx.sourcePocket),
    tags: ['merge'],
    user: [zh
      ? '（由 context-pocket merge 自动记录 —— 这不是用户的一轮，是合并另一个口袋这个事实。）'
      : '(Recorded automatically by context-pocket merge — not a user turn, but the fact that another pocket was merged.)'],
    action: [
      (zh ? '合并源口袋 ' : 'Merged source pocket ') + ctx.sourcePocket
        + ' (' + ctx.sourceVersion + ', source latest T' + ctx.sourceLatest + ')',
      (zh ? '新增轮次 ' : 'Added turns ') + ctx.turns.added + ' T / ' + ctx.turns.fixesAdded + ' fix'
        + '; ' + (zh ? '已存在 ' : 'already present ') + ctx.turns.duplicates + ' T / ' + ctx.turns.fixesDuplicates + ' fix',
      'ADR +' + ctx.docs.adrsAdded + ', R +' + ctx.docs.reqsAdded + ', 🔒 +' + ctx.docs.absoluteAdded
        + ', prefs +' + ctx.docs.prefsAdded,
    ],
  };
  const uncertain = [];
  if (ctx.docs.prefConflicts.length > 0) {
    uncertain.push((zh ? '偏好冲突已保留目标值，详见 ' : 'Preference conflicts kept target values; see ')
      + '`' + path.basename(ctx.reportPath) + '`');
  }
  if (ctx.docs.reqStatusConflicts.length > 0) {
    uncertain.push((zh ? '需求状态冲突已保留目标状态，详见 ' : 'Requirement status conflicts kept target state; see ')
      + '`' + path.basename(ctx.reportPath) + '`');
  }
  if (ctx.sourceState.summary.length || ctx.sourceState.nextSteps.length || ctx.sourceState.pitfalls.length
    || ctx.sourceCodeMapExists) {
    const codeMapCount = (ctx.sourceCodeMapSuggestions || []).length;
    uncertain.push(zh
      ? '源 state.md / code-map.md 未自动合并，详见 merge 报告'
        + (codeMapCount > 0 ? '（code-map 有 ' + codeMapCount + ' 条可复核描述）' : '') + '。'
      : 'Source state.md / code-map.md were not auto-merged; see the merge report'
        + (codeMapCount > 0 ? ' (' + codeMapCount + ' code-map suggestion(s))' : '') + '.');
  }
  if (uncertain.length > 0) fields.uncertain = uncertain;
  fields.conflictCheck = false;
  return writer.internal.appendLogBlock(pocketDir, fields);
}

// ============================================================
// 主流程
// ============================================================

const CODE_MAP_TODO_DESC = '⚠️ TODO: add description';
const CODE_MAP_SUGGESTION_LIMIT = 50;

/**
 * 源 code-map 里可以直接沿用的描述：
 *   - 只建议目标项目里真实存在的文件（目录与缺失文件不猜）；
 *   - 只建议有真实描述（TODO 占位符不算）且与目标不同的条目；
 *   - 最多 50 条，报告里注明截断。
 * 合并仍不自动改目标 code-map：这里只是把"要人工看哪些"列清楚。
 */
function planCodeMapSuggestions(sourcePocket, targetPocket) {
  const sourcePath = path.join(sourcePocket, 'code-map.md');
  if (!fileExists(sourcePath)) return { entries: [], truncated: false };

  const sourceMap = parseCodeMapEntries(readTextOr(sourcePath, ''));
  const targetMap = parseCodeMapEntries(readTextOr(path.join(targetPocket, 'code-map.md'), ''));
  const projectRoot = getProjectRoot(targetPocket);
  const entries = [];

  for (const [filePath, description] of Object.entries(sourceMap.byPath)) {
    if (!description || description === CODE_MAP_TODO_DESC) continue;
    if (filePath.endsWith('/')) continue;
    if (!fileExists(path.join(projectRoot, filePath))) continue;
    const current = targetMap.byPath[filePath];
    if (current === description) continue;
    entries.push({
      path: filePath,
      description,
      current: current === undefined ? null : current,
      reason: current === undefined ? 'missing' : 'different',
    });
    if (entries.length >= CODE_MAP_SUGGESTION_LIMIT) {
      return { entries, truncated: true };
    }
  }
  return { entries, truncated: false };
}

function mergePocketImpl(targetPocket, options = {}) {
  const dryRun = !!options.dryRun;
  const includeArchive = !!options.includeArchive;

  if (!isPocketDir(targetPocket)) {
    return { ok: false, error: 'Target is not a ContextPocket: ' + targetPocket };
  }

  const targetIso = detectIsolation({ cwd: getProjectRoot(targetPocket), pocketDir: targetPocket });
  if (targetIso.isolated) {
    return { ok: false, error: 'Target pocket is isolated (' + targetIso.source + '): ' + targetIso.reason };
  }

  const resolved = resolveSource(options.from);
  if (resolved.error) return { ok: false, error: resolved.error };
  const sourcePocket = resolved.pocketDir;

  const pre = preflightSource(sourcePocket, targetPocket);
  if (pre.error) return { ok: false, error: pre.error, sourceVerify: pre.sourceVerify };

  const codeMapPlan = planCodeMapSuggestions(sourcePocket, targetPocket);

  const targetVersion = detectFormatVersion(targetPocket);
  const sourceVersion = pre.sourceVersion;
  const targetLatestBefore = parseLog(targetPocket).latestT;
  const targetVerifyBefore = verify(targetPocket);

  const turns = planTurns(targetPocket, sourcePocket, { includeArchive });
  if (turns.error) return { ok: false, error: turns.error };

  const mergeRecordT = (targetLatestBefore + turns.newUnits.length) + 1;
  const docsAdr = planDecisions(targetPocket, sourcePocket, turns.tMap, mergeRecordT);
  const docsReq = planRequirements(targetPocket, sourcePocket, turns.tMap, mergeRecordT);
  const docsAbs = planAbsolute(targetPocket, sourcePocket, turns.tMap, mergeRecordT);
  const maps = { t: turns.tMap, adr: docsAdr.adrMap, r: docsReq.rMap };
  const docsPref = planPreferences(targetPocket, sourcePocket, maps);
  const allNewUnits = turns.newUnits.concat(turns.newFixUnits);
  const refError = validateDocRefs(allNewUnits, maps);
  if (refError) return { ok: false, error: refError };
  for (const unit of allNewUnits) {
    unit.raw = rewriteCopiedUnit(unit, maps, versionNumber(targetVersion));
  }

  const attachments = planAttachments(sourcePocket, targetPocket, turns.newUnits, turns.tMap);
  applyAttachmentReplacements(turns.newUnits, attachments.replacements);

  const newTIds = turns.newUnits.map((u) => u.targetId);
  const hasNew = turns.newUnits.length > 0
    || turns.newFixUnits.length > 0
    || docsAdr.newAdrs.length > 0
    || docsReq.newItems.length > 0
    || docsReq.statusConflicts.length > 0
    || docsAbs.newEntries.length > 0
    || docsPref.newPrefs.length > 0
    || docsPref.conflicts.length > 0;

  const sourceState = parseState(sourcePocket);
  const sourceCodeMapPath = path.join(sourcePocket, 'code-map.md');

  const baseResult = {
    ok: true,
    dryRun,
    alreadyMerged: !hasNew,
    source: {
      pocketDir: sourcePocket,
      projectRoot: getProjectRoot(sourcePocket),
      version: sourceVersion,
      latestT: turns.sourceLatest,
    },
    target: {
      pocketDir: targetPocket,
      version: targetVersion,
      latestTBefore: targetLatestBefore,
      latestTAfter: targetLatestBefore + turns.newUnits.length + (hasNew ? 1 : 0),
    },
    turns: {
      added: turns.newUnits.length,
      duplicates: turns.duplicateTurns,
      fixesAdded: turns.newFixUnits.length,
      fixesDuplicates: turns.duplicateFixes,
      archivedSkipped: turns.skippedArchive,
      archivedMerged: turns.archivedMerged,
    },
    docs: {
      adrsAdded: docsAdr.newAdrs.length,
      adrsMatched: docsAdr.adrMap.size - docsAdr.newAdrs.length,
      reqsAdded: docsReq.newItems.length,
      reqsMatched: docsReq.rMap.size - docsReq.newItems.length,
      reqStatusConflicts: docsReq.statusConflicts,
      absoluteAdded: docsAbs.newEntries.length,
      absoluteDuplicates: docsAbs.duplicates.length,
      prefsAdded: docsPref.newPrefs.length,
      prefConflicts: docsPref.conflicts,
      sameTitle: docsAdr.sameTitle,
    },
    attachments: {
      copied: attachments.copies.map((c) => c.dest),
      conflicts: attachments.conflicts,
      missing: attachments.missing,
    },
    codeMap: {
      suggestions: codeMapPlan.entries,
      truncated: codeMapPlan.truncated,
    },
    maps: {
      t: mapPairs(turns.tMap),
      adr: mapPairs(docsAdr.adrMap),
      r: mapPairs(docsReq.rMap),
    },
    newTIds,
    mergeRecordT: hasNew ? mergeRecordT : null,
    verifyBefore: verifySummary(targetVerifyBefore),
  };

  if (!hasNew) {
    return baseResult;
  }

  if (dryRun) {
    baseResult.reportPath = null;
    return baseResult;
  }

  // ---------- 快照 ----------
  const snapshots = new Map();
  for (const file of SNAPSHOT_FILES) {
    const p = path.join(targetPocket, file);
    snapshots.set(file, fileExists(p) ? readTextOr(p, '') : null);
  }

  const today = getTodayStr();
  const reportPath = path.join(targetPocket, 'merge-' + today + '.md');
  const reportSnapshot = fileExists(reportPath) ? readTextOr(reportPath, '') : null;
  const createdAttachments = [];

  const restore = () => {
    for (const [file, content] of snapshots) {
      const p = path.join(targetPocket, file);
      if (content === null) {
        try { if (fileExists(p)) fs.unlinkSync(p); } catch (e) { /* ignore */ }
      } else {
        writeAtomic(p, content);
      }
    }
    if (reportSnapshot === null) {
      try { if (fileExists(reportPath)) fs.unlinkSync(reportPath); } catch (e) { /* ignore */ }
    } else {
      writeAtomic(reportPath, reportSnapshot);
    }
    for (const file of createdAttachments) {
      try { if (fileExists(file)) fs.unlinkSync(file); } catch (e) { /* ignore */ }
    }
  };

  try {
    // ---------- 1. 写 log 合并块 ----------
    if (turns.newUnits.length > 0 || turns.newFixUnits.length > 0) {
      let logContent = readTextRequired(path.join(targetPocket, 'log.md'));
      if (!logContent.endsWith('\n')) logContent += '\n';
      const targetLog = parseLog(targetPocket);
      const lastSession = targetLog.sessions.length > 0
        ? targetLog.sessions[targetLog.sessions.length - 1].date
        : null;
      if (lastSession !== today) {
        logContent += '\n--- SESSION: ' + today + ' ---\n';
      }
      const chunks = turns.newUnits.concat(turns.newFixUnits).map((u) => u.raw.trim());
      logContent += '\n' + chunks.join('\n\n') + '\n';
      writeAtomic(path.join(targetPocket, 'log.md'), logContent);
    }

    // ---------- 2. merge 记录 ----------
    const record = appendMergeRecord(targetPocket, {
      sourcePocket,
      sourceVersion,
      sourceLatest: turns.sourceLatest,
      targetPocket,
      targetVersion,
      targetLatestBefore,
      targetLatestAfter: mergeRecordT,
      turns: baseResult.turns,
      docs: baseResult.docs,
      reportPath,
      sourceState,
      sourceCodeMapExists: fileExists(sourceCodeMapPath),
      sourceCodeMapSuggestions: codeMapPlan.entries,
    });
    if (!record || record.success === false) {
      throw new Error('merge record could not be written');
    }
    if (record.tId !== mergeRecordT) {
      throw new Error('merge record T-id mismatch: expected T' + mergeRecordT + ', got T' + record.tId);
    }

    // ---------- 3. 长期文档 ----------
    const finalLatest = mergeRecordT;

    if (docsAdr.newAdrs.length > 0) {
      const p = path.join(targetPocket, 'decisions.md');
      let content = fileExists(p) ? readTextOr(p, '') : defaultDocContent('decisions.md');
      content = ensureTrailingNewline(content);
      for (const entry of docsAdr.newAdrs) {
        content += formatAdrEntry(entry.adr, entry.newId, maps, mergeRecordT) + '\n';
      }
      writeAtomic(p, content);
    }

    if (docsReq.newItems.length > 0) {
      const p = path.join(targetPocket, 'requirements.md');
      let content = fileExists(p) ? readTextOr(p, '') : defaultDocContent('requirements.md');
      const groups = { Open: [], Done: [], Cancelled: [] };
      for (const entry of docsReq.newItems) {
        const status = groups[entry.item.status] ? entry.item.status : 'Open';
        groups[status].push(formatRequirementEntry(entry, maps, mergeRecordT));
      }
      for (const status of ['Open', 'Done', 'Cancelled']) {
        content = insertRequirementLines(content, status, groups[status]);
      }
      writeAtomic(p, content);
    }

    if (docsAbs.newEntries.length > 0) {
      const p = path.join(targetPocket, 'absolute.md');
      let content = fileExists(p) ? readTextOr(p, '') : defaultDocContent('absolute.md');
      content = ensureTrailingNewline(content);
      for (const entry of docsAbs.newEntries) {
        content += '\n## 🔒 T' + entry.anchor + ' · ' + sanitizeInline(entry.entry.gist) + '\n';
        content += sanitizeBlockquote(entry.entry.content) + '\n';
      }
      writeAtomic(p, content);
    }

    if (docsPref.newPrefs.length > 0) {
      const p = path.join(targetPocket, 'preferences.md');
      let content = fileExists(p) ? readTextOr(p, '') : defaultDocContent('preferences.md');
      content = ensureTrailingNewline(content);
      for (const pref of docsPref.newPrefs) {
        content += `- ${sanitizeInline(pref.key)}: ${sanitizeInline(pref.value)}\n`;
      }
      writeAtomic(p, content);
    }

    // ---------- 4. 派生头行 ----------
    for (const file of ['decisions.md', 'preferences.md', 'state.md', 'code-map.md']) {
      const p = path.join(targetPocket, file);
      if (!fileExists(p)) continue;
      const content = readTextOr(p, '');
      const next = bumpHeaderT(content, finalLatest);
      if (next !== content) writeAtomic(p, next);
    }
    {
      const p = path.join(targetPocket, 'requirements.md');
      if (fileExists(p)) {
        const content = readTextOr(p, '');
        writeAtomic(p, bumpHeaderT(content, finalLatest, docsReq.nextId));
      }
    }

    // ---------- 5. index.md ----------
    writer.internal.updateIndexHeader(targetPocket, finalLatest, today);
    writer.updateIndexReqCount(targetPocket);
    writer.updateIndexAdrCount(targetPocket, parseDecisions(targetPocket).count);
    writer.updateIndexAbsoluteCount(targetPocket, parseAbsolute(targetPocket).count);
    writer.updateIndexPrefCount(targetPocket);

    // ---------- 6. 附件 ----------
    for (const copy of attachments.copies) {
      if (fileExists(copy.dest)) continue;
      ensureDir(path.dirname(copy.dest));
      createdAttachments.push(copy.dest);
      fs.copyFileSync(copy.src, copy.dest);
    }

    // ---------- 7. 报告 ----------
    const report = composeReport(targetPocket, {
      sourcePocket,
      sourceVersion,
      sourceLatest: turns.sourceLatest,
      targetPocket,
      targetVersion,
      targetLatestBefore,
      targetLatestAfter: finalLatest,
      turns: baseResult.turns,
      newTIds: baseResult.newTIds,
      docs: baseResult.docs,
      tMapPairs: baseResult.maps.t,
      adrMapPairs: baseResult.maps.adr,
      rMapPairs: baseResult.maps.r,
      attachments: {
        copied: attachments.copies,
        conflicts: attachments.conflicts,
        missing: attachments.missing,
      },
      sourceState,
      sourceCodeMapExists: fileExists(sourceCodeMapPath),
      sourceCodeMapSuggestions: codeMapPlan.entries,
      sourceCodeMapTruncated: codeMapPlan.truncated,
      reportPath,
    });
    if (reportSnapshot !== null) {
      writeAtomic(reportPath, ensureTrailingNewline(reportSnapshot) + '\n' + report + '\n');
    } else {
      writeAtomic(reportPath, report);
    }

    // ---------- 8. verify 闸门 ----------
    const after = verify(targetPocket);
    const liveHeadings = collectHeadings(readTextRequired(path.join(targetPocket, 'log.md')).split('\n'));
    if (after.errorCount > targetVerifyBefore.errorCount || hasDuplicateIds(liveHeadings)) {
      restore();
      try { refreshGraphCacheIfExists(targetPocket); } catch (e) { /* derived */ }
      return {
        ok: false,
        error: 'merge rolled back: verify errors ' + targetVerifyBefore.errorCount + ' → ' + after.errorCount
          + (hasDuplicateIds(liveHeadings) ? ' (duplicate T-id after merge)' : ''),
        rolledBack: true,
        source: baseResult.source,
        target: baseResult.target,
        verifyBefore: baseResult.verifyBefore,
        verifyAfter: verifySummary(after),
      };
    }

    try { refreshGraphCacheIfExists(targetPocket); } catch (e) { /* derived */ }
    let handoffRegenerated = false;
    try {
      writer.internal.generateHandoff(targetPocket);
      handoffRegenerated = true;
    } catch (e) { /* handoff 是派生文件，失败不拦合并 */ }
    afterWrite(targetPocket, { latestT: finalLatest, gist: 'merge: ' + path.basename(sourcePocket) });

    // ---------- 9. 复核侧车 ----------
    // 只有存在可安全重放的建议时才落 sidecar；state 建议本身也算可复核项。
    const reviewSuggestions = {
      reqStatus: baseResult.docs.reqStatusConflicts,
      pref: baseResult.docs.prefConflicts,
      state: sourceState,
      codeMap: codeMapPlan.entries,
      codeMapTruncated: codeMapPlan.truncated,
    };
    const actionable = reviewSuggestions.reqStatus.length
      + reviewSuggestions.pref.length
      + reviewSuggestions.codeMap.length
      + mergeReview.stateSuggestionCount(sourceState);
    const review = actionable > 0
      ? mergeReview.appendReview(targetPocket, {
        date: today,
        source: baseResult.source,
        target: baseResult.target,
        suggestions: reviewSuggestions,
      })
      : null;

    return Object.assign(baseResult, {
      target: {
        pocketDir: targetPocket,
        version: targetVersion,
        latestTBefore: targetLatestBefore,
        latestTAfter: finalLatest,
      },
      reportPath,
      reviewId: review ? review.id : null,
      reviewPath: review ? review.path : null,
      reviewPending: review ? review.pending : 0,
      handoffRegenerated,
      verifyAfter: verifySummary(after),
    });
  } catch (e) {
    try {
      restore();
      try { refreshGraphCacheIfExists(targetPocket); } catch (cacheErr) { /* derived */ }
    } catch (rollbackErr) {
      throw new Error(e.message + ' (rollback also failed: ' + rollbackErr.message + ')');
    }
    return {
      ok: false,
      error: e.message,
      rolledBack: true,
      source: baseResult.source,
      target: baseResult.target,
    };
  }
}

module.exports = {
  mergePocket: require('./io').lockedWrite(mergePocketImpl),
  // 纯函数导出给测试
  mergePocketImpl,
  resolveSource,
  sliceUnits,
  contentKey,
  canonicalText,
  planDecisions,
  planRequirements,
  planAbsolute,
  planPreferences,
};
