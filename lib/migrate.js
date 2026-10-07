'use strict';

/**
 * ContextPocket — 迁移工具
 * 数据格式版本迁移，带备份、逐步 verify、失败回滚、dry-run
 * Zero-dependency. Works in Node.js 14+.
 *
 * 迁移登记表（MIGRATIONS）是这条链的唯一真相源：
 * 一条记录 = 一跳（from → to），真正干活的是记录上的 `run(pocketDir)`。
 * 目前登记表里有一跳真实的格式升级（v1 → v2：给每个 T-block 补一条时间结构行，
 * 见 `migrateV1ToV2`）和一条 v1 → v1 的空跑（用来验证机制本身）。
 * `migrate --to latest` 会自动串起 v1 → v2 → v3 这样的多跳路径，
 * 升级新跳时按 CONTRIBUTING.md 的"如何新增一个迁移步骤"注册一跳即可，
 * 不需要改这里的执行逻辑。
 */

const fs = require('fs');
const path = require('path');
const { writeAtomic, readTextRequired } = require('./io');
const { fileExists, readFileSafe } = require('./core');
const { verify } = require('./validator');
const { WHEN_LINE_RE, whenLine } = require('./when');

// 当前最新版本
const CURRENT_VERSION = 'v2';

/**
 * 一跳迁移。字段：
 * - `from` / `to`：`v<数字>`
 * - `name`：给人看的一行说明（`--list` / `--dry-run` 直接打印）
 * - `run(pocketDir)`：真正改写内容的那段代码。不写 `run` 时按 `type` 走内置分支
 *   （目前内置只有 `noop`）
 * @type {Array<{from:string,to:string,name:string,type?:string,run?:Function}>}
 */
const MIGRATIONS = [
  { from: 'v1', to: 'v1', name: 'v1-to-v1 (noop — format verification)', type: 'noop' },
  {
    from: 'v1',
    to: 'v2',
    name: 'v1-to-v2 (add the "--- WHEN: <date> (day) ---" time line to every T-block)',
    run: migrateV1ToV2,
  },
];

/** 可读的跳清单，报错和 --list 都用它 */
function describeStep(step) {
  return `${step.from} → ${step.to}: ${step.name}`;
}

/**
 * 注册一跳迁移。
 *
 * 为什么开这个口子：把登记表做成模块内字面量 + switch 的话，加一跳要同时改两处，
 * 而且测试永远无法构造"链真的存在"的场景（回滚、多跳这些只有真链才测得出来）。
 * 注册表暴露出来之后，链是可组装的，执行逻辑不用碰。
 *
 * @param {object} step {from, to, name, run?|type?}
 * @returns {Function} 反注册（主要给测试用；生产代码注册一次就够）
 */
function registerMigration(step) {
  if (!step || typeof step !== 'object') {
    throw new Error('registerMigration: step must be an object');
  }
  const from = normalizeVersion(step.from, 'from');
  const to = normalizeVersion(step.to, 'to');
  const name = typeof step.name === 'string' && step.name.trim()
    ? step.name.trim()
    : `${from}-to-${to}`;
  if (step.run !== undefined && typeof step.run !== 'function') {
    throw new Error(`registerMigration: run must be a function (${from} → ${to})`);
  }
  if (step.run === undefined && !BUILTIN_STEP_TYPES.has(step.type)) {
    throw new Error(
      `registerMigration: give either run() or a builtin type (${[...BUILTIN_STEP_TYPES].join(', ')}) (${from} → ${to})`
    );
  }
  const entry = { from, to, name, type: step.type, run: step.run };
  MIGRATIONS.push(entry);
  return function unregister() {
    const i = MIGRATIONS.indexOf(entry);
    if (i >= 0) MIGRATIONS.splice(i, 1);
  };
}

const BUILTIN_STEP_TYPES = new Set(['noop']);

/** 归一化版本号：接受 'v2' / '2' / 'V2'，其余报错 */
function normalizeVersion(value, label = 'version') {
  const raw = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  const norm = /^\d+$/.test(raw) ? 'v' + raw : raw;
  if (!/^v\d+$/.test(norm)) {
    throw new Error(`Invalid ${label} "${value}". Use a version like "v2", or "v" + number.`);
  }
  return norm;
}

function versionNumber(version) {
  const m = /^v(\d+)$/.exec(String(version || '').toLowerCase());
  return m ? Number(m[1]) : null;
}

/**
 * 登记表里能达到的最高版本 = "latest"。
 * 取的是 `CURRENT_VERSION` 与所有跳 `to` 的最大值，所以"代码原生理解的版本"
 * 和"注册了但还没进主干的跳"两种情况都能被 `--to latest` 命中。
 * @returns {string}
 */
function latestVersion() {
  let max = versionNumber(CURRENT_VERSION) || 1;
  for (const step of MIGRATIONS) {
    const n = versionNumber(step.to);
    if (n !== null && n > max) max = n;
  }
  return 'v' + max;
}

/** 解析 `--to`：省略或 'latest' 都取登记表里的最新版本 */
function resolveTarget(target) {
  const raw = String(target === undefined || target === null ? '' : target).trim().toLowerCase();
  if (raw === '' || raw === 'latest' || raw === 'newest') return latestVersion();
  return normalizeVersion(raw, 'target version');
}


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
  // 格式: # ContextPocket · format: v<N>
  const match = content.match(/format:\s*(v\d+)/i);
  if (match) {
    return match[1].toLowerCase();
  }

  return null;
}

/**
 * 在登记表里找 from → to 的最短跳序（BFS）。
 * 自环（内置那条 v1 → v1）会被 seen 挡掉，所以它只出现在 `--list` 里，
 * 永远不会被当成"往前走一步"。
 * @param {string} from
 * @param {string} to
 * @returns {object[]|null} 一跳一跳的数组；不可达返回 null（from===to 时为 []）
 */
function findStepPath(from, to) {
  if (from === to) return [];
  // 队列里存的必须是"到达的版本号 + 走到这里用到的跳"，
  // 直接把跳对象放进链尾会让 cursor 变成对象，多跳永远匹配不上。
  const queue = [{ version: from, steps: [] }];
  const seen = new Set([from]);

  while (queue.length) {
    const node = queue.shift();
    for (const step of MIGRATIONS) {
      if (step.from !== node.version || seen.has(step.to)) continue;
      seen.add(step.to);
      const steps = node.steps.concat(step);
      if (step.to === to) return steps;
      queue.push({ version: step.to, steps });
    }
  }
  return null;
}

// ============================================================
// 列出可用的迁移路径
// ============================================================

/**
 * 列出从当前版本到目标版本的可用迁移路径
 * @param {string} pocketDir
 * @param {string} [targetVersion] - 目标版本（省略或 'latest' = 登记表里的最新一跳）
 * @returns {object} { currentVersion, targetVersion, latestVersion, available: [], path: [], isLatest, error? }
 */
function listMigrations(pocketDir, targetVersion) {
  const currentVersion = detectFormatVersion(pocketDir);
  const available = MIGRATIONS.map((s) => ({ from: s.from, to: s.to, name: s.name, type: s.type, hasRun: typeof s.run === 'function' }));

  let target;
  try {
    target = resolveTarget(targetVersion);
  } catch (e) {
    return {
      currentVersion,
      targetVersion: String(targetVersion === undefined ? '' : targetVersion),
      latestVersion: latestVersion(),
      available,
      path: [],
      isLatest: false,
      error: e.message,
    };
  }

  if (!currentVersion) {
    return {
      currentVersion: null,
      targetVersion: target,
      latestVersion: latestVersion(),
      available,
      path: [],
      isLatest: false,
      error: 'Cannot detect format version',
    };
  }

  const steps = findStepPath(currentVersion, target);

  if (steps === null) {
    return {
      currentVersion,
      targetVersion: target,
      latestVersion: latestVersion(),
      available,
      path: [],
      isLatest: false,
      error: describeAvailableSteps(`No migration path from ${currentVersion} to ${target}`),
    };
  }

  return {
    currentVersion,
    targetVersion: target,
    latestVersion: latestVersion(),
    available,
    path: steps,
    isLatest: currentVersion === target,
  };
}

/** 把"当前登记表里有哪些跳"拼成一句人可读的提示（找不到路径时报错用） */
function describeAvailableSteps(headline) {
  const steps = MIGRATIONS.map((s) => describeStep(s));
  if (steps.length === 0) return `${headline}. The migration registry is empty.`;
  return `${headline}. Registered step(s): ${steps.join(' | ')}. ` +
    `Add one with registerMigration({from,to,name,run}) — see CONTRIBUTING.md.`;
}

// ============================================================
// 执行迁移
// ============================================================

/**
 * 执行数据格式迁移（可能多跳，一条命令走完 v1 → v2 → v3）
 *
 * 每一步都是"先 verify 当前状态 → 执行这一跳 → 盖上目标版本号"，任何一步出错
 * 或事后体检不合格，整个 `ContextPocket/` 回滚到本次运行开始前的备份：
 * 半截迁移比没有迁移糟得多，历史文件必须要么全升要么全不动。
 *
 * @param {string} pocketDir
 * @param {object} options
 * @param {string} [options.to] - 目标版本（省略或 'latest' = 登记表里的最新一跳）
 * @param {boolean} [options.dryRun=false] - 只显示计划，不实际执行
 * @returns {object} { success, fromVersion, toVersion, steps, dryRun, backupPath }
 */
function runMigration(pocketDir, options = {}) {
  const dryRun = !!options.dryRun;

  let targetVersion;
  try {
    targetVersion = resolveTarget(options.to);
  } catch (e) {
    throw new Error(`${e.message} ${availableHint()}`.trim());
  }

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
      reason: `Already at ${targetVersion} (registered steps: ${availableHint()})`,
    };
  }

  const migrationInfo = listMigrations(pocketDir, targetVersion);

  if (migrationInfo.error || migrationInfo.path.length === 0) {
    throw new Error(migrationInfo.error || describeAvailableSteps(
      `No migration path from ${currentVersion} to ${targetVersion}`
    ));
  }

  if (dryRun) {
    return {
      success: true,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      steps: migrationInfo.path.map(summarizeStep),
      dryRun: true,
      planned: migrationInfo.path.map(summarizeStep),
    };
  }

  // 迁移前备份
  const backupPath = backupPocketDir(pocketDir);

  // 迁移前 verify
  const preVerify = verify(pocketDir);
  if (preVerify.errorCount > 0) {
    removeDirSync(backupPath);
    throw new Error(`Cannot migrate: verify found ${preVerify.errorCount} error(s). Fix errors first.`);
  }

  const executedSteps = [];

  let rolledBack = false;
  const rollback = () => {
    if (rolledBack) return;
    restorePocketDir(pocketDir, backupPath);
    rolledBack = true;
    // 回滚成功后备份就是当前内容的副本，留在项目根目录只会让人误以为迁移过
    removeDirSync(backupPath);
  };

  try {
    // 依次执行每步迁移
    for (const step of migrationInfo.path) {
      const before = verify(pocketDir);
      if (before.errorCount > 0) {
        throw new Error(
          `Stopped before ${describeStep(step)}: verify already found ${before.errorCount} error(s).`
        );
      }
      executeStepWithLabel(pocketDir, step);
      executedSteps.push(step);
    }

    // 迁移后 verify
    const postVerify = verify(pocketDir);
    if (postVerify.errorCount > 0) {
      // 回滚
      rollback();
      throw new Error(`Post-migration verify failed (${postVerify.errorCount} error(s)). Rolled back to ${currentVersion}.`);
    }

    return {
      success: true,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      steps: executedSteps.map(summarizeStep),
      dryRun: false,
      backupPath,
    };
  } catch (e) {
    // 失败回滚
    try {
      rollback();
    } catch (rollbackErr) {
      throw new Error(`${e.message} (rollback also failed: ${rollbackErr.message})`);
    }
    throw e;
  }
}

/** 返回给 CLI / --json 的步骤形状：带 run 的迁移函数不该被序列化出去 */
function summarizeStep(step) {
  return {
    from: step.from,
    to: step.to,
    name: step.name,
    type: step.type || (typeof step.run === 'function' ? 'custom' : undefined),
    hasRun: typeof step.run === 'function',
  };
}

function availableHint() {
  return MIGRATIONS.length ? MIGRATIONS.map((s) => describeStep(s)).join(' | ') : 'none registered';
}

// ============================================================
// 执行单步迁移
// ============================================================

/**
 * 执行一跳 + 盖上目标版本号，并把任何失败都绑到"是哪一跳炸的"上。
 * 版本号由框架盖，不由各步自己记得写：漏写一次就会让它下一步又跑一遍。
 */
function executeStepWithLabel(pocketDir, step) {
  try {
    executeMigrationStep(pocketDir, step);
    setFormatVersion(pocketDir, step.to);
  } catch (e) {
    const label = describeStep(step);
    if (String(e && e.message).includes(label)) throw e;
    throw new Error(`Migration step failed (${label}): ${e.message}`);
  }
}

function executeMigrationStep(pocketDir, step) {
  const { from, to, type } = step;

  // 注册进来的迁移自带干活的函数
  if (typeof step.run === 'function') {
    step.run(pocketDir, { from, to });
    return;
  }

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
  let content = readTextRequired(readmePath);

  // 更新 format 版本号（即使相同也确认一下）
  content = content.replace(/format:\s*v\d+/i, `format: ${to}`);
  writeAtomic(readmePath, content);
}

/**
 * 把 readme.md 头部的 `format: v<N>` 改成指定版本。
 * 每跳之后由框架统一调用，迁移函数本身不必记得写它。
 */
function setFormatVersion(pocketDir, version) {
  const readmePath = path.join(pocketDir, 'readme.md');
  const content = readTextRequired(readmePath);
  if (!/format:\s*v\d+/i.test(content)) {
    throw new Error(`readme.md has no "format: v<N>" header to bump to ${version}`);
  }
  writeAtomic(readmePath, content.replace(/format:\s*v\d+/i, `format: ${version}`));
}

// ============================================================
// v1 → v2：给每个 T-block 补一条时间结构行
// ============================================================

/** 这一跳要改写的文件；归档里的历史块同样需要时间行，否则升级后老的轮次反而更模糊 */
const WHEN_TARGET_FILES = ['log.md', 'log-archive.md'];

const T_BLOCK_HEAD_RE = /^##\s*T\d+\b/;
const SESSION_DAY_RE = /^---\s*SESSION:\s*(\d{4}-\d{2}-\d{2})/;

/**
 * v1 的 T-block 只有"哪天"，日期来自它上方最近的 `--- SESSION: <date> ---`。
 * 这一跳把那个日期抄成块内的 `--- WHEN: <date> (day) ---`，让"某一轮属于哪一天"
 * 从此跟着块走（归档切片、跨文件搜索都不再依赖上方的 SESSION 行）。
 *
 * 三条不变量，跟 `lib/when.js` 头部写的一样：
 * - **宽化不替换**：SESSION 行、`## T<n>` 标题、各小节内容一字不动，只在标题下面插一行。
 * - **不编造精度**：v1 只给得出"日"，所以写 `(day)`；分钟只能由用户之后用
 *   `log amend <Tn> --when` 补（那一行是 day 精度，amend 允许换掉）。
 *   尤其不会拿 mtime 冒充记录时刻 —— 复制、归档、`git checkout` 都会改 mtime。
 * - **拿不到日期就留空**：块上方没有 SESSION 行（手搓的、或早期版本写的 log.md）
 *   时不写这一行。少一行时间是真的，编一个日期是假信息，后者会一路抄进后续记录。
 *
 * 幂等：已经有时间行的块原样保留，所以重复跑（或半途失败后重跑）不会插入两行。
 *
 * @param {string} pocketDir
 * @param {object} [ctx] 由 executeMigrationStep 传入 {from,to}
 * @returns {object} { files, blocks, added, already, noDate } 供测试与 --json 断言
 */
function migrateV1ToV2(pocketDir) {
  const stats = { files: 0, blocks: 0, added: 0, already: 0, noDate: 0 };

  for (const name of WHEN_TARGET_FILES) {
    const filePath = path.join(pocketDir, name);
    if (!fileExists(filePath)) continue;

    const content = readTextRequired(filePath);
    // 读的时候两种行尾都认，但**不按原文件的行尾写回去**：writeAtomic 一律把 CRLF
    // 归一成 LF（`lib/io.js:37`）， append / amend / archive 都是这个约定。
    // "检测原行尾再照抄回去"只会是个自欺的动作 —— 落盘时照样被抹平。
    const lines = content.split(/\r?\n/);
    const out = [];
    let sessionDay = null;
    let changed = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const session = SESSION_DAY_RE.exec(line);
      if (session) {
        sessionDay = session[1];
        out.push(line);
        continue;
      }

      if (!T_BLOCK_HEAD_RE.test(line)) {
        out.push(line);
        continue;
      }

      out.push(line);
      stats.blocks++;

      // 向后看：紧跟标题（或隔若干空行）的时间行说明这一块已经升过了
      let j = i + 1;
      while (j < lines.length && String(lines[j]).trim() === '') j++;
      if (j < lines.length && WHEN_LINE_RE.test(String(lines[j]).trim())) {
        stats.already++;
        out.push(...lines.slice(i + 1, j + 1));
        i = j;
        continue;
      }

      if (!sessionDay) {
        stats.noDate++;
        continue;
      }
      const stamp = whenLine({ kind: 'day', date: sessionDay });
      if (!stamp) {
        stats.noDate++;
        continue;
      }
      out.push(stamp);
      stats.added++;
      changed = true;
    }

    if (!changed) continue;
    writeAtomic(filePath, out.join('\n'));
    stats.files++;
  }

  return stats;
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
  registerMigration,
  latestVersion,
  resolveTarget,
  findStepPath,
  migrateV1ToV2,
  CURRENT_VERSION,
  backupPocketDir,
  restorePocketDir,
};
