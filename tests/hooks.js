'use strict';

/**
 * 套件：pre-commit hook（lib/hooks.js + bin install-hook）
 *
 * 分两层：
 *   1) 内容断言 —— 直接在临时目录里伪造 `.git/hooks`，install 之后读回脚本本体。
 *      这一步不需要 git，也不需要 sh，是防止 hook 逻辑回归的主力。
 *   2) 端到端 —— 真有 git 时 `git init` + 真提交，验证"该拦的拦住、不该拦的放行"。
 *      没有 git / sh 时整组跳过并打印说明，绝不把跳过算成通过。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { assert, test, tmpProject, makePocket, ROOT } = require('./harness');

const {
  findGitDir,
  installPreCommitHook,
  uninstallPreCommitHook,
  MARKER,
} = require(path.join(ROOT, 'lib', 'hooks'));

const POCKET_DIR_NAME = require(path.join(ROOT, 'lib', 'constants')).POCKET_DIR_NAME;

const CLI_PATH = path.join(ROOT, 'bin', 'context-pocket.js').split(path.sep).join('/');

// ------------------------------------------------------------
// 辅助
// ------------------------------------------------------------

/** 只造一个 .git 目录，不依赖真实 git —— 内容断言用这个就够了 */
function fakeGitRepo(tag) {
  const projectDir = tmpProject(tag);
  const hooksDir = path.join(projectDir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  return projectDir;
}

function readHook(projectDir) {
  return fs.readFileSync(path.join(projectDir, '.git', 'hooks', 'pre-commit'), 'utf-8');
}

function markerCount(content) {
  return content.split('\n').filter((l) => l.includes(MARKER)).length;
}

function which(bin) {
  const probe = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [bin] : ['-v', bin];
  if (process.platform === 'win32') return spawnSync(probe, args).status === 0;
  return spawnSync('/bin/sh', ['-c', `command -v ${bin} >/dev/null 2>&1`]).status === 0;
}

const HAS_GIT = which('git');
const HAS_SH = process.platform === 'win32' ? which('sh') : true;

/** 在临时目录里跑一次真实 git 命令，返回 spawnSync 结果 */
function git(cwd, args) {
  return spawnSync(
    'git',
    ['-c', 'user.name=ContextPocket Test', '-c', 'user.email=cp-test@example.invalid', ...args],
    { cwd, encoding: 'utf-8' }
  );
}

/** e2e：一个干净的真实 git 仓库（可能带 pocket） */
function realRepo(tag, withPocket) {
  const projectDir = tmpProject(tag);
  const r = git(projectDir, ['init', '-q']);
  if (r.status !== 0) return null;
  if (withPocket) {
    const { bootstrap } = require(path.join(ROOT, 'lib', 'bootstrap'));
    bootstrap(projectDir);
  }
  fs.writeFileSync(path.join(projectDir, 'app.js'), '// hello\n');
  return projectDir;
}

// ============================================================
// 1. 生成的脚本内容
// ============================================================

test('hooks: install creates a hook with shebang, marker pair and both steps', () => {
  const projectDir = fakeGitRepo('hook-content');
  const result = installPreCommitHook(projectDir);

  assert.strictEqual(result.action, 'created');
  assert.ok(result.hookPath.endsWith(path.join('.git', 'hooks', 'pre-commit')));

  const content = readHook(projectDir);
  assert.ok(content.startsWith('#!/bin/sh\n'), 'hook must start with a POSIX shebang');
  assert.strictEqual(markerCount(content), 2, 'MARKER must appear exactly twice (open + close)');

  const syncAt = content.indexOf('sync --auto');
  const verifyAt = content.indexOf('verify --quiet');
  assert.ok(syncAt > -1, 'hook must run sync --auto');
  assert.ok(verifyAt > -1, 'hook must run verify --quiet');
  assert.ok(syncAt < verifyAt, 'sync (step 1) must come before verify (step 2)');

  // 两步都必须真的能拦住提交
  assert.strictEqual(content.split('commit blocked').length - 1, 2, 'both steps block on failure');

  // 回归锁：曾经这里写死 exit 1，把 warning 也当成 error 拦截提交。
  const last = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .pop();
  assert.strictEqual(last, 'exit $VERIFY_RC', 'final exit must follow verify, not a hard-coded 1');
});

test('hooks: generated CLI path is absolute, forward-slashed and exists', () => {
  const projectDir = fakeGitRepo('hook-cli-path');
  installPreCommitHook(projectDir);

  const line = readHook(projectDir)
    .split('\n')
    .find((l) => l.startsWith('CLI="'));
  assert.ok(line, 'hook must define the CLI path');

  const cli = line.slice('CLI="'.length, -1);
  assert.ok(!cli.includes('\\'), 'backslashes break POSIX sh quoting: ' + cli);
  assert.ok(path.isAbsolute(cli), 'CLI path must be absolute: ' + cli);
  assert.ok(fs.existsSync(cli), 'CLI must resolve from the hook: ' + cli);
  assert.strictEqual(cli, CLI_PATH);
});

test('hooks: node or CLI missing means skip, never block', () => {
  const projectDir = fakeGitRepo('hook-guards');
  installPreCommitHook(projectDir);
  const content = readHook(projectDir);

  const nodeGuard = content.indexOf('command -v node');
  const cliGuard = content.indexOf('[ ! -f "$CLI" ]');
  assert.ok(nodeGuard > -1 && cliGuard > -1);

  // 两个兜底都必须在 sync/verify 之前，且各自那个 if 块只能是 exit 0
  for (const at of [nodeGuard, cliGuard]) {
    const block = content.slice(at, at + content.slice(at).indexOf('\nfi') + 3);
    assert.ok(block.includes('exit 0'), 'guard must exit 0 (skip)');
    assert.ok(!block.includes('exit 1'), 'guard must not exit 1');
    assert.ok(at < content.indexOf('sync --auto'), 'guards must run before step 1');
  }
});

test('hooks: reinstall upgrades in place instead of stacking sections', () => {
  const projectDir = fakeGitRepo('hook-upgrade');
  installPreCommitHook(projectDir);

  // 手改出一个"旧版"区块，模拟 v1 装过的用户
  const stale = readHook(projectDir).replace('sync --auto', 'sync');
  fs.writeFileSync(path.join(projectDir, '.git', 'hooks', 'pre-commit'), stale, 'utf-8');

  const result = installPreCommitHook(projectDir);
  assert.strictEqual(result.action, 'upgraded');

  const content = readHook(projectDir);
  assert.strictEqual(markerCount(content), 2, 'upgrade must not duplicate the managed block');
  assert.strictEqual(content.split('SYNC_OUT=').length - 1, 1);
  assert.ok(content.includes('sync --auto'), 'upgrade restores the current step 1');
});

// ============================================================
// 2. 与别人的 hook 共存
// ============================================================

test('hooks: appends to a foreign hook and removes only its own section', () => {
  const projectDir = fakeGitRepo('hook-append');
  const hookPath = path.join(projectDir, '.git', 'hooks', 'pre-commit');
  const foreign = '#!/bin/sh\n\necho foreign-lint\nexit 0\n';
  fs.writeFileSync(hookPath, foreign, 'utf-8');

  assert.strictEqual(installPreCommitHook(projectDir).action, 'appended');
  const merged = fs.readFileSync(hookPath, 'utf-8');
  assert.ok(merged.includes('echo foreign-lint'), 'foreign content must survive install');

  const removed = uninstallPreCommitHook(projectDir);
  assert.strictEqual(removed.action, 'removed-section');

  const after = fs.readFileSync(hookPath, 'utf-8');
  assert.strictEqual(markerCount(after), 0);
  assert.ok(after.includes('echo foreign-lint'), 'foreign content must survive uninstall');
  assert.ok(!after.includes('verify --quiet'));

  assert.strictEqual(uninstallPreCommitHook(projectDir).action, 'not-installed');
});

test('hooks: uninstall deletes the file when the hook is entirely ours', () => {
  const projectDir = fakeGitRepo('hook-delete');
  installPreCommitHook(projectDir);

  assert.strictEqual(uninstallPreCommitHook(projectDir).action, 'deleted');
  assert.ok(!fs.existsSync(path.join(projectDir, '.git', 'hooks', 'pre-commit')));
  assert.strictEqual(uninstallPreCommitHook(projectDir).action, 'not-found');
});

test('hooks: uninstall leaves a hook without our marker alone', () => {
  const projectDir = fakeGitRepo('hook-foreign-only');
  const hookPath = path.join(projectDir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hookPath, '#!/bin/sh\nexit 0\n', 'utf-8');

  assert.strictEqual(uninstallPreCommitHook(projectDir).action, 'not-installed');
  assert.strictEqual(fs.readFileSync(hookPath, 'utf-8'), '#!/bin/sh\nexit 0\n');
});

test('hooks: install outside a git repository throws', () => {
  const { projectDir } = makePocket('hook-no-git');
  assert.throws(
    () => installPreCommitHook(projectDir),
    /No \.git directory found/,
    'install must refuse a non-repo'
  );
});

test('hooks: findGitDir follows a worktree .git file', () => {
  const projectDir = tmpProject('hook-worktree');
  const realGit = path.join(tmpProject('hook-worktree-git'), 'gitdir');
  fs.mkdirSync(realGit, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.git'), 'gitdir: ' + realGit + '\n', 'utf-8');

  assert.strictEqual(findGitDir(projectDir), realGit);
});

// ============================================================
// 3. 没有 pocket 的仓库绝不能锁死提交
// ============================================================

test('hooks: generated script skips when the repo has no ContextPocket', () => {
  const projectDir = fakeGitRepo('hook-nopocket');
  installPreCommitHook(projectDir);
  const content = readHook(projectDir);

  assert.ok(
    content.includes('POCKET_DIR_NAME="' + POCKET_DIR_NAME + '"'),
    'hook must carry the pocket directory name (from lib/constants, not hard-coded)'
  );
  const pocketCheck = content
    .split('\n')
    .findIndex((l) => l.includes('[ -d ') && l.includes('$POCKET_DIR_NAME'));
  assert.ok(pocketCheck > -1, 'hook must look for the pocket directory before doing any work');
  assert.ok(
    content.indexOf('sync --auto') > content.indexOf('# step 0'),
    'the pocket check must run before step 1'
  );
  assert.ok(
    content.includes('sync --auto'),
    'the pocket check must not replace step 1'
  );

  if (!HAS_SH) {
    console.log('       (sh not available — content check only)');
    return;
  }

  // 真跑一次：没有 pocket 的仓库里，hook 必须退 0（放行）
  const run = spawnSync('sh', [path.join(projectDir, '.git', 'hooks', 'pre-commit')], {
    cwd: projectDir,
    encoding: 'utf-8',
  });
  assert.strictEqual(run.status, 0, 'no-pocket must not block the commit:\n' + run.stdout + run.stderr);
  assert.ok(/skip/i.test(run.stdout), 'hook should say it is skipping: ' + run.stdout);
});

// ============================================================
// 4. 端到端（需要真实 git）
// ============================================================

test('hooks e2e: healthy pocket commits, and unlogged staged files get auto-recorded', () => {
  if (!HAS_GIT || !HAS_SH) {
    console.log('       (skipped: needs git + sh)');
    return;
  }
  const projectDir = realRepo('hook-e2e-ok', true);
  assert.ok(projectDir, 'git init failed');

  assert.strictEqual(installPreCommitHook(projectDir).action, 'created');
  git(projectDir, ['add', 'app.js']);

  const run = git(projectDir, ['commit', '-q', '-m', 'feat: first commit']);
  assert.strictEqual(run.status, 0, 'healthy pocket must allow commits:\n' + run.stdout + run.stderr);

  const log = fs.readFileSync(path.join(projectDir, POCKET_DIR_NAME, 'log.md'), 'utf-8');
  assert.ok(/\[auto\]/.test(log), 'step 1 must auto-record the unlogged staged file:\n' + log);
  assert.ok(log.includes('app.js'), 'the auto T-block must name the staged file');
});

test('hooks e2e: broken pocket blocks the commit', () => {
  if (!HAS_GIT || !HAS_SH) {
    console.log('       (skipped: needs git + sh)');
    return;
  }
  const projectDir = realRepo('hook-e2e-block', true);
  assert.ok(projectDir, 'git init failed');

  installPreCommitHook(projectDir);
  // 打掉一个核心文件：sync 与 verify 都会报错
  fs.unlinkSync(path.join(projectDir, POCKET_DIR_NAME, 'log.md'));

  git(projectDir, ['add', 'app.js']);
  const run = git(projectDir, ['commit', '-q', '-m', 'chore: should be blocked']);
  assert.notStrictEqual(run.status, 0, 'a broken pocket must block the commit');
  assert.ok(/ContextPocket/i.test(run.stdout + run.stderr), 'hook must explain why it blocked');
});

/** 往真实 pocket 的 log.md 里塞一条记录（用 writer，index.md 会跟着更新） */
function recordInto(projectDir, gist, extra) {
  const writer = require(path.join(ROOT, 'lib', 'writer'));
  return writer.appendLogBlock(path.join(projectDir, POCKET_DIR_NAME), Object.assign({
    gist,
    tags: ['测试'],
    action: ['修改 tests/fixtures/' + gist.replace(/\s+/g, '-') + '.js'],
  }, extra || {}));
}

const PASTED_KEY = 'sk-ant-abcdefghijklmnopqrstuvwxyz1234';

test('hooks e2e: a credential in the pocket blocks the commit, and the key is never echoed', () => {
  if (!HAS_GIT || !HAS_SH) {
    console.log('       (skipped: needs git + sh)');
    return;
  }
  const projectDir = realRepo('hook-e2e-secret', true);
  assert.ok(projectDir, 'git init failed');

  installPreCommitHook(projectDir);
  recordInto(projectDir, '排查报错', { user: ['报错原文：401 using ' + PASTED_KEY + ' 调用失败'] });

  git(projectDir, ['add', 'app.js']);
  const run = git(projectDir, ['commit', '-q', '-m', 'fix: keep the log turn']);
  assert.notStrictEqual(run.status, 0, '一条凭证形状的密钥必须拦下这次提交');
  assert.ok(/Anthropic API key/.test(run.stdout + run.stderr),
    '拦截理由要说清是什么、在哪一行：\n' + run.stdout + run.stderr);
  assert.ok(!run.stdout.includes(PASTED_KEY),
    'hook 的 stderr/stdout 会被 Agent 抄进下一条记录，所以只能出掩码');
});

test('hooks e2e: personal data is a warning and never blocks the commit', () => {
  if (!HAS_GIT || !HAS_SH) {
    console.log('       (skipped: needs git + sh)');
    return;
  }
  const projectDir = realRepo('hook-e2e-pii', true);
  assert.ok(projectDir, 'git init failed');

  installPreCommitHook(projectDir);
  recordInto(projectDir, '回访客户', { user: ['客户手机 13800138000 说登录不上了'] });

  git(projectDir, ['add', 'app.js']);
  const run = git(projectDir, ['commit', '-q', '-m', 'fix: 回访记录']);
  assert.strictEqual(run.status, 0,
    'PII 只能提示，不能把日常提交拦死：\n' + run.stdout + run.stderr);
  assert.ok(!run.stdout.includes('13800138000'), '放行时也一样只出掩码');
});

test('hooks e2e: repo without a pocket is never locked out', () => {
  if (!HAS_GIT || !HAS_SH) {
    console.log('       (skipped: needs git + sh)');
    return;
  }
  const projectDir = realRepo('hook-e2e-nopocket', false);

  assert.ok(projectDir, 'git init failed');

  installPreCommitHook(projectDir);
  git(projectDir, ['add', 'app.js']);

  const run = git(projectDir, ['commit', '-q', '-m', 'chore: no pocket yet']);
  assert.strictEqual(
    run.status,
    0,
    'installing the hook before bootstrap must not block every commit:\n' + run.stdout + run.stderr
  );

  // 并且确实跑了 hook（否则"放行"是假的）——用输出里的跳过提示自证
  assert.ok(/ContextPocket/.test(run.stdout + run.stderr), 'hook must have run and explained the skip');
});

// ============================================================
// 5. CLI 层：install-hook 要提前告知风险
// ============================================================

test('hooks: install-hook warns when the project has no pocket yet', () => {
  const projectDir = fakeGitRepo('hook-cli-warn');
  const run = spawnSync(process.execPath, [CLI_PATH, 'install-hook', '--dir', projectDir, '--json'], {
    encoding: 'utf-8',
  });
  assert.strictEqual(run.status, 0, 'install itself must succeed:\n' + run.stdout + run.stderr);

  const out = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.hook.action, 'created');
  assert.strictEqual(out.pocket, false, 'JSON must say there is no pocket');
});
