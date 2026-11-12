#!/usr/bin/env node
'use strict';

/**
 * ContextPocket Lite — CLI 入口
 *
 * 11 条命令：bootstrap / status / log append / log amend / recall / search / why /
 * diff / verify / graph / handoff。
 * 骨架与主包 bin/context-pocket.js 同源（参数解析、--json 契约、退出码语义），
 * 帮助文本单源在 lite/lib/help.js。CLI 命令与 MCP 工具（mcp-server-lite.js）
 * 一一对应，lite/tests/core.js 钉着这个对称。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const fs = require('fs');
const path = require('path');

const { findPocketDir, readConfig, parseAll } = (() => {
  const core = require('../lib/core');
  const parser = require('../lib/parser');
  return { findPocketDir: core.findPocketDir, readConfig: core.readConfig, parseAll: parser.parseAll };
})();

const { POCKET_DIR_NAME } = require('../lib/constants');
const { bootstrap } = require('../lib/bootstrap');
const { verify } = require('../lib/validator');
const { recall, recallWindow, searchAny, why, diff } = require('../lib/query');
const { deriveLinks, buildContext, formatContextLines } = require('../lib/links');
const { turnFields, textOption, sectionFields, hasAnySection } = require('../lib/fields');
const { describeWhen, describeWhenLine } = require('../lib/when');
const { colorize, formatVerifyResult, formatStatus } = require('../lib/formatter');
const { pkgVersion } = require('../lib/version');

// ============================================================
// 解析命令行参数
// ============================================================

// 明确"带值"的选项名（Lite 命令面用到的那个子集；规则与主包同一套）
const VALUE_OPTIONS = new Set([
  'action', 'attachments', 'author', 'commits', 'conflicts', 'decisions', 'dir', 'expand', 'f', 'file',
  'file-path', 'from', 'gist', 'gitignore', 'language', 'limit', 'offset', 'pitfall', 'pitfalls',
  'preferences', 'project-type', 'since', 't-a', 't-b', 'tags', 'to', 'type', 'uncertain', 'until', 'user', 'when',
]);

// 纯开关型选项：绝不吞掉后面的裸词
const BOOL_OPTIONS = new Set([
  'help', 'h', 'json', 'quiet', 'verify', 'version', 'v', 'with-context',
]);

// 真实存在的两段式命令
const SUBCOMMANDS_BY_COMMAND = {
  log: ['append', 'amend'],
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
      // 容忍 `--gitignore: false` 这种从文档里抄来的写法
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
        // 已知值型选项：值本身以 "-" 开头也照收（`--gist -weird`）
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
        result.subcommand = arg;
        continue;
      }
    }
    result.positional.push(arg);
  }

  return result;
}

// ============================================================
// --json：机器可读输出（与主包同一契约：一行 JSON、无颜色、退出码一致）
// ============================================================

function emitJson(payload, exitCode) {
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(exitCode || 0);
}

/** --json 下的失败出口：错误也是机器可读的一行 JSON */
function failJson(options, message) {
  if (options && options.json) {
    emitJson({ ok: false, error: message }, 1);
  }
}

function ensurePocket(options) {
  const startDir = options.dir || process.cwd();
  const pocketDir = findPocketDir(startDir);
  if (!pocketDir) {
    failJson(options, 'No ContextPocket/ directory found. Run "context-pocket-lite bootstrap" first, or use --dir to specify a project path.');
    console.error(colorize('\n  ❌ Error:', 'red') + ' No ContextPocket/ directory found.');
    console.error('     Run "context-pocket-lite bootstrap" first, or use --dir to specify a project path.\n');
    process.exit(1);
  }
  return pocketDir;
}

function getProjectDir(options) {
  return options.dir ? path.resolve(options.dir) : process.cwd();
}

// toTId / intOption 来自 lib/core：CLI 与 MCP 共用同一套数值/编号归一规则
const { toTId, intOption, stripPlaceholders } = require('../lib/core');

/**
 * "必填的文本选项"是否缺值。判据在 lib/fields.js 的 textOption()，CLI 与 MCP 共用。
 */
function missingValue(options, name) {
  return textOption(options, name) === undefined;
}

/** 一个 T 号：长写法 `--t-id` 与 MCP 的 `tId` 同名，历史别名 `--t` / `--id` 继续可用。 */
const T_ID_OPTIONS = ['t-id', 't', 'id'];
function tIdOption(options) {
  return textOption(options, ...T_ID_OPTIONS);
}

/** 一个文件路径：长写法 `--file-path` 对齐 MCP 的 `filePath`，`--file` / `-f` 是既有写法。 */
const FILE_PATH_OPTIONS = ['file-path', 'file', 'f'];
function filePathOption(options) {
  return textOption(options, ...FILE_PATH_OPTIONS);
}

// ============================================================
// 命令：help / version
// ============================================================

const { HELP_GROUPS, HELP_COL, HELP_OPTIONS, commandHelp } = require('../lib/help');

function cmdHelp(options) {
  const opts = options || {};
  if (opts.json) {
    emitJson({
      ok: true,
      usage: 'context-pocket-lite <command> [options]',
      groups: HELP_GROUPS.map((g) => ({
        group: g.group,
        commands: g.commands.map((c) => ({ command: c[0], summary: c[1] })),
      })),
      options: HELP_OPTIONS.map((o) => ({ option: o[0], summary: o[1] })),
    });
  }

  const lines = [];
  lines.push('');
  lines.push(colorize('  ContextPocket Lite CLI', 'bold'));
  lines.push('  Record dev conversations into your project — the light way.');
  lines.push('');
  lines.push(colorize('  Usage:', 'bold'));
  lines.push('    context-pocket-lite <command> [options]');
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
  lines.push('  Run "context-pocket-lite <command> --help" for command-specific help.');
  lines.push('');
  console.log(lines.join('\n'));
}

/**
 * 命令：version（`--version` / `-v` / `context-pocket-lite version`）
 *
 * 只读 lite/package.json（lib/version.js），不需要 ContextPocket/ 目录。
 * 对外展示：hotfix 预发布显示完整串（2.0.1-Lite-hotfix1）；稳定版两位加 -lite。
 */
function cmdVersion(options) {
  const opts = options || {};
  const info = pkgVersion();
  if (opts.json) {
    emitJson({
      ok: true,
      name: 'context-pocket-lite',
      version: info.version,
      display: info.display,
      source: info.source,
      node: process.version,
    });
  }
  console.log('');
  console.log(colorize('  ContextPocket Lite CLI', 'bold') + ' ' + info.display);
  console.log('    version: ' + info.version + ' (source: ' + (info.source === 'package.json'
    ? 'package.json'
    : 'built-in fallback (no package.json next to the binary)') + ')');
  console.log('    node:    ' + process.version);
  console.log('');
}

// ============================================================
// 命令：bootstrap
// ============================================================

function cmdBootstrap(options) {
  const projectDir = getProjectDir(options);

  // 幂等：已经有 ContextPocket/ 不是"失败"，而是"早就在记了"。
  // 库层那道"拒绝覆盖"保护原样保留。
  const existingPocket = path.join(projectDir, POCKET_DIR_NAME);
  if (fs.existsSync(existingPocket) && fs.statSync(existingPocket).isDirectory()) {
    if (options.json) {
      emitJson({ ok: true, alreadyExists: true, projectDir, pocketDir: existingPocket });
    }
    console.log('');
    console.log(colorize('  ℹ️  ContextPocket/ already exists — nothing to create, keep recording.', 'cyan'));
    console.log(`     ${existingPocket}`);
    console.log(colorize('     Read index.md + state.md to pick up where the last session left off.', 'dim'));
    console.log('');
    return;
  }

  try {
    // Lite 永远建 lite 口袋（5 个核心文件，零缓存目录）
    const result = bootstrap(projectDir, {
      projectType: options['project-type'],
      mode: 'lite',
      language: options.language,
      gitignore: options.gitignore !== undefined
        ? options.gitignore !== 'false' && options.gitignore !== false
        : undefined,
    });

    if (options.json) {
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
      });
    }

    console.log('');
    console.log(colorize('  ✅ ContextPocket initialized (lite)!', 'green'));
    console.log(`     Project type: ${result.projectType}`);
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

    // 初始化里"没做成但不致命"的部分必须说出来
    if (result.warnings && result.warnings.length > 0) {
      console.log(colorize(`     ${result.warnings.length} warning(s):`, 'yellow'));
      for (const w of result.warnings) {
        console.log(colorize(`       ⚠ ${w}`, 'yellow'));
      }
    }

    console.log('');
    console.log('  Next steps:');
    console.log('    1. Edit ContextPocket/readme.md with project info');
    console.log('    2. Run "context-pocket-lite verify" to check health');
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
  const result = verify(pocketDir);

  if (options.json) {
    emitJson(Object.assign({ ok: result.errorCount === 0, pocketDir }, result), result.errorCount > 0 ? 1 : 0);
  }

  console.log(formatVerifyResult(result, { quiet: options.quiet || config.quiet }));

  if (result.errorCount > 0) {
    process.exit(1);
  }
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

/**
 * 时间窗口的人类可读说明。search 与 recall 的窗口模式共用一份措辞。
 */
function timeWindowLabel(sinceT, untilT, fromDate, toDate) {
  const parts = [];
  if (sinceT !== null || untilT !== null) {
    parts.push(
      'T号: ' +
      (sinceT !== null ? `>= T${sinceT}` : '') +
      (sinceT !== null && untilT !== null ? ' 且 ' : '') +
      (untilT !== null ? `<= T${untilT}` : '')
    );
  }
  if (fromDate !== null || toDate !== null) {
    parts.push(
      '日期: ' +
      (fromDate !== null ? `>= ${fromDate}` : '') +
      (fromDate !== null && toDate !== null ? ' 且 ' : '') +
      (toDate !== null ? `<= ${toDate}` : '')
    );
  }
  return parts.join(' · ');
}

/** 窗口模式：列一段时间线，而不是某一轮的全文 */
function printRecallWindow(options, pocketDir, w) {
  const out = recallWindow(pocketDir, {
    sinceT: w.sinceT,
    untilT: w.untilT,
    fromDate: w.fromDate,
    toDate: w.toDate,
    limit: options.limit,
    offset: options.offset,
  });

  if (options.json) {
    emitJson({
      ok: true,
      mode: 'window',
      sinceT: w.sinceT,
      untilT: w.untilT,
      fromDate: w.fromDate,
      toDate: w.toDate,
      count: out.turns.length,
      total: out.total,
      offset: out.offset,
      limit: out.limit,
      hasMore: out.hasMore,
      turns: out.turns,
    });
  }

  const label = timeWindowLabel(w.sinceT, w.untilT, w.fromDate, w.toDate);
  const shown = out.limit !== null && out.turns.length < out.total
    ? colorize(` · showing ${out.offset + 1}–${out.offset + out.turns.length}`, 'dim')
    : '';
  console.log('');
  console.log(colorize(`  Recall: ${out.total} turn${out.total === 1 ? '' : 's'}`, 'bold') +
    (label ? colorize('  ( ' + label + ' )', 'dim') : '') + shown);
  console.log('  ' + colorize('─'.repeat(40), 'dim'));

  if (out.turns.length === 0) {
    console.log('  (no turns in this window)');
  } else {
    for (const t of out.turns) {
      const tags = t.tags.length > 0 ? ' ' + t.tags.map(x => colorize(`[${x}]`, 'cyan')).join('') : '';
      const when = t.when ? describeWhen(t.when) : (t.session || 'no time recorded');
      const archived = t.archived ? colorize('  (archived)', 'dim') : '';
      console.log(`  ${colorize('T' + t.id, 'bold')}  ${colorize(when, 'dim')}${tags}  ${t.gist}${archived}`);
    }
  }
  if (out.hasMore) {
    console.log(colorize(`  … ${out.total - out.offset - out.turns.length} more — next page: --offset ${out.offset + out.turns.length}; all: --limit 0`, 'dim'));
  }
  console.log('');
}

function cmdRecall(options, positional) {
  const pocketDir = ensurePocket(options);
  const tIdStr = positional[0] || tIdOption(options);
  const withContext = !!options['with-context'];

  // 与 search 同一组窗口旗标：intOption / textOption 统一收，垃圾值回落成 null
  const sinceT = intOption(options.since, 0) > 0 ? intOption(options.since, 0) : null;
  const untilT = intOption(options.until, 0) > 0 ? intOption(options.until, 0) : null;
  const fromDate = textOption(options, 'from') || null;
  const toDate = textOption(options, 'to') || null;
  const hasWindow = sinceT !== null || untilT !== null || fromDate !== null || toDate !== null;

  // 两种形态互斥：同时给 T 号和窗口，静默丢掉窗口就是"选项被正常解析、命令悄悄无视"
  if (tIdStr && hasWindow) {
    failJson(options, 'recall: a T-id and a time window cannot be used together. Use either recall <T-id> or recall --since/--until/--from/--to.');
    console.error(colorize('\n  ❌ Error:', 'red') + ' A T-id and a time window cannot be used together.');
    console.error('     Use either `context-pocket-lite recall <T-id>` or `context-pocket-lite recall --since <T> --until <T>`.\n');
    process.exit(1);
  }

  if (!tIdStr && !hasWindow) {
    failJson(options, 'T-id is required. Usage: context-pocket-lite recall <T-id>, or a time window: recall --since <T> --until <T> --from <YYYY-MM-DD> --to <YYYY-MM-DD>');
    console.error(colorize('\n  ❌ Error:', 'red') + ' T-id is required (or a time window)');
    console.error('     Show one turn:  context-pocket-lite recall <T-id>  (or --t-id <n>)');
    console.error('     List a window:  context-pocket-lite recall --since <T> --until <T>');
    console.error('                     context-pocket-lite recall --from <YYYY-MM-DD> --to <YYYY-MM-DD>\n');
    process.exit(1);
  }

  // --with-context 只对单轮形态有意义：窗口模式列的是一串轮次
  if (!tIdStr && withContext) {
    failJson(options, 'recall: --with-context applies to a single T-id, not to a window listing.');
    console.error(colorize('\n  ❌ Error:', 'red') + ' --with-context needs a single T-id.');
    console.error('     Use `context-pocket-lite recall <T-id> --with-context`, or drop the flag for a window.\n');
    process.exit(1);
  }

  if (!tIdStr) {
    printRecallWindow(options, pocketDir, { sinceT, untilT, fromDate, toDate });
    return;
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

  // 图是只读派生的：不给旗标时输出逐字不变（回归锁盯着这一点）
  const context = withContext ? buildContext(pocketDir, tId) : null;
  if (options.json) emitJson(context ? { ok: true, t: result, context } : { ok: true, t: result });

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

  if (context) {
    console.log('  ' + colorize('─'.repeat(40), 'dim'));
    console.log(colorize('  Inbound context (derived, read-only)', 'bold'));
    for (const line of formatContextLines(context)) {
      console.log('  ' + line);
    }
  }
  console.log('');
}

// ============================================================
// 命令：search
// ============================================================

function cmdSearch(options, positional) {
  const pocketDir = ensurePocket(options);
  const keyword = positional[0] || (typeof options.keyword === 'string' ? options.keyword : undefined);

  if (!keyword) {
    failJson(options, 'keyword is required. Usage: context-pocket-lite search <keyword>');
    console.error(colorize('\n  ❌ Error:', 'red') + ' keyword is required');
    console.error('     Usage: context-pocket-lite search <keyword>\n');
    process.exit(1);
  }

  // 4 个过滤旗标：两两等价（T 号窗口 / 日期窗口）
  const sinceT = intOption(options.since, 0) > 0 ? intOption(options.since, 0) : null;
  const untilT = intOption(options.until, 0) > 0 ? intOption(options.until, 0) : null;
  const fromDate = textOption(options, 'from') || null;
  const toDate = textOption(options, 'to') || null;

  // Lite 没有索引：永远现场扫描（与主包 `search --no-index` 同一份实现、同一份排序）
  // --expand：从命中出发走 n 跳现场派生的关联图，扩展轮次追加在分页之后
  const expand = intOption(options.expand, 0);
  const { results, total, hasMore, offset, limit, expandedCount, expansionTruncated } = searchAny(pocketDir, keyword, {
    limit: options.limit,
    offset: options.offset,
    sinceT,
    untilT,
    fromDate,
    toDate,
    expand,
  });

  if (options.json) {
    emitJson({
      ok: true,
      keyword,
      sinceT,
      untilT,
      fromDate,
      toDate,
      count: results.length - expandedCount,
      total,
      offset,
      limit,
      hasMore,
      viaIndex: false,
      expandedCount,
      expansionTruncated,
      expand,
      results,
    });
  }

  // 时间窗口说明（人类输出头部）：措辞与 recall 的窗口模式共用一份
  const label = timeWindowLabel(sinceT, untilT, fromDate, toDate);

  console.log('');
  // 扩展出来的轮次单独一组：它们不是关键词命中，是通过图上的关系连过来的，
  // 混在命中里会让「3 matches found」这句话变假。
  const direct = results.filter((r) => !r.expanded);
  const linked = results.filter((r) => r.expanded);

  console.log(colorize(`  Search: "${keyword}"`, 'bold') + (label ? colorize('  ( ' + label + ' )', 'dim') : ''));
  const shown = limit !== null && direct.length < total
    ? colorize(` · showing ${offset + 1}–${offset + direct.length}`, 'dim')
    : '';
  console.log(`  ${total} match${total !== 1 ? 'es' : ''} found${shown}`);
  console.log('  ' + colorize('─'.repeat(40), 'dim'));

  if (direct.length === 0) {
    console.log('  (no matches)');
  } else {
    for (const r of direct) {
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
      } else if (r.type === 'FIX') {
        const fixTags = r.tags && r.tags.length > 0
          ? ' ' + r.tags.map(t => colorize(`[${t}]`, 'cyan')).join('')
          : '';
        console.log(`  ${colorize(r.fixId, 'bold')}${fixTags} · ${r.gist} ${colorize('→ corrects T' + r.targetId, 'dim')}${r.archived ? colorize(' (archived)', 'dim') : ''}`);
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

  if (linked.length > 0) {
    console.log('  ' + colorize('─'.repeat(40), 'dim'));
    console.log(colorize(`  Related via graph (${linked.length} turn${linked.length === 1 ? '' : 's'}):`, 'cyan'));
    for (const r of linked) {
      const hops = r.distance + ' hop' + (r.distance === 1 ? '' : 's');
      console.log(`  ${colorize('T' + r.id, 'bold')} ${colorize('[linked]', 'magenta')} · ${r.gist} ${colorize('(via ' + r.via + ', ' + hops + ')', 'dim')}`);
    }
  }
  // 截断提示独立于 linked 块：最坏情况是扩展轮次全被截掉（linked 为空），
  // 这时更需要告诉用户"还有更多"，而不是静默
  if (expansionTruncated) {
    console.log(colorize('  (additional graph context omitted at the 100-node safety limit)', 'dim'));
  }

  // 截断必须可见：否则用户以为"就这些"，而真实总数在 total 里
  if (hasMore) {
    console.log('  ' + colorize(`  ↳ ${total - offset - direct.length} more — next page: --offset ${offset + direct.length}`, 'dim'));
    console.log('  ' + colorize('    all of them: --limit 0', 'dim'));
  }
  console.log('');
}

// ============================================================
// 命令：why — 反向检索：哪些 T-block 提到这个文件
// ============================================================

function cmdWhy(options, positional) {
  const pocketDir = ensurePocket(options);
  const filePath = positional[0] || filePathOption(options);

  if (!filePath) {
    failJson(options, 'file path is required. Usage: context-pocket-lite why <file-path> [--limit <N>] (or --file-path <p>, aliases --file / -f)');
    console.error(colorize('\n  ❌ Error:', 'red') + ' file path is required');
    console.error('     Usage: context-pocket-lite why <file-path> [--limit <N>]');
    console.error('     (also accepted: --file-path <p>, --file <p>, -f <p> — same as MCP filePath)\n');
    console.error('     Example: context-pocket-lite why lib/parser.js\n');
    process.exit(1);
  }

  const limit = Math.max(1, intOption(options.limit, 10));
  const expand = intOption(options.expand, 0);
  const results = why(pocketDir, filePath, { limit, expand });

  // linked = 通过图上的关系连过来的轮次（它没碰过这个文件）；分开显示，
  // count 也只数真正提到过这个文件的那些。
  const direct = results.filter(r => r.evidence !== 'linked');
  const linked = results.filter(r => r.evidence === 'linked');

  if (options.json) {
    emitJson({
      ok: true,
      file: filePath,
      count: direct.length,
      limit,
      results,
      expanded: { depth: expand, count: linked.length, truncated: !!results.expansionTruncated },
    });
  }

  console.log('');
  console.log(colorize(`  Why: "${filePath}"`, 'bold'));
  const changedN = direct.filter(r => r.evidence === 'changed').length;
  const mentionedN = direct.length - changedN;
  console.log(
    `  ${direct.length} T-block${direct.length !== 1 ? 's' : ''} referenced this file` +
    (direct.length > 0 ? colorize(` (${changedN} changed it, ${mentionedN} only mentioned it)`, 'dim') : '')
  );
  console.log('  ' + colorize('─'.repeat(40), 'dim'));

  if (direct.length === 0) {
    console.log('  (no references found)');
  } else {
    for (const r of direct) {
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

  if (linked.length > 0) {
    console.log('  ' + colorize('─'.repeat(40), 'dim'));
    console.log(colorize(`  Related via graph (${linked.length} turn${linked.length === 1 ? '' : 's'}):`, 'cyan'));
    for (const r of linked) {
      const hops = r.distance + ' hop' + (r.distance === 1 ? '' : 's');
      console.log(`  ${colorize('T' + r.id, 'bold')} ${colorize('[linked]', 'magenta')} · ${r.gist} ${colorize('(via ' + r.via + ', ' + hops + ')', 'dim')}`);
    }
  }
  if (results.expansionTruncated) {
    console.log(colorize('  (additional graph context omitted at the 100-node safety limit)', 'dim'));
  }
  console.log('');
}

// ============================================================
// 命令：graph — 运行时派生关联图（Lite 无缓存）
// ============================================================

// graph 认的边类型；--type 给别的值是用户拼错了，明确报错而不是静默过滤成空
const GRAPH_EDGE_TYPES = ['modifies', 'mentions', 'references', 'decided-in', 'supersedes', 'last-changed',
  'tagged', 'opened-in', 'completed-in', 'implements'];

function cmdGraph(options) {
  const pocketDir = ensurePocket(options);

  const typeFilter = options.type === undefined || options.type === true || String(options.type).trim() === ''
    ? null
    : String(options.type).trim();
  if (typeFilter && !GRAPH_EDGE_TYPES.includes(typeFilter)) {
    failJson(options, 'graph: unknown edge type "' + typeFilter + '". Known types: ' + GRAPH_EDGE_TYPES.join(', ') + '.');
    console.error(colorize('\n  ❌ Error:', 'red') + ' Unknown edge type: ' + typeFilter);
    console.error('     Known types: ' + GRAPH_EDGE_TYPES.join(', ') + '\n');
    process.exit(1);
  }

  const limit = intOption(options.limit, 100);
  // Lite：每次调用都现场派生，零写盘 —— 没有缓存，也就没有 rebuild / verify
  const graph = deriveLinks(pocketDir);

  let edges = graph.edges;
  if (typeFilter) edges = edges.filter((e) => e.type === typeFilter);
  const total = edges.length;
  const shown = limit === 0 ? edges : edges.slice(0, limit);

  if (options.json) {
    emitJson({
      ok: true,
      action: 'view',
      derived: 'runtime',
      stats: graph.stats,
      nodes: graph.nodes,
      edges: shown,
      edgeCount: total,
      truncated: limit === 0 ? false : total > shown.length,
      type: typeFilter,
    });
  }

  const nodesByType = {};
  for (const n of graph.nodes) nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;

  console.log('');
  console.log(colorize('  ContextPocket Lite · Derived link graph', 'bold'));
  console.log('  ' + colorize('─'.repeat(40), 'dim'));
  console.log(`  Nodes: ${graph.stats.nodes} (${Object.keys(nodesByType).sort().map((t) => `${nodesByType[t]} ${t}`).join(', ')})`);
  console.log(`  Edges: ${graph.stats.edges} — ${Object.keys(graph.stats.byType).sort().map((t) => `${t} ${graph.stats.byType[t]}`).join(' · ')}`);
  console.log(colorize('  runtime-derived · zero cache files written', 'dim'));
  console.log('');

  if (typeFilter) {
    console.log(colorize(`  ${typeFilter} edges (${total}${limit !== 0 && total > shown.length ? `, showing first ${shown.length}` : ''}):`, 'cyan'));
  } else if (limit !== 0 && total > shown.length) {
    console.log(colorize(`  Edges (${total}, showing first ${shown.length} — --limit 0 for all, --type to filter):`, 'cyan'));
  } else {
    console.log(colorize(`  Edges (${total}):`, 'cyan'));
  }
  for (const e of shown) {
    const weak = e.evidence === 'weak' ? colorize(' · weak', 'yellow') : '';
    const via = e.via ? colorize(` · via ${e.via}`, 'dim') : '';
    console.log(`    ${e.from} ${colorize('—' + e.type + '→', 'magenta')} ${e.to}${weak}${via}`);
    console.log(colorize(`      source: ${e.source}${e.tId !== null && e.tId !== undefined ? ' · T' + e.tId : ''}`, 'dim'));
  }
  if (shown.length === 0) {
    console.log(colorize('    (no edges' + (typeFilter ? ` of type "${typeFilter}"` : '') + ' derived from this pocket)', 'dim'));
  }
  console.log('');
  console.log(colorize('  Derived from log.md / log-archive.md / decisions.md / requirements.md / code-map.md —', 'dim'));
  console.log(colorize('  every edge cites its source line; weak evidence is marked.', 'dim'));
  console.log('');
}

// ============================================================
// 命令：log append
// ============================================================

function cmdLogAppend(options) {
  const pocketDir = ensurePocket(options);

  if (missingValue(options, 'gist')) {
    failJson(options, '--gist is required (and needs a value)');
    console.error(colorize('\n  ❌ Error:', 'red') + ' --gist is required');
    console.error('     Usage: context-pocket-lite log append --gist "one-line summary"\n');
    process.exit(1);
  }

  // 字段形状与 MCP 入口共用一份定义（lib/fields.js）
  const fields = turnFields(options);
  const result = appendLogBlock(pocketDir, fields);

  if (!options.json) {
    // 打的是还原成一句话的时间，不是 `--- WHEN: … ---` 那行格式；--json 里仍给逐字的行
    const whenText = describeWhenLine(result.when);
    const whenSuffix = whenText ? '\n  ' + colorize('⏱  ' + whenText, 'dim') : '';
    // 用户给了时间、却因为 pocket 还停在 v1 而没落盘 —— 这必须说出来
    const skipSuffix = result.whenSkipped
      ? '\n  ' + colorize(`⚠️  ${result.whenSkipped}`, 'yellow')
      : '';
    console.log(`\n  ✅ T${result.tId} added: ${fields.gist}\n` + whenSuffix + skipSuffix);

    // 本轮新建的块缺了 verify 会判 ERROR 的小节：当场说，别等提交撞墙。
    // 修法是 `log amend`（只填缺失小节、不覆盖历史），不必手改 markdown。
    if (result.missingSections && result.missingSections.length > 0) {
      console.log(colorize(`  ⚠️  T${result.tId} 没有 ${result.missingSections.join(' / ')} 节 — verify 会判成 ERROR：`, 'yellow'));
      console.log(colorize(`     用 context-pocket-lite log amend ${result.tId} --user "…" --action "…" 补齐（只填缺失小节，不覆盖历史）\n`, 'dim'));
    }
  }

  const verifyResult = options.verify ? verify(pocketDir) : null;

  if (options.json) {
    const failed = verifyResult !== null && verifyResult.errorCount > 0;
    emitJson({
      ok: !failed,
      tId: result.tId,
      gist: fields.gist,
      // v2 及以上才有时间行；null 说明这个 pocket 还是 v1
      when: result.when || null,
      // 非 null = 调用方给了 --when，但这一轮的时间没能落盘，原因写在里面
      whenSkipped: result.whenSkipped || null,
      // 本轮新建块里缺的必需小节（verify 会判 ERROR）；空数组 = 这一条写得齐
      missingSections: result.missingSections || [],
      // Lite 不带写时冲突闸：形状不变、值恒为「没检查」（六维冲突引擎在 full 包）
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
// 命令：diff — 对比两轮（需求 / 决策 / 文件增量）
// ============================================================

function cmdDiff(options, positional) {
  const pocketDir = ensurePocket(options);
  const aStr = positional[0] || textOption(options, 't-a');
  const bStr = positional[1] || textOption(options, 't-b');

  if (!aStr || !bStr) {
    failJson(options, 'two T-ids are required. Usage: context-pocket-lite diff <T-a> <T-b>');
    console.error(colorize('\n  ❌ Error:', 'red') + ' two T-ids are required');
    console.error('     Usage: context-pocket-lite diff <T-a> <T-b>  (or --t-a <T> --t-b <T>)\n');
    process.exit(1);
  }

  const tA = toTId(aStr);
  const tB = toTId(bStr);
  if (Number.isNaN(tA) || Number.isNaN(tB)) {
    const bad = Number.isNaN(tA) ? aStr : bStr;
    failJson(options, 'Invalid T-id: ' + bad);
    console.error(colorize('\n  ❌ Error:', 'red') + ' Invalid T-id: ' + bad + '\n');
    process.exit(1);
  }

  let result;
  try {
    result = diff(pocketDir, tA, tB);
  } catch (e) {
    // diff 对找不到的轮次抛 `T<n> not found`：翻译成一行错误，别把堆栈丢给 --json 消费方
    failJson(options, e.message);
    console.error(colorize('\n  ❌ Error:', 'red') + ' ' + e.message + '\n');
    process.exit(1);
  }

  if (options.json) emitJson({ ok: true, ...result });

  console.log('');
  console.log(colorize(`  Diff: T${result.tA} → T${result.tB}`, 'bold'));
  console.log('  ' + colorize('─'.repeat(40), 'dim'));
  console.log(`  T${result.tA} · ${result.gistA}`);
  console.log(`  T${result.tB} · ${result.gistB}`);
  console.log('');

  const section = (title, rows, render) => {
    console.log(colorize(`  ${title} (${rows.length})`, 'cyan'));
    if (rows.length === 0) {
      console.log(colorize('    (none)', 'dim'));
    } else {
      for (const r of rows) console.log('    ' + render(r));
    }
    console.log('');
  };

  section('Requirements added', result.requirements.added,
    (r) => `R${r.id} (${r.status}) · ${r.text}`);
  section('Requirements completed', result.requirements.completed,
    (r) => `R${r.id} · ${r.text} (T${r.completedAt})`);
  section('Requirements cancelled', result.requirements.cancelled,
    (r) => `R${r.id} · ${r.text} (T${r.cancelledAt})`);
  section('Decisions added', result.decisions.added,
    (r) => `ADR-${r.id} · ${r.title} (T${r.createdAt})`);
  section('Files added', result.files.added, (f) => f);
  section('Files removed', result.files.removed, (f) => f);
  section('Files modified', result.files.modified, (f) => f);
}

// ============================================================
// 命令：log amend — 补已有轮的缺失小节（只填缺失、不覆盖历史）
// ============================================================

function cmdLogAmend(options, positional) {
  const pocketDir = ensurePocket(options);
  const tIdStr = positional[0] || tIdOption(options);

  if (!tIdStr) {
    failJson(options, 'T-id is required. Usage: context-pocket-lite log amend <T-id> [--user "…" --action "…"]');
    console.error(colorize('\n  ❌ Error:', 'red') + ' T-id is required');
    console.error('     Usage: context-pocket-lite log amend <T-id> --user "…" --action "…"\n');
    process.exit(1);
  }

  const tId = toTId(tIdStr);
  if (Number.isNaN(tId)) {
    failJson(options, 'Invalid T-id: ' + tIdStr);
    console.error(colorize('\n  ❌ Error:', 'red') + ' Invalid T-id: ' + tIdStr + '\n');
    process.exit(1);
  }

  // 字段形状与 append / MCP 共用一份定义（lib/fields.js 的 sectionFields）。
  // hasAnySection 是"你没打算改任何东西"的守卫：只给了空值就等于没说不改什么。
  const fields = sectionFields(options);
  if (!hasAnySection(fields)) {
    failJson(options, 'at least one section to fill is required (--user / --action / --decisions / … / --when)');
    console.error(colorize('\n  ❌ Error:', 'red') + ' at least one section is required');
    console.error('     Give the sections you want to fill, e.g. --user "…" --action "…"\n');
    process.exit(1);
  }

  const result = amendLogBlock(pocketDir, tId, fields);
  if (!result.success) {
    failJson(options, result.error || ('could not amend T' + tId));
    console.error(colorize('\n  ❌ Error:', 'red') + ' ' + (result.error || ('could not amend T' + tId)) + '\n');
    process.exit(1);
  }

  if (options.json) emitJson({ ok: true, ...result });

  if (result.unchanged) {
    const already = result.skipped && result.skipped.length > 0
      ? ` — already present: ${result.skipped.join(', ')}`
      : '';
    console.log(colorize(`\n  ℹ️  T${tId}: nothing to fill${already} (amend never overwrites history)`, 'dim'));
    if (result.when) console.log(colorize(`     ${result.when}`, 'dim'));
    console.log('');
    return;
  }

  console.log(`\n  ✅ T${tId} amended — filled: ${result.filled.join(', ')}`);
  if (result.skipped && result.skipped.length > 0) {
    console.log(colorize(`     already present (not overwritten): ${result.skipped.join(', ')}`, 'dim'));
  }
  if (result.when) console.log(colorize(`     ${result.when}`, 'dim'));
  console.log('');
}

// ============================================================
// 命令：handoff — 派生交接摘要
// ============================================================

function cmdHandoff(options) {
  const pocketDir = ensurePocket(options);
  const result = generateHandoff(pocketDir);

  if (options.json) emitJson({ ok: true, ...result });

  console.log(`\n  ✅ handoff.md generated · T${result.tId} · ${result.date}`);
  console.log(colorize('     One-page summary for the next session. It turns STALE the moment a newer T-block lands.', 'dim'));
  console.log('');
}

// ============================================================
// 分发
// ============================================================

const { appendLogBlock, amendLogBlock, generateHandoff } = require('../lib/writer');

function main() {
  const { command, subcommand, options, positional } = parseArgs(process.argv);

  // --version / -v 全局短路
  if (options.version || options.v) {
    cmdVersion(options);
    return;
  }

  // help / 无命令：主帮助页；单命令帮助走 `<command> --help`（与主包同一条路径）
  if (command === null || command === undefined || command === 'help') {
    if (options.h || options.help) {
      printCommandHelp(subcommand || positional[0], options);
      return;
    }
    cmdHelp(options);
    return;
  }

  // `<command> --help`：在任何分发之前拦下，否则"status --help"会去跑 status
  if (options.h || options.help) {
    printCommandHelp(command === 'log' ? 'log ' + (subcommand || 'append') : command, options);
    return;
  }

  switch (command) {
    case 'version':
      cmdVersion(options);
      return;
    case 'bootstrap':
      cmdBootstrap(options);
      return;
    case 'status':
      cmdStatus(options);
      return;
    case 'verify':
      cmdVerify(options);
      return;
    case 'recall':
      cmdRecall(options, positional);
      return;
    case 'search':
      cmdSearch(options, positional);
      return;
    case 'why':
      cmdWhy(options, positional);
      return;
    case 'graph':
      cmdGraph(options);
      return;
    case 'diff':
      cmdDiff(options, positional);
      return;
    case 'handoff':
      cmdHandoff(options);
      return;
    case 'log':
      if (subcommand === 'append') {
        cmdLogAppend(options);
        return;
      }
      if (subcommand === 'amend') {
        cmdLogAmend(options, positional);
        return;
      }
      break;
    default:
      break;
  }

  const unknown = command === 'log'
    ? `log ${subcommand || ''}`.trim()
    : command;
  failJson(options, 'Unknown command: ' + unknown + '. Run "context-pocket-lite help" for available commands.');
  console.error(colorize('\n  ❌ Unknown command:', 'red') + ' ' + unknown);
  console.error('     Run "context-pocket-lite help" for available commands.\n');
  process.exit(1);
}

/** `<command> --help`：文本单源在 lite/lib/help.js 的 COMMAND_HELP */
function printCommandHelp(key, options) {
  const normalized = String(key || '').trim();
  if (!normalized) {
    cmdHelp(options);
    return;
  }
  let entry;
  try {
    entry = commandHelp(normalized);
  } catch (e) {
    entry = null;
  }
  if (!entry) {
    failJson(options, 'No help for command "' + normalized + '". Run "context-pocket-lite help" for available commands.');
    console.error(colorize('\n  ❌ Error:', 'red') + ' No help for command "' + normalized + '"');
    console.error('     Run "context-pocket-lite help" for available commands.\n');
    process.exit(1);
  }
  if (options && options.json) {
    emitJson({ ok: true, command: normalized, text: entry });
  }
  console.log(entry);
}

// ============================================================
// 入口
// ============================================================

function runCli() {
  try {
    main();
  } catch (e) {
    // lib 层会抛错（writeAtomic、锁超时……）。--json 消费方拿到 Node 堆栈
    // 就没法解析了，所以这里统一转成一行 JSON。
    const wantsJson = parseArgs(process.argv).options.json;
    if (wantsJson) {
      emitJson({ ok: false, error: e.message }, 1);
    }
    console.error(colorize('\n  ❌ Error:', 'red') + ' ' + (e && e.message ? e.message : String(e)));
    console.error('');
    process.exit(1);
  }
}

module.exports = { parseArgs, runCli };

if (require.main === module) {
  runCli();
}
