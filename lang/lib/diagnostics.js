'use strict';

/**
 * ContextPocket yuan — 深度诊断与修复计划
 *
 * `workspace verify --deep` 只读：清单、口袋可用性、跨口袋引用、repo map 漂移、
 * 未处理的 merge 复核记录。
 *
 * `workspace repair` 默认只出计划；`--apply` 只执行安全动作（当前只有重建
 * repo map）。删除口袋、应用 merge 复核等需要人类确认的动作永远只列计划。
 */

const fs = require('fs');
const path = require('path');

const { readManifest, resolvePocket, parsePocketAll } = require('./workspace');
const { verifyMap, updateMap, readMap } = require('./repomap');
const { inspectIndex } = require('./workspace-index');

const REF_RE = /\b([a-z][a-z0-9_-]*):T(\d+)\b/gi;

function pendingMergeReviews(pocketDir) {
  let files;
  try {
    files = fs.readdirSync(pocketDir).filter((name) => /^merge-\d{4}-\d{2}-\d{2}\.json$/.test(name));
  } catch (e) {
    return [];
  }
  const pending = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(pocketDir, file), 'utf-8'));
      for (const review of data.reviews || []) {
        if (!review.appliedAt) pending.push({ file, id: review.id, source: review.source });
      }
    } catch (e) { /* 坏 sidecar 由 verify 报，不在这里中断 */ }
  }
  return pending;
}

function blockText(block) {
  const parts = [block.gist || ''];
  for (const value of Object.values(block.sections || {})) {
    if (Array.isArray(value)) parts.push(value.join('\n'));
    else if (value) parts.push(String(value));
  }
  return parts.join('\n');
}

function verifyWorkspace(root, options = {}) {
  const deep = !!options.deep;
  const manifest = readManifest(root);
  const errors = [];
  const warnings = [];
  const checks = {
    manifest: true,
    duplicateNames: [],
    duplicatePaths: [],
    missingPockets: [],
    parseErrors: [],
    repoMap: null,
    index: null,
    pendingReviews: [],
    crossRefErrors: [],
    crossRefWarnings: [],
  };

  const seenNames = new Set();
  const seenPaths = new Set();
  for (const entry of manifest.pockets) {
    if (seenNames.has(entry.name)) checks.duplicateNames.push(entry.name);
    if (seenPaths.has(entry.path)) checks.duplicatePaths.push(entry.path);
    seenNames.add(entry.name);
    seenPaths.add(entry.path);
  }
  if (checks.duplicateNames.length > 0) errors.push('duplicate pocket names: ' + checks.duplicateNames.join(', '));
  if (checks.duplicatePaths.length > 0) errors.push('duplicate pocket paths: ' + checks.duplicatePaths.join(', '));

  const parsed = new Map();
  for (const entry of manifest.pockets) {
    const resolved = resolvePocket(root, entry);
    if (!resolved.exists) {
      checks.missingPockets.push(entry.name);
      errors.push('pocket missing on disk: ' + entry.name + ' (' + entry.path + ')');
      continue;
    }
    try {
      parsed.set(entry.name, parsePocketAll(resolved.pocketDir));
    } catch (e) {
      checks.parseErrors.push({ pocket: entry.name, error: e.message });
      errors.push('cannot parse pocket ' + entry.name + ': ' + e.message);
      continue;
    }
    if (deep) {
      const reviews = pendingMergeReviews(resolved.pocketDir);
      if (reviews.length > 0) {
        checks.pendingReviews.push({ pocket: entry.name, reviews });
        warnings.push('pocket ' + entry.name + ' has ' + reviews.length + ' pending merge review(s)');
      }
    }
  }

  if (deep) {
    checks.repoMap = verifyMap(root);
    if (!checks.repoMap.ok) {
      if (checks.repoMap.missing) warnings.push('repo map cache is missing');
      else warnings.push('repo map drift: '
        + 'added ' + checks.repoMap.added.length
        + ', removed ' + checks.repoMap.removed.length
        + ', changed ' + checks.repoMap.changed.length);
    }

    // 索引是可选缓存：缺失不算问题；存在但签名过期才提示（search 会自愈，但审计时应该看得见）
    checks.index = inspectIndex(root);
    if (checks.index.present && !checks.index.fresh) {
      warnings.push('workspace index is stale (run "context-pocket-yuan workspace index")');
    }

    for (const [name, data] of parsed) {
      for (const block of data.log.blocks) {
        const text = blockText(block);
        let m;
        REF_RE.lastIndex = 0;
        while ((m = REF_RE.exec(text)) !== null) {
          const targetName = m[1];
          const targetId = Number(m[2]);
          if (targetName === name) continue;
          const target = parsed.get(targetName);
          if (!target) {
            checks.crossRefErrors.push({ from: name + ':T' + block.id, ref: targetName + ':T' + targetId, reason: 'unknown pocket' });
            errors.push('broken cross-pocket ref ' + targetName + ':T' + targetId + ' in ' + name + ':T' + block.id);
            continue;
          }
          if (!target.log.blocks.some((b) => b.id === targetId)) {
            checks.crossRefWarnings.push({ from: name + ':T' + block.id, ref: targetName + ':T' + targetId, reason: 'turn missing' });
            warnings.push('missing turn ' + targetName + ':T' + targetId + ' referenced by ' + name + ':T' + block.id);
          }
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    root,
    workspace: manifest.name,
    deep,
    pockets: manifest.pockets.length,
    checks,
    errors,
    warnings,
  };
}

function planRepair(root) {
  const verify = verifyWorkspace(root, { deep: true });
  const actions = [];
  const map = readMap(root);
  const mapCheck = verify.checks.repoMap;
  if (!map || (mapCheck && !mapCheck.ok)) {
    actions.push({
      id: 'rebuild-repo-map',
      safe: true,
      command: 'context-pocket-yuan map update',
      reason: map ? 'repo map drift' : 'repo map cache is missing',
    });
  }
  for (const name of verify.checks.missingPockets) {
    actions.push({
      id: 'remove-pocket-' + name,
      safe: false,
      command: 'context-pocket-yuan workspace remove ' + name,
      reason: 'pocket is registered but missing on disk',
    });
  }
  for (const item of verify.checks.pendingReviews) {
    for (const review of item.reviews) {
      actions.push({
        id: 'apply-' + review.id,
        safe: false,
        command: 'context-pocket merge report --apply ' + review.id + ' --dir ' + item.pocket,
        reason: 'merge review is still pending',
      });
    }
  }
  return { ok: true, root, verify, actions, safeCount: actions.filter((a) => a.safe).length };
}

function repairWorkspace(root, options = {}) {
  const plan = planRepair(root);
  if (!options.apply) return plan;
  const applied = [];
  const skipped = [];
  for (const action of plan.actions) {
    if (action.safe && action.id === 'rebuild-repo-map') {
      const result = updateMap(root);
      applied.push({ id: action.id, count: result.count });
    } else {
      skipped.push(action);
    }
  }
  return { ok: true, root, applied, skipped, plan };
}

module.exports = {
  verifyWorkspace,
  planRepair,
  repairWorkspace,
  pendingMergeReviews,
};
