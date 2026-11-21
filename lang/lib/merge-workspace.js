'use strict';

/**
 * ContextPocket yuan — workspace merge 编排
 *
 * 用工作区清单里的口袋名调用 quan 的 `mergePocket`，把 source 合并进 target。
 * 默认 dry-run（只出计划），`--apply` 才落盘 —— 与 forget / consolidate 同一口径。
 *
 * 真正的合并语义（重编号、去重、ADR / 需求 / 偏好映射、快照回滚、复核 sidecar）
 * 全在 shared 的 `lib/merge.js` 里，yuan 只负责把两个名字解析成口袋目录。
 */

const { readManifest, resolvePocket } = require('./workspace');
const { mergePocket } = require('./merge');

function findEntry(manifest, name) {
  return manifest.pockets.find((entry) => entry.name === name);
}

/**
 * @param {string} root
 * @param {string} sourceName workspace 里的源口袋名
 * @param {string} targetName workspace 里的目标口袋名
 * @param {object} [options]
 * @param {boolean} [options.apply] 写盘（默认 false：dry-run）
 * @param {boolean} [options.includeArchive] 一并合并源 log-archive.md
 */
function mergeWorkspace(root, sourceName, targetName, options = {}) {
  const source = String(sourceName || '').trim();
  const target = String(targetName || '').trim();
  if (!source) throw new Error('merge needs a source pocket name');
  if (!target) throw new Error('merge needs a target pocket name (--into <pocket>)');
  if (source === target) throw new Error('source and target must be different pockets');

  const manifest = readManifest(root);
  const sourceEntry = findEntry(manifest, source);
  const targetEntry = findEntry(manifest, target);
  if (!sourceEntry) throw new Error('Pocket not found: ' + source);
  if (!targetEntry) throw new Error('Pocket not found: ' + target);

  const resolvedSource = resolvePocket(root, sourceEntry);
  const resolvedTarget = resolvePocket(root, targetEntry);
  if (!resolvedSource.exists) throw new Error('Source pocket is missing on disk: ' + source);
  if (!resolvedTarget.exists) throw new Error('Target pocket is missing on disk: ' + target);

  const apply = !!options.apply;
  const result = mergePocket(resolvedTarget.pocketDir, {
    from: resolvedSource.pocketDir,
    dryRun: !apply,
    includeArchive: !!options.includeArchive,
  });

  return {
    ok: !!result.ok,
    root,
    workspace: manifest.name,
    mode: apply ? 'apply' : 'plan',
    source: { name: sourceEntry.name, path: sourceEntry.path },
    target: { name: targetEntry.name, path: targetEntry.path },
    merge: result,
  };
}

module.exports = {
  mergeWorkspace,
};
