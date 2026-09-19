'use strict';

/**
 * ContextPocket — Git Hook 管理
 * 安装/卸载 pre-commit hook。
 *
 * v2 hook 行为（两步）：
 *   1) `context-pocket sync --auto`  —— git 漏记兜底：把"已暂存但未被最近
 *      T-block 记录"的文件自动补录为一个 [auto] T-block（解决 Agent 漏记）。
 *   2) `context-pocket verify --quiet` —— 健康检查：有 error 阻止提交，warning 放行。
 *
 * 定位策略：安装时把 skill 内 CLI 的绝对路径（正斜杠）写进 hook，直接
 * `node <cli> ...` 调用，不依赖项目里的 node_modules / npx。找不到 node
 * 或 CLI 时跳过（不阻断提交），避免误伤。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const fs = require('fs');
const path = require('path');
const { fileExists } = require('./core');

// 区块标记（成对出现，用于安装/升级/卸载的精确切分）
const MARKER = 'ContextPocket :: pre-commit hook (managed by context-pocket install-hook)';

// ============================================================
// 查找 .git 目录
// ============================================================

/**
 * 从指定目录向上查找 .git 目录
 * @param {string} startDir
 * @returns {string|null} .git 目录的绝对路径
 */
function findGitDir(startDir) {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (current !== root) {
    const gitPath = path.join(current, '.git');
    if (fs.existsSync(gitPath)) {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) {
        return gitPath;
      }
      // .git 可能是文件（worktree 情况）
      if (stat.isFile()) {
        const content = fs.readFileSync(gitPath, 'utf-8');
        const match = content.match(/gitdir:\s*(.+)/);
        if (match) {
          const gitdir = match[1].trim();
          const absGitdir = path.isAbsolute(gitdir)
            ? gitdir
            : path.resolve(current, gitdir);
          if (fs.existsSync(absGitdir) && fs.statSync(absGitdir).isDirectory()) {
            return absGitdir;
          }
        }
      }
    }
    current = path.dirname(current);
  }

  return null;
}

// ============================================================
// CLI 路径
// ============================================================

/**
 * 定位 skill 内的 CLI（lib/../bin/context-pocket.js），转成正斜杠绝对路径。
 * 正斜杠在 POSIX sh 与 Windows git-bash 下都能被 node 接受，避免反斜杠转义问题。
 * @returns {string}
 */
function getCliPath() {
  return path.join(__dirname, '..', 'bin', 'context-pocket.js').split(path.sep).join('/');
}

// ============================================================
// 安装 pre-commit hook
// ============================================================

/**
 * 安装（或升级）pre-commit hook
 * @param {string} projectRoot - 项目根目录
 * @returns {object} { success, hookPath, action: 'created'|'appended'|'upgraded'|'already-installed' }
 */
function installPreCommitHook(projectRoot) {
  const gitDir = findGitDir(projectRoot);
  if (!gitDir) {
    throw new Error('No .git directory found. Is this a git repository?');
  }

  const hooksDir = path.join(gitDir, 'hooks');
  const hookPath = path.join(hooksDir, 'pre-commit');

  // 确保 hooks 目录存在
  if (!fileExists(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const body = generateHookBody(getCliPath());

  if (!fileExists(hookPath)) {
    // 全新安装
    const content = '#!/bin/sh\n' + body.join('\n') + '\n';
    fs.writeFileSync(hookPath, content, 'utf-8');
    try {
      fs.chmodSync(hookPath, 0o755);
    } catch (e) {
      // Windows 上 chmod 可能不生效，忽略
    }
    return { success: true, hookPath, action: 'created' };
  }

  const existingContent = fs.readFileSync(hookPath, 'utf-8');

  if (existingContent.includes(MARKER)) {
    // 已有我们的区块 → 先移除旧区块，再追加新区块（升级 v1→v2 或刷新 CLI 路径）
    const withoutOurs = removeContextPocketSection(existingContent);
    const upgraded = (withoutOurs ? withoutOurs : '#!/bin/sh\n') + '\n' + body.join('\n') + '\n';
    fs.writeFileSync(hookPath, upgraded, 'utf-8');
    try { fs.chmodSync(hookPath, 0o755); } catch (e) { /* ignore */ }
    return { success: true, hookPath, action: 'upgraded' };
  }

  // 有其他 hook 且没有我们的区块 → 追加
  const appendContent = existingContent.replace(/\s*$/, '\n') + body.join('\n') + '\n';
  fs.writeFileSync(hookPath, appendContent, 'utf-8');
  try { fs.chmodSync(hookPath, 0o755); } catch (e) { /* ignore */ }

  return { success: true, hookPath, action: 'appended' };
}

// ============================================================
// 卸载 pre-commit hook
// ============================================================

/**
 * 卸载 pre-commit hook
 * @param {string} projectRoot
 * @returns {object} { success, hookPath, action }
 */
function uninstallPreCommitHook(projectRoot) {
  const gitDir = findGitDir(projectRoot);
  if (!gitDir) {
    throw new Error('No .git directory found. Is this a git repository?');
  }

  const hookPath = path.join(gitDir, 'hooks', 'pre-commit');

  if (!fileExists(hookPath)) {
    return { success: true, hookPath, action: 'not-found' };
  }

  const content = fs.readFileSync(hookPath, 'utf-8');

  if (!content.includes(MARKER)) {
    return { success: true, hookPath, action: 'not-installed' };
  }

  const hasOtherContent = hasNonContextPocketContent(content);

  if (!hasOtherContent) {
    // 整个 hook 都是我们的，直接删除
    fs.unlinkSync(hookPath);
    return { success: true, hookPath, action: 'deleted' };
  }

  const newContent = removeContextPocketSection(content);
  fs.writeFileSync(hookPath, newContent, 'utf-8');

  return { success: true, hookPath, action: 'removed-section' };
}

// ============================================================
// 生成 hook 区块（不含 shebang；首尾用成对 MARKER 行包裹）
// ============================================================

function generateHookBody(cliPath) {
  return [
    '# >>> ' + MARKER,
    '',
    '# v2: (1) auto-record unlogged staged changes (git safety net)',
    '#      (2) verify health before commit; block on errors, allow warnings.',
    '# Install: context-pocket install-hook · Uninstall: context-pocket uninstall-hook',
    '',
    'CLI="' + cliPath + '"',
    '',
    'if ! command -v node >/dev/null 2>&1; then',
    '  echo "⚠️  ContextPocket: node not found in PATH; skipping pre-commit checks."',
    '  exit 0',
    'fi',
    '',
    'if [ ! -f "$CLI" ]; then',
    '  echo "⚠️  ContextPocket CLI not found at: $CLI"',
    '  echo "    Reinstall with: context-pocket install-hook"',
    '  exit 0',
    'fi',
    '',
    '# step 1: git safety net — auto-fill missed T-blocks',
    'SYNC_OUT=$(node "$CLI" sync --auto 2>&1)',
    'SYNC_RC=$?',
    'if [ $SYNC_RC -ne 0 ]; then',
    '  echo ""',
    '  echo "❌ ContextPocket sync failed — commit blocked."',
    '  echo "$SYNC_OUT"',
    '  echo "   Override (at your own risk): git commit --no-verify"',
    '  exit 1',
    'fi',
    '',
    '# step 2: verify',
    'VERIFY_OUT=$(node "$CLI" verify --quiet 2>&1)',
    'VERIFY_RC=$?',
    '# NOTE: sync already exited above if it failed (SYNC_RC != 0 blocks).',
    '# Here, SYNC_RC=0 means sync succeeded (or was clean).',
    '# Verify failure means the ContextPocket state is broken — block commit.',
    'if [ $VERIFY_RC -ne 0 ]; then',
    '  echo ""',
    '  echo "❌ ContextPocket verify failed — commit blocked."',
    '  echo "   Fix the errors above, or run \'context-pocket uninstall-hook\' to disable."',
    '  echo ""',
    '  echo "$VERIFY_OUT"',
    '  exit 1',
    'fi',
    '',
    '# surface sync auto-fill info (if any)',
    'if [ -n "$SYNC_OUT" ]; then',
    '  echo "$SYNC_OUT"',
    'fi',
    '',
    '# exit with verify result: 0 = all good, 1 = verify found errors (block commit)',
    'exit $VERIFY_RC',
    '# <<< ' + MARKER,
  ];
}

/**
 * 是否含有 ContextPocket 区块之外的内容
 * @param {string} content
 * @returns {boolean}
 */
function hasNonContextPocketContent(content) {
  const lines = content.split('\n');
  let inOur = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes(MARKER)) {
      inOur = !inOur;
      continue;
    }
    if (!inOur && trimmed && !trimmed.startsWith('#!')) {
      return true;
    }
  }

  return false;
}

/**
 * 移除 ContextPocket 区块（成对 MARKER 之间，含 MARKER 行本身）
 * @param {string} content
 * @returns {string}
 */
function removeContextPocketSection(content) {
  const lines = content.split('\n');
  const result = [];
  let inOur = false;

  for (const line of lines) {
    if (line.includes(MARKER)) {
      inOur = !inOur;
      continue;
    }
    if (inOur) {
      continue;
    }
    result.push(line);
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

module.exports = {
  findGitDir,
  getCliPath,
  installPreCommitHook,
  uninstallPreCommitHook,
  MARKER,
};
