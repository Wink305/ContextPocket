'use strict';

/**
 * ContextPocket yuan — 生命周期（consolidate）
 *
 * 找出同一个口袋里语义重复的记录：ADR、需求、偏好。
 *
 * 默认只出计划（plan），`--apply` 也只执行**安全动作**：
 *   - 偏好行的完全重复（同 key 同 value）可以安全删除；
 *   - 同 key 不同 value 是冲突，永远只报告，不替用户选一个；
 *   - ADR / 需求带编号与引用，删一条会破坏连续编号与 `Supersedes` / 跨口袋
 *     引用，所以永远只列计划，交给人工合并。
 *
 * 这与 `workspace repair` 的口径一致：自动动作必须可回滚、不破坏格式。
 */

const fs = require('fs');
const path = require('path');

const { readManifest, resolvePocket } = require('./workspace');
const { parseAll } = require('./parser');
const { writeAtomic } = require('./io');
const { updateIndexPrefCount } = require('./writer');

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].filter((group) => group.length >= 2);
}

function consolidateAdrs(data) {
  const groups = groupBy(data.decisions.adrs, (adr) => normalizeText(adr.title));
  return groups.map((adrs) => {
    const sorted = adrs.slice().sort((a, b) => a.id - b.id);
    const decisions = new Set(sorted.map((adr) => normalizeText(adr.decision)));
    return {
      keep: sorted[0].id,
      conflict: decisions.size > 1,
      items: sorted.map((adr) => ({
        id: adr.id,
        title: adr.title,
        createdAt: adr.createdAt,
        decision: adr.decision,
      })),
    };
  });
}

function consolidateRequirements(data) {
  const groups = groupBy(data.requirements.items, (req) => normalizeText(req.text));
  return groups.map((items) => {
    const sorted = items.slice().sort((a, b) => a.id - b.id);
    return {
      keep: sorted[0].id,
      statuses: sorted.map((req) => req.status),
      items: sorted.map((req) => ({
        id: req.id,
        text: req.text,
        status: req.status,
        openedAt: req.openedAt,
      })),
    };
  });
}

/**
 * 偏好行按 key 归并：同 key 同 value = 完全重复（安全删除后面的），
 * 同 key 不同 value = 冲突（只报告）。没有 key 的行按整行比较。
 * @param {string} pocketDir
 * @returns {{duplicates: object[], conflicts: object[], drop: Set<number>, file: string|null}}
 */
function scanPreferences(pocketDir) {
  const file = path.join(pocketDir, 'preferences.md');
  if (!fs.existsSync(file)) {
    return { duplicates: [], conflicts: [], drop: new Set(), file: null };
  }
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');
  const seen = new Map();
  const duplicates = [];
  const conflicts = [];
  const drop = new Set();

  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('- ')) return;
    const text = trimmed.slice(2).trim();
    const colon = text.indexOf(':');
    const key = normalizeText(colon > -1 ? text.slice(0, colon) : text);
    if (!key) return;
    const value = colon > -1 ? normalizeText(text.slice(colon + 1)) : '';
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, { line: index + 1, text, value });
      return;
    }
    if (prev.value === value) {
      duplicates.push({ line: index + 1, keepLine: prev.line, text });
      drop.add(index);
      return;
    }
    let conflict = conflicts.find((item) => item.key === key);
    if (!conflict) {
      conflict = { key, lines: [{ line: prev.line, text: prev.text }] };
      conflicts.push(conflict);
    }
    conflict.lines.push({ line: index + 1, text });
  });

  return { duplicates, conflicts, drop, file };
}

function consolidatePocket(root, entry, apply) {
  const resolved = resolvePocket(root, entry);
  const base = { name: entry.name, path: entry.path };
  if (!resolved.exists) {
    return Object.assign(base, { ok: false, error: 'missing ContextPocket/log.md' });
  }

  let data;
  try {
    data = parseAll(resolved.pocketDir);
  } catch (e) {
    return Object.assign(base, { ok: false, error: e.message });
  }

  const adrGroups = consolidateAdrs(data);
  const requirementGroups = consolidateRequirements(data);
  const prefs = scanPreferences(resolved.pocketDir);

  let removed = 0;
  let applied = false;
  let error = null;
  if (apply) {
    if (prefs.drop.size > 0) {
      try {
        const lines = fs.readFileSync(prefs.file, 'utf-8').split('\n');
        writeAtomic(prefs.file, lines.filter((_, index) => !prefs.drop.has(index)).join('\n'));
        // index.md 的 preferences 计数是派生的；不重算，下一次 verify 会报计数漂移
        updateIndexPrefCount(resolved.pocketDir);
        removed = prefs.drop.size;
        applied = true;
      } catch (e) {
        error = e.message;
      }
    }
  }

  return Object.assign(base, {
    ok: !error,
    error: error || undefined,
    adrs: {
      groups: adrGroups,
      duplicates: adrGroups.reduce((sum, group) => sum + group.items.length - 1, 0),
    },
    requirements: {
      groups: requirementGroups,
      duplicates: requirementGroups.reduce((sum, group) => sum + group.items.length - 1, 0),
    },
    preferences: {
      duplicates: prefs.duplicates,
      conflicts: prefs.conflicts,
      applied,
      removed,
    },
  });
}

/**
 * @param {string} root
 * @param {object} [options]
 * @param {string} [options.pockets] comma-separated pocket names
 * @param {boolean} [options.apply] remove exact duplicate preference lines
 */
function consolidateWorkspace(root, options = {}) {
  const manifest = readManifest(root);
  const apply = !!options.apply;
  let entries = manifest.pockets;
  let unknown = [];
  if (options.pockets) {
    const names = String(options.pockets).split(',').map((name) => name.trim()).filter(Boolean);
    const known = new Set(manifest.pockets.map((entry) => entry.name));
    unknown = names.filter((name) => !known.has(name));
    entries = manifest.pockets.filter((entry) => names.includes(entry.name));
  }

  const pockets = entries.map((entry) => consolidatePocket(root, entry, apply));
  for (const name of unknown) {
    pockets.push({ name, ok: false, error: 'pocket not found in workspace manifest' });
  }

  const sum = (key, sub) => pockets.reduce((total, pocket) => {
    if (!pocket.ok || !pocket[sub]) return total;
    return total + (Array.isArray(pocket[sub][key]) ? pocket[sub][key].length : (pocket[sub][key] || 0));
  }, 0);

  const duplicateAdrs = pockets.reduce((total, pocket) => total + (pocket.adrs ? pocket.adrs.duplicates : 0), 0);
  const duplicateRequirements = pockets.reduce((total, pocket) => total + (pocket.requirements ? pocket.requirements.duplicates : 0), 0);
  const preferenceDuplicates = sum('duplicates', 'preferences');
  const preferenceConflicts = sum('conflicts', 'preferences');
  const removedPreferences = pockets.reduce((total, pocket) => total + (pocket.preferences ? pocket.preferences.removed : 0), 0);

  return {
    ok: pockets.every((pocket) => pocket.ok),
    root,
    workspace: manifest.name,
    mode: apply ? 'apply' : 'plan',
    totals: {
      pockets: pockets.length,
      adrGroups: sum('groups', 'adrs'),
      duplicateAdrs,
      requirementGroups: sum('groups', 'requirements'),
      duplicateRequirements,
      preferenceDuplicates,
      preferenceConflicts,
      removedPreferences,
    },
    pockets,
  };
}

module.exports = {
  consolidateWorkspace,
};
