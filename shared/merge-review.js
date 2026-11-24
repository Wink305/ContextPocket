'use strict';

/**
 * ContextPocket — merge 复核侧车（quan）
 *
 * merge 会把无法自动合并的内容写进 merge-<date>.md；这个模块把同样的建议
 * 以结构化 JSON 落到 merge-<date>.json，供 `merge report --apply <id>` 逐项应用。
 *
 * 只处理四类可以安全重放的项：
 *   - 需求状态冲突：目标需求按源状态迁移，前提是目标仍停在合并时记录的状态
 *   - 偏好冲突：把目标值改成源值，前提是目标值仍等于合并时记录的目标值
 *   - 源 state 建议：summary / next steps / pitfalls 中目标尚未出现的行
 *   - code-map "目标缺失"：只给目标树里存在、但没有真实描述的文件补上源描述；
 *     "目标已有不同描述"（different）仍留在 Markdown 报告里人工复核
 * 附件冲突仍留在 Markdown 报告里，保持人工复核。
 *
 * 幂等：应用前逐项比对当前值；重复 --apply 不会写第二遍。
 */

const fs = require('fs');
const path = require('path');

const { writeAtomic, readTextOr, withPocketLock, sanitizeInline } = require('./io');
const { fileExists, isPlaceholderLine } = require('./core');
const { parseLog, parseRequirements } = require('./parser');
const writer = require('./writer');

const SIDECAR_VERSION = 1;

function sidecarPath(pocketDir, date) {
  return path.join(pocketDir, 'merge-' + date + '.json');
}

function emptySidecar(date) {
  return { version: SIDECAR_VERSION, date, reviews: [] };
}

function loadSidecar(pocketDir, date) {
  const file = sidecarPath(pocketDir, date);
  if (!fileExists(file)) return emptySidecar(date);
  try {
    const data = JSON.parse(readTextOr(file, '{}'));
    if (data && Array.isArray(data.reviews)) {
      return { version: SIDECAR_VERSION, date, reviews: data.reviews };
    }
  } catch (e) { /* 坏文件按空处理，下一次 merge 重建 */ }
  return emptySidecar(date);
}

function saveSidecar(pocketDir, data) {
  writeAtomic(sidecarPath(pocketDir, data.date), JSON.stringify(data, null, 2) + '\n');
}

function stateLines(state) {
  const src = state || {};
  const clean = (items) => (Array.isArray(items) ? items : [])
    .filter((item) => !isPlaceholderLine(String(item)));
  return {
    summary: clean(src.summary),
    nextSteps: clean(src.nextSteps),
    pitfalls: clean(src.pitfalls),
  };
}

function stateSuggestionCount(state) {
  const clean = stateLines(state);
  return clean.summary.length + clean.nextSteps.length + clean.pitfalls.length;
}

function codeMapCount(suggestions) {
  const codeMap = suggestions && suggestions.codeMap;
  if (Array.isArray(codeMap)) return codeMap.length;
  return codeMap ? 1 : 0; // 旧 sidecar 只有 boolean
}

/**
 * 应用后仍未处理的 code-map 项：missing 已补的从 pending 里消失，
 * different / 目标树里没有路径 / 已被别人补过 的仍算人工待办。
 */
function pendingCodeMap(review) {
  if (!review.appliedAt) return codeMapCount(review.suggestions || {});
  return (review.skipped || []).filter((item) => item.type === 'code-map').length;
}

function reviewPending(review) {
  const s = review.suggestions || {};
  const state = stateLines(s.state);
  return (s.reqStatus || []).length + (s.pref || []).length
    + pendingCodeMap(review)
    + state.summary.length + state.nextSteps.length + state.pitfalls.length;
}

function summarize(review) {
  return {
    id: review.id,
    generatedAt: review.generatedAt,
    source: review.source,
    target: review.target,
    pending: reviewPending(review),
    manual: pendingCodeMap(review),
    appliedAt: review.appliedAt || null,
    appliedCount: (review.applied || []).length,
    skippedCount: (review.skipped || []).length,
  };
}

/**
 * merge 成功后追加一条复核记录；同一天多次 merge 会进同一个侧车的 reviews 数组。
 */
function appendReview(pocketDir, payload) {
  const date = payload.date;
  const data = loadSidecar(pocketDir, date);
  const review = {
    id: 'merge-' + date + '#' + (data.reviews.length + 1),
    generatedAt: new Date().toISOString(),
    source: payload.source,
    target: payload.target,
    suggestions: {
      reqStatus: payload.suggestions.reqStatus || [],
      pref: payload.suggestions.pref || [],
      state: stateLines(payload.suggestions.state),
      codeMap: Array.isArray(payload.suggestions.codeMap) ? payload.suggestions.codeMap : [],
      codeMapTruncated: !!payload.suggestions.codeMapTruncated,
    },
    appliedAt: null,
    applied: [],
    skipped: [],
  };
  data.reviews.push(review);
  saveSidecar(pocketDir, data);
  return { id: review.id, path: sidecarPath(pocketDir, date), pending: reviewPending(review) };
}

function listReviews(pocketDir) {
  const files = fs.readdirSync(pocketDir)
    .filter((name) => /^merge-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  const reviews = [];
  for (const file of files) {
    const date = file.slice('merge-'.length, -'.json'.length);
    const data = loadSidecar(pocketDir, date);
    for (const review of data.reviews) {
      reviews.push(Object.assign(summarize(review), { file }));
    }
  }
  return reviews;
}

function normalizeValue(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildRequirementLine(item, status, atT) {
  let line = '- [' + (status === 'Open' ? ' ' : 'x') + '] ';
  if (item.uncertain) line += '❓ ';
  line += 'R' + item.id + ' ' + item.text;
  if (item.tags && item.tags.length > 0) line += ' [' + item.tags.join(', ') + ']';
  line += ' (opened T' + item.openedAt;
  if (status === 'Done') line += ', completed T' + atT;
  else if (status === 'Cancelled') line += ', cancelled T' + atT;
  line += ')';
  if (item.impl && item.impl.length > 0) line += ' · impl: ' + item.impl.join(', ');
  return line;
}

/**
 * 把一条需求迁移到另一个状态小节。调用方负责持锁。
 * @returns {{ok:boolean, error?:string}}
 */
function setRequirementStatus(pocketDir, item, status, atT) {
  const file = path.join(pocketDir, 'requirements.md');
  const lines = readTextOr(file, '').split('\n');
  // 模板里也有同样的 R 号（`- [ ] R1 <req> ... (opened T<n>)`），只认带真实数字时间的那一行。
  const lineRe = new RegExp('^-\\s*\\[[ x]\\]\\s*(?:❓\\s*)?R' + item.id + '\\s+.*\\(opened T\\d+');
  const currentIdx = lines.findIndex((line) => lineRe.test(line.trim()));
  if (currentIdx < 0) return { ok: false, error: 'R' + item.id + ' line not found' };

  const newLine = buildRequirementLine(item, status, atT);
  lines.splice(currentIdx, 1);

  const heading = '## ' + status;
  const headingIdx = lines.findIndex((line) => line.trim() === heading);
  if (headingIdx < 0) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', heading, newLine, '');
  } else {
    let insertAt = headingIdx + 1;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('## ')) break;
      if (trimmed.startsWith('- ')) insertAt = i + 1;
    }
    lines.splice(insertAt, 0, newLine);
  }

  writeAtomic(file, lines.join('\n'));
  writer.updateIndexReqCount(pocketDir);
  return { ok: true };
}

function currentPreference(pocketDir, key) {
  const file = path.join(pocketDir, 'preferences.md');
  if (!fileExists(file)) return undefined;
  const wanted = String(key).toLowerCase();
  for (const line of readTextOr(file, '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) continue;
    const text = trimmed.slice(2);
    const idx = text.indexOf(':');
    if (idx < 0) continue;
    if (text.slice(0, idx).trim().toLowerCase() === wanted) {
      return text.slice(idx + 1).trim();
    }
  }
  return undefined;
}

function hasStateLine(content, prefix, text) {
  const wanted = normalizeValue(prefix + text);
  return String(content || '').split('\n').some((line) => normalizeValue(line) === wanted);
}

function applyStateSuggestions(pocketDir, state, applied, skipped) {
  const statePath = path.join(pocketDir, 'state.md');
  let content = readTextOr(statePath, '');
  const sections = [
    ['summary', 'summary', '- '],
    ['nextSteps', 'next step', '- '],
    ['pitfalls', 'pitfall', '- ⚠️ Pitfall: '],
  ];

  for (const [key, label, prefix] of sections) {
    for (const raw of state[key] || []) {
      const text = String(raw).trim();
      if (!text) continue;
      if (hasStateLine(content, prefix, text)) {
        skipped.push({ type: 'state', kind: key, text, reason: 'already present' });
        continue;
      }
      if (key === 'summary') {
        writer.updateState(pocketDir, { summary: text, appendSummary: true });
      } else if (key === 'nextSteps') {
        writer.updateState(pocketDir, { nextStep: text });
      } else {
        writer.updateState(pocketDir, { pitfall: text });
      }
      content = readTextOr(statePath, content);
      applied.push({ type: 'state', kind: key, text });
    }
  }
}

const CODE_MAP_TODO = '⚠️ TODO: add description';

/**
 * 只给"目标 code-map 树里已经存在、但没有真实描述"的文件补描述。
 *
 * 安全边界：
 *   - 不重扫目录、不重建树、不改文件清单，只在现有行尾追加 `→ 描述`；
 *   - reason="different"（目标已有不同描述）永远跳过，交给人工；
 *   - 目标树里没有这个路径也跳过，不替人新增节点；
 *   - 描述先 sanitizeInline，且只取第一行，不能伪造结构行。
 */
function applyCodeMapSuggestions(pocketDir, suggestions, applied, skipped) {
  if (suggestions && !Array.isArray(suggestions)) {
    skipped.push({ type: 'code-map', count: 1, reason: 'manual review (legacy boolean suggestion)' });
    return;
  }
  const entries = Array.isArray(suggestions) ? suggestions : [];
  const missing = new Map();
  for (const item of entries) {
    if (!item || !item.path) continue;
    if (item.reason === 'different') {
      skipped.push({ type: 'code-map', path: item.path, reason: 'manual review (target description differs)' });
      continue;
    }
    if (item.reason === 'missing' && item.description) missing.set(item.path, item);
  }
  if (missing.size === 0) return;

  const file = path.join(pocketDir, 'code-map.md');
  const content = readTextOr(file, '');
  const block = /(## Structure\n+(?:[^\n]*\n)*?```\n)([\s\S]*?)(```)/.exec(content);
  if (!block) {
    for (const item of missing.values()) {
      skipped.push({ type: 'code-map', path: item.path, reason: 'target code-map has no Structure block' });
    }
    return;
  }

  const lines = block[2].split('\n');
  const dirsAtDepth = [];
  let changed = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const connIdx = raw.search(/[├└]/);
    const depth = connIdx === -1 ? 0 : Math.floor(connIdx / 4);
    const bodyStart = connIdx === -1 ? 0 : connIdx + 4;
    const body = raw.slice(bodyStart).trim();
    if (!body) continue;

    const entryMatch = body.match(/^(.+?)\s*→\s*(.+)$/);
    const name = (entryMatch ? entryMatch[1] : body).trim();
    const desc = entryMatch ? entryMatch[2].trim().split('\n')[0] : '';
    const isDir = name.endsWith('/');
    const fullPath = dirsAtDepth.slice(0, depth).join('') + name;

    if (isDir) {
      dirsAtDepth[depth] = name;
      dirsAtDepth.length = depth + 1;
      continue;
    }

    const item = missing.get(fullPath);
    if (!item) continue;
    missing.delete(fullPath);

    if (desc && desc !== CODE_MAP_TODO) {
      skipped.push({ type: 'code-map', path: fullPath, reason: 'already described' });
      continue;
    }

    const clean = sanitizeInline(String(item.description || '').split('\n')[0]).trim();
    if (!clean) {
      skipped.push({ type: 'code-map', path: fullPath, reason: 'empty description' });
      continue;
    }

    lines[i] = raw.slice(0, bodyStart) + name + ' → ' + clean;
    applied.push({ type: 'code-map', path: fullPath, description: clean });
    changed += 1;
  }

  for (const item of missing.values()) {
    skipped.push({ type: 'code-map', path: item.path, reason: 'not in target code-map tree' });
  }

  if (changed > 0) {
    const next = content.slice(0, block.index)
      + block[1] + lines.join('\n') + block[3]
      + content.slice(block.index + block[0].length);
    writeAtomic(file, next);
  }
}

/**
 * 应用一份复核记录。
 * @returns {object} { ok, alreadyApplied?, error?, review?, applied?, skipped? }
 */
function applyReview(pocketDir, id) {
  const m = /^merge-(\d{4}-\d{2}-\d{2})#(\d+)$/.exec(String(id || '').trim());
  if (!m) {
    return { ok: false, error: 'Unknown merge review id "' + id + '" (expected merge-YYYY-MM-DD#n)' };
  }
  const date = m[1];
  const index = Number(m[2]) - 1;
  const file = sidecarPath(pocketDir, date);
  if (!fileExists(file)) {
    return { ok: false, error: 'No merge review sidecar for ' + date + ' (merge may predate 3.0)' };
  }

  return withPocketLock(pocketDir, () => {
    const data = loadSidecar(pocketDir, date);
    const review = data.reviews[index];
    if (!review || review.id !== id.trim()) {
      return { ok: false, error: 'Merge review not found: ' + id };
    }
    if (review.appliedAt) {
      return { ok: true, alreadyApplied: true, review: summarize(review) };
    }

    const applied = [];
    const skipped = [];
    const atT = Math.max(parseLog(pocketDir).latestT, 0);

    for (const conflict of review.suggestions.reqStatus || []) {
      const item = parseRequirements(pocketDir).items
        .find((r) => r.id === conflict.targetId && !r.implausibleId);
      if (!item) {
        skipped.push({ type: 'requirement', id: 'R' + conflict.targetId, reason: 'target requirement missing' });
        continue;
      }
      if (item.status === conflict.sourceStatus) {
        skipped.push({ type: 'requirement', id: 'R' + conflict.targetId, reason: 'already at source status' });
        continue;
      }
      if (item.status !== conflict.targetStatus) {
        skipped.push({
          type: 'requirement', id: 'R' + conflict.targetId,
          reason: 'changed since merge (' + item.status + ')',
        });
        continue;
      }
      const changed = setRequirementStatus(pocketDir, item, conflict.sourceStatus, atT);
      if (!changed.ok) {
        skipped.push({ type: 'requirement', id: 'R' + conflict.targetId, reason: changed.error });
        continue;
      }
      applied.push({
        type: 'requirement', id: 'R' + conflict.targetId,
        from: item.status, to: conflict.sourceStatus,
      });
    }

    for (const conflict of review.suggestions.pref || []) {
      const current = currentPreference(pocketDir, conflict.key);
      if (current === undefined) {
        skipped.push({ type: 'preference', key: conflict.key, reason: 'preference missing' });
        continue;
      }
      if (normalizeValue(current) === normalizeValue(conflict.source)) {
        skipped.push({ type: 'preference', key: conflict.key, reason: 'already at source value' });
        continue;
      }
      if (normalizeValue(current) !== normalizeValue(conflict.target)) {
        skipped.push({ type: 'preference', key: conflict.key, reason: 'changed since merge' });
        continue;
      }
      writer.updatePreferences(pocketDir, { key: conflict.key, value: conflict.source });
      applied.push({ type: 'preference', key: conflict.key, from: current, to: conflict.source });
    }

    applyStateSuggestions(pocketDir, stateLines(review.suggestions.state), applied, skipped);
    applyCodeMapSuggestions(pocketDir, review.suggestions.codeMap, applied, skipped);

    review.appliedAt = new Date().toISOString();
    review.applied = applied;
    review.skipped = skipped;
    saveSidecar(pocketDir, data);

    return { ok: true, alreadyApplied: false, review: summarize(review), applied, skipped };
  });
}

module.exports = {
  appendReview,
  listReviews,
  applyReview,
  sidecarPath,
  reviewPending,
  stateSuggestionCount,
};
