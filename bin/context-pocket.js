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
 *   context-pocket log amend <T-id> --user "..." [--action "..."]
 *   context-pocket absolute add --text "..." [--gist "..."]
 *   context-pocket req add "text" [--tags "a,b"] [--uncertain] [--impl "file1,file2"]
 *   context-pocket decision add --title "..." --context "..." --options "..." --decision "..."
 *   context-pocket archive [--keep-last <N>] [--dry-run]
 *   context-pocket repair [--dry-run] [--apply-refs] [--author <text>]
 *   context-pocket state update [--summary "..."] [--next-step "..."] [--pitfall "..."]
 *   context-pocket preferences update --key "..." --value "..."
 *   context-pocket code-map update
 *   context-pocket migrate [--to v<N>|latest] [--dry-run] [--list]
 *   context-pocket install-hook
 *   context-pocket uninstall-hook
 *   context-pocket handoff
 *   context-pocket help
 *   context-pocket --version          (aliases: -v, "context-pocket version")
 *
 *   Any command above accepts --json for machine-readable output (one JSON
 *   line on stdout, no colors; exit codes unchanged).
 *
 * Zero-dependency Node.js script. Works with Node.js 14+.
 */

const path = require('path');
const fs = require('fs');
const { findPocketDir, readConfig, stripPlaceholders, intOption, toTId } = require('../lib/core');
const { POCKET_DIR_NAME } = require('../lib/constants');
const { parseAll } = require('../lib/parser');
const { verify } = require('../lib/validator');
const {
  appendLogBlock,
  amendLogBlock,
  addRequirement,
  addDecision,
  addAbsoluteEntry,
  generateHandoff,
  archiveLog,
  updateState,
  updatePreferences,
  updateCodeMap,
} = require('../lib/writer');
const { formatVerifyResult, formatStatus, colorize } = require('../lib/formatter');
const { bootstrap } = require('../lib/bootstrap');
const { recall, diff, searchAny, why, checkConflicts } = require('../lib/query');
const { runMigration, listMigrations } = require('../lib/migrate');
const { repairLogIds } = require('../lib/repair');
const { installPreCommitHook, uninstallPreCommitHook } = require('../lib/hooks');
const { sync: syncPocket } = require('../lib/sync');
const { buildIndex } = require('../lib/indexer');
const { distill } = require('../lib/distill');
const { importSession } = require('../lib/importer');
const { toList, textOption, sectionFields, turnFields, hasAnySection } = require('../lib/fields');
const { describeWhen, describeWhenLine } = require('../lib/when');
const { afterWrite } = require('../lib/lifecycle');
const { pkgVersion } = require('../lib/version');
const {
  getHubDir,
  getHubFile,
  registerProject,
  removeProject,
  listProjects,
  setGlobalPref,
  getGlobalPref,
} = require('../lib/userhub');

// ============================================================
// 解析命令行参数
// ============================================================

// 明确"带值"的选项名。有了这份表才能正确解析：
//   --gist -weird        → gist 的值是 "-weird"（旧实现把它当新 flag，值丢失）
//   --key --value        → key 是布尔 true，不会被误喂下一个 flag
const VALUE_OPTIONS = new Set([
  'action', 'append-summary', 'attachments', 'author', 'commits', 'conflicts', 'consequences',
  'context', 'decision', 'decisions', 'dir', 'drift-last-n', 'f', 'file', 'file-path',
  'gist', 'id', 'impl', 'key', 'keyword', 'keep-last', 'language', 'last-n', 'limit',
  'mode', 'next-step', 'offset', 'options', 'pitfall', 'pitfalls', 'preferences', 'project-type', 'recent-keep', 'source',
  'status', 'summary', 'supersedes', 't', 't-a', 't-b', 't-id', 'tags', 'text', 'title', 'to', 'truncate', 'uncertain',
  'user', 'value', 'when', 'gitignore',
]);

// 纯开关型选项：绝不吞掉后面的裸词（旧实现会把 `--quiet rebuild` 里的
// "rebuild" 当成 quiet 的值，导致开关失效）
const BOOL_OPTIONS = new Set([
  'apply-refs', 'auto', 'drift', 'dry-run', 'help', 'h', 'json', 'list', 'list-only', 'no-conflict-check', 'no-hub', 'no-index',
  'quiet', 'rebuild', 'verify', 'version', 'v',
]);

// 真实存在的两段式命令。只有落在这些组合里的第二个词才当子命令，
// 否则 `context-pocket search update` 会把 "update" 从关键词里吞掉。
const SUBCOMMANDS_BY_COMMAND = {
  log: ['append', 'amend'],
  absolute: ['add'],
  req: ['add'],
  decision: ['add'],
  state: ['update'],
  preferences: ['update'],
  prefs: ['update'],
  'code-map': ['update'],
  codemap: ['update'],
};

function isKnownOption(token) {
  if (!token || token === '-' || token === '--') return false;
  if (!token.startsWith('-')) return false;
  const name = token.replace(/^-+/, '').replace(/:$/, '').split('=')[0];
  return VALUE_OPTIONS.has(name) || BOOL_OPTIONS.has(name);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    command: null,
    subcommand: null,
    options: {},
    positional: [],
  };
  let optionsTerminated = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // `--` 之后全部按位置参数处理：`search -- --foo` 能搜到 "--foo"
    // （旧实现把 "--" 变成 options[''] ，后面的值全乱）
    if (optionsTerminated) {
      result.positional.push(arg);
      continue;
    }
    if (arg === '--') {
      optionsTerminated = true;
      continue;
    }
    if (arg === '-') {
      result.positional.push('-');
      continue;
    }

    if (arg.startsWith('-')) {
      const dashed = arg.startsWith('--');
      let key = dashed ? arg.slice(2) : arg.slice(1);
      // 容忍 `--gitignore: false` 这种从文档里抄来的写法：旧实现解析出的
      // 键名是 "gitignore:"，于是 --gitignore 从未生效，效果与文档相反
      key = key.replace(/:$/, '');

      const eq = key.indexOf('=');
      if (eq > -1) {
        const name = key.slice(0, eq);
        const value = key.slice(eq + 1);
        result.options[name] = value === '' ? true : value;
        continue;
      }

      const next = args[i + 1];
      if (VALUE_OPTIONS.has(key)) {
        // 已知值型选项：值本身以 "-" 开头也照收（`--gist -weird`），
        // 只有下一个 token 是"认识的其他选项"时才当作缺省
        if (next !== undefined && !isKnownOption(next)) {
          result.options[key] = next;
          i++;
        } else {
          result.options[key] = true;
        }
      } else if (BOOL_OPTIONS.has(key)) {
        result.options[key] = true;
      } else if (next !== undefined && !isKnownOption(next)) {
        // 未知选项保持旧行为：吃掉下一个裸词当值，避免新增选项时静默失效
        result.options[key] = next;
        i++;
      } else {
        result.options[key] = true;
      }
      continue;
    }

    if (!result.command) {
      result.command = arg;
      continue;
    }
    if (!result.subcommand && result.positional.length === 0) {
      const allowed = SUBCOMMANDS_BY_COMMAND[result.command];
      if (allowed && allowed.includes(arg)) {
        // 只有紧跟在命令后的第一个裸词才有资格当子命令
        result.subcommand = arg;
        continue;
      }
    }
    result.positional.push(arg);
  }

  return result;
}

// ============================================================
// --json：机器可读输出
// ============================================================
//
// SKILL.md 承诺 "Use --json for machine-readable output"，此前代码里并不存在。
// 契约：--json 时 stdout 只有一行 JSON（不带 ANSI 颜色、不带排版），
// 人类模式的信息量不减；退出码沿用人类模式（verify 报错 / 冲突 critical 仍为 1）。

function emitJson(payload, exitCode) {
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(exitCode || 0);
}

/** --json 下的失败出口：错误也是机器可读的一行 JSON，而不是带 emoji 的提示语 */
function failJson(options, message) {
  if (options && options.json) {
    emitJson({ ok: false, error: message }, 1);
  }
}

function ensurePocket(options) {
  const startDir = options.dir || process.cwd();
  const pocketDir = findPocketDir(startDir);
  if (!pocketDir) {
    failJson(options, 'No ContextPocket/ directory found. Run "context-pocket bootstrap" first, or use --dir to specify a project path.');
    console.error(colorize('\n  ❌ Error:', 'red') + ' No ContextPocket/ directory found.');
    console.error('     Run "context-pocket bootstrap" first, or use --dir to specify a project path.\n');
    process.exit(1);
  }
  return pocketDir;
}

function getProjectDir(options) {
  return options.dir ? path.resolve(options.dir) : process.cwd();
}

// toTId / intOption 来自 lib/core：CLI 与 MCP 共用同一套数值/编号归一规则，
// 否则 "limit: abc" 在 MCP 侧会变成 NaN 一路渗进截断阈值。

/**
 * "必填的文本选项"是否缺值。
 * `--gist` 写在行尾（或后面紧跟另一个 flag）时值是 true，
 * 直接拼进 Markdown 就会留下一个字面量 "true" 的记录 —— 这里统一判缺。
 * 判据本身在 lib/fields.js 的 textOption()，CLI 与 MCP 共用同一份。
 */
function missingValue(options, name) {
  return textOption(options, name) === undefined;
}

// 同一个概念在 CLI 里曾有几种拼写（T 号的 `--t-id` / `--t` / `--id`，文件路径的
// `--file-path` / `--file` / `-f`）。这些键都在 VALUE_OPTIONS 里，所以猜错的那一种会被
// parseArgs 正常解析、再被对应命令静默丢掉，报错于是谎称"你没传"。
// 下面按顺序取第一个**真的给了值**的写法；只写 flag 没给值不算传了 —— 那种情况仍然报
// "… is required"，那是实话。别名只扩接受面，不放宽校验。

/** 一个 T 号：长写法 `--t-id` 与 MCP 的 `tId` 同名（kebab-case），历史别名 `--t` / `--id` 继续可用。 */
const T_ID_OPTIONS = ['t-id', 't', 'id'];
function tIdOption(options) {
  return textOption(options, ...T_ID_OPTIONS);
}

/** 同上，但用于 `diff` 的两个号：名字直接对齐 MCP 的 tA / tB。 */
function tIdPairOption(options) {
  return { tA: textOption(options, 't-a'), tB: textOption(options, 't-b') };
}

/** 一个文件路径：长写法 `--file-path` 对齐 MCP 的 `filePath`，`--file` / `-f` 是既有写法。 */
const FILE_PATH_OPTIONS = ['file-path', 'file', 'f'];
function filePathOption(options) {
  return textOption(options, ...FILE_PATH_OPTIONS);
}

// ============================================================
// 命令：help
// ============================================================

// 命令清单只写一次：人类帮助与 `--json` 都从这张表渲染。
// 以前这里是一串 console.log，Agent 想机器可读地拿到命令表就只能去解析带颜色的文本。
const HELP_GROUPS = [
  {
    group: 'Setup commands',
    commands: [
      ['bootstrap', 'Initialize ContextPocket/ in your project'],
      ['install-hook', 'Install git pre-commit hook (sync + verify)'],
      ['uninstall-hook', 'Uninstall git pre-commit hook'],
    ],
  },
  {
    group: 'Inspection commands',
    commands: [
      ['verify', 'Run health check on ContextPocket/ (--drift for tree-scanning drift checks)'],
      ['sync', 'Git safety net: detect/auto-record unlogged changes'],
      ['status', 'Show current status summary'],
      ['recall <T-id>', 'Show full details of a T-block'],
      ['diff <Ta> <Tb>', 'Compare two T-blocks (reqs/ADRs/files)'],
      ['search <kw>', 'Search turns + ADRs + reqs + prefs (--limit/--offset to page)'],
      ['why <file>', 'Reverse lookup: which T-blocks changed or merely mentioned this file'],
      ['check-conflicts', 'Scan for conflicts across 6 dimensions'],
    ],
  },
  {
    group: 'Write commands',
    commands: [
      ['log append', 'Append a new T-block to log.md'],
      ['log amend <Tn>', 'Fill in MISSING sections of an existing T-block'],
      ['absolute add', 'Append a 🔒 red-line entry to absolute.md'],
      ['req add', 'Add a new requirement'],
      ['decision add', 'Add a new ADR entry'],
      ['state update', 'Update state.md (summary/next-step/pitfall)'],
      ['preferences update', 'Update preferences.md (key/value)'],
      ['code-map update', 'Rescan project and update code-map.md'],
      ['handoff', 'Generate handoff.md'],
    ],
  },
  {
    group: 'Long-term memory commands',
    commands: [
      ['index', 'Build/refresh the search index (--rebuild to force)'],
      ['distill', 'Distill old turns into a digest report (--dry-run, --recent-keep)'],
      ['import', 'Import past agent sessions as T-blocks (claude-code/codex)'],
      ['hub', 'Cross-project registry + global prefs (~/.contextpocket)'],
    ],
  },
  {
    group: 'Maintenance commands',
    commands: [
      ['archive', 'Archive old T-blocks to log-archive.md'],
      ['repair', 'Renumber duplicate T-ids (multi-agent merge) and list stale references'],
      ['migrate', 'Migrate data format to new version'],
    ],
  },
];

// 名称列宽（含尾随空格），人类帮助与测试用同一个常量对齐
const HELP_COL = 20;

const HELP_OPTIONS = [
  ['--dir <path>', 'Specify project directory (default: cwd)'],
  ['--json', 'Machine-readable output: one JSON line on stdout, no colors, same exit codes (1 on verify errors / critical conflicts)'],
  ['--version', 'Print the installed version and exit (aliases: -v, "context-pocket version"); works without a ContextPocket/ directory'],
];

function cmdHelp(options) {
  const opts = options || {};
  if (opts.json) {
    emitJson({
      ok: true,
      usage: 'context-pocket <command> [options]',
      groups: HELP_GROUPS.map((g) => ({
        group: g.group,
        commands: g.commands.map((c) => ({ command: c[0], summary: c[1] })),
      })),
      options: HELP_OPTIONS.map((o) => ({ option: o[0], summary: o[1] })),
    });
  }

  const lines = [];
  lines.push('');
  lines.push(colorize('  ContextPocket CLI', 'bold'));
  lines.push('  Auto-record dev conversations into your project.');
  lines.push('');
  lines.push(colorize('  Usage:', 'bold'));
  lines.push('    context-pocket <command> [options]');
  for (const g of HELP_GROUPS) {
    lines.push('');
    lines.push(colorize(`  ${g.group}:`, 'bold'));
    for (const [name, summary] of g.commands) {
      lines.push(`    ${name.padEnd(HELP_COL)}${summary}`);
    }
  }
  lines.push('');
  lines.push(colorize('  Options:', 'bold'));
  for (const [name, summary] of HELP_OPTIONS) {
    lines.push(`    ${name.padEnd(HELP_COL)}${summary}`);
  }
  lines.push('');
  lines.push('  Run "context-pocket <command> --help" for command-specific help.');
  lines.push('');
  console.log(lines.join('\n'));
}

/**
 * 命令：version（`--version` / `-v` / `context-pocket version`）
 *
 * 只读 package.json（同一份判据在 lib/version.js，MCP 的 initialize 回包用它的
 * version），所以不需要 ContextPocket/ 目录、不碰家目录，装了就能问"我装的是哪版"。
 */
function cmdVersion(options) {
  const opts = options || {};
  const info = pkgVersion();
  if (opts.json) {
    emitJson({
      ok: true,
      name: 'context-pocket',
      version: info.version,
      source: info.source,
      node: process.version,
    });
    return;
  }
  console.log('');
  console.log(colorize('  ContextPocket CLI', 'bold') + ' ' + info.version);
  console.log('    source: ' + (info.source === 'package.json'
    ? 'package.json'
    : 'built-in fallback (no package.json next to the binary)'));
  console.log('    node:   ' + process.version);
  console.log('');
}

// ============================================================
// 命令：bootstrap
// ============================================================

function cmdBootstrap(options) {
  const projectDir = getProjectDir(options);
  // --no-hub：把 bootstrap 唯一那个"写到你家目录里"的副作用关掉。
  // 临时目录、脚本试跑、CI 里跑一遍都不该在用户的项目清单里留一行。
  const noHub = !!options['no-hub'];

  // 幂等：已经有 ContextPocket/ 不是"失败"，而是"早就在记了"。激活方式是全自动的
  // （SKILL.md：用户永远不需要执行命令），用户说「开始记一下」时项目大概率已有 pocket，
  // 退 1 会让 Agent 以为自己没资格继续记录。库层那道"拒绝覆盖"保护原样保留。
  const existingPocket = path.join(projectDir, POCKET_DIR_NAME);
  if (fs.existsSync(existingPocket) && fs.statSync(existingPocket).isDirectory()) {
    let hub = null;
    if (!noHub) {
      try {
        hub = registerProject(projectDir, {});
      } catch (e) { /* hub 不可用 → 如实为 null */ }
    }

    if (options.json) {
      emitJson({ ok: true, alreadyExists: true, projectDir, pocketDir: existingPocket, hub, hubSkipped: noHub });
    }
    console.log('');
    console.log(colorize('  ℹ️  ContextPocket/ already exists — nothing to create, keep recording.', 'cyan'));
    console.log(`     ${existingPocket}`);
    console.log(colorize('     Read index.md + state.md to pick up where the last session left off.', 'dim'));
    // 这一行不能省：文档告诉用户"去掉 --no-hub 重跑就能补登记"，而 bootstrap 幂等分支
    // 原本一句话都不提 hub，重跑之后用户在屏幕上找不到任何登记发生了的证据。
    if (noHub) {
      console.log(colorize(`     Hub: skipped (--no-hub) — nothing was written to ${getHubFile()}`, 'dim'));
    } else if (hub) {
      console.log(`     Hub: registered in ${getHubFile()}`);
    }
    console.log('');
    return;
  }

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

    if (options.json) {
      let hub = null;
      if (!noHub) {
        try {
          hub = registerProject(projectDir, {
            projectType: result.projectType,
            mode: result.mode,
            latestT: 0,
          });
        } catch (e) { /* hub 不可用 → JSON 里如实为 null */ }
      }
      emitJson({
        ok: true,
        projectDir,
        pocketDir: result.pocketDir,
        projectType: result.projectType,
        mode: result.mode,
        language: result.language,
        filesCreated: result.filesCopied.length,
        files: result.filesCopied,
        gitignore: result.gitignore || null,
        warnings: result.warnings || [],
        hub,
        hubSkipped: noHub,
      });
    }

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

    // 初始化里"没做成但不致命"的部分必须说出来，否则用户以为模板生成成功、内容本来如此
    if (result.warnings && result.warnings.length > 0) {
      console.log(colorize(`     ${result.warnings.length} warning(s):`, 'yellow'));
      for (const w of result.warnings) {
        console.log(colorize(`       ⚠ ${w}`, 'yellow'));
      }
    }

    // 注册到用户级 hub（best-effort，失败不影响 bootstrap）
    if (noHub) {
      console.log(colorize(`     Hub: skipped (--no-hub) — nothing was written to ${getHubFile()}`, 'dim'));
      console.log(colorize('     Register it later by running the same command without --no-hub', 'dim'));
    } else {
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
    }

    console.log('');
    console.log('  Next steps:');
    console.log('    1. Edit ContextPocket/readme.md with project info');
    console.log('    2. Run "context-pocket verify" to check health');
    console.log('    3. Run "context-pocket install-hook" to enable pre-commit checks');
    console.log('');
  } catch (e) {
    failJson(options, e.message);
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
  const lastN = intOption(options['drift-last-n'], 5);
  const result = verify(pocketDir, { drift, lastN });

  if (options.json) {
    emitJson(Object.assign({ ok: result.errorCount === 0, pocketDir }, result), result.errorCount > 0 ? 1 : 0);
  }

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
  const lastN = intOption(options['last-n'], 5);

  const result = syncPocket(pocketDir, { auto, dryRun, lastN });

  if (options.json) {
    // 退出码与人类模式一致：非 git 仓库是"跳过"而非失败
    const fatal = (result.skipped && result.isGit !== false) || (result.error && !result.filled);
    emitJson(Object.assign({ ok: !fatal }, result), fatal ? 1 : 0);
  }

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

  const listFiles = (arr) => arr.map(c => {
    if (!c.mentionedIn || c.mentionedIn.length === 0) return `     ${c.path}`;
    const where = c.mentionedIn.map(m => `T${m.tId}/${m.section}`).join(', ');
    return `     ${c.path}${colorize(`  ← only mentioned in ${where}, never in Action`, 'dim')}`;
  }).join('\n');

  // 弱证据的用处就在这里：这些文件不是"完全没记录"，而是"记录没写在 Action 里"，
  // 正确的修法是把它们补进那一轮，而不是留一个只有 [auto] 免责声明的块。
  const mentionHint = () => {
    if (!result.mentionedOnly || result.mentionedOnly.length === 0) return;
    const ids = [...new Set(result.unrecorded
      .filter(c => c.mentionedIn)
      .map(c => c.mentionedIn[0].tId))];
    console.log('');
    console.log(colorize(`  ℹ️  ${result.mentionedOnly.length} of them already appear in another section of a recent T-block.`, 'cyan'));
    console.log(`     If you really changed them, prefer ${colorize(`context-pocket log amend T${ids[0]} --action "..."`, 'bold')}`);
    console.log(`     over an [auto] block — the turn exists, only its Action section is incomplete.`);
  };

  if (result.dryRun) {
    console.log('');
    console.log(colorize('  📋 sync plan (dry-run):', 'bold'));
    console.log(`     ${result.unrecorded.length} staged file(s) not recorded in recent T-blocks:`);
    console.log(listFiles(result.unrecorded));
    mentionHint();
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
    mentionHint();
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
  mentionHint();
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

  if (options.json) {
    const { log, requirements, decisions, state, preferences, absolute, index } = data;
    // 与 formatStatus 同规则：模板占位符不算内容，否则空项目看起来"有下一步"
    const nextSteps = stripPlaceholders(state.nextSteps);
    const pitfalls = stripPlaceholders(state.pitfalls);
    emitJson({
      ok: true,
      pocketDir,
      latestT: log.latestT,
      date: index.date || null,
      mode: config.mode,
      language: config.language,
      tBlocks: log.blocks.length,
      logLines: log.lineCount,
      archiveAt: Number.isFinite(Number(config.archive_at)) ? Number(config.archive_at) : null,
      hasArchive: !!index.hasArchive,
      requirements: {
        open: requirements.openCount,
        done: requirements.doneCount,
        cancelled: requirements.cancelledCount,
        uncertain: requirements.uncertainCount,
        items: requirements.items,
      },
      decisions: { count: decisions.count, adrs: decisions.adrs },
      absolute: { count: absolute.count, entries: absolute.entries },
      preferences: { count: preferences.count, items: preferences.items },
      nextSteps,
      pitfalls,
      summary: stripPlaceholders(state.summary),
    });
  }

  console.log(formatStatus(data, config));
}

// ============================================================
// 命令：recall
// ============================================================

function cmdRecall(options, positional) {
  const pocketDir = ensurePocket(options);
  const tIdStr = positional[0] || tIdOption(options);

  if (!tIdStr) {
    failJson(options, 'T-id is required. Usage: context-pocket recall <T-id> (or --t-id <n>)');
    console.error(colorize('\n  ❌ Error:', 'red') + ' T-id is required');
    console.error('     Usage: context-pocket recall <T-id>  (or --t-id <n>, aliases --t/--id)\n');
    process.exit(1);
  }

  const tId = toTId(tIdStr);
  if (Number.isNaN(tId)) {
    failJson(options, 'Invalid T-id: ' + tIdStr);
    console.error(colorize('\n  ❌ Error:', 'red') + ' Invalid T-id: ' + tIdStr);
    process.exit(1);
  }

  const result = recall(pocketDir, tId);
  if (!result) {
    failJson(options, 'T' + tId + ' not found');
    console.error(colorize('\n  ❌ Error:', 'red') + ` T${tId} not found\n`);
    process.exit(1);
  }

  if (options.json) emitJson({ ok: true, t: result });

  console.log('');
  console.log(colorize(`  T${result.id} · ${result.gist}`, 'bold'));
  if (result.tags && result.tags.length > 0) {
    console.log('  ' + result.tags.map(t => colorize(`[${t}]`, 'cyan')).join(' '));
  }
  if (result.session) {
    console.log(colorize(`  Session: ${result.session}`, 'dim'));
  }
  if (result.when) {
    // v2 的块才有；kind 之间的差别（记下的时刻 / 只有天 / 用户原话）直接显示给读者
    console.log(colorize(`  When:    ${describeWhen(result.when)}`, 'dim'));
  }
  if (result.archived) {
    console.log(colorize('  (archived in log-archive.md)', 'dim'));
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
  // 位置参数是首选写法；两个号也可以按 MCP 的 tA / tB 写成 --t-a / --t-b
  const tIdPair = tIdPairOption(options);
  const tAStr = positional[0] || tIdPair.tA;
  const tBStr = positional[1] || tIdPair.tB;

  if (!tAStr || !tBStr) {
    failJson(options, 'Two T-ids are required. Usage: context-pocket diff <T-a> <T-b> (or --t-a <n> --t-b <n>)');
    console.error(colorize('\n  ❌ Error:', 'red') + ' Two T-ids are required');
    console.error('     Usage: context-pocket diff <T-a> <T-b>  (or --t-a <n> --t-b <n>)\n');
    process.exit(1);
  }

  const tA = toTId(tAStr);
  const tB = toTId(tBStr);

  if (Number.isNaN(tA) || Number.isNaN(tB)) {
    failJson(options, 'Invalid T-id: ' + (Number.isNaN(tA) ? tAStr : tBStr));
    console.error(colorize('\n  ❌ Error:', 'red') + ' Invalid T-id: ' + (Number.isNaN(tA) ? tAStr : tBStr));
    process.exit(1);
  }

  try {
    const result = diff(pocketDir, tA, tB);

    if (options.json) emitJson(Object.assign({ ok: true }, result));

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
    failJson(options, e.message);
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
  const keyword = positional[0] || (typeof options.keyword === 'string' ? options.keyword : undefined);

  if (!keyword) {
    failJson(options, 'keyword is required. Usage: context-pocket search <keyword>');
    console.error(colorize('\n  ❌ Error:', 'red') + ' keyword is required');
    console.error('     Usage: context-pocket search <keyword>\n');
    process.exit(1);
  }

  // 优先走倒排索引（历史增长后依然即时）。缓存缺失 / 坏 JSON / INDEX_VERSION 对不上 / 签名过期
  // 都是当场重建然后继续走索引，只有连重建都做不成（只读盘、索引路径被别的东西占住）才真的
  // viaIndex:false 去扫 Markdown；--no-index 是显式声明"这一次不信缓存"。
  // 两条路径的匹配与排序是同一份实现，所以 --limit / --offset 与走哪条无关。
  const { results, total, hasMore, offset, limit, viaIndex } = searchAny(pocketDir, keyword, {
    useIndex: !options['no-index'],
    limit: options.limit,
    offset: options.offset,
  });

  if (options.json) {
    emitJson({
      ok: true,
      keyword,
      count: results.length,
      total,
      offset,
      limit,
      hasMore,
      viaIndex,
      results,
    });
  }

  console.log('');
  console.log(colorize(`  Search: "${keyword}"`, 'bold'));
  const shown = limit !== null && results.length < total
    ? colorize(` · showing ${offset + 1}–${offset + results.length}`, 'dim')
    : '';
  console.log(`  ${total} match${total !== 1 ? 'es' : ''} found${shown}`);
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
        console.log(`  ${colorize('T' + r.id, 'bold')}${tagsStr} · ${r.gist}${r.archived ? colorize(' (archived)', 'dim') : ''}`);
        printHighlights(r);
      }
    }
  }

  // 截断必须可见：否则用户以为"就这些"，而真实总数在 total 里
  if (hasMore) {
    console.log('  ' + colorize(`  ↳ ${total - offset - results.length} more — next page: --offset ${offset + results.length}`, 'dim'));
    console.log('  ' + colorize('    all of them: --limit 0', 'dim'));
  }
  console.log('');
}

// ============================================================
// 命令：why — 反向检索：哪些 T-block 提到这个文件
// ============================================================

function cmdWhy(options, positional) {
  const pocketDir = ensurePocket(options);
  // 同一个"文件路径"在 MCP 侧叫 filePath，CLI 侧历史上只认 --file：写成 --file-path 或 -f
  // 都会被 parseArgs 解析好再丢掉，然后谎报"你没传"。这里把三种写法收齐。
  const filePath = positional[0] || filePathOption(options);

  if (!filePath) {
    failJson(options, 'file path is required. Usage: context-pocket why <file-path> [--limit <N>] (or --file-path <p>, aliases --file / -f)');
    console.error(colorize('\n  ❌ Error:', 'red') + ' file path is required');
    console.error('     Usage: context-pocket why <file-path> [--limit <N>]');
    console.error('     (also accepted: --file-path <p>, --file <p>, -f <p> — same as MCP filePath)\n');
    console.error('     Example: context-pocket why lib/parser.js\n');
    process.exit(1);
  }

  const limit = Math.max(1, intOption(options.limit, 10));
  const results = why(pocketDir, filePath, { limit });

  if (options.json) {
    emitJson({ ok: true, file: filePath, count: results.length, limit, results });
  }

  console.log('');
  console.log(colorize(`  Why: "${filePath}"`, 'bold'));
  const changedN = results.filter(r => r.evidence === 'changed').length;
  const mentionedN = results.length - changedN;
  console.log(
    `  ${results.length} T-block${results.length !== 1 ? 's' : ''} referenced this file` +
    (results.length > 0 ? colorize(` (${changedN} changed it, ${mentionedN} only mentioned it)`, 'dim') : '')
  );
  console.log('  ' + colorize('─'.repeat(40), 'dim'));

  if (results.length === 0) {
    console.log('  (no references found)');
  } else {
    for (const r of results) {
      const tagsStr = r.tags.length > 0
        ? ' ' + r.tags.map(t => colorize(`[${t}]`, 'cyan')).join('')
        : '';
      const badge = r.evidence === 'changed'
        ? colorize('[changed]', 'green')
        : colorize('[mentioned only]', 'yellow');
      console.log(`  ${colorize('T' + r.id, 'bold')} ${badge}${tagsStr} · ${r.gist}`);
      for (const ref of r.references.slice(0, 3)) {
        const snippet = ref.text.length > 60 ? ref.text.slice(0, 60) + '...' : ref.text;
        console.log(colorize(`     ↳ [${ref.section}] ${snippet}`, 'dim'));
      }
    }
    if (changedN === 0) {
      console.log('');
      console.log(colorize('  ⚠️  No T-block records changing this file — every hit above only mentions it', 'yellow'));
      console.log(colorize('     (in Attachments / Uncertain / Conflicts / Pitfalls …). Treat the "why" as unresolved.', 'dim'));
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

  if (options.json) {
    emitJson(Object.assign({ ok: result.criticalCount === 0 }, result), result.criticalCount > 0 ? 1 : 0);
  }

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

  if (missingValue(options, 'gist')) {
    failJson(options, '--gist is required (and needs a value)');
    console.error(colorize('\n  ❌ Error:', 'red') + ' --gist is required');
    console.error('     Usage: context-pocket log append --gist "one-line summary"\n');
    process.exit(1);
  }

  // 字段形状与 MCP 入口共用一份定义（lib/fields.js），见该文件头的原因说明
  const fields = turnFields(options);
  // 写时冲突闸默认开；`--no-conflict-check` 是唯一把它关掉的入口（大块历史里
  // 每次 append 都要多读一遍 pocket，用户明确不要时才省掉）
  if (options['no-conflict-check']) fields.conflictCheck = false;
  const result = appendLogBlock(pocketDir, fields);

  if (!options.json) {
    // 打的是还原成一句话的时间，不是 `--- WHEN: … ---` 那行格式；--json 里仍给逐字的行
    const whenText = describeWhenLine(result.when);
    const whenSuffix = whenText ? '\n  ' + colorize('⏱  ' + whenText, 'dim') : '';
    // 用户给了时间、却因为 pocket 还停在 v1 而没落盘 —— 这必须说出来，不能当没事发生
    const skipSuffix = result.whenSkipped
      ? '\n  ' + colorize(`⚠️  ${result.whenSkipped}`, 'yellow')
      : '';
    console.log(`\n  ✅ T${result.tId} added: ${fields.gist}\n` + whenSuffix + skipSuffix);

    // 本轮新建的块缺了 verify 会判 ERROR 的小节：当场说，别等 archive/migrate/提交撞墙。
    // 只报这一块（不回扫历史），否则老 pocket 每次 append 都会被别人的漏记刷屏。
    if (result.missingSections && result.missingSections.length > 0) {
      console.log(colorize(`  ⚠️  T${result.tId} 没有 ${result.missingSections.join(' / ')} 节 — verify 会判成 ERROR 并拦住 archive/migrate/提交：`, 'yellow'));
      for (const title of result.missingSections) {
        const flag = title === 'User' ? '--user' : '--action';
        console.log(colorize(`     context-pocket log amend ${result.tId} ${flag} "…"\n`, 'dim'));
      }
    }

    // 检出的冲突已经写进本块的 Conflicts 节；这里只负责让人当场看见
    if (result.conflictsWritten > 0) {
      console.log(colorize(`  ⚔️  ${result.conflictsWritten} 条冲突已记入 T${result.tId} 的 Conflicts 节：`, 'yellow'));
      for (const f of result.autoConflicts.filter((x) => x.severity === 'critical' || x.severity === 'warning')) {
        console.log(`     · [${f.severity}] ${f.message}`);
      }
      console.log('');
    }
    if (result.conflictCheckError) {
      console.log(colorize(`  ⚠️  本轮没做冲突检查：${result.conflictCheckError}`, 'yellow') + '\n');
    }
  }

  // 副作用：更新 hub 活跃信息 + 刷新搜索索引（都 best-effort，不阻断记录）
  afterWrite(pocketDir, {
    latestT: result.tId,
    gist: fields.gist,
    index: !options['no-index'],
  });

  const verifyResult = options.verify ? verify(pocketDir) : null;

  if (options.json) {
    const failed = verifyResult !== null && verifyResult.errorCount > 0;
    emitJson({
      ok: !failed,
      tId: result.tId,
      gist: fields.gist,
      // v2 及以上才有时间行；null 说明这个 pocket 还是 v1（migrate --to latest 之后才会有）
      when: result.when || null,
      // 非 null = 调用方给了 --when，但这一轮的时间没能落盘，原因写在里面
      whenSkipped: result.whenSkipped || null,
      // 本轮新建块里缺的必需小节（verify 会判 ERROR）；空数组 = 这一条写得齐
      missingSections: result.missingSections || [],
      // 写时冲突闸：all 是全部检出（含只提示、不写进块的 info 那条），
      // conflictsWritten 是已进本块 Conflicts 节的条数；skipped/error 说明这一轮没检查成
      autoConflicts: result.autoConflicts,
      conflictsWritten: result.conflictsWritten,
      conflictCheckSkipped: result.conflictCheckSkipped,
      conflictCheckError: result.conflictCheckError,
      verify: verifyResult,
    }, failed ? 1 : 0);
  }

  if (verifyResult !== null && verifyResult.errorCount > 0) {
    console.log(colorize('  ⚠️  Verification found errors:\n', 'yellow'));
    console.log(formatVerifyResult(verifyResult, { quiet: true }));
    process.exit(1);
  }
}

// ============================================================
// 命令：log amend
// ============================================================

function cmdLogAmend(options, positional) {
  const pocketDir = ensurePocket(options);

  const tArg = positional[0] || tIdOption(options);
  const tId = toTId(tArg);

  if (!tId || Number.isNaN(tId)) {
    failJson(options, 'a T-id is required. Usage: context-pocket log amend 3 --user "用户当时的原话" (or --t-id 3, aliases --t/--id)');
    console.error(colorize('\n  ❌ Error:', 'red') + ' a T-id is required');
    console.error('     Usage: context-pocket log amend 3 --user "用户当时的原话"');
    console.error('     (also accepted: --t-id <n>, --t <n>, --id <n>)\n');
    process.exit(1);
  }

  const payload = sectionFields(options);

  if (!hasAnySection(payload)) {
    failJson(options, 'nothing to amend — pass at least one section');
    console.error(colorize('\n  ❌ Error:', 'red') + ' nothing to amend — pass at least one section');
    console.error('     Usage: context-pocket log amend ' + tId + ' --user "用户当时的原话"\n');
    process.exit(1);
  }

  const result = amendLogBlock(pocketDir, tId, payload);

  if (!result.success) {
    failJson(options, result.error);
    console.error(colorize('\n  ❌ Error:', 'red') + ' ' + result.error + '\n');
    process.exit(1);
  }

  // 刷新搜索索引（新增的 User / Action 段应可被搜到）
  afterWrite(pocketDir, { index: !options['no-index'] });

  // JSON 在副作用之后输出：消费方紧接着 search 也应看到新内容
  if (options.json) {
    emitJson({
      ok: true,
      tId,
      filled: result.filled,
      skipped: result.skipped,
      unchanged: !!result.unchanged,
      // amend 的时间行可能被拒（历史不回写）或被换掉，note 说明到底改没改
      whenNote: result.when || null,
    });
  }

  if (result.when) {
    // v1 pocket / 解析失败 / 覆盖被拒都只会有一句话说明，不会改动文件
    console.log(colorize('\n  ⏱  ' + result.when, 'dim'));
  }

  if (result.unchanged && !result.when) {
    console.log(`\n  ℹ️  T${tId} already has those sections — nothing changed (existing content is never overwritten)`);
  } else {
    console.log(`\n  ✅ T${tId} amended — filled: ${result.filled.join(', ')}`);
  }

  if (result.skipped.length > 0) {
    console.log(colorize(`     already present, left untouched: ${result.skipped.join(', ')}`, 'dim'));
  }
}

// ============================================================
// 命令：absolute add
// ============================================================

function cmdAbsoluteAdd(options, positional) {
  const pocketDir = ensurePocket(options);

  const text = positional[0] || textOption(options, 'text');
  if (!text) {
    failJson(options, 'the requirement text is required');
    console.error(colorize('\n  ❌ Error:', 'red') + ' the requirement text is required');
    console.error('     Usage: context-pocket absolute add --text "绝不允许改 X 的 API 形状"\n');
    process.exit(1);
  }

  const createdArg = tIdOption(options);
  // `--t-id` 给了就得是个号。以前 `--t abc` 会被 intOption 静默归成 undefined，
  // 于是这条 🔒 盖到"最新一轮"上——用户指名的是 abc，落盘的号却是猜的。
  const createdTId = createdArg === undefined ? undefined : toTId(createdArg);
  if (createdTId !== undefined && Number.isNaN(createdTId)) {
    failJson(options, 'Invalid T-id: ' + createdArg);
    console.error(colorize('\n  ❌ Error:', 'red') + ' Invalid T-id: ' + createdArg);
    console.error('     Usage: context-pocket absolute add --text "…" --t-id <n>\n');
    process.exit(1);
  }

  const result = addAbsoluteEntry(pocketDir, {
    text,
    gist: textOption(options, 'gist'),
    createdAt: createdTId,
  });

  if (options.json) emitJson({ ok: true, absolute: result });

  console.log(`\n  ✅ 🔒 added to absolute.md (${result.count} entries) · T${result.tId}`);
  console.log(colorize('     Never compressed, never archived. Verify before acting on it.', 'dim'));
  console.log('');
}

// ============================================================
// 命令：req add
// ============================================================

function cmdReqAdd(options, positional) {
  const pocketDir = ensurePocket(options);

  const text = positional[0] || textOption(options, 'text');
  if (!text) {
    failJson(options, 'requirement text is required');
    console.error(colorize('\n  ❌ Error:', 'red') + ' requirement text is required');
    console.error('     Usage: context-pocket req add "requirement text"\n');
    process.exit(1);
  }

  const result = addRequirement(pocketDir, {
    text,
    tags: toList(options.tags),
    status: textOption(options, 'status') || 'Open',
    uncertain: !!options.uncertain,
    impl: toList(options.impl),
  });

  if (options.json) emitJson({ ok: true, requirement: result });

  const prefix = options.uncertain ? '❓ ' : '';
  console.log(`\n  ✅ ${prefix}R${result.rId} added: ${text}\n`);
}

// ============================================================
// 命令：decision add
// ============================================================

function cmdDecisionAdd(options) {
  const pocketDir = ensurePocket(options);
  const title = textOption(options, 'title');

  if (!title) {
    failJson(options, '--title is required (and needs a value)');
    console.error(colorize('\n  ❌ Error:', 'red') + ' --title is required');
    console.error('     Usage: context-pocket decision add --title "Use X over Y"');
    console.error('            --context "..." --options "..." --decision "..."\n');
    process.exit(1);
  }

  const result = addDecision(pocketDir, {
    title,
    context: textOption(options, 'context') || '',
    options: textOption(options, 'options') || '',
    decision: textOption(options, 'decision') || '',
    consequences: textOption(options, 'consequences') || '',
    supersedes: textOption(options, 'supersedes') || 'none',
  });

  if (options.json) emitJson({ ok: true, decision: result });

  console.log(`\n  ✅ ADR-${result.adrId} added: ${title}\n`);
}

// ============================================================
// 命令：handoff
// ============================================================

function cmdHandoff(options) {
  const pocketDir = ensurePocket(options);

  const result = generateHandoff(pocketDir);

  if (options.json) emitJson({ ok: true, handoff: result });

  console.log(`\n  ✅ Handoff generated: T${result.tId} · ${result.date}`);
  console.log(`     File: ContextPocket/handoff.md\n`);
}

// ============================================================
// 命令：archive
// ============================================================

function cmdArchive(options) {
  const pocketDir = ensurePocket(options);

  // 缺省时由 archiveLog 读 config.md 的 recent_keep
  const keepLast = intOption(options['keep-last']);
  const dryRun = !!options['dry-run'];

  try {
    const result = archiveLog(pocketDir, { keepLast, dryRun });

    // 归档改变了 T-block 分布 → 静默刷新索引（在输出之前完成，json 消费方接着 search 也一致）
    afterWrite(pocketDir, { index: !dryRun && !result.skipped });

    if (options.json) emitJson(Object.assign({ ok: true }, result));

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

    if (dryRun) {
      console.log(colorize('  (dry-run: no files were modified)', 'dim'));
      console.log('');
    }
  } catch (e) {
    failJson(options, e.message);
    console.error(colorize('\n  ❌ Error:', 'red') + ' ' + e.message);
    console.error('');
    process.exit(1);
  }
}

// ============================================================
// 命令：repair
// ============================================================

/**
 * 修 T 编号撞车（两个 Agent 各写各的，合并后 log.md 里出现两个 `## T9`）。
 *
 * 为什么默认不动引用：`T9` 在撞号历史里同时指过两块，"这一处引用说的是哪一块"
 * 只有读的人知道。工具替人猜一次，就等于往历史里写了一句没根据的话。
 */
function cmdRepair(options) {
  const pocketDir = ensurePocket(options);

  let result;
  try {
    result = repairLogIds(pocketDir, {
      dryRun: !!options['dry-run'],
      applyRefs: !!options['apply-refs'],
      author: options.author,
    });
  } catch (e) {
    failJson(options, e.message);
    console.error(colorize('\n  ❌ Error:', 'red') + ' ' + e.message);
    console.error('');
    process.exit(1);
    return;
  }

  if (!result.success) {
    failJson(options, result.error);
    console.error(colorize('\n  ❌ ' + result.error, 'red'));
    console.error('');
    process.exit(1);
  }

  // 编号变了就要重建搜索索引（旧索引里的 T 号已经指错了地方）
  if (!result.dryRun && result.changed) afterWrite(pocketDir, { latestT: result.latestTAfter, index: true });

  if (options.json) {
    emitJson(Object.assign({ ok: true }, result));
    return;
  }

  console.log('');
  if (!result.changed) {
    console.log(colorize('  ✅ Nothing to repair: ' + result.message, 'green'));
    console.log('');
    return;
  }

  console.log(colorize(result.dryRun ? '  📋 Repair plan (dry-run):' : '  ✅ Repair completed:', 'bold'));
  console.log(`     ${result.message}`);
  console.log('');

  console.log(colorize('  Renumbered:', 'bold'));
  for (const c of result.renumbered) {
    console.log(`     T${c.from} → T${c.to}   (log.md:${c.line})  ${c.heading}`);
  }
  console.log('');

  if (result.references.length > 0) {
    const shown = result.references.slice(0, 20);
    console.log(colorize(result.applyRefs
      ? `  References rewritten (${result.references.length}):`
      : `  References still naming an old T-id (${result.references.length}; not rewritten — add --apply-refs):`, 'yellow'));
    for (const r of shown) {
      console.log(`     ${r.file}:${r.line}  T${r.from} → T${r.to}   ${r.text.slice(0, 90)}`);
    }
    if (result.references.length > shown.length) {
      console.log(colorize(`     … +${result.references.length - shown.length} more (--json for the full list)`, 'dim'));
    }
    console.log('');
  }

  const fileNames = result.fileNames || [];
  if (fileNames.length > 0) {
    console.log(colorize(`  📎 Attachment file names still carry an old id (${fileNames.length}) — never rewritten,`
      + ' renaming a file is `mv`, not a text edit:'));
    for (const f of fileNames.slice(0, 20)) {
      console.log(`     ${f.file}:${f.line}  ${f.command}`);
    }
    if (fileNames.length > 20) {
      console.log(colorize(`     … +${fileNames.length - 20} more (--json for the full list)`, 'dim'));
    }
    console.log(colorize('     run the mv inside ContextPocket/, then `context-pocket verify` to confirm the links hold', 'dim'));
    console.log('');
  }

  if (result.stillShadowed && result.stillShadowed.length > 0) {
    console.log(colorize(`  ⚠️  T${result.stillShadowed.join(', T')} 与 log-archive.md 里的编号同名：` +
      ' recall/search 会显示 log.md 那块、把归档那份遮住。归档声明只读，repair 不替它改号。', 'yellow'));
    console.log('');
  }

  if (result.recordTId) {
    console.log(colorize(`  📝 记录块：T${result.recordTId}（编号被工具动过这件事本身进了历史）`, 'dim'));
    console.log('');
  }
}

// ============================================================
// 命令：state update
// ============================================================

function cmdStateUpdate(options) {
  const pocketDir = ensurePocket(options);

  // 三个字段都只收文本：`--summary` 后面没有值时不等于"要写 summary"，
  // 否则 state.md 里会多出一行 `- true`（判据见 lib/fields.js textOption）
  const summary = textOption(options, 'summary');
  const nextStep = textOption(options, 'next-step');
  const pitfall = textOption(options, 'pitfall', 'pitfalls');

  if (summary === undefined && nextStep === undefined && pitfall === undefined) {
    failJson(options, 'at least one option is required (--summary / --next-step / --pitfall)');
    console.error(colorize('\n  ❌ Error:', 'red') + ' At least one option is required');
    console.error('     Usage: context-pocket state update [--summary "..."] [--next-step "..."] [--pitfall "..."]');
    console.error('     (a flag with no value counts as "not given" — nothing was written)\n');
    process.exit(1);
  }

  const result = updateState(pocketDir, {
    summary,
    appendSummary: !!options['append-summary'],
    nextStep,
    pitfall,
  });

  if (options.json) emitJson({ ok: true, state: result });

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

  if (missingValue(options, 'key')) {
    failJson(options, '--key is required (and needs a value)');
    console.error(colorize('\n  ❌ Error:', 'red') + ' --key is required');
    console.error('     Usage: context-pocket preferences update --key "..." --value "..."\n');
    process.exit(1);
  }

  if (options.value === undefined || options.value === true) {
    failJson(options, '--value is required (and needs a value)');
    console.error(colorize('\n  ❌ Error:', 'red') + ' --value is required');
    console.error('     Usage: context-pocket preferences update --key "..." --value "..."\n');
    process.exit(1);
  }

  const result = updatePreferences(pocketDir, {
    key: options.key,
    value: options.value,
  });

  if (options.json) emitJson({ ok: true, preference: result });

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

    if (options.json) emitJson(Object.assign({ ok: true }, result));

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
    failJson(options, e.message);
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
    if (options.json) emitJson(Object.assign({ ok: !info.error }, info), info.error ? 1 : 0);
    console.log('');
    console.log(colorize('  ContextPocket · Migration', 'bold'));
    console.log('  ' + colorize('─'.repeat(40), 'dim'));
    console.log(`  Current version: ${info.currentVersion || colorize('(unknown)', 'yellow')}`);
    console.log(`  Target version: ${info.targetVersion}${typeof options.to === 'string' && /latest|newest/i.test(options.to) ? colorize(' (latest registered)', 'dim') : ''}`);
    console.log(`  Latest registered: ${info.latestVersion}`);
    console.log(`  Status: ${info.isLatest ? colorize('up to date', 'green') : colorize('upgrade available', 'yellow')}`);
    console.log('');

    if (info.error) {
      console.log(colorize('  ⚠️  ' + info.error, 'yellow'));
      console.log('');
      return;
    }

    if (info.path.length > 0 && !info.isLatest) {
      console.log(colorize('  Migration path:', 'bold'));
      for (const step of info.path) {
        console.log(`     ${step.from} → ${step.to}: ${step.name}`);
      }
      console.log('');
    }

    console.log(colorize('  Registered steps:', 'bold'));
    for (const s of info.available) {
      console.log(`     ${s.from} → ${s.to}: ${s.name}`);
    }
    console.log('');
    return;
  }

  try {
    const result = runMigration(pocketDir, {
      to: targetVersion,
      dryRun,
    });

    if (options.json) emitJson(Object.assign({ ok: true }, result));

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
      console.log(`     Steps: ${result.planned.length}${result.planned.length > 1 ? ' (multi-hop, all-or-nothing)' : ''}`);
      for (const [i, step] of result.planned.entries()) {
        console.log(`       ${i + 1}. ${step.from} → ${step.to}: ${step.name}`);
      }
      console.log('');
      console.log(colorize('  (dry-run: no files were modified)', 'dim'));
      console.log('');
    } else {
      console.log(colorize('  ✅ Migration complete!', 'green'));
      console.log(`     From: ${result.fromVersion} → To: ${result.toVersion}`);
      console.log(`     Steps executed: ${result.steps.length}`);
      for (const [i, step] of result.steps.entries()) {
        console.log(`       ${i + 1}. ${step.from} → ${step.to}: ${step.name}`);
      }
      console.log(`     Backup: ${result.backupPath}`);
      console.log('');
    }
  } catch (e) {
    failJson(options, e.message);
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
    const pocketPresent = !!findPocketDir(projectDir);

    if (options.json) emitJson({ ok: true, hook: result, pocket: pocketPresent });

    console.log('');
    if (result.action === 'created') {
      console.log(colorize('  ✅ Pre-commit hook installed', 'green'));
    } else if (result.action === 'appended') {
      console.log(colorize('  ✅ Pre-commit hook appended to existing hook', 'green'));
    } else if (result.action === 'upgraded') {
      console.log(colorize('  ✅ Pre-commit hook upgraded (pocket check + sync + verify)', 'green'));
    } else if (result.action === 'already-installed') {
      console.log(colorize('  ℹ️  Pre-commit hook already installed', 'cyan'));
    }
    console.log(`     Hook path: ${result.hookPath}`);
    console.log('');
    console.log('  Before each commit the hook will:');
    console.log('    1. check that a ' + POCKET_DIR_NAME + '/ exists here — if not, it skips (so an');
    console.log('       un-bootstrapped repo never has its commits blocked)');
    console.log('    2. run "context-pocket sync --auto" — auto-record staged files that');
    console.log('       were missed in recent T-blocks (git safety net for agent forgets)');
    console.log('    3. run "context-pocket verify --quiet" — block on errors, allow warnings');
    console.log('');
    if (!pocketPresent) {
      console.log(colorize('  ⚠️  No ' + POCKET_DIR_NAME + '/ in this project yet.', 'yellow'));
      console.log('     The hook is installed but will skip every commit until you run:');
      console.log('       context-pocket bootstrap --dir ' + projectDir);
      console.log('');
    }
    console.log('  Run "context-pocket install-hook" again anytime to upgrade the hook.');
    console.log('');
  } catch (e) {
    failJson(options, e.message);
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

    if (options.json) emitJson({ ok: true, hook: result });

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

  if (options.json) emitJson(Object.assign({ ok: true }, result));

  console.log('');
  console.log(colorize(`  ✅ Search index ${result.unchanged ? 'already up to date' : result.rebuilt ? 'built' : 'refreshed'}`, 'green'));
  console.log(`     Docs indexed: ${result.docsCount} (T-blocks + ADRs + reqs + prefs)`);
  console.log(`     Terms: ${result.termsCount}`);
  if (!result.rebuilt) {
    console.log(`     Delta: +${result.added} added · ~${result.updated} updated · -${result.removed} removed · ${result.reused} reused`);
    // 增量是否真的生效看这一行：一次 append 只该重分词那 1 篇
    console.log(`     Re-tokenized: ${result.retokenized} of ${result.docsCount} docs`);
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
  // --recent-keep 曾被 --help 承诺但从未传给 distill()，所以永远只用 config.recent_keep
  const recentKeep = options['recent-keep'] === undefined
    ? undefined
    : intOption(options['recent-keep'], undefined);

  const result = distill(pocketDir, { dryRun, recentKeep });

  if (options.json) {
    // 报"生效的那个数"而不是"旗标给没给"：没给 --recent-keep 时用的是 config.recent_keep，
    // 报 null 会让人以为窗口没生效（判据一直是对的，只是这个数字会骗人）
    emitJson(Object.assign({ ok: true }, result));
  }

  console.log('');
  if (result.nothing) {
    console.log(colorize('  ℹ️  Nothing to distill yet:', 'cyan'));
    console.log('     No log-archive.md and no old turns in log.md.');
    console.log('     Distill becomes useful once archiving has moved old T-blocks out (context-pocket archive).');
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
  console.log('  then delete the report. In agent mode, just ask for a digest of the old turns.');
  console.log('');
}

// ============================================================
// 命令：import — 历史会话导入
// ============================================================

function cmdImport(options) {
  const pocketDir = ensurePocket(options);
  const dryRun = !!options['dry-run'];
  const limit = intOption(options.limit, 100);
  const truncate = intOption(options.truncate, 400);

  // 会话文件路径有三种写法（--file / --file-path / -f）。缺值时在 CLI 层就说清楚，
  // 不等 lib/importer.js 抛出那句只认 `--file` 的错误 —— 猜对别名的人不该被告知"你只能用 --file"。
  const sessionFile = filePathOption(options);
  if (!sessionFile) {
    failJson(options, 'session file is required. Usage: context-pocket import --file <session.jsonl> (also --file-path <p>, -f <p>)');
    console.error(colorize('\n  ❌ Error:', 'red') + ' session file is required');
    console.error('     Usage: context-pocket import --file <session.jsonl> [options]');
    console.error('     (also accepted: --file-path <p>, -f <p> — same as MCP filePath)\n');
    process.exit(1);
  }

  const result = importSession(pocketDir, {
    file: sessionFile,
    source: options.source || 'auto',
    limit,
    truncate,
    dryRun,
  });

  if (options.json) emitJson(Object.assign({ ok: true }, result));

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
      if (options.json) {
        emitJson({ ok: true, hubFile: getHubFile(), count: entries.length, preferences: prefs || {} });
      }
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

    if (missingValue(options, 'key')) {
      failJson(options, '--key is required (or --list for all global preferences)');
      console.error(colorize('\n  ❌ Error:', 'red') + ' --key is required');
      console.error('     Usage: context-pocket hub pref --key "<k>" --value "<v>"   (set)');
      console.error('            context-pocket hub pref --key "<k>"                 (get)');
      console.error('            context-pocket hub pref --list                      (all)\n');
      process.exit(1);
    }

    // `--value` 给了却没带值：既不是"设值"，也不能悄悄当成"取值"——那会让人以为写进去了。
    // 直接判错，hub.json 一个字节都不动。
    const prefValue = textOption(options, 'value');
    if (options.value !== undefined && prefValue === undefined) {
      failJson(options, '--value was given without a value — nothing was stored');
      console.error(colorize('\n  ❌ Error:', 'red') + ' --value needs a value');
      console.error('     Usage: context-pocket hub pref --key "<k>" --value "<v>"');
      console.error('            (no value written — use "hub pref --key \\"<k>\\"" to read it)\n');
      process.exit(1);
    }

    if (prefValue === undefined) {
      const v = getGlobalPref(options.key);
      if (options.json) {
        emitJson({ ok: true, key: options.key, value: v, found: v !== null && v !== undefined });
      }
      console.log('');
      console.log(v === null
        ? colorize(`  (no global pref "${options.key}")`, 'dim')
        : `  ${options.key}: ${v}`);
      console.log('');
      return;
    }

    const r = setGlobalPref(options.key, prefValue);
    if (options.json) {
      emitJson({ ok: true, key: options.key, value: prefValue, isNew: !!r.isNew, hubFile: getHubFile() });
    }
    console.log('');
    console.log(colorize(`  ✅ Global preference ${r.isNew ? 'added' : 'updated'}:`, 'green'));
    console.log(`     ${options.key}: ${prefValue}`);
    console.log(`     Stored in: ${getHubFile()}`);
    console.log('');
    return;
  }

  // hub remove — 从注册表移除项目
  if (action === 'remove' || action === 'rm') {
    const projectDir = getProjectDir(options);
    const removed = removeProject(projectDir);
    if (options.json) {
      emitJson({ ok: true, action: 'remove', projectDir, removed: !!removed });
    }
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
  if (options.json) {
    emitJson({
      ok: true,
      hubDir: getHubDir(),
      count: projects.length,
      projects: projects.map(({ key, project }) => Object.assign({ key }, project)),
    });
  }
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

  // version —— 放在 help 分支之前：只写 `context-pocket --version` 时 command 是空的，
  // 会掉进默认 help，用户要的号码被整页帮助盖掉（1.1.0 之前的实际行为）。
  if (cmd === 'version' || args.options.version || args.options.v) {
    cmdVersion(args.options);
    return;
  }

  // help
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    cmdHelp(args.options);
    return;
  }

  // bootstrap
  if (cmd === 'bootstrap') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket bootstrap [options]

  Initialize ContextPocket/ directory with template files.
  Nothing is overwritten: if ContextPocket/ already exists this is a no-op
  (exit 0) — read index.md + state.md and keep recording.

  Options:
    --project-type <type>  Project type: frontend/backend/fullstack/data/mobile
                           (auto-detected if not specified)
    --mode <full|lite>     full = all 10 core files; lite = 5 core files (default: full)
    --language <zh|en>     Default language for tags and prompts (default: zh)
    --gitignore <bool>     true = ignore ContextPocket/ in .gitignore (default);
                           false = commit ContextPocket/ (sync across machines via git)
    --no-hub               Do not add this project to the user hub (~/.contextpocket/hub.json).
                           By default every bootstrap registers the pocket there; use this for
                           throwaway directories, script runs and CI so they leave nothing behind
                           in your home. Run the same command without it to register later.
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

  Run health check on ContextPocket/. 15 checks by default: file existence, T/R/ADR id
  continuity, T-block section format, reference integrity, index consistency, code-map drift,
  handoff staleness, header T agreement, implausible ids, log size vs archive_at, the
  credential/PII scan, format-version lag, and attachment existence — a "### Attachments"
  line naming a file that is not on disk is an ERROR. Placeholders (<...>), URLs, absolute
  paths, paths that leave the pocket (../) and entries already written as
  "[missing: T<n> <file>]" are skipped, so the check reports only what the record claims and
  the disk does not have.

  The credential scan decides severity by what a leak costs: vendor-shaped keys
  (sk-ant-…, AKIA…, ghp_…, private-key blocks, JWT) are ERRORS — they block pre-commit and
  make archive/migrate refuse. Personal data (ID numbers, card numbers, phone numbers,
  password: xxxx) is a WARNING and never blocks a commit. Findings print a masked prefix
  only. Set "- secret_scan: false" in config.md to switch the check off.

  Options:
    --quiet             Only show errors and warnings
    --drift             Enable the two tree-scanning checks (slower than default):
                        1) cognition drift — paths mentioned in recent T-blocks vs working tree
                        2) code newer than log — files whose mtime is later than the last record,
                           which catches unlogged edits in projects that aren't a git repo
                        (1) is inspired by AOCI-CODE's cognition refresh.
                        Both are WARNING-only, so pre-commit never blocks on them.
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

  Coverage is judged on evidence strength: a staged file counts as recorded only
  if its path appears in a recent T-block's Action section. A file that shows up
  elsewhere (Uncertain / Attachments / Conflicts / Pitfalls) still counts as
  unrecorded, but the report names the turn and section that mentioned it, since
  the right fix there is "log amend T<n> --action" rather than a new [auto] block.

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
    --t-id <n>     T-id as an option instead of positional (MCP name: tId).
                   --t <n> and --id <n> are accepted aliases.
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
    --t-a <n>      First T-block (MCP name: tA) — instead of the positional pair
    --t-b <n>      Second T-block (MCP name: tB)
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
  Usage: context-pocket search <keyword> [--limit <N>] [--offset <N>]

  Search T-blocks (gist + tags + every section, live log and archive), ADRs,
  requirements and preference lines by keyword. It uses the search index, and
  rebuilds it on the spot when the cache is missing, corrupt, stale, or written
  by an older index format; only when even that fails (read-only disk, the path
  is taken by something else) does it fall back to a full scan. Every path
  returns the same matches in the same order, so paging works either way.

  Results are capped at 50 per page; the summary always reports the true total.

  Options:
    --limit <N>    Matches per page (default 50, 0 = all)
    --offset <N>   Skip the first N matches (next page)
    --no-index     Skip the cached index and scan the markdown
                   (Here it means "don't trust the cache for this query". On
                    "log append" / "log amend" the same flag means "don't
                    refresh the cache after this write" — markdown stays the
                    source of truth either way, so search results don't change.)
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

  Searches every T-block section (User, Action, Commits, Decisions & Constraints,
  Pitfalls, Preferences, Conflicts, Attachments, Uncertain) and archived turns.

  Each hit is labelled by evidence strength:
    [changed]          the path appears in that turn's Action section
    [mentioned only]   it appears elsewhere (Uncertain / Attachments / Conflicts …),
                       which does NOT mean that turn modified the file
  Turns that changed the file are listed first; within each group, most recent first.

  Examples:
    context-pocket why lib/parser.js
    context-pocket why CHANGELOG.md --limit 5
    context-pocket why --file-path lib/parser.js    (same path, flag form)

  Options:
    --limit <N>       Max T-blocks to return (default: 10)
    --dir <path>      Project directory
    The path is normally the positional argument. As a flag it accepts
    --file-path <p> (matching MCP filePath), --file <p> and -f <p>.
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
    --author <text>      Who records this turn (your agent id, not the user).
                         Several agents share one ContextPocket/; this is what
                         tells their turns apart later. Goes in ### Author.
    --user <text>        User request text (### User — verify makes a block
                         without it an ERROR, and an ERROR blocks archive,
                         migrate and the pre-commit hook)
    --action <text>      Action description (### Action — same rule as --user;
                         omit it and the append still succeeds, but it now says
                         so on the same line as the ✅)
    --commits <csv>      Commit hashes
    --decisions <text>   Decisions & constraints
    --pitfalls <text>    Pitfalls discovered (alias: --pitfall)
    --preferences <text> Preferences noted
    --conflicts <text>   Conflicts detected
    --attachments <text> Attachment references
    --uncertain <text>   Uncertain items
    --when <text>        When this turn happened (v2+ pockets only).
                         "2026-10-03 09:00 → 11:30" · day-only range
                         "2026-05-01 → 2026-05-03" · "2026-10-03" / any
                         verbatim words ("上周三下午" — stored as-is, never
                         computed). Default: the write clock.
    --no-conflict-check  Skip the write-time conflict scan (it runs by default:
                         the 6-dimension scan is replayed as if this block were
                         already in log.md, and anything it newly finds is
                         recorded in this block's Conflicts section as
                         "[auto] …" and printed here).
    --verify             Run the full pocket health check after appending and
                         exit 1 if it finds errors (opt-in here; the MCP tool
                         context_pocket_log_append runs it unless you pass
                         verify=false — the difference is deliberate: a full
                         verify re-reads every file, which on an 800-turn
                         pocket is paid on every single append).
    --no-index           Skip the index refresh that normally happens right
                         after the write. The turn is still in log.md and still
                         searchable — the next search notices the source files
                         changed and rebuilds the cache itself. Safe; the cost
                         is that one slower search. Bulk loops that append many
                         turns in a row (a test harness, re-logging a long
                         session by hand) are what this is for. How much it
                         saves scales with the pocket: ~15 ms/turn at 30 turns,
                         ~0.18 s/turn at 800 — and a one-shot CLI call already
                         pays ~112 ms of Node startup, so the real win is in a
                         resident MCP server or a long loop, not here.
                         Note: on "search" the same flag reads the other way
                         ("ignore the cache for this query"), and on "log amend"
                         it does exactly what it does here.
    --dir <path>         Project directory

  Example:
    context-pocket log append --gist "改登录超时" --when "2026-10-03 09:00 → 11:30"
`);
      return;
    }
    cmdLogAppend(args.options);
    return;
  }

  // log amend
  if (cmd === 'log' && sub === 'amend') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket log amend <T-id> --user <text> [options]

  Fill in sections that are MISSING from an already-written T-block.
  Never overwrites existing content — this completes a half-written turn,
  it does not rewrite history.

  Why this exists: "verify" reports a T-block with no "### User" / "### Action"
  section as an ERROR, and the pre-commit hook blocks commits on errors. Before
  this command there was no way to fix it except hand-editing markdown (which
  the skill forbids) or "git commit --no-verify".

  Options:
    --t-id <n>             T-block to fill, instead of the positional <T-id>
                           (--t <n> / --id <n> are accepted aliases; MCP name: tId)
    --author <text>      Who recorded that turn (fills a missing ### Author only)
    --user <text>        User's original request for this turn
    --action <text>      What was done
    --commits <csv>      Commit hashes
    --decisions <text>   Decisions & constraints
    --pitfalls <text>    Pitfalls discovered (alias: --pitfall)
    --preferences <text> Preferences noted
    --conflicts <text>   Conflicts detected
    --attachments <text> Attachment references
    --uncertain <text>   Uncertain items
    --when <text>        Time for this turn, same forms as "log append".
                         Added only when the block has no time line yet, or
                         when its current line is day-only (a v1→v2 migration
                         artifact). A timestamp recorded at the time is
                         history — amend refuses to overwrite it.
    --no-index           Skip the index refresh after the fill-in (same meaning
                         as on "log append": the amended sections stay
                         searchable, the next search rebuilds the cache)
    --dir <path>         Project directory

  Example:
    context-pocket log amend 7 --user "登录接口报 500" --action "修复 src/auth/session.ts 空指针"
`);
      return;
    }
    cmdLogAmend(args.options, args.positional);
    return;
  }

  // absolute add
  if (cmd === 'absolute' && sub === 'add') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket absolute add --text <verbatim> [--gist <short>]

  Append a 🔒 red-line entry to absolute.md — verbatim, never compressed,
  never archived. Use this for architecture / tech / code constraints a future
  agent must not silently violate (NOT for schedule or scope emphasis).

  Options:
    --text <text>        The user's requirement, saved verbatim (required)
    --gist <text>        Short summary used for conflict keyword matching
                         (default: first sentence of --text)
    --t-id <n>           Associate with a specific T (default: latest T).
                         Same one T id as everywhere else: --t <n> / --id <n> work too
    --dir <path>         Project directory

  Example:
    context-pocket absolute add --text "绝不改动 /api/v1 的响应字段" --gist "API v1 形状冻结"
`);
      return;
    }
    cmdAbsoluteAdd(args.options, args.positional);
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
    --keep-last <N>      Keep latest N T-blocks in log.md (default: config.md recent_keep)
    --dry-run            Show what would be archived, don't modify files
    --dir <path>         Project directory
`);
      return;
    }
    cmdArchive(args.options);
    return;
  }

  // repair
  if (cmd === 'repair') {
    if (args.options.help || args.options.h) {
      console.log(`
  Usage: context-pocket repair [options]

  Fix duplicate T-ids in log.md. This is what two agents writing to the same
  ContextPocket/ produce: each one computes its next id as "latest + 1" inside
  its own machine, so both write T9 and the merge leaves two "## T9" blocks.
  verify reports that as an ERROR, and the only fix it can offer is "rename by
  hand" — repair does the renaming instead.

  What it does:
    - shifts the colliding block and every block after it up by one, so ids
      increase with file order (log.md is append-only history)
    - keeps every line of every block verbatim; only the heading numbers move
    - lists the places that still cite an old number (requirements.md,
      decisions.md, state.md, other blocks' text...) — by default it does NOT
      rewrite them, because "T9" meant two different blocks and only a reader
      knows which one each reference was pointing at
    - appends a record block so the pocket itself says the tool moved numbers
    - backs up each file it touches and rolls all of them back if the post-repair
      verify is not at least as clean as before

  What it never does:
    - a "reference" must be a STANDALONE T<n>. GPT4, RTX4090, UTF8 contain the
      shape but are words, so --apply-refs leaves them exactly as written
    - attachment file names (T04-diagram.png, assets/T04-diagram.png) are not
      references either, and are never rewritten even with --apply-refs:
      renaming is two halves — mv the file, then edit the text — and doing only
      the second half leaves a broken link and drops the zero-padding. They are
      listed with the ready-made mv command; run it, then context-pocket verify
    - log-archive.md is reported, never modified (it declares itself read-only)

  Options:
    --dry-run            Show the plan, change nothing
    --apply-refs         Also rewrite standalone old T-numbers in the files above
    --author <text>      Sign the record block (which agent ran the repair)
    --dir <path>         Project directory
`);
      return;
    }
    cmdRepair(args.options);
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
    --pitfall <text>     Append a pitfall (alias: --pitfalls)
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
  Backs up the whole directory first; on failure it restores that backup and
  then removes it (a copy of the state you are already back in). Only a run
  that fully succeeds keeps ContextPocket.backup-<timestamp>/ for comparison.
  A pocket that already fails "verify" is refused — nothing is written.

  The migration registry is a chain of one-hop steps (v1 -> v2 -> v3). A single
  "migrate" walks every hop needed: each hop is verified before it runs, the
  format stamp is bumped after it succeeds, and if any hop (or the final check)
  fails the whole ContextPocket/ directory is restored from the pre-run backup —
  history is either fully upgraded or fully untouched, never half-migrated.

  Options:
    --to <version>       Target version: "v2", "2" or "V2" all mean v2;
                         "latest" (default) = newest reachable in the registry
    --dry-run            Show the full multi-hop plan, don't modify files
    --list               Show the version registry + planned path without executing
                         (--list-only is accepted as an alias)
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
    0. look upward from the working directory for a ContextPocket/ folder — none
       found means "this project is not recorded", so the hook says so and exits
       0 (it must never lock out commits in a project with no pocket)
    1. context-pocket sync --auto    — auto-record staged files missed in recent
                                        T-blocks (git safety net for agent forgets)
    2. context-pocket verify --quiet — block commit on errors; warnings allowed

  Re-running this command refreshes the managed section (upgrades v1/v2 → v3 and
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
    --file-path <p>   Same file, spelled like MCP filePath (--file / -f also work)
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

  const unknown = cmd + (sub ? ' ' + sub : '');
  failJson(args.options, 'Unknown command: ' + unknown);
  console.error(colorize('\n  ❌ Unknown command:', 'red') + ' ' + unknown);
  console.error('     Run "context-pocket help" for available commands.\n');
  process.exit(1);
}

// ============================================================
// 入口
// ============================================================

function runCli() {
  try {
    main();
  } catch (e) {
    // lib 层会抛错（writeAtomic、锁超时、import 缺文件……）。
    // --json 消费方拿到 Node 堆栈就没法解析了，所以这里统一转成一行 JSON。
    const wantsJson = parseArgs(process.argv).options.json;
    if (wantsJson) {
      emitJson({ ok: false, error: e.message }, 1);
    }
    console.error(colorize('\n  ❌ Error:', 'red') + ' ' + (e && e.message ? e.message : String(e)));
    console.error('');
    process.exit(1);
  }
}

module.exports = { parseArgs, runCli, HELP_COL };

if (require.main === module) {
  runCli();
}
