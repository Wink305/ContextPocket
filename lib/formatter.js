'use strict';

/**
 * ContextPocket — CLI 输出格式化
 * 彩色输出、表格、进度条等
 */

const { SEVERITY } = require('./constants');
const { stripPlaceholders } = require('./core');

// ANSI 颜色
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

function colorize(text, color) {
  if (process.env.NO_COLOR) return text;
  if (!color || !COLORS[color]) return text;
  return COLORS[color] + text + COLORS.reset;
}

function severityLabel(severity) {
  switch (severity) {
    case SEVERITY.ERROR:
      return colorize('ERROR', 'red');
    case SEVERITY.WARNING:
      return colorize('WARN ', 'yellow');
    case SEVERITY.INFO:
      return colorize('INFO ', 'cyan');
    default:
      return severity;
  }
}

function severityIcon(severity) {
  switch (severity) {
    case SEVERITY.ERROR:
      return '❌';
    case SEVERITY.WARNING:
      return '⚠️';
    case SEVERITY.INFO:
      return 'ℹ️';
    default:
      return '•';
  }
}

/**
 * 格式化 verify 结果
 * @param {object} result - verify() 的返回值
 * @param {object} options
 * @returns {string}
 */
function formatVerifyResult(result, options = {}) {
  const { results, errorCount, warningCount, infoCount } = result;
  const { quiet = false } = options;

  const lines = [];

  // 标题
  lines.push('');
  lines.push(colorize('  ContextPocket · Verify', 'bold'));
  lines.push('  ' + colorize('─'.repeat(40), 'dim'));

  // 摘要
  const total = errorCount + warningCount + infoCount;
  let statusIcon, statusText, statusColor;
  if (errorCount > 0) {
    statusIcon = '❌';
    statusText = `${errorCount} error${errorCount > 1 ? 's' : ''} found`;
    statusColor = 'red';
  } else if (warningCount > 0) {
    statusIcon = '⚠️';
    statusText = `${warningCount} warning${warningCount > 1 ? 's' : ''} found`;
    statusColor = 'yellow';
  } else {
    statusIcon = '✅';
    statusText = 'All checks passed';
    statusColor = 'green';
  }

  lines.push(`  ${statusIcon}  ${colorize(statusText, statusColor)}`);
  lines.push(`     ${infoCount} info items`);
  lines.push('');

  if (quiet) {
    // quiet 模式只显示 error 和 warning
    const important = results.filter(r => r.severity !== SEVERITY.INFO);
    if (important.length > 0) {
      lines.push(colorize('  Issues:', 'bold'));
      for (const r of important) {
        lines.push(`     ${severityIcon(r.severity)}  ${r.message}`);
        if (r.fix) {
          lines.push(`         ${colorize('Fix: ' + r.fix, 'dim')}`);
        }
        pushDetails(lines, r);
      }
      lines.push('');
    }
  } else {
    // 详细模式：按类别分组
    const byCategory = {};
    for (const r of results) {
      if (!byCategory[r.category]) byCategory[r.category] = [];
      byCategory[r.category].push(r);
    }

    for (const [category, items] of Object.entries(byCategory)) {
      const hasErrors = items.some(i => i.severity === SEVERITY.ERROR);
      const hasWarnings = items.some(i => i.severity === SEVERITY.WARNING);
      const icon = hasErrors ? '❌' : hasWarnings ? '⚠️' : '✅';

      lines.push(`  ${icon}  ${colorize(category, 'bold')}`);
      for (const r of items) {
        lines.push(`     ${severityLabel(r.severity)}  ${r.message}`);
        if (r.fix && r.severity !== SEVERITY.INFO) {
          lines.push(`         ${colorize('↳ ' + r.fix, 'dim')}`);
        }
        pushDetails(lines, r);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * `details` 是"到底是哪几个文件"这一层信息。以前只有 --json 拿得到，
 * 人读的输出只说"3 file(s) not referenced"却不说是哪 3 个，
 * 于是 verify --drift 的提示没法直接照着做。
 */
function pushDetails(lines, r) {
  if (!Array.isArray(r.details) || r.details.length === 0) return;
  for (const d of r.details) {
    lines.push(`           ${colorize('- ' + d, 'dim')}`);
  }
}

/**
 * 格式化状态摘要
 * @param {object} data - parseAll() 的返回值
 * @param {object} config
 * @returns {string}
 */
function formatStatus(data, config) {
  const lines = [];
  const { log, requirements, decisions, state, preferences, absolute, index } = data;

  lines.push('');
  lines.push(colorize('  ContextPocket · Status', 'bold'));
  lines.push('  ' + colorize('─'.repeat(40), 'dim'));

  lines.push(`  📍 Latest: ${colorize('T' + log.latestT, 'cyan')}${index.date ? ' · ' + index.date : ''}`);
  // archive_at 只有被读出来才有意义：归档从来不会自己发生，所以阈值必须显式出现在
  // 状态里，否则 log.md 会一路长到几千行而没有任何一处提示。
  const archiveAt = Number(config.archive_at);
  const due = Number.isFinite(archiveAt) && archiveAt > 0 && log.lineCount >= archiveAt;
  lines.push(`  📝 Log: ${log.blocks.length} T-blocks${index.hasArchive ? ' (+ archive)' : ''}`
    + (due ? colorize(` · ${log.lineCount}/${archiveAt} lines — archive is due`, 'yellow') : ''));
  lines.push(`  📋 Requirements: ${requirements.openCount} open / ${requirements.doneCount} done / ${requirements.cancelledCount} cancelled`);
  if (requirements.uncertainCount > 0) {
    lines.push(`     ❓ ${requirements.uncertainCount} uncertain`);
  }
  lines.push(`  🧠 Decisions: ${decisions.count} ADRs`);
  lines.push(`  🔒 Absolute: ${absolute.count} entries`);
  lines.push(`  ⚙️  Mode: ${config.mode} · language: ${config.language}`);

  // state.md 里 bootstrap 预填的是模板占位符（`- <2-3 lines: what to do first>`）。
  // 原样打印会让一个刚 bootstrap 的项目显示成"有下一步、有坑点"，而内容全是假的
  // —— 对下一个 agent 是直接的上下文投毒。这里过滤掉占位符。
  const nextSteps = stripPlaceholders(state.nextSteps);
  const pitfalls = stripPlaceholders(state.pitfalls);

  if (nextSteps.length > 0) {
    lines.push('');
    lines.push(`  ${colorize('Next Steps:', 'bold')}`);
    for (const step of nextSteps.slice(0, 3)) {
      lines.push(`     → ${step}`);
    }
  }

  if (pitfalls.length > 0) {
    lines.push('');
    lines.push(`  ${colorize('Pitfalls:', 'bold')}`);
    for (const pitfall of pitfalls.slice(0, 3)) {
      lines.push(`     ⚠️  ${pitfall}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * 渲染一条检索结果（T / ADR / R / pref / FIX），供 search 与 hub search 共用。
 * opts.indent：首行缩进；opts.highlightIndent：高亮行缩进。
 * @param {object} row
 * @param {object} [opts]
 * @returns {string[]}
 */
function formatSearchHitLines(row, opts = {}) {
  const indent = opts.indent === undefined ? '  ' : opts.indent;
  const highlightIndent = opts.highlightIndent === undefined ? '     ' : opts.highlightIndent;
  const lines = [];

  const pushHighlights = (r) => {
    if (r.highlights && r.highlights.length > 0) {
      for (const h of r.highlights.slice(0, 3)) {
        const snippet = h.text.length > 60 ? h.text.slice(0, 60) + '...' : h.text;
        lines.push(colorize(`${highlightIndent}↳ [${h.field}] ${snippet}`, 'dim'));
      }
    }
  };

  if (row.type === 'ADR') {
    lines.push(`${indent}${colorize('ADR-' + row.adrId, 'bold')} · ${row.title}`);
    pushHighlights(row);
  } else if (row.type === 'R') {
    const flag = row.uncertain ? ' ❓' : '';
    lines.push(`${indent}${colorize('R' + row.rId, 'bold')} (${row.status})${flag} · ${row.text}`);
    pushHighlights(row);
  } else if (row.type === 'pref') {
    lines.push(`${indent}${colorize('pref', 'bold')} · ${row.line}`);
    pushHighlights(row);
  } else if (row.type === 'FIX') {
    const fixTags = row.tags && row.tags.length > 0
      ? ' ' + row.tags.map(t => colorize(`[${t}]`, 'cyan')).join('')
      : '';
    lines.push(`${indent}${colorize(row.fixId, 'bold')}${fixTags} · ${row.gist} ${colorize('→ corrects T' + row.targetId, 'dim')}${row.archived ? colorize(' (archived)', 'dim') : ''}`);
    pushHighlights(row);
  } else {
    const tagsStr = row.tags && row.tags.length > 0
      ? ' ' + row.tags.map(t => colorize(`[${t}]`, 'cyan')).join('')
      : '';
    lines.push(`${indent}${colorize('T' + row.id, 'bold')}${tagsStr} · ${row.gist}${row.archived ? colorize(' (archived)', 'dim') : ''}`);
    pushHighlights(row);
  }

  return lines;
}

module.exports = {
  colorize,
  formatVerifyResult,
  formatStatus,
  formatSearchHitLines,
};
