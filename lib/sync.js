'use strict';

/**
 * ContextPocket — Git 漏记兜底（sync）
 *
 * 解决最核心的 "Agent 漏记" 问题：
 * 当 Agent 改了文件却没有把对应的 T-block 记进 log.md 时，
 * 通过对比「即将提交的 staged 文件」与「最近 N 个 T-block 的 Action 文件」，
 * 找出漏记项，并可选地自动补录一个标记为 [auto] 的 T-block。
 *
 * 设计原则：
 * - 只读检测是默认行为（--auto 才真正写入）；
 * - 幂等：补录后这些文件即被"覆盖"，再次运行不会再补录；
 * - 忽略 ContextPocket/ 自身（记录本身不是"被记录的对象"）；
 * - 非 git 仓库 / 无 staged 变更 → 直接返回 clean，不报错。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getProjectRoot, readConfig, fileExists } = require('./core');
const { parseLog } = require('./parser');
const { appendLogBlock } = require('./writer');

// ============================================================
// git 封装
// ============================================================

const GIT_MAX_BUFFER = 1024 * 1024 * 32; // 32MB，足够大仓库的 name-status

/**
 * 运行 git 子命令（同步）
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ok: boolean, stdout?: string, stderr?: string}}
 */
function git(args, cwd) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: GIT_MAX_BUFFER,
    });
    return { ok: true, stdout: stdout || '' };
  } catch (e) {
    return { ok: false, stderr: (e.stderr ? e.stderr.toString() : e.message) || String(e) };
  }
}

/**
 * 判断是否为 git 仓库
 * @param {string} cwd
 * @returns {boolean}
 */
function isGitRepo(cwd) {
  if (!fs.existsSync(cwd)) return false;
  const r = git(['rev-parse', '--is-inside-work-tree'], cwd);
  return r.ok && r.stdout.trim() === 'true';
}

// ============================================================
// 路径工具
// ============================================================

/**
 * 归一化文件路径：反斜杠→正斜杠、去前导 ./、去尾部斜杠
 * @param {string} p
 * @returns {string}
 */
function normalizePath(p) {
  if (!p) return '';
  let s = String(p).replace(/\\/g, '/').trim();
  // 去掉前导 ./
  while (s.startsWith('./')) s = s.slice(2);
  // 去掉前导 /（相对路径语义）
  s = s.replace(/^\/+/, '');
  // 去尾部 /
  s = s.replace(/\/+$/, '');
  return s;
}

/**
 * 是否属于应忽略的路径（ContextPocket 自身等）
 * @param {string} normPath
 * @returns {boolean}
 */
function isIgnoredPath(normPath) {
  const lower = normPath.toLowerCase();
  if (lower === 'contextpocket' || lower.startsWith('contextpocket/')) return true;
  // 记录工具自身的产物
  if (lower.startsWith('.git/')) return true;
  return false;
}

// git status 码 → 操作标签（语言跟随 config.language）
const STATUS_LABELS = {
  zh: { A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', T: '修改' },
  en: { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Modified' },
};

// ============================================================
// 检测：找出"已改动但未记录"的文件
// ============================================================

/**
 * 检测 staged 变更中哪些文件未被最近 N 个 T-block 覆盖
 * @param {string} pocketDir
 * @param {object} [opts]
 * @param {number} [opts.lastN=5] 覆盖判定回看最近多少个 T-block
 * @returns {object}
 */
function detectUnrecorded(pocketDir, opts = {}) {
  const lastN = opts.lastN || 5;
  const projectRoot = getProjectRoot(pocketDir);

  const base = { isGit: isGitRepo(projectRoot) };

  if (!base.isGit) {
    return { ...base, clean: false, needsLog: false, changedCount: 0, unrecorded: [], error: null };
  }

  // log.md 不存在 → 让 verify 去报，这里不补录
  if (!fileExists(path.join(pocketDir, 'log.md'))) {
    return {
      ...base,
      clean: false,
      needsLog: true,
      changedCount: 0,
      unrecorded: [],
      error: 'log.md missing (verify will report it)',
    };
  }

  // 1) staged 变更（即将提交的文件）
  const res = git(['diff', '--cached', '--name-status'], projectRoot);
  if (!res.ok) {
    return { ...base, clean: false, changedCount: 0, unrecorded: [], error: res.stderr };
  }

  const changed = [];
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const status = parts[0].charAt(0).toUpperCase();
    // R/C 有两列路径，取最后一列（新路径）
    const rawPath = parts[parts.length - 1];
    const normPath = normalizePath(rawPath);
    if (!normPath) continue;
    if (isIgnoredPath(normPath)) continue;
    changed.push({ status, path: normPath });
  }

  // 2) 最近 N 个 T-block 覆盖的文件
  const logData = parseLog(pocketDir);
  const recentBlocks = logData.blocks.slice(-lastN);
  const covered = new Set();
  for (const b of recentBlocks) {
    const actions = b.actions || [];
    for (const a of actions) {
      if (a && a.file) {
        covered.add(normalizePath(a.file));
      }
    }
  }

  // 3) 漏记 = 变更 - 覆盖
  const unrecorded = changed.filter(c => !covered.has(c.path));

  return {
    ...base,
    clean: unrecorded.length === 0,
    needsLog: false,
    changedCount: changed.length,
    changed,
    covered: [...covered],
    unrecorded,
    latestT: logData.latestT,
    recentTBlocks: recentBlocks.map(b => b.id),
    error: null,
  };
}

// ============================================================
// 构造补录 T-block
// ============================================================

/**
 * 依据漏记文件构造一个 [auto] T-block 的内容（appendLogBlock 的 options）
 * @param {Array<{status:string, path:string}>} unrecorded
 * @param {object} config
 * @returns {object}
 */
function buildCatchupBlock(unrecorded, config) {
  const lang = config && config.language === 'en' ? 'en' : 'zh';
  const labels = STATUS_LABELS[lang] || STATUS_LABELS.zh;
  const n = unrecorded.length;

  const gist = lang === 'en'
    ? `Auto-catchup: ${n} staged file${n !== 1 ? 's' : ''} not recorded in recent T-blocks`
    : `自动补录：${n} 个已暂存文件未被最近 T-block 记录`;

  const user = lang === 'en'
    ? ['(Auto-reconstructed by the ContextPocket pre-commit hook — original user request was not captured.)']
    : ['（由 ContextPocket pre-commit hook 自动重建 —— 原始用户请求未被记录，请核对后补充。）'];

  const action = unrecorded.map(c => {
    const label = labels[c.status] || labels.M;
    return `${label} ${c.path} — ${lang === 'en' ? 'auto-detected from staged git changes' : '由 git 暂存变更自动检测'}`;
  });

  const decisions = lang === 'en'
    ? ['Auto-recorded by the git safety-net hook. Review and expand with real details if needed.']
    : ['由 git 兜底 hook 自动记录。请核对后按实际情况补充细节。'];

  return {
    gist,
    tags: ['auto'],
    user,
    action,
    decisions,
  };
}

// ============================================================
// sync 主函数
// ============================================================

/**
 * 检测漏记并（可选）自动补录
 * @param {string} pocketDir
 * @param {object} [opts]
 * @param {boolean} [opts.auto=false] 自动补录（写入 log.md）
 * @param {boolean} [opts.dryRun=false] 只打印计划，不写入
 * @param {number} [opts.lastN=5] 覆盖判定回看最近 N 个 T-block
 * @returns {object}
 */
function sync(pocketDir, opts = {}) {
  const auto = !!opts.auto;
  const dryRun = !!opts.dryRun;

  const det = detectUnrecorded(pocketDir, { lastN: opts.lastN });

  // 非 git / 需要 log / 出错
  if (!det.isGit) {
    return { ...det, skipped: true, reason: 'not a git repository' };
  }
  if (det.error) {
    return { ...det, skipped: true, reason: 'git error: ' + det.error };
  }
  if (det.needsLog) {
    return { ...det, skipped: true, reason: 'log.md missing' };
  }

  // 干净：无漏记
  if (det.clean) {
    return {
      ...det,
      clean: true,
      filled: false,
      tId: null,
      dryRun,
      auto,
    };
  }

  const config = readConfig(pocketDir);
  const block = buildCatchupBlock(det.unrecorded, config);

  // dry-run：只给计划
  if (dryRun) {
    return {
      ...det,
      clean: false,
      dryRun: true,
      auto: false,
      filled: false,
      tId: null,
      wouldFill: block,
      nextT: det.latestT + 1,
    };
  }

  // 自动补录
  if (auto) {
    try {
      const r = appendLogBlock(pocketDir, block);
      return {
        ...det,
        clean: false,
        auto: true,
        dryRun: false,
        filled: true,
        tId: r.tId,
        filledBlock: block,
      };
    } catch (e) {
      return {
        ...det,
        clean: false,
        auto: true,
        filled: false,
        tId: null,
        error: 'auto-fill failed: ' + e.message,
      };
    }
  }

  // 默认：仅报告，不写入
  return {
    ...det,
    clean: false,
    auto: false,
    dryRun: false,
    filled: false,
    tId: null,
    wouldFill: block,
    nextT: det.latestT + 1,
  };
}

module.exports = {
  git,
  isGitRepo,
  normalizePath,
  isIgnoredPath,
  detectUnrecorded,
  buildCatchupBlock,
  sync,
};
