#!/usr/bin/env node
'use strict';

/**
 * ContextPocket CLI
 *
 * Usage:
 *   context-pocket bootstrap [--project-type <type>] [--mode <full|lite>] [--language <zh|en>]
 *   context-pocket verify [--quiet]
 *   context-pocket sync [--auto] [--dry-run] [--last-n <N>] [--quiet]
 *   context-pocket status
 *   context-pocket recall <T-id>
 *   context-pocket diff <T-a> <T-b>
 *   context-pocket search <keyword>
 *   context-pocket why <file-path> [--limit <N>]
 *   context-pocket check-conflicts
 *   context-pocket log append --gist "..." --tags "a,b" --user "..." --action "..."
 *   context-pocket req add "text" [--tags "a,b"] [--uncertain] [--impl "file1,file2"]
 *   context-pocket decision add --title "..." --context "..." --options "..." --decision "..."
 *   context-pocket archive [--keep-last <N>] [--dry-run]
 *   context-pocket state update [--summary "..."] [--next-step "..."] [--pitfall "..."]
 *   context-pocket preferences update --key "..." --value "..."
 *   context-pocket code-map update
 *   context-pocket migrate [--to <version>] [--dry-run]
 *   context-pocket install-hook
 *   context-pocket uninstall-hook
 *   context-pocket handoff
 *   context-pocket help
 *
 * Zero-dependency Node.js script. Works with Node.js 14+.
 */

const path = require('path');
const { findPocketDir, readConfig, getProjectRoot } = require('../lib/core');
const { parseAll, parseLog } = require('../lib/parser');
const { verify } = require('../lib/validator');
const {
  appendLogBlock,
  addRequirement,
  addDecision,
  generateHandoff,
  archiveLog,
  updateState,
  updatePreferences,
  updateCodeMap,
} = require('../lib/writer');
const { formatVerifyResult, formatStatus, colorize } = require('../lib/formatter');
const { bootstrap } = require('../lib/bootstrap');
const { recall, diff, search, why, checkConflicts } = require('../lib/query');
const { runMigration, detectFormatVersion, listMigrations } = require('../lib/migrate');
const { installPreCommitHook, uninstallPreCommitHook } = require('../lib/hooks');
const { sync: syncPocket } = require('../lib/sync');
const { buildIndex, searchWithIndex } = require('../lib/indexer');
const { distill } = require('../lib/distill');
const { importSession } = require('../lib/importer');
const {
  getHubDir,
  getHubFile,
  registerProject,
  touchProject,
  removeProject,
  listProjects,
  setGlobalPref,
  getGlobalPref,
} = require('../lib/userhub');

// ============================================================
// 解析命令行参数
// ============================================================

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    command: null,
    subcommand: null,
    options: {},
    positional: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > -1) {
        const key = arg.slice(2, eqIdx);
        const value = arg.slice(eqIdx + 1);
        result.options[key] = value === '' ? true : value;
      } else {
        const key = arg.slice(2);
        if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
          result.options[key] = args[i + 1];
          i++;
        } else {
          result.options[key] = true;
        }
      }
    } else if (arg.startsWith('-')) {
      result.options[arg.slice(1)] = true;
    } else {
      if (!result.command) {
        result.command = arg;
      } else if (!result.subcommand && ['append', 'add', 'update'].includes(arg)) {
        result.subcommand = arg;
      } else {
        result.positional.push(arg);
      }
    }
  }

  return result;
}

// ============================================================
// 工具函数
// ============================================================

function splitCsv(str) {
  if (!str) return [];
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

function ensurePocket(options) {
  const startDir = options.dir || process.cwd();
  const pocketDir = findPocketDir(startDir);
  if (!pocketDir) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' No ContextPocket/ directory found.');
    console.error('     Run "context-pocket bootstrap" first, or use --dir to specify a project path.\n');
    process.exit(1);
  }
  return pocketDir;
}

function getProjectDir(options) {
  return options.dir ? path.resolve(options.dir) : process.cwd();
}

// ============================================================
// 命令：help
// ============================================================

function cmdHelp() {
  const lines = [];
  lines.push('');
  lines.push(colorize('  ContextPocket CLI', 'bold'));
  lines.push('  Auto-record dev conversations into your project.');
  lines.push('');
  lines.push(colorize('  Usage:', 'bold'));
  lines.push('    context-pocket <command> [options]');
  lines.push('');
  lines.push(colorize('  Setup commands:', 'bold'));
  lines.push('    bootstrap       Initialize ContextPocket/ in your project');
  lines.push('    install-hook    Install git pre-commit hook (sync + verify)');
  lines.push('    uninstall-hook  Uninstall git pre-commit hook');
  lines.push('');
  lines.push(colorize('  Inspection commands:', 'bold'));
  lines.push('    verify          Run health check on ContextPocket/ (--drift for cognition drift)');
  lines.push('    sync            Git safety net: detect/auto-record unlogged changes');
  lines.push('    status          Show current status summary');
  lines.push('    recall <T-id>   Show full details of a T-block');
  lines.push('    diff <Ta> <Tb>  Compare two T-blocks (reqs/ADRs/files)');
  lines.push('    search <kw>     Search all T-blocks by keyword');
  lines.push('    why <file>      Reverse lookup: which T-blocks mentioned this file');
  lines.push('    check-conflicts Scan for conflicts across 6 dimensions');
  lines.push('');
  lines.push(colorize('  Write commands:', 'bold'));
  lines.push('    log append      Append a new T-block to log.md');
  lines.push('    req add         Add a new requirement');
  lines.push('    decision add    Add a new ADR entry');
  lines.push('    state update    Update state.md (summary/next-step/pitfall)');
  lines.push('    prefs update    Update preferences.md (key/value)');
  lines.push('    code-map update Rescan project and update code-map.md');
  lines.push('    handoff         Generate handoff.md');
  lines.push('');
  lines.push(colorize('  Long-term memory commands:', 'bold'));
  lines.push('    index           Build/refresh the search index (--rebuild to force)');
  lines.push('    distill         Distill archived turns into digest report (--dry-run)');
  lines.push('    import          Import past agent sessions as T-blocks (claude-code/codex)');
  lines.push('    hub             Cross-project registry + global prefs (~/.contextpocket)');
  lines.push('');
  lines.push(colorize('  Maintenance commands:', 'bold'));
  lines.push('    archive         Archive old T-blocks to log-archive.md');
  lines.push('    migrate         Migrate data format to new version');
  lines.push('');
  lines.push(colorize('  Options:', 'bold'));
  lines.push('    --dir <path>    Specify project directory (default: cwd)');
  lines.push('');
  lines.push('  Run "context-pocket <command> --help" for command-specific help.');
  lines.push('');
  console.log(lines.join('\n'));
}

// ============================================================
// 命令：bootstrap
// ============================================================

function cmdBootstrap(options) {
  const projectDir = getProjectDir(options);

  try {
    const result = bootstrap(projectDir, {
      projectType: options['project-type'],
      mode: options.mode,
      language: options.language,
      // --gitignore false → pocket 数据进 git（跨设备同步用），默认忽略
      gitignore: options.gitignore !== undefined
        ? options.gitignore !== 'false' && options.gitignore !== false
        : undefined,
    });

    console.log('');
    console.log(colorize('  ✅ ContextPocket initialized!', 'green'));
    console.log(`     Project type: ${result.projectType}`);
    console.log(`     Mode: ${result.mode}`);
    console.log(`     Language: ${result.language}`);
    console.log(`     Files created: ${result.filesCopied.length}`);
    for (const f of result.filesCopied) {
      console.log(`       - ${f}`);
    }
    if (result.gitignore) {
      if (result.gitignore.removed) {
        console.log('     Git: ContextPocket/ removed from .gitignore (will be committed — sync across machines via git)');
      } else if (result.gitignore.absent) {
        console.log('     Git: ContextPocket/ not ignored (will be committed)');
      } else {
        console.log('     Git: ContextPocket/ added to .gitignore (project-local)');
      }
    }

    // 注册到用户级 hub（best-effort，失败不影响 bootstrap）
    try {
      const hubResult = registerProject(projectDir, {
        projectType: result.projectType,
        mode: result.mode,
        latestT: 0,
      });
      console.log(`     Hub: registered in ${getHubFile()}`);
      void hubResult;
    } catch (e) {
      // hub 不可用（只读 home 等）→ 静默跳过
    }

    console.log('');
    console.log('  Next steps:');
    console.log('    1. Edit ContextPocket/readme.md with project info');
    console.log('    2. Run "context-pocket verify" to check health');
    console.log('    3. Run "context-pocket install-hook" to enable pre-commit checks');
    console.log('');
  } catch (e) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' ' + e.message);
    console.error('');
    process.exit(1);
  }
}

// ============================================================
// 命令：verify
// ============================================================

function cmdVerify(options) {
  const pocketDir = ensurePocket(options);
  const config = readConfig(pocketDir);
  const drift = !!options.drift;
  const lastN = options['drift-last-n'] ? parseInt(options['drift-last-n'], 10) : 5;
  const result = verify(pocketDir, { drift, lastN });

  console.log(formatVerifyResult(result, { quiet: options.quiet || config.quiet }));

  if (result.errorCount > 0) {
    process.exit(1);
  }
}

// ============================================================
// 命令：sync（Git 漏记兜底）
// ============================================================

function cmdSync(options) {
  const pocketDir = ensurePocket(options);

  const auto = !!options.auto;
  const dryRun = !!options['dry-run'];
  const lastN = options['last-n'] ? parseInt(options['last-n'], 10) : 5;

  const result = syncPocket(pocketDir, { auto, dryRun, lastN });

  // 跳过场景（非 git / 缺 log.md / git 出错）
  if (result.skipped) {
    if (result.isGit === false) {
      console.log(colorize('\n  ℹ️  sync skipped:', 'cyan') + ' not a git repository');
      return;
    }
    if (result.reason && result.reason.startsWith('log.md missing')) {
      console.error(colorize('\n  ❌ Error:', 'red') + ' ' + result.reason);
      process.exit(1);
    }
    console.error(colorize('\n  ❌ Error:', 'red') + ' ' + (result.reason || 'sync failed'));
    process.exit(1);
  }

  // git 检测本身出错
  if (result.error && !result.filled) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' ' + result.error);
    process.exit(1);
  }

  // 干净：无漏记
  if (result.clean) {
    if (options.quiet) {
      console.log(`  ✅ no unrecorded changes (${result.changedCount} staged, all logged)`);
    } else {
      console.log('');
      console.log(colorize('  ✅ No unrecorded changes', 'green'));
      console.log(`     ${result.changedCount} staged file(s), all covered by recent T-blocks (T${result.latestT}).`);
      console.log('');
    }
    return;
  }

  const listFiles = (arr) => arr.map(c => `     ${c.path}`).join('\n');

  if (result.dryRun) {
    console.log('');
    console.log(colorize('  📋 sync plan (dry-run):', 'bold'));
    console.log(`     ${result.unrecorded.length} staged file(s) not recorded in recent T-blocks:`);
    console.log(listFiles(result.unrecorded));
    console.log(`     Would auto-record T${result.nextT} with tag [auto]`);
    console.log('');
    console.log(colorize('  (dry-run: no files were modified)', 'dim'));
    console.log('');
    return;
  }

  if (result.auto && result.filled) {
    console.log('');
    console.log(colorize('  ✅ Auto-recorded unlogged changes', 'green'));
    console.log(`     Added T${result.tId} [auto] covering ${result.unrecorded.length} staged file(s):`);
    console.log(listFiles(result.unrecorded));
    console.log('');
    console.log(colorize('  Review the auto T-block and expand with real details if needed.', 'dim'));
    console.log('');
    return;
  }

  // 默认（report-only）：提示漏记，不写入
  console.log('');
  console.log(colorize('  ⚠️  Unrecorded staged changes detected', 'yellow'));
  console.log(`     ${result.unrecorded.length} staged file(s) not covered by recent T-blocks (T${result.latestT}):`);
  console.log(listFiles(result.unrecorded));
  console.log('');
  console.log('     Run "context-pocket sync --auto" to auto-record them,');
  console.log('     or record manually before committing. (Use --quiet to stay silent.)');
  console.log('');
}

// ============================================================
// 命令：status
// ============================================================

function cmdStatus(options) {
  const pocketDir = ensurePocket(options);
  const config = readConfig(pocketDir);
  const data = parseAll(pocketDir);

  console.log(formatStatus(data, config));
}

// ============================================================
// 命令：recall
// ============================================================

function cmdRecall(options, positional) {
  const pocketDir = ensurePocket(options);
  const tIdStr = positional[0] || options.id;

  if (!tIdStr) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' T-id is required');
    console.error('     Usage: context-pocket recall <T-id>\n');
    process.exit(1);
  }

  const tId = parseInt(tIdStr.replace(/^T/i, ''), 10);
  if (isNaN(tId) || tId <= 0) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' Invalid T-id: ' + tIdStr);
    process.exit(1);
  }

  const result = recall(pocketDir, tId);
  if (!result) {
    console.error(colorize('\n  ❌ Error:', 'red') + ` T${tId} not found\n`);
    process.exit(1);
  }

  console.log('');
  console.log(colorize(`  T${result.id} · ${result.gist}`, 'bold'));
  if (result.tags && result.tags.length > 0) {
    console.log('  ' + result.tags.map(t => colorize(`[${t}]`, 'cyan')).join(' '));
  }
  if (result.session) {
    console.log(colorize(`  Session: ${result.session}`, 'dim'));
  }
  console.log('  ' + colorize('─'.repeat(40), 'dim'));

  if (result.rawText) {
    // 输出原始内容，去掉第一行标题
    const lines = result.rawText.split('\n');
    for (let i = 1; i < lines.length; i++) {
      console.log('  ' + lines[i]);
    }
  } else {
    // 从解析的数据构建输出
    for (const [section, items] of Object.entries(result.sections)) {
      console.log(`  ### ${section}`);
      for (const item of items) {
        console.log(`  - ${item}`);
      }
      console.log('');
    }
  }
  console.log('');
}

// ============================================================
// 命令：diff
// ============================================================

function cmdDiff(options, positional) {
  const pocketDir = ensurePocket(options);
  const tAStr = positional[0];
  const tBStr = positional[1];

  if (!tAStr || !tBStr) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' Two T-ids are required');
    console.error('     Usage: context-pocket diff <T-a> <T-b>\n');
    process.exit(1);
  }

  const tA = parseInt(tAStr.replace(/^T/i, ''), 10);
  const tB = parseInt(tBStr.replace(/^T/i, ''), 10);

  try {
    const result = diff(pocketDir, tA, tB);

    console.log('');
    console.log(colorize(`  Diff: T${result.tA} → T${result.tB}`, 'bold'));
    console.log(colorize(`  ${result.gistA} → ${result.gistB}`, 'dim'));
    console.log('  ' + colorize('─'.repeat(40), 'dim'));

    // 需求变化
    console.log(`  ${colorize('📋 Requirements:', 'bold')}`);
    if (result.requirements.added.length === 0 &&
        result.requirements.completed.length === 0 &&
        result.requirements.cancelled.length === 0) {
      console.log('     (no changes)');
    } else {
      for (const r of result.requirements.added) {
        console.log(`     ${colorize('+', 'green')} R${r.id}: ${r.text} (opened T${r.openedAt})`);
      }
      for (const r of result.requirements.completed) {
        console.log(`     ${colorize('✓', 'green')} R${r.id}: ${r.text} (completed T${r.completedAt})`);
      }
      for (const r of result.requirements.cancelled) {
        console.log(`     ${colorize('✗', 'red')} R${r.id}: ${r.text} (cancelled T${r.cancelledAt})`);
      }
    }
    console.log('');

    // 决策变化
    console.log(`  ${colorize('🧠 Decisions:', 'bold')}`);
    if (result.decisions.added.length === 0) {
      console.log('     (no new ADRs)');
    } else {
      for (const adr of result.decisions.added) {
        console.log(`     ${colorize('+', 'green')} ADR-${adr.id}: ${adr.title} (T${adr.createdAt})`);
      }
    }
    console.log('');

    // 文件变化
    console.log(`  ${colorize('📁 Files:', 'bold')}`);
    if (result.files.added.length === 0 &&
        result.files.removed.length === 0 &&
        result.files.modified.length === 0) {
      console.log('     (no file changes detected)');
    } else {
      for (const f of result.files.added) {
        console.log(`     ${colorize('+', 'green')} ${f}`);
      }
      for (const f of result.files.removed) {
        console.log(`     ${colorize('-', 'red')} ${f}`);
      }
      for (const f of result.files.modified) {
        console.log(`     ${colorize('~', 'yellow')} ${f}`);
      }
    }
    console.log('');
  } catch (e) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' ' + e.message);
    console.error('');
    process.exit(1);
  }
}

// ============================================================
// 命令：search
// ============================================================

function cmdSearch(options, positional) {
  const pocketDir = ensurePocket(options);
  const keyword = positional[0] || options.keyword;

  if (!keyword) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' keyword is required');
    console.error('     Usage: context-pocket search <keyword>\n');
    process.exit(1);
  }

  // 优先走倒排索引（历史增长后依然即时）；--no-index 或索引不可用时回退全量扫描
  let results = null;
  if (!options['no-index']) {
    results = searchWithIndex(pocketDir, keyword);
  }
  if (results === null) {
    results = search(pocketDir, keyword);
  }

  console.log('');
  console.log(colorize(`  Search: "${keyword}"`, 'bold'));
  console.log(`  ${results.length} match${results.length !== 1 ? 'es' : ''} found`);
  console.log('  ' + colorize('─'.repeat(40), 'dim'));

  if (results.length === 0) {
    console.log('  (no matches)');
  } else {
    for (const r of results) {
      const printHighlights = (r) => {
        if (r.highlights && r.highlights.length > 0) {
          for (const h of r.highlights.slice(0, 3)) {
            const snippet = h.text.length > 60 ? h.text.slice(0, 60) + '...' : h.text;
            console.log(colorize(`     ↳ [${h.field}] ${snippet}`, 'dim'));
          }
        }
      };

      if (r.type === 'ADR') {
        console.log(`  ${colorize('ADR-' + r.adrId, 'bold')} · ${r.title}`);
        printHighlights(r);
      } else if (r.type === 'R') {
        const flag = r.uncertain ? ' ❓' : '';
        console.log(`  ${colorize('R' + r.rId, 'bold')} (${r.status})${flag} · ${r.text}`);
        printHighlights(r);
      } else if (r.type === 'pref') {
        console.log(`  ${colorize('pref', 'bold')} · ${r.line}`);
        printHighlights(r);
      } else {
        const tagsStr = r.tags && r.tags.length > 0
          ? ' ' + r.tags.map(t => colorize(`[${t}]`, 'cyan')).join('')
          : '';
        console.log(`  ${colorize('T' + r.id, 'bold')}${tagsStr} · ${r.gist}`);
        printHighlights(r);
      }
    }
  }
  console.log('');
}

// ============================================================
// 命令：why — 反向检索：哪些 T-block 提到这个文件
// ============================================================

function cmdWhy(options, positional) {
  const pocketDir = ensurePocket(options);
  const filePath = positional[0] || options.file;

  if (!filePath) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' file path is required');
    console.error('     Usage: context-pocket why <file-path> [--limit <N>]\n');
    console.error('     Example: context-pocket why lib/parser.js\n');
    process.exit(1);
  }

  const limit = parseInt(options.limit, 10) || 10;
  const results = why(pocketDir, filePath, { limit });

  console.log('');
  console.log(colorize(`  Why: "${filePath}"`, 'bold'));
  console.log(`  ${results.length} T-block${results.length !== 1 ? 's' : ''} referenced this file`);
  console.log('  ' + colorize('─'.repeat(40), 'dim'));

  if (results.length === 0) {
    console.log('  (no references found)');
  } else {
    for (const r of results) {
      const tagsStr = r.tags.length > 0
        ? ' ' + r.tags.map(t => colorize(`[${t}]`, 'cyan')).join('')
        : '';
      console.log(`  ${colorize('T' + r.id, 'bold')}${tagsStr} · ${r.gist}`);
      for (const ref of r.references.slice(0, 3)) {
        const snippet = ref.text.length > 60 ? ref.text.slice(0, 60) + '...' : ref.text;
        console.log(colorize(`     ↳ [${ref.section}] ${snippet}`, 'dim'));
      }
    }
  }
  console.log('');
}

// ============================================================
// 命令：check-conflicts
// ============================================================

function cmdCheckConflicts(options) {
  const pocketDir = ensurePocket(options);
  const result = checkConflicts(pocketDir);

  console.log('');
  console.log(colorize('  ContextPocket · Conflict Scan', 'bold'));
  console.log('  ' + colorize('─'.repeat(40), 'dim'));
  console.log(`  ${colorize('🔴 critical:', 'red')} ${result.criticalCount}`);
  console.log(`  ${colorize('🟡 warning:', 'yellow')} ${result.warningCount}`);
  console.log(`  ${colorize('🔵 info:', 'cyan')} ${result.infoCount}`);
  console.log('');

  for (const cat of result.categories) {
    const hasCritical = cat.items.some(i => i.severity === 'critical');
    const hasWarning = cat.items.some(i => i.severity === 'warning');
    const icon = hasCritical ? '🔴' : hasWarning ? '🟡' : '🟢';

    console.log(`  ${icon} ${colorize(cat.name, 'bold')}`);
    for (const item of cat.items) {
      const sevIcon = item.severity === 'critical' ? '🔴'
        : item.severity === 'warning' ? '🟡' : '🔵';
      console.log(`     ${sevIcon} ${item.message}`);
      if (item.detail) {
        const detailLines = item.detail.split('\n');
        for (const dl of detailLines) {
          console.log(colorize(`        ${dl}`, 'dim'));
        }
      }
    }
    console.log('');
  }

  if (result.criticalCount > 0) {
    process.exit(1);
  }
}

// ============================================================
// 命令：log append
// ============================================================

function cmdLogAppend(options) {
  const pocketDir = ensurePocket(options);

  if (!options.gist) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' --gist is required');
    console.error('     Usage: context-pocket log append --gist "one-line summary"\n');
    process.exit(1);
  }

  const result = appendLogBlock(pocketDir, {
    gist: options.gist,
    tags: splitCsv(options.tags),
    user: options.user ? [options.user] : [],
    action: options.action ? [options.action] : [],
    commits: splitCsv(options.commits),
    decisions: options.decisions ? [options.decisions] : [],
    pitfalls: options.pitfalls ? [options.pitfalls] : [],
    preferences: options.preferences ? [options.preferences] : [],
    conflicts: options.conflicts ? [options.conflicts] : [],
    attachments: options.attachments ? [options.attachments] : [],
    uncertain: options.uncertain ? [options.uncertain] : [],
  });

  console.log(`\n  ✅ T${result.tId} added: ${options.gist}\n`);

  // 副作用：更新 hub 活跃信息 + 刷新搜索索引（都 best-effort，不阻断记录）
  try {
    touchProject(getProjectRoot(pocketDir), { latestT: result.tId, gist: options.gist });
  } catch (e) { /* hub 不可用 */ }
  if (!options['no-index']) {
    try {
      buildIndex(pocketDir, {});
    } catch (e) { /* 索引在下次 search 时懒刷新 */ }
  }

  if (options.verify) {
    const verifyResult = verify(pocketDir);
    if (verifyResult.errorCount > 0) {
      console.log(colorize('  ⚠️  Verification found errors:\n', 'yellow'));
      console.log(formatVerifyResult(verifyResult, { quiet: true }));
      process.exit(1);
    }
  }
}

// ============================================================
// 命令：req add
// ============================================================

function cmdReqAdd(options, positional) {
  const pocketDir = ensurePocket(options);

  const text = positional[0] || options.text;
  if (!text) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' requirement text is required');
    console.error('     Usage: context-pocket req add "requirement text"\n');
    process.exit(1);
  }

  const result = addRequirement(pocketDir, {
    text,
    tags: splitCsv(options.tags),
    status: options.status || 'Open',
    uncertain: !!options.uncertain,
    impl: splitCsv(options.impl),
  });

  const prefix = options.uncertain ? '❓ ' : '';
  console.log(`\n  ✅ ${prefix}R${result.rId} added: ${text}\n`);
}

// ============================================================
// 命令：decision add
// ============================================================

function cmdDecisionAdd(options) {
  const pocketDir = ensurePocket(options);

  if (!options.title) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' --title is required');
    console.error('     Usage: context-pocket decision add --title "Use X over Y"');
    console.error('            --context "..." --options "..." --decision "..."\n');
    process.exit(1);
  }

  const result = addDecision(pocketDir, {
    title: options.title,
    context: options.context || '',
    options: options.options || '',
    decision: options.decision || '',
    consequences: options.consequences || '',
    supersedes: options.supersedes || 'none',
  });

  console.log(`\n  ✅ ADR-${result.adrId} added: ${options.title}\n`);
}

// ============================================================
// 命令：handoff
// ============================================================

function cmdHandoff(options) {
  const pocketDir = ensurePocket(options);

  const result = generateHandoff(pocketDir);

  console.log(`\n  ✅ Handoff generated: T${result.tId} · ${result.date}`);
  console.log(`     File: ContextPocket/handoff.md\n`);
}

// ============================================================
// 命令：archive
// ============================================================

function cmdArchive(options) {
  const pocketDir = ensurePocket(options);

  const keepLast = options['keep-last'] ? parseInt(options['keep-last'], 10) : 20;
  const dryRun = !!options['dry-run'];

  try {
    const result = archiveLog(pocketDir, { keepLast, dryRun });

    console.log('');
    if (result.skipped) {
      console.log(colorize('  ℹ️  Archive skipped:', 'cyan'));
      console.log(`     ${result.reason}`);
      console.log('');
      return;
    }

    if (dryRun) {
      console.log(colorize('  📋 Archive plan (dry-run):', 'bold'));
    } else {
      console.log(colorize('  ✅ Archive completed!', 'green'));
    }

    console.log(`     Archived: ${result.archivedCount} blocks (T${result.firstArchivedId}–T${result.lastArchivedId})`);
    console.log(`     Kept: ${result.keptCount} blocks (T${result.firstKeptId}–T${result.lastKeptId})`);
    console.log('');

    if (result.summary.length > 0) {
      console.log(colorize('  Archive summary:', 'bold'));
      for (const line of result.summary) {
        console.log(`     ${line}`);
      }
      console.log('');
    }

    // 归档改变了 T-block 分布 → 静默刷新索引
    if (!dryRun) {
      try {
        buildIndex(pocketDir, {});
      } catch (e) { /* 索引在下次 search 时懒刷新 */ }
    }

    if (dryRun) {
      console.log(colorize('  (dry-run: no files were modified)', 'dim'));
      console.log('');
    }
  } catch (e) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' ' + e.message);
    console.error('');
    process.exit(1);
  }
}

// ============================================================
// 命令：state update
// ============================================================

function cmdStateUpdate(options) {
  const pocketDir = ensurePocket(options);

  const hasSummary = options.summary !== undefined;
  const hasNextStep = options['next-step'] !== undefined;
  const hasPitfall = options.pitfall !== undefined;

  if (!hasSummary && !hasNextStep && !hasPitfall) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' At least one option is required');
    console.error('     Usage: context-pocket state update [--summary "..."] [--next-step "..."] [--pitfall "..."]');
    console.error('');
    process.exit(1);
  }

  const result = updateState(pocketDir, {
    summary: options.summary,
    appendSummary: !!options['append-summary'],
    nextStep: options['next-step'],
    pitfall: options.pitfall,
  });

  console.log('');
  console.log(colorize('  ✅ state.md updated', 'green'));
  console.log(`     Updated fields: ${result.updatedFields.join(', ')}`);
  console.log(`     Latest T: T${result.latestT}`);
  console.log('');
}

// ============================================================
// 命令：preferences update
// ============================================================

function cmdPreferencesUpdate(options) {
  const pocketDir = ensurePocket(options);

  if (!options.key) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' --key is required');
    console.error('     Usage: context-pocket preferences update --key "..." --value "..."\n');
    process.exit(1);
  }

  if (options.value === undefined) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' --value is required');
    console.error('     Usage: context-pocket preferences update --key "..." --value "..."\n');
    process.exit(1);
  }

  const result = updatePreferences(pocketDir, {
    key: options.key,
    value: options.value,
  });

  console.log('');
  const action = result.isNew ? 'added' : 'updated';
  console.log(colorize(`  ✅ Preference ${action}:`, 'green'));
  console.log(`     ${result.key}: ${result.value}`);
  console.log(`     Latest T: T${result.latestT}`);
  console.log('');
}

// ============================================================
// 命令：code-map update
// ============================================================

function cmdCodeMapUpdate(options) {
  const pocketDir = ensurePocket(options);

  try {
    const result = updateCodeMap(pocketDir);

    console.log('');
    console.log(colorize('  ✅ code-map.md updated', 'green'));
    console.log(`     Added: ${result.addedCount} files`);
    console.log(`     Removed: ${result.removedCount} files`);
    console.log(`     Existing: ${result.existingCount} files`);
    console.log('');

    if (result.added.length > 0) {
      console.log(colorize('  New files (⚠️ add descriptions):', 'yellow'));
      for (const f of result.added.slice(0, 10)) {
        console.log(`     + ${f}`);
      }
      if (result.added.length > 10) {
        console.log(colorize(`     ... and ${result.added.length - 10} more`, 'dim'));
      }
      console.log('');
    }
  } catch (e) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' ' + e.message);
    console.error('');
    process.exit(1);
  }
}

// ============================================================
// 命令：migrate
// ============================================================

function cmdMigrate(options) {
  const pocketDir = ensurePocket(options);

  const dryRun = !!options['dry-run'];
  const targetVersion = options.to;

  // 只列出版本信息
  if (options.list || options['list-only']) {
    const info = listMigrations(pocketDir, targetVersion);
    console.log('');
    console.log(colorize('  ContextPocket · Migration', 'bold'));
    console.log('  ' + colorize('─'.repeat(40), 'dim'));
    console.log(`  Current version: ${info.currentVersion || '(unknown)'}`);
    console.log(`  Target version: ${info.targetVersion}`);
    console.log(`  Status: ${info.isLatest ? colorize('up to date', 'green') : colorize('upgrade available', 'yellow')}`);
    console.log('');

    if (info.path.length > 0 && !info.isLatest) {
      console.log(colorize('  Migration path:', 'bold'));
      for (const step of info.path) {
        console.log(`     ${step.from} → ${step.to}: ${step.name}`);
      }
      console.log('');
    }
    return;
  }

  try {
    const result = runMigration(pocketDir, {
      to: targetVersion,
      dryRun,
    });

    console.log('');
    if (result.skipped) {
      console.log(colorize('  ℹ️  Migration skipped:', 'cyan'));
      console.log(`     ${result.reason}`);
      console.log('');
      return;
    }

    if (dryRun) {
      console.log(colorize('  📋 Migration plan (dry-run):', 'bold'));
      console.log(`     From: ${result.fromVersion}`);
      console.log(`     To: ${result.toVersion}`);
      console.log(`     Steps: ${result.planned.length}`);
      for (const step of result.planned) {
        console.log(`       ${step.from} → ${step.to}: ${step.name}`);
      }
      console.log('');
      console.log(colorize('  (dry-run: no files were modified)', 'dim'));
      console.log('');
    } else {
      console.log(colorize('  ✅ Migration complete!', 'green'));
      console.log(`     From: ${result.fromVersion} → To: ${result.toVersion}`);
      console.log(`     Steps executed: ${result.steps.length}`);
      console.log(`     Backup: ${result.backupPath}`);
      console.log('');
    }
  } catch (e) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' ' + e.message);
    console.error('');
    process.exit(1);
  }
}

// ============================================================
// 命令：install-hook
// ============================================================

function cmdInstallHook(options) {
  const projectDir = getProjectDir(options);

  try {
    const result = installPreCommitHook(projectDir);

    console.log('');
    if (result.action === 'created') {
      console.log(colorize('  ✅ Pre-commit hook installed', 'green'));
    } else if (result.action === 'appended') {
      console.log(colorize('  ✅ Pre-commit hook appended to existing hook', 'green'));
    } else if (result.action === 'upgraded') {
      console.log(colorize('  ✅ Pre-commit hook upgraded to v2 (sync + verify)', 'green'));
    } else if (result.action === 'already-installed') {
      console.log(colorize('  ℹ️  Pre-commit hook already installed', 'cyan'));
    }
    console.log(`     Hook path: ${result.hookPath}`);
    console.log('');
    console.log('  Before each commit the hook will:');
    console.log('    1. run "context-pocket sync --auto" — auto-record staged files that');
    console.log('       were missed in recent T-blocks (git safety net for agent forgets)');
    console.log('    2. run "context-pocket verify --quiet" — block on errors, allow warnings');
    console.log('');
    console.log('  Run "context-pocket install-hook" again anytime to upgrade the hook.');
    console.log('');
  } catch (e) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' ' + e.message);
    console.error('');
    process.exit(1);
  }
}

// ============================================================
// 命令：uninstall-hook
// ============================================================

function cmdUninstallHook(options) {
  const projectDir = getProjectDir(options);

  try {
    const result = uninstallPreCommitHook(projectDir);

    console.log('');
    switch (result.action) {
      case 'deleted':
        console.log(colorize('  ✅ Pre-commit hook removed', 'green'));
        break;
      case 'removed-section':
        console.log(colorize('  ✅ ContextPocket section removed from pre-commit hook', 'green'));
        break;
      case 'not-found':
        console.log(colorize('  ℹ️  No pre-commit hook found', 'cyan'));
        break;
      case 'not-installed':
        console.log(colorize('  ℹ️  ContextPocket hook not found in pre-commit', 'cyan'));
        break;
    }
    console.log(`     Hook path: ${result.hookPath}`);
    console.log('');
  } catch (e) {
    console.error(colorize('\n  ❌ Error:', 'red') + ' ' + e.message);
    console.error('');
    process.exit(1);
  }
}

// ============================================================
// 命令：index — 构建/刷新搜索索引
// ============================================================

function cmdIndex(options) {
  const pocketDir = ensurePocket(options);
  const rebuild = !!options.rebuild;

  const result = buildIndex(pocketDir, { rebuild });

  console.log('');
  console.log(colorize(`  ✅ Search index ${result.rebuilt ? 'built' : 'refreshed'}`, 'green'));
  console.log(`     Docs indexed: ${result.docsCount} (T-blocks + ADRs + reqs + prefs)`);
  console.log(`     Terms: ${result.termsCount}`);
  if (!result.rebuilt) {
    console.log(`     Delta: +${result.added} added · ~${result.updated} updated · -${result.removed} removed · ${result.reused} reused`);
  }
  console.log(`     Took: ${result.tookMs}ms`);
  console.log(`     File: ${path.relative(process.cwd(), result.path) || result.path}`);
  console.log('');
  console.log(colorize('  Markdown files remain the single source of truth —', 'dim'));
  console.log(colorize('  the index is a derived cache you can rebuild anytime.', 'dim'));
  console.log('');
}

// ============================================================
// 命令：distill — 旧信息蒸馏
// ============================================================

function cmdDistill(options) {
  const pocketDir = ensurePocket(options);
  const dryRun = !!options['dry-run'];

  const result = distill(pocketDir, { dryRun });

  console.log('');
  if (result.nothing) {
    console.log(colorize('  ℹ️  Nothing to distill yet:', 'cyan'));
    console.log('     No log-archive.md and no old turns in log.md.');
    console.log('     Distill becomes useful after /archive moves old T-blocks out.');
    console.log('');
    return;
  }

  console.log(colorize(`  📦 Distill scan: T${result.tRange.min}–T${result.tRange.max} (${result.scannedBlocks} blocks)`, 'bold'));
  console.log('  ' + colorize('─'.repeat(40), 'dim'));
  console.log(`     Candidate decisions  (→ decisions.md):  ${result.candidates.decisions.length}`);
  console.log(`     Candidate pitfalls   (→ state.md):      ${result.candidates.pitfalls.length}`);
  console.log(`     Candidate preferences(→ preferences.md):${result.candidates.preferences.length}`);
  console.log(`     Open ❓ in archive   (→ confirm):       ${result.candidates.uncertain.length}`);

  if (dryRun) {
    console.log('');
    console.log(colorize('  (dry-run: no report file written — rerun without --dry-run to save)', 'dim'));
    console.log('');
    return;
  }

  console.log('');
  console.log(colorize('  ✅ Digest report generated', 'green'));
  console.log(`     File: ContextPocket/${path.basename(result.outFile)}`);
  console.log('');
  console.log('  Next: review the report, merge still-valid items into the living docs');
  console.log('  (decisions.md / state.md / preferences.md) with their T references,');
  console.log('  then delete the report. In agent mode, just say: /digest');
  console.log('');
}

// ============================================================
// 命令：import — 历史会话导入
// ============================================================

function cmdImport(options) {
  const pocketDir = ensurePocket(options);
  const dryRun = !!options['dry-run'];
  const limit = options.limit ? parseInt(options.limit, 10) : 100;
  const truncate = options.truncate ? parseInt(options.truncate, 10) : 400;

  const result = importSession(pocketDir, {
    file: options.file || options.f,
    source: options.source || 'auto',
    limit,
    truncate,
    dryRun,
  });

  console.log('');
  if (result.dryRun) {
    console.log(colorize(`  📋 Import plan (dry-run): ${result.plannedTurns} turn(s) from ${result.source} session`, 'bold'));
    for (const p of result.preview) {
      console.log(`     ${p.ts ? colorize('[' + p.ts + ']', 'dim') : ''} ${p.gist}`);
    }
    console.log('');
    console.log(colorize('  (dry-run: nothing written — rerun without --dry-run to import)', 'dim'));
    console.log('');
    return;
  }

  if (result.imported === 0) {
    console.log(colorize('  ℹ️  No importable turns found in this session file.', 'cyan'));
    console.log('     Supported: claude-code / codex session JSONL (source auto-detected).');
    console.log('');
    return;
  }

  console.log(colorize('  ✅ Session imported', 'green'));
  console.log(`     Source: ${result.source}`);
  console.log(`     Turns:  ${result.imported} (T${result.tStart}–T${result.tEnd}, tagged [imported])`);
  console.log('');
  console.log('  Imported blocks are conversation backfill — skim them with');
  console.log('  "context-pocket recall" and enrich gists where needed.');
  console.log('');
}

// ============================================================
// 命令：hub — 用户级跨项目注册表 + 全局偏好
// ============================================================

function cmdHub(options, positional) {
  const action = positional[0] || 'list';

  // hub pref — 全局偏好
  if (action === 'pref' || action === 'prefs') {
    if (options.list || (!options.key && positional[1] === 'list')) {
      const prefs = getGlobalPref();
      const entries = Object.entries(prefs || {});
      console.log('');
      console.log(colorize(`  Global preferences · ${getHubFile()}`, 'bold'));
      console.log('  ' + colorize('─'.repeat(40), 'dim'));
      if (entries.length === 0) {
        console.log('  (none — set with: context-pocket hub pref --key "k" --value "v")');
      } else {
        for (const [k, v] of entries) {
          console.log(`  ${colorize(k, 'cyan')}: ${v}`);
        }
      }
      console.log('');
      return;
    }

    if (!options.key) {
      console.error(colorize('\n  ❌ Error:', 'red') + ' --key is required');
      console.error('     Usage: context-pocket hub pref --key "<k>" --value "<v>"   (set)');
      console.error('            context-pocket hub pref --key "<k>"                 (get)');
      console.error('            context-pocket hub pref --list                      (all)\n');
      process.exit(1);
    }

    if (options.value === undefined) {
      const v = getGlobalPref(options.key);
      console.log('');
      console.log(v === null
        ? colorize(`  (no global pref "${options.key}")`, 'dim')
        : `  ${options.key}: ${v}`);
      console.log('');
      return;
    }

    const r = setGlobalPref(options.key, options.value);
    console.log('');
    console.log(colorize(`  ✅ Global preference ${r.isNew ? 'added' : 'updated'}:`, 'green'));
    console.log(`     ${options.key}: ${options.value}`);
    console.log(`     Stored in: ${getHubFile()}`);
    console.log('');
    return;
  }

  // hub remove — 从注册表移除项目
  if (action === 'remove' || action === 'rm') {
    const projectDir = getProjectDir(options);
    const removed = removeProject(projectDir);
    console.log('');
    console.log(removed
      ? colorize(`  ✅ Removed from hub: ${projectDir}`, 'green')
      : colorize(`  ℹ️  Not registered in hub: ${projectDir}`, 'cyan'));
    console.log(colorize('  (project ContextPocket/ data untouched)', 'dim'));
    console.log('');
    return;
  }

  // hub list（默认）
  const projects = listProjects();
  console.log('');
  console.log(colorize(`  ContextPocket Hub · ${projects.length} project(s) · ${getHubDir()}`, 'bold'));
  console.log('  ' + colorize('─'.repeat(60), 'dim'));
  if (projects.length === 0) {
    console.log('  (no projects registered — run "context-pocket bootstrap" in a project)');
  } else {
    for (const { key, project } of projects) {
      const active = (project.lastActiveAt || '').slice(0, 10);
      console.log(`  ${colorize(project.name || '?', 'bold')}  ${colorize('T' + (project.latestT || 0), 'cyan')} · ${project.projectType || '?'} · last active ${active}`);
      console.log(colorize(`    ${key}`, 'dim'));
    }
  }
  console.log('');
  console.log(colorize('  Multi-machine: point CONTEXTPOCKET_HOME at a synced folder (cloud drive / git repo),', 'dim'));
  console.log(colorize('  or commit ContextPocket/ per project (config gitignore: false).', 'dim'));
  console.log('');
}

// ============================================================
// 主入口
// ============================================================

function main() {
  const args = parseArgs(process.argv);
  const cmd = args.command || 'help';
  const sub = args.subcommand;

  // help
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    cmdHelp();
    return;
  }

  // bootstrap
  if (cmd === 'bootstrap') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket bootstrap [options]

  Initialize ContextPocket/ directory with template files.

  Options:
    --project-type <type>  Project type: frontend/backend/fullstack/data/mobile
                           (auto-detected if not specified)
    --mode <full|lite>     full = all 10 core files; lite = 5 core files (default: full)
    --language <zh|en>     Default language for tags and prompts (default: zh)
    --gitignore <bool>     true = ignore ContextPocket/ in .gitignore (default);
                           false = commit ContextPocket/ (sync across machines via git)
    --dir <path>           Project directory (default: cwd)
`);
      return;
    }
    cmdBootstrap(args.options);
    return;
  }

  // verify
  if (cmd === 'verify') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket verify [options]

  Run health check on ContextPocket/. Checks file existence, ID continuity,
  reference integrity, code-map drift, handoff staleness, and more.

  Options:
    --quiet             Only show errors and warnings
    --drift             Enable cognition drift check (log.md vs working tree).
                        Inspired by AOCI-CODE's cognition refresh.
                        Note: walks the project tree, slower than default checks.
    --drift-last-n <N>  How many recent T-blocks to compare (default: 5)
    --dir <path>        Project directory
`);
      return;
    }
    cmdVerify(args.options);
    return;
  }

  // sync
  if (cmd === 'sync') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket sync [options]

  Git safety net: detect staged file changes that were NOT recorded in recent
  T-blocks (the "agent forgot to log" case), and optionally auto-record them.

  By default this is report-only (no writes). The pre-commit hook runs
  "context-pocket sync --auto" before "verify" so missed turns get filled.

  Options:
    --auto             Auto-record unlogged staged files as a [auto] T-block
    --dry-run          Show the plan without writing anything
    --last-n <N>       Look back over the last N T-blocks when checking coverage (default: 5)
    --quiet            One-line summary (used by the pre-commit hook)
    --dir <path>       Project directory
`);
      return;
    }
    cmdSync(args.options);
    return;
  }

  // status
  if (cmd === 'status') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket status [options]

  Show current status summary: latest T, requirement counts, decisions, next steps.

  Options:
    --dir <path>   Project directory
`);
      return;
    }
    cmdStatus(args.options);
    return;
  }

  // recall
  if (cmd === 'recall') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket recall <T-id>

  Show full details of a specific T-block.

  Options:
    --dir <path>   Project directory
`);
      return;
    }
    cmdRecall(args.options, args.positional);
    return;
  }

  // diff
  if (cmd === 'diff') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket diff <T-a> <T-b>

  Compare two T-blocks. Shows changes in requirements, decisions (ADRs), and files.

  Options:
    --dir <path>   Project directory
`);
      return;
    }
    cmdDiff(args.options, args.positional);
    return;
  }

  // search
  if (cmd === 'search') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket search <keyword>

  Search all T-blocks by keyword. Searches gist and all section content.

  Options:
    --dir <path>   Project directory
`);
      return;
    }
    cmdSearch(args.options, args.positional);
    return;
  }

  // why — 反向检索：哪些 T-block 提到这个文件
  if (cmd === 'why') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket why <file-path> [--limit <N>]

  Reverse lookup: which T-blocks mentioned this file path?
  Inspired by ThoughtDAG's why_file/why_check tools.

  Searches Action, Changes, Pitfalls, Notes, Commits, User sections.
  Returns most recent matches first.

  Examples:
    context-pocket why lib/parser.js
    context-pocket why CHANGELOG.md --limit 5

  Options:
    --limit <N>     Max T-blocks to return (default: 10)
    --dir <path>    Project directory
`);
      return;
    }
    cmdWhy(args.options, args.positional);
    return;
  }

  // check-conflicts
  if (cmd === 'check-conflicts') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket check-conflicts

  Scan for conflicts across 6 dimensions:
    1. Tech stack   2. Requirements   3. ADRs
    4. Style        5. Deployment     6. 🔒 Absolute

  Severity levels: critical / warning / info

  Options:
    --dir <path>   Project directory
`);
      return;
    }
    cmdCheckConflicts(args.options);
    return;
  }

  // log append
  if (cmd === 'log' && sub === 'append') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket log append --gist <summary> [options]

  Options:
    --gist <text>        One-line summary (required)
    --tags <csv>         Comma-separated tags
    --user <text>        User request text
    --action <text>      Action description
    --commits <csv>      Commit hashes
    --decisions <text>   Decisions & constraints
    --pitfalls <text>    Pitfalls discovered
    --preferences <text> Preferences noted
    --conflicts <text>   Conflicts detected
    --attachments <text> Attachment references
    --uncertain <text>   Uncertain items
    --verify             Run verify after append
    --dir <path>         Project directory
`);
      return;
    }
    cmdLogAppend(args.options);
    return;
  }

  // req add
  if (cmd === 'req' && sub === 'add') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket req add <text> [options]

  Options:
    --tags <csv>         Comma-separated tags
    --status <Open|Done|Cancelled>  Default: Open
    --uncertain          Mark as inferred / unconfirmed (❓)
    --impl <csv>         Comma-separated implementing files
    --dir <path>         Project directory
`);
      return;
    }
    cmdReqAdd(args.options, args.positional);
    return;
  }

  // decision add
  if (cmd === 'decision' && sub === 'add') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket decision add --title <text> [options]

  Options:
    --title <text>       Decision title (required)
    --context <text>     Problem / what was on the table
    --options <text>     Options considered (A / B / C)
    --decision <text>    Chosen option + why
    --consequences <text>  What this locks in
    --supersedes <text>  ADR-x + why, or "none"
    --dir <path>         Project directory
`);
      return;
    }
    cmdDecisionAdd(args.options);
    return;
  }

  // handoff
  if (cmd === 'handoff') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket handoff [options]

  Generate handoff.md — a single-file summary for the next agent to get up to speed.

  Options:
    --dir <path>         Project directory
`);
      return;
    }
    cmdHandoff(args.options);
    return;
  }

  // archive
  if (cmd === 'archive') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket archive [options]

  Archive old T-blocks to log-archive.md.
  Runs verify before and after. Rolls back on failure.

  Options:
    --keep-last <N>      Keep latest N T-blocks in log.md (default: 20)
    --dry-run            Show what would be archived, don't modify files
    --dir <path>         Project directory
`);
      return;
    }
    cmdArchive(args.options);
    return;
  }

  // state update
  if (cmd === 'state' && sub === 'update') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket state update [options]

  Update state.md. Updates the T-number in the header automatically.

  Options:
    --summary <text>     Replace Summary section with this text
    --append-summary     Append to Summary instead of replacing
    --next-step <text>   Append a next step
    --pitfall <text>     Append a pitfall
    --dir <path>         Project directory
`);
      return;
    }
    cmdStateUpdate(args.options);
    return;
  }

  // preferences update (also support "prefs" alias)
  if ((cmd === 'preferences' || cmd === 'prefs') && sub === 'update') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket preferences update --key <k> --value <v>

  Update or add a preference entry. Updates the T-number in the header.

  Options:
    --key <text>         Preference key (e.g. "coding style", "tooling")
    --value <text>       Preference value
    --dir <path>         Project directory
`);
      return;
    }
    cmdPreferencesUpdate(args.options);
    return;
  }

  // code-map update
  if ((cmd === 'code-map' || cmd === 'codemap') && sub === 'update') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket code-map update [options]

  Rescan project directory and update code-map.md.
  Preserves existing descriptions; marks new files as TODO.

  Options:
    --dir <path>         Project directory
`);
      return;
    }
    cmdCodeMapUpdate(args.options);
    return;
  }

  // migrate
  if (cmd === 'migrate') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket migrate [options]

  Migrate ContextPocket data format to a new version.
  Auto-backs up before migrating. Rolls back on failure.

  Options:
    --to <version>       Target version (default: latest)
    --dry-run            Show migration plan, don't modify files
    --list               List available migrations without executing
    --dir <path>         Project directory
`);
      return;
    }
    cmdMigrate(args.options);
    return;
  }

  // install-hook
  if (cmd === 'install-hook') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket install-hook [options]

  Install (or upgrade) a git pre-commit hook that runs, before each commit:
    1. context-pocket sync --auto    — auto-record staged files missed in recent
                                        T-blocks (git safety net for agent forgets)
    2. context-pocket verify --quiet — block commit on errors; warnings allowed

  Re-running this command refreshes the managed section (upgrades v1 → v2 and
  updates the CLI path). If a pre-commit hook with other content exists, the
  ContextPocket section is appended/replaced, leaving the rest intact.

  Options:
    --dir <path>         Project directory
`);
      return;
    }
    cmdInstallHook(args.options);
    return;
  }

  // uninstall-hook
  if (cmd === 'uninstall-hook') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket uninstall-hook [options]

  Uninstall the ContextPocket pre-commit hook (sync + verify).
  If other hook content exists, only removes the managed ContextPocket section.

  Options:
    --dir <path>         Project directory
`);
      return;
    }
    cmdUninstallHook(args.options);
    return;
  }

  // index — 搜索索引
  if (cmd === 'index') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket index [--rebuild]

  Build or refresh the derived search index over your ContextPocket
  (T-blocks from log.md + log-archive.md, ADRs, requirements, preferences).

  The index lives in ContextPocket/assets/search-index.json and is a cache:
  markdown files remain the single source of truth. search auto-refreshes
  it when sources change, so you rarely need to run this manually.

  Options:
    --rebuild       Ignore the existing index and rebuild from scratch
    --dir <path>    Project directory
`);
      return;
    }
    cmdIndex(args.options);
    return;
  }

  // distill — 旧信息蒸馏
  if (cmd === 'distill') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket distill [--dry-run] [--recent-keep <N>]

  Scan log-archive.md (plus old turns in log.md) and extract content worth
  promoting back into the living docs: decisions, pitfalls, preferences and
  open ❓ items. Writes a digest report ContextPocket/digest-<date>.md;
  the agent merges still-valid items into decisions.md / state.md /
  preferences.md, then deletes the report.

  Options:
    --dry-run         Report counts only, don't write the digest file
    --recent-keep <N> Override how many recent T-blocks count as "new"
    --dir <path>      Project directory
`);
      return;
    }
    cmdDistill(args.options);
    return;
  }

  // import — 历史会话导入
  if (cmd === 'import') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket import --file <session.jsonl> [options]

  Import past agent conversation sessions as [imported] T-blocks.
  Turns continue from the current latest T number. Useful when enabling
  ContextPocket on a project that already has agent history.

  Supported sources (auto-detected):
    claude-code   ~/.claude/projects/<project>/<session>.jsonl
    codex         ~/.codex/sessions/**/*.jsonl

  Options:
    --file <path>     Session JSONL file (required)
    --source <name>   claude-code / codex / auto (default: auto)
    --limit <N>       Max turns to import (default: 100)
    --truncate <N>    Max chars per field (default: 400)
    --dry-run         Show what would be imported, don't write
    --dir <path>      Project directory
`);
      return;
    }
    cmdImport(args.options);
    return;
  }

  // hub — 用户级注册表 + 全局偏好
  if (cmd === 'hub') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket hub [list|pref|remove] [options]

  User-level memory hub at ~/.contextpocket/hub.json (redirect the folder
  with the CONTEXTPOCKET_HOME env var to share it across machines).

  Subcommands:
    (default) / list    List registered projects with latest T + last activity
    pref --key <k> --value <v>   Set a global preference (cross-project)
    pref --key <k>               Read one global preference
    pref --list                  List all global preferences
    remove [--dir <path>]        Unregister a project (pocket data untouched)

  Global prefs are the fallback when a project's preferences.md has no
  matching entry — they follow you across projects.
`);
      return;
    }
    cmdHub(args.options, args.positional);
    return;
  }

  console.error(colorize('\n  ❌ Unknown command:', 'red') + ' ' + cmd + (sub ? ' ' + sub : ''));
  console.error('     Run "context-pocket help" for available commands.\n');
  process.exit(1);
}

main();
