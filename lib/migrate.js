'use strict';

/**
 * ContextPocket — 迁移工具
 * 数据格式版本迁移，带备份、回滚、dry-run
 * Zero-dependency. Works in Node.js 14+.
 */

const fs = require('fs');
const path = require('path');
const { fileExists, readFileSafe } = require('./core');
const { verify } = require('./validator');

// 当前最新版本
const CURRENT_VERSION = 'v1';

// 可用的迁移路径（按顺序执行）
// key: 源版本，value: [{ to: 目标版本, script: 迁移函数名 }]
// 目前只有 v1 → v1（空迁移，验证机制）
const MIGRATION_PATHS = {
  v1: [
    { to: 'v1', name: 'v1-to-v1 (noop — format verification)', type: 'noop' },
  ],
};

// ============================================================
// 检测当前数据格式版本
// ============================================================

/**
 * 检测当前 ContextPocket 的数据格式版本
 * @param {string} pocketDir
 * @returns {string|null} 版本号（如 'v1'），检测不到返回 null
 */
function detectFormatVersion(pocketDir) {
  const readmePath = path.join(pocketDir, 'readme.md');
  const content = readFileSafe(readmePath);

  if (!content) return null;

  // 从 readme.md 标题行提取 format 版本
  // 格式: # ContextPocket · format: v1
  const match = content.match(/format:\s*(v\d+)/i);
  if (match) {
    return match[1].toLowerCase();
  }

  return null;
}

// ============================================================
// 列出可用的迁移路径
// ============================================================

/**
 * 列出从当前版本到目标版本的可用迁移路径
 * @param {string} pocketDir
 * @param {string} [targetVersion] - 目标版本（默认最新）
 * @returns {object} { currentVersion, targetVersion, available: [], path: [] }
 */
function listMigrations(pocketDir, targetVersion) {
  const currentVersion = detectFormatVersion(pocketDir);
  const target = targetVersion || CURRENT_VERSION;

  const available = [];
  const path = [];

  if (!currentVersion) {
    return {
      currentVersion: null,
      targetVersion: target,
      available: [],
      path: [],
      error: 'Cannot detect format version',
    };
  }

  // 收集所有可用迁移
  let cursor = currentVersion;
  const visited = new Set([cursor]);

  while (MIGRATION_PATHS[cursor]) {
    const migrations = MIGRATION_PATHS[cursor];
    let foundNext = false;

    for (const mig of migrations) {
      available.push({ from: cursor, to: mig.to, name: mig.name, type: mig.type });

      if (mig.to === target && !foundNext) {
        path.push({ from: cursor, to: mig.to, name: mig.name, type: mig.type });
        foundNext = true;
        cursor = mig.to;
        break;
      }

      if (!visited.has(mig.to) && !foundNext && mig.to !== cursor) {
        path.push({ from: cursor, to: mig.to, name: mig.name, type: mig.type });
        foundNext = true;
        cursor = mig.to;
        visited.add(cursor);
        break;
      }
    }

    if (!foundNext || cursor === target) break;
    if (visited.has(cursor)) break; // 防止循环
  }

  return {
    currentVersion,
    targetVersion: target,
    available,
    path,
    isLatest: currentVersion === target,
  };
}

// ============================================================
// 执行迁移
// ============================================================

/**
 * 执行数据格式迁移
 * @param {string} pocketDir
 * @param {object} options
 * @param {string} [options.to] - 目标版本（默认最新）
 * @param {boolean} [options.dryRun=false] - 只显示计划，不实际执行
 * @returns {object} { success, fromVersion, toVersion, steps, dryRun, backupPath }
 */
function runMigration(pocketDir, options = {}) {
  const targetVersion = options.to || CURRENT_VERSION;
  const dryRun = !!options.dryRun;

  const currentVersion = detectFormatVersion(pocketDir);

  if (!currentVersion) {
    throw new Error('Cannot detect format version. Make sure readme.md exists with "format: v<N>" in header.');
  }

  if (currentVersion === targetVersion) {
    return {
      success: true,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      steps: [],
      dryRun,
      skipped: true,
      reason: `Already at ${targetVersion}`,
    };
  }

  const migrationInfo = listMigrations(pocketDir, targetVersion);

  if (migrationInfo.path.length === 0) {
    throw new Error(`No migration path from ${currentVersion} to ${targetVersion}`);
  }

  if (dryRun) {
    return {
      success: true,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      steps: migrationInfo.path,
      dryRun: true,
      planned: migrationInfo.path,
    };
  }

  // 迁移前备份
  const backupPath = backupPocketDir(pocketDir);

  // 迁移前 verify
  const preVerify = verify(pocketDir);
  if (preVerify.errorCount > 0) {
    throw new Error(`Cannot migrate: verify found ${preVerify.errorCount} error(s). Fix errors first.`);
  }

  const executedSteps = [];

  try {
    // 依次执行每步迁移
    for (const step of migrationInfo.path) {
      executeMigrationStep(pocketDir, step);
      executedSteps.push(step);
    }

    // 迁移后 verify
    const postVerify = verify(pocketDir);
    if (postVerify.errorCount > 0) {
      // 回滚
      restorePocketDir(pocketDir, backupPath);
      throw new Error(`Post-migration verify failed (${postVerify.errorCount} error(s)). Rolled back to ${currentVersion}.`);
    }

    return {
      success: true,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      steps: executedSteps,
      dryRun: false,
      backupPath,
    };
  } catch (e) {
    // 失败回滚
    try {
      restorePocketDir(pocketDir, backupPath);
    } catch (rollbackErr) {
      throw new Error(`${e.message} (rollback also failed: ${rollbackErr.message})`);
    }
    throw e;
  }
}

// ============================================================
// 执行单步迁移
// ============================================================

function executeMigrationStep(pocketDir, step) {
  const { from, to, type } = step;

  switch (type) {
    case 'noop':
      // 空迁移，只验证格式正确
      verifyNoopMigration(pocketDir, from, to);
      break;

    default:
      throw new Error(`Unknown migration type: ${type} (${from} → ${to})`);
  }
}

function verifyNoopMigration(pocketDir, from, to) {
  // v1 → v1 空迁移：只验证 readme.md 中 format 版本正确
  const readmePath = path.join(pocketDir, 'readme.md');
  let content = fs.readFileSync(readmePath, 'utf-8');

  // 更新 format 版本号（即使相同也确认一下）
  content = content.replace(/format:\s*v\d+/i, `format: ${to}`);
  fs.writeFileSync(readmePath, content, 'utf-8');
}

// ============================================================
// 备份与恢复
// ============================================================

function backupPocketDir(pocketDir) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `ContextPocket.backup-${timestamp}`;
  const backupPath = path.join(path.dirname(pocketDir), backupName);

  copyDirSync(pocketDir, backupPath);

  return backupPath;
}

function restorePocketDir(pocketDir, backupPath) {
  if (!fileExists(backupPath)) {
    throw new Error(`Backup not found: ${backupPath}`);
  }

  // 删除当前目录，恢复备份
  removeDirSync(pocketDir);
  copyDirSync(backupPath, pocketDir);
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function removeDirSync(dir) {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeDirSync(entryPath);
    } else {
      fs.unlinkSync(entryPath);
    }
  }
  fs.rmdirSync(dir);
}

module.exports = {
  detectFormatVersion,
  listMigrations,
  runMigration,
  CURRENT_VERSION,
  backupPocketDir,
  restorePocketDir,
};
