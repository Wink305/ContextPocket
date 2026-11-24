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
const { normalizeKey } = require('./graph-core');

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
  const groups = groupBy(data.decisions.adrs, (adr) => normalizeKey(adr.title));
  return groups.map((adrs) => {
    const sorted = adrs.slice().sort((a, b) => a.id - b.id);
    const decisions = new Set(sorted.map((adr) => normalizeKey(adr.decision)));
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
  const groups = groupBy(data.requirements.items, (req) => normalizeKey(req.text));
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
 * @returns {{duplicates: object[], conflicts: object[], drop: Set<number>, entries: object[], file: string|null}}
 */
function scanPreferences(pocketDir) {
  const file = path.join(pocketDir, 'preferences.md');
  if (!fs.existsSync(file)) {
    return { duplicates: [], conflicts: [], drop: new Set(), entries: [], file: null };
  }
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');
  const seen = new Map();
  const duplicates = [];
  const conflicts = [];
  const entries = [];
  const drop = new Set();

  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('- ')) return;
    const text = trimmed.slice(2).trim();
    const colon = text.indexOf(':');
    const key = normalizeKey(colon > -1 ? text.slice(0, colon) : text);
    if (!key) return;
    const value = colon > -1 ? normalizeKey(text.slice(colon + 1)) : '';
    const entry = { line: index + 1, text, key, value };
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, { line: index + 1, text, value });
      entries.push(entry);
      return;
    }
    entries.push(entry);
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

  return { duplicates, conflicts, drop, entries, file };
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

  const result = Object.assign(base, {
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

  // 跨口袋检测需要归一化后的原始条目；非枚举，避免把内部数据写进 --json
  Object.defineProperty(result, '_entries', {
    value: {
      adrs: data.decisions.adrs.map((adr) => ({
        id: 'ADR-' + adr.id,
        title: adr.title,
        key: normalizeKey(adr.title),
        decision: adr.decision,
      })),
      requirements: data.requirements.items.map((req) => ({
        id: 'R' + req.id,
        text: req.text,
        key: normalizeKey(req.text),
        status: req.status,
      })),
      preferences: prefs.entries,
    },
    enumerable: false,
  });

  return result;
}

/**
 * 跨口袋归并：同一个 key 至少在两个不同口袋里出现才算 workspace 级重复。
 * 永远只报告，不自动删除 —— 跨口袋合并要人来决定哪个是主副本。
 */
function crossPocketGroups(sources, keyOf, fieldsOf) {
  const groups = new Map();
  for (const { pocket, entries } of sources) {
    for (const entry of entries) {
      const key = keyOf(entry);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(Object.assign({ pocket }, fieldsOf(entry)));
    }
  }
  return [...groups.values()]
    .filter((items) => new Set(items.map((item) => item.pocket)).size >= 2)
    .map((items) => {
      const sorted = items.slice().sort((a, b) => {
        if (a.pocket !== b.pocket) return a.pocket.localeCompare(b.pocket);
        return String(a.id || a.line).localeCompare(String(b.id || b.line));
      });
      return {
        key: keyOf(sorted[0]),
        pockets: [...new Set(sorted.map((item) => item.pocket))],
        items: sorted,
      };
    });
}

function crossPocketReport(pockets) {
  const readable = pockets.filter((pocket) => pocket.ok && pocket._entries);

  const adrGroups = crossPocketGroups(
    readable.map((pocket) => ({ pocket: pocket.name, entries: pocket._entries.adrs })),
    (entry) => entry.key,
    (entry) => ({ id: entry.id, title: entry.title, decision: entry.decision })
  ).map((group) => ({
    key: group.key,
    pockets: group.pockets,
    conflict: new Set(group.items.map((item) => normalizeKey(item.decision))).size > 1,
    items: group.items,
  }));

  const requirementGroups = crossPocketGroups(
    readable.map((pocket) => ({ pocket: pocket.name, entries: pocket._entries.requirements })),
    (entry) => entry.key,
    (entry) => ({ id: entry.id, text: entry.text, status: entry.status })
  ).map((group) => ({
    key: group.key,
    pockets: group.pockets,
    conflict: new Set(group.items.map((item) => normalizeKey(item.status))).size > 1,
    items: group.items,
  }));

  const preferenceGroups = crossPocketGroups(
    readable.map((pocket) => ({ pocket: pocket.name, entries: pocket._entries.preferences })),
    (entry) => entry.key,
    (entry) => ({ line: entry.line, text: entry.text, value: entry.value })
  ).map((group) => ({
    key: group.key,
    pockets: group.pockets,
    conflict: new Set(group.items.map((item) => item.value)).size > 1,
    items: group.items,
  }));

  return {
    adrs: {
      groups: adrGroups,
      duplicates: adrGroups.reduce((sum, group) => sum + group.items.length - 1, 0),
    },
    requirements: {
      groups: requirementGroups,
      duplicates: requirementGroups.reduce((sum, group) => sum + group.items.length - 1, 0),
    },
    preferences: {
      duplicates: preferenceGroups.filter((group) => !group.conflict),
      conflicts: preferenceGroups.filter((group) => group.conflict),
    },
  };
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

  const crossPocket = crossPocketReport(pockets);

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
      crossPocketAdrGroups: crossPocket.adrs.groups.length,
      crossPocketRequirementGroups: crossPocket.requirements.groups.length,
      crossPocketPreferenceDuplicates: crossPocket.preferences.duplicates.length,
      crossPocketPreferenceConflicts: crossPocket.preferences.conflicts.length,
    },
    crossPocket,
    pockets,
  };
}

module.exports = {
  consolidateWorkspace,
};
