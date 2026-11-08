#!/usr/bin/env node
'use strict';

/**
 * ContextPocket Lite — MCP 服务器
 *
 * 8 个工具，与 CLI 的 8 条命令一一对应（context_pocket_<name>）：
 * bootstrap / status / verify / recall / search / why / graph / log_append。
 * stdio 传输层（换行分隔 JSON-RPC）与主包 mcp-server.js 同一套实现。
 *
 * Zero-dependency. Works in Node.js 14+.
 */

const path = require('path');
const { findPocketDir, readConfig, stripPlaceholders, toTId, intOption } = require('./lib/core');
const { parseAll } = require('./lib/parser');
const { verify } = require('./lib/validator');
const { bootstrap } = require('./lib/bootstrap');
const { recall, recallWindow, searchAny, why } = require('./lib/query');
const { appendLogBlock } = require('./lib/writer');
const { deriveLinks, buildContext, formatContextLines } = require('./lib/links');
const { turnFields, textOption } = require('./lib/fields');
const { describeWhen } = require('./lib/when');
const { TOOL_DESCRIPTIONS, SERVER_INSTRUCTIONS } = require('./lib/help');

// ============================================================
// 版本
// ============================================================

// lite/package.json 是版本的唯一来源（lib/version.js），CLI 的 --version 读同一处。
const { pkgVersion } = require('./lib/version');
const SERVER_VERSION = pkgVersion().version;

// ============================================================
// MCP stdio transport
// ============================================================
//
// MCP 的 stdio 传输是"换行分隔的 JSON-RPC"：每条消息一行、内部不得有裸换行，
// 行与行之间没有 Content-Length 头（那是 LSP 的 base protocol）。

let pending = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let idx;
  while ((idx = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, idx);
    pending = pending.slice(idx + 1);
    handleLine(line);
  }
});

process.stdin.on('end', () => {
  // 处理最后没有换行符的一行
  if (pending.trim()) handleLine(pending);
  pending = '';
});

function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (e) {
    sendError(null, -32700, 'Parse error: ' + e.message);
    return;
  }

  // JSON-RPC 批量：规范允许数组，逐个处理
  if (Array.isArray(message)) {
    for (const m of message) handleMessage(m);
    return;
  }
  handleMessage(message);
}

function sendMessage(message) {
  // 单行写出：JSON.stringify 不会产出裸换行，天然满足分帧要求
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sendResponse(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

// ============================================================
// 消息处理
// ============================================================

// 从新到老：客户端协商时优先落在它请求的版本上
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    sendError((msg && msg.id) || null, -32600, 'Invalid Request: jsonrpc version mismatch');
    return;
  }

  // 通知（无 id）不应有回应
  if (msg.id === undefined || msg.id === null) {
    return;
  }

  switch (msg.method) {
    case 'initialize':
      handleInitialize(msg.id, msg.params || {});
      break;
    case 'ping':
      sendResponse(msg.id, {});
      break;
    case 'tools/list':
      handleToolsList(msg.id);
      break;
    case 'tools/call':
      handleToolsCall(msg.id, msg.params || {});
      break;
    default:
      sendError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

function handleInitialize(id, params) {
  const requested = params.protocolVersion;
  const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;

  sendResponse(id, {
    protocolVersion: negotiated,
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: {
      name: 'context-pocket-lite',
      version: SERVER_VERSION,
    },
    instructions: SERVER_INSTRUCTIONS,
  });
}

// ============================================================
// 工具定义（8 个，与 CLI 的 8 条命令一一对应）
// ============================================================

const TOOLS = [
  // --- Setup ---
  {
    name: 'context_pocket_bootstrap',
    description: TOOL_DESCRIPTIONS.context_pocket_bootstrap,
    inputSchema: {
      type: 'object',
      properties: {
        projectType: {
          type: 'string',
          description: 'Project type: frontend/backend/fullstack/data/mobile (auto-detected if not specified)',
        },
        language: {
          type: 'string',
          enum: ['zh', 'en'],
          description: 'Default language for tags and prompts',
          default: 'zh',
        },
        gitignore: {
          type: 'boolean',
          description: 'true = ignore ContextPocket/ in .gitignore (default); false = commit ContextPocket/ to sync across machines via git',
          default: true,
        },
      },
    },
  },
  // --- Inspection ---
  {
    name: 'context_pocket_status',
    description: TOOL_DESCRIPTIONS.context_pocket_status,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'context_pocket_verify',
    description: TOOL_DESCRIPTIONS.context_pocket_verify,
    inputSchema: {
      type: 'object',
      properties: {
        quiet: {
          type: 'boolean',
          description: 'Only show errors and warnings',
          default: false,
        },
      },
    },
  },
  {
    name: 'context_pocket_recall',
    description: TOOL_DESCRIPTIONS.context_pocket_recall,
    inputSchema: {
      type: 'object',
      properties: {
        tId: {
          type: 'integer',
          description: 'T-block ID number. Omit it and pass a time window instead to list the turns in that window. Cannot be combined with a window.',
        },
        withContext: {
          type: 'boolean',
          description: 'Append the read-only inbound context derived from log.md, decisions.md and code-map.md (single tId only).',
          default: false,
        },
        sinceT: { type: 'integer', description: 'T-id window lower bound (closed)' },
        untilT: { type: 'integer', description: 'T-id window upper bound (closed)' },
        fromDate: { type: 'string', description: 'Date window lower bound, yyyy-mm-dd (closed)' },
        toDate: { type: 'string', description: 'Date window upper bound, yyyy-mm-dd (closed)' },
        limit: { type: 'integer', description: 'Page size for the window listing (0 = all)' },
        offset: { type: 'integer', description: 'Skip the first N turns of the window listing' },
      },
    },
  },
  {
    name: 'context_pocket_search',
    description: TOOL_DESCRIPTIONS.context_pocket_search,
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'What to search for. "T7" style queries jump straight to that turn.',
        },
        sinceT: { type: 'integer', description: 'T-id window lower bound (closed)' },
        untilT: { type: 'integer', description: 'T-id window upper bound (closed)' },
        fromDate: { type: 'string', description: 'Date window lower bound, yyyy-mm-dd (closed)' },
        toDate: { type: 'string', description: 'Date window upper bound, yyyy-mm-dd (closed)' },
        limit: { type: 'integer', description: 'Page size (0 = all)' },
        offset: { type: 'integer', description: 'Skip the first N results' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'context_pocket_why',
    description: TOOL_DESCRIPTIONS.context_pocket_why,
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Full or partial file path to look up',
        },
        limit: {
          type: 'integer',
          description: 'Max hits (default: 10)',
          default: 10,
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'context_pocket_graph',
    description: TOOL_DESCRIPTIONS.context_pocket_graph,
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['modifies', 'mentions', 'references', 'decided-in', 'supersedes', 'last-changed'],
          description: 'Filter to one edge type',
        },
        limit: {
          type: 'integer',
          description: 'Max edges shown (default: 100; 0 = all)',
          default: 100,
        },
      },
    },
  },
  // --- Write ---
  {
    name: 'context_pocket_log_append',
    description: TOOL_DESCRIPTIONS.context_pocket_log_append,
    inputSchema: {
      type: 'object',
      properties: {
        gist: {
          type: 'string',
          description: 'One-line summary of this turn (goes in the T-block header)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for this turn',
        },
        author: { type: 'string', description: 'Who recorded this turn (multi-agent pockets)' },
        user: { type: 'string', description: 'What the user asked (required by verify)' },
        action: { type: 'string', description: 'What was done (required by verify)' },
        commits: {
          type: 'array',
          items: { type: 'string' },
          description: 'Commit ids',
        },
        decisions: { type: 'string', description: 'Decisions & constraints' },
        pitfalls: { type: 'string', description: 'Pitfalls encountered' },
        preferences: { type: 'string', description: 'Preferences learned' },
        conflicts: { type: 'string', description: 'Conflicts (Lite has no write-time conflict gate — pass them manually)' },
        attachments: { type: 'string', description: 'Attachments' },
        uncertain: { type: 'string', description: 'Open questions' },
        when: {
          type: 'string',
          description: 'When this turn happened: "2026-10-03 09:00 → 11:30", "2026-10-03", a date range, or free text (stored verbatim). Default: now.',
        },
        verify: {
          type: 'boolean',
          description: 'Run verify after appending (default true; pass false to skip)',
          default: true,
        },
      },
      required: ['gist'],
    },
  },
];

function handleToolsList(id) {
  sendResponse(id, { tools: TOOLS });
}

// ============================================================
// 工具调用
// ============================================================

function handleToolsCall(id, params) {
  const { name, arguments: args } = params;

  try {
    let result;
    switch (name) {
      case 'context_pocket_bootstrap':
        result = toolBootstrap(args || {});
        break;
      case 'context_pocket_status':
        result = toolStatus();
        break;
      case 'context_pocket_verify':
        result = toolVerify(args || {});
        break;
      case 'context_pocket_recall':
        result = toolRecall(args || {});
        break;
      case 'context_pocket_search':
        result = toolSearch(args || {});
        break;
      case 'context_pocket_why':
        result = toolWhy(args || {});
        break;
      case 'context_pocket_graph':
        result = toolGraph(args || {});
        break;
      case 'context_pocket_log_append':
        result = toolLogAppend(args || {});
        break;
      default:
        sendResponse(id, {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        });
        return;
    }

    sendResponse(id, result);
  } catch (e) {
    sendResponse(id, {
      content: [{ type: 'text', text: `Error: ${e.message}` }],
      isError: true,
    });
  }
}

// ============================================================
// 辅助：获取 pocketDir
// ============================================================

function getPocketDir() {
  const pocketDir = findPocketDir(process.cwd());
  if (!pocketDir) {
    throw new Error('No ContextPocket/ directory found in the current project.\n\nRun context_pocket_bootstrap first to initialize ContextPocket, or check that you\'re in the right project directory.');
  }
  return pocketDir;
}

// ============================================================
// 工具实现
// ============================================================

// --- Setup ---

function toolBootstrap(args) {
  const projectDir = process.cwd();

  // 与 CLI 同规则：已有 ContextPocket/ 是"早就在记了"，不是失败。
  // lib/bootstrap 的拒绝覆盖保护原样保留。
  const fs = require('fs');
  const existingPocket = path.join(projectDir, 'ContextPocket');
  if (fs.existsSync(existingPocket) && fs.statSync(existingPocket).isDirectory()) {
    return {
      content: [{
        type: 'text',
        text: [
          'ℹ️ **ContextPocket/ already exists** — nothing to create, keep recording.',
          '',
          `- **Path:** ${existingPocket}`,
          '- **Next:** read `index.md` + `state.md` to pick up where the last session left off.',
        ].join('\n'),
      }],
    };
  }

  // Lite 永远建 lite 口袋（5 个核心文件，零缓存目录）
  const result = bootstrap(projectDir, {
    projectType: args.projectType,
    mode: 'lite',
    language: args.language,
    gitignore: args.gitignore,
  });

  const lines = [];
  lines.push('✅ **ContextPocket initialized (lite)!**');
  lines.push('');
  lines.push(`- **Project type:** ${result.projectType}`);
  lines.push(`- **Language:** ${result.language}`);
  lines.push(`- **Files created:** ${result.filesCopied.length}`);
  for (const f of result.filesCopied) {
    lines.push(`  - ${f}`);
  }
  if (result.gitignore) {
    if (result.gitignore.removed) {
      lines.push(`- **Git:** ContextPocket/ removed from .gitignore (will be committed — sync across machines via git)`);
    } else if (result.gitignore.absent) {
      lines.push(`- **Git:** ContextPocket/ not ignored (will be committed)`);
    } else {
      lines.push(`- **Git:** ContextPocket/ added to .gitignore (project-local)`);
    }
  }
  lines.push('');

  // 初始化里"没做成但不致命"的部分必须交给调用方（agent）
  if (result.warnings && result.warnings.length > 0) {
    lines.push(`⚠ **${result.warnings.length} warning(s) during initialization:**`);
    for (const w of result.warnings) {
      lines.push(`- ${w}`);
    }
    lines.push('');
  }

  lines.push('**Next steps:**');
  lines.push('1. Edit ContextPocket/readme.md with project info');
  lines.push('2. Run context_pocket_verify to check health');

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

// --- Inspection ---

function toolStatus() {
  const pocketDir = getPocketDir();
  const data = parseAll(pocketDir);
  const config = readConfig(pocketDir);

  const lines = [];
  lines.push('**ContextPocket Status (lite)**');
  lines.push('');
  lines.push(`- **Latest:** T${data.log.latestT}`);
  // 归档不会自己发生，所以阈值要在状态里说出口
  const archiveAt = Number(config.archive_at);
  const due = Number.isFinite(archiveAt) && archiveAt > 0 && data.log.lineCount >= archiveAt;
  lines.push(`- **Log:** ${data.log.blocks.length} T-blocks${data.index.hasArchive ? ' (+ archive)' : ''}`
    + (due ? ` — ⚠ ${data.log.lineCount}/${archiveAt} lines past archive_at (archiving lives in the full package)` : ''));
  lines.push(`- **Requirements:** ${data.requirements.openCount} open / ${data.requirements.doneCount} done / ${data.requirements.cancelledCount} cancelled`);
  if (data.requirements.uncertainCount > 0) {
    lines.push(`  - ❓ ${data.requirements.uncertainCount} uncertain`);
  }
  lines.push(`- **Decisions:** ${data.decisions.count} ADRs`);
  lines.push(`- **Mode:** ${config.mode} · language: ${config.language}`);

  // 过滤 state.md 里的模板占位符（bootstrap 预填、尚未填写）
  const nextSteps = stripPlaceholders(data.state.nextSteps);
  if (nextSteps.length > 0) {
    lines.push('');
    lines.push('**Next Steps:**');
    for (const step of nextSteps.slice(0, 5)) {
      lines.push(`- ${step}`);
    }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function toolVerify(args) {
  const pocketDir = getPocketDir();
  const result = verify(pocketDir);
  const { results, errorCount, warningCount, infoCount } = result;
  const quiet = args.quiet || false;

  const lines = [];
  lines.push('**ContextPocket · Verify (lite)**');
  lines.push('');

  if (errorCount > 0) {
    lines.push(`❌ **${errorCount} error${errorCount > 1 ? 's' : ''} found**`);
  } else if (warningCount > 0) {
    lines.push(`⚠️ **${warningCount} warning${warningCount > 1 ? 's' : ''} found**`);
  } else {
    lines.push('✅ **All checks passed**');
  }
  lines.push(`${infoCount} info items`);
  lines.push('');

  const important = quiet
    ? results.filter(r => r.severity !== 'info')
    : results;

  if (important.length > 0) {
    const byCategory = {};
    for (const r of important) {
      if (!byCategory[r.category]) byCategory[r.category] = [];
      byCategory[r.category].push(r);
    }

    for (const [category, items] of Object.entries(byCategory)) {
      const hasErrors = items.some(i => i.severity === 'error');
      const hasWarnings = items.some(i => i.severity === 'warning');
      const icon = hasErrors ? '❌' : hasWarnings ? '⚠️' : 'ℹ️';

      lines.push(`### ${icon} ${category}`);
      for (const r of items) {
        const prefix = r.severity === 'error' ? '❌' : r.severity === 'warning' ? '⚠️' : 'ℹ️';
        lines.push(`- ${prefix} ${r.message}`);
        if (r.fix) {
          lines.push(`  - *Fix:* ${r.fix}`);
        }
        if (Array.isArray(r.details)) {
          for (const d of r.details) {
            lines.push(`    - ${d}`);
          }
        }
      }
      lines.push('');
    }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: errorCount > 0,
  };
}

function toolRecall(args) {
  const pocketDir = getPocketDir();
  // 与 CLI 同一份归一：裸 parseInt 会把 "abc" 变成 NaN 再当合法编号传给 recall
  const tId = toTId(args.tId);
  const withContext = args.withContext === true;

  // 四个窗口参数与 context_pocket_search 同名同义，判据最终都落到 query.filterByTime。
  const sinceT = typeof args.sinceT === 'number' && args.sinceT > 0 ? args.sinceT : null;
  const untilT = typeof args.untilT === 'number' && args.untilT > 0 ? args.untilT : null;
  const fromDate = typeof args.fromDate === 'string' && args.fromDate ? args.fromDate : null;
  const toDate = typeof args.toDate === 'string' && args.toDate ? args.toDate : null;
  const hasWindow = sinceT !== null || untilT !== null || fromDate !== null || toDate !== null;

  if (!Number.isNaN(tId) && hasWindow) {
    return {
      content: [{ type: 'text', text: '❌ Error: tId and a time window cannot be combined. Pass either tId, or sinceT/untilT/fromDate/toDate.' }],
      isError: true,
    };
  }

  if (Number.isNaN(tId) && !hasWindow) {
    return {
      content: [{ type: 'text', text: '❌ Error: tId or a time window is required. Pass tId (positive integer, e.g. 7 or "T7") for one full turn, or sinceT/untilT/fromDate/toDate to list a window.' }],
      isError: true,
    };
  }

  // 与 CLI 同一份互斥：withContext 只对单轮有意义
  if (withContext && Number.isNaN(tId) && hasWindow) {
    return {
      content: [{ type: 'text', text: '❌ Error: withContext applies to a single tId, not to a window listing. Pass tId with withContext, or omit withContext for a window.' }],
      isError: true,
    };
  }

  // 窗口模式：按坐标浏览时间线（关键词检索是 search 的职责）
  if (Number.isNaN(tId)) {
    const out = recallWindow(pocketDir, {
      sinceT, untilT, fromDate, toDate,
      limit: args.limit,
      offset: args.offset,
    });
    const windowParts = [];
    if (sinceT !== null) windowParts.push(`T >= ${sinceT}`);
    if (untilT !== null) windowParts.push(`T <= ${untilT}`);
    if (fromDate !== null) windowParts.push(`from ${fromDate}`);
    if (toDate !== null) windowParts.push(`to ${toDate}`);
    const lines = [`## Recall: ${out.total} turn${out.total === 1 ? '' : 's'}${windowParts.length ? ' (' + windowParts.join(', ') + ')' : ''}`, ''];
    if (out.turns.length === 0) {
      lines.push('*(no turns in this window)*');
    } else {
      for (const t of out.turns) {
        const tags = t.tags.length > 0 ? ' ' + t.tags.map((x) => `[${x}]`).join('') : '';
        const when = t.when ? describeWhen(t.when) : (t.session || 'no time recorded');
        lines.push(`- **T${t.id}**${tags}: ${t.gist} — *${when}*${t.archived ? ' *(archived)*' : ''}`);
      }
    }
    if (out.hasMore) {
      lines.push('');
      lines.push(`_${out.total - out.offset - out.turns.length} more — next page: {"offset": ${out.offset + out.turns.length}}; all of them: {"limit": 0}_`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  const result = recall(pocketDir, tId);
  if (!result) {
    return {
      content: [{ type: 'text', text: `❌ Error: T${tId} not found` }],
      isError: true,
    };
  }

  const context = withContext ? buildContext(pocketDir, tId) : null;

  const lines = [];
  lines.push(`## T${result.id} · ${result.gist}${result.archived ? ' *(archived)*' : ''}`);
  if (result.tags && result.tags.length > 0) {
    lines.push(result.tags.map(t => `[${t}]`).join(' '));
  }
  if (result.session) {
    lines.push(`*Session: ${result.session}*`);
  }
  if (result.when) {
    lines.push(`*When: ${describeWhen(result.when)}*`);
  }
  lines.push('');

  if (result.rawText) {
    const rawLines = result.rawText.split('\n');
    for (let i = 1; i < rawLines.length; i++) {
      lines.push(rawLines[i]);
    }
  } else {
    for (const [section, items] of Object.entries(result.sections)) {
      lines.push(`### ${section}`);
      for (const item of items) {
        lines.push(`- ${item}`);
      }
      lines.push('');
    }
  }

  if (context) {
    lines.push('', '### Inbound context (derived, read-only)', ...formatContextLines(context));
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function toolSearch(args) {
  const pocketDir = getPocketDir();
  const keyword = args.keyword;

  if (!keyword) {
    return {
      content: [{ type: 'text', text: '❌ Error: keyword is required' }],
      isError: true,
    };
  }

  // Lite 没有索引：永远现场扫描（noIndex 收下但已无意义，保留参数形状兼容）
  const { results, total, hasMore, offset, limit } = searchAny(pocketDir, keyword, {
    limit: args.limit,
    offset: args.offset,
    sinceT: typeof args.sinceT === 'number' && args.sinceT > 0 ? args.sinceT : null,
    untilT: typeof args.untilT === 'number' && args.untilT > 0 ? args.untilT : null,
    fromDate: typeof args.fromDate === 'string' && args.fromDate ? args.fromDate : null,
    toDate: typeof args.toDate === 'string' && args.toDate ? args.toDate : null,
  });

  const lines = [];
  const shown = limit !== null && results.length < total
    ? ` · showing ${offset + 1}–${offset + results.length}`
    : '';
  lines.push(`## Search: "${keyword}"`);
  lines.push(`${total} match${total !== 1 ? 'es' : ''} found${shown}`);
  lines.push('');

  if (results.length === 0) {
    lines.push('*(no matches)*');
  } else {
    for (const r of results) {
      const printHighlights = (r) => {
        if (!r.highlights || r.highlights.length === 0) return;
        for (const h of r.highlights.slice(0, 3)) {
          const snippet = h.text.length > 80 ? h.text.slice(0, 80) + '...' : h.text;
          lines.push(`  - *[${h.field}]* ${snippet}`);
        }
      };

      if (r.type === 'ADR') {
        lines.push(`- **ADR-${r.adrId}**: ${r.title}`);
        printHighlights(r);
      } else if (r.type === 'R') {
        const flag = r.uncertain ? ' ❓' : '';
        lines.push(`- **R${r.rId}** (${r.status})${flag}: ${r.text}`);
        printHighlights(r);
      } else if (r.type === 'pref') {
        lines.push(`- **pref**: ${r.line}`);
        printHighlights(r);
      } else if (r.type === 'FIX') {
        const fixTags = r.tags && r.tags.length > 0
          ? ' ' + r.tags.map(t => `[${t}]`).join('')
          : '';
        lines.push(`- **${r.fixId}**${fixTags}: ${r.gist} → corrects T${r.targetId}${r.archived ? ' *(archived)*' : ''}`);
        printHighlights(r);
      } else {
        const tagsStr = r.tags && r.tags.length > 0
          ? ' ' + r.tags.map(t => `[${t}]`).join('')
          : '';
        lines.push(`- **T${r.id}**${tagsStr}: ${r.gist}${r.archived ? ' *(archived)*' : ''}`);
        printHighlights(r);
      }
    }
  }

  // 截断必须可见：否则调用方以为"就这些"，而真实总数在 total 里
  if (hasMore) {
    lines.push('');
    lines.push(`_${total - offset - results.length} more — next page: {"offset": ${offset + results.length}}; all of them: {"limit": 0}_`);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function toolWhy(args) {
  const pocketDir = getPocketDir();
  const filePath = args.filePath;

  if (!filePath) {
    return {
      content: [{ type: 'text', text: '❌ Error: filePath is required' }],
      isError: true,
    };
  }

  // 与 CLI 的 why 同一条归一：limit=0 不该被当成"没给"而变回默认值
  const limit = Math.max(1, intOption(args.limit, 10));
  const results = why(pocketDir, filePath, { limit });

  const lines = [];
  const changedN = results.filter(r => r.evidence === 'changed').length;
  lines.push(`## Why: "${filePath}"`);
  lines.push(`${results.length} T-block${results.length !== 1 ? 's' : ''} referenced this file (${changedN} changed it, ${results.length - changedN} only mentioned it)`);
  lines.push('');

  if (results.length === 0) {
    lines.push('*(no references found)*');
  } else {
    for (const r of results) {
      const tagsStr = r.tags.length > 0
        ? ' ' + r.tags.map(t => `[${t}]`).join('')
        : '';
      const badge = r.evidence === 'changed' ? '**[changed]**' : '**[mentioned only]**';
      lines.push(`- **T${r.id}** ${badge}${tagsStr}: ${r.gist}${r.archived ? ' *(archived)*' : ''}`);
      for (const ref of r.references.slice(0, 3)) {
        const snippet = ref.text.length > 80 ? ref.text.slice(0, 80) + '...' : ref.text;
        lines.push(`  - *[${ref.section}]* ${snippet}`);
      }
    }
    if (changedN === 0) {
      lines.push('');
      lines.push('> ⚠️ No T-block records *changing* this file — every hit above only mentions it (Attachments / Uncertain / Conflicts / Pitfalls …). Treat the "why" as unresolved.');
    }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

// --- Derived link graph（运行时派生，Lite 无缓存）---

function toolGraph(args) {
  const pocketDir = getPocketDir();
  const typeFilter = args.type === undefined || args.type === null || String(args.type).trim() === ''
    ? null
    : String(args.type).trim();

  const KNOWN_TYPES = ['modifies', 'mentions', 'references', 'decided-in', 'supersedes', 'last-changed'];
  if (typeFilter && !KNOWN_TYPES.includes(typeFilter)) {
    return {
      content: [{ type: 'text', text: `❌ Error: unknown edge type "${typeFilter}". Known types: ${KNOWN_TYPES.join(', ')}.` }],
      isError: true,
    };
  }

  const limit = intOption(args.limit, 100);
  // Lite：每次调用都现场派生，零写盘 —— 没有 rebuild / verify action
  // （那些管理的是 full 包的 assets/graph.jsonl 缓存）。
  const graph = deriveLinks(pocketDir);

  let edges = graph.edges;
  if (typeFilter) edges = edges.filter((e) => e.type === typeFilter);
  const total = edges.length;
  const shown = limit === 0 ? edges : edges.slice(0, limit);

  const nodesByType = {};
  for (const n of graph.nodes) nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;

  const lines = [];
  lines.push('## ContextPocket Lite · Derived link graph');
  lines.push(`- Nodes: ${graph.stats.nodes} (${Object.keys(nodesByType).sort().map((t) => `${nodesByType[t]} ${t}`).join(', ')})`);
  const parts = Object.keys(graph.stats.byType).sort().map((t) => `${t} ${graph.stats.byType[t]}`);
  lines.push(`- Edges: ${graph.stats.edges}${parts.length ? ' — ' + parts.join(' · ') : ''}`);
  lines.push('- Derived: runtime, on every call — no cache file, nothing is written');
  lines.push('');

  const title = typeFilter
    ? `### ${typeFilter} edges (${total})`
    : `### Edges (${total}${limit !== 0 && total > shown.length ? `, showing first ${shown.length} — pass limit=0 for all, type to filter` : ''})`;
  lines.push(title);
  if (shown.length === 0) {
    lines.push(`*(no edges${typeFilter ? ` of type "${typeFilter}"` : ''} derived from this pocket)*`);
  }
  for (const e of shown) {
    const weak = e.evidence === 'weak' ? ' · **weak**' : '';
    const via = e.via ? ` · via ${e.via}` : '';
    const src = `source ${e.source}${e.tId !== null && e.tId !== undefined ? ' · T' + e.tId : ''}`;
    lines.push(`- \`${e.from}\` —${e.type}→ \`${e.to}\`${weak}${via} (${src})`);
  }
  lines.push('');
  lines.push('Derived from log.md / log-archive.md / decisions.md / code-map.md — every edge cites its source; weak evidence is marked.');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// --- Write ---

function toolLogAppend(args) {
  const pocketDir = getPocketDir();

  // gist 会落在块头 `## T7 · <gist> · [标签]` 上：只收文本，`{ gist: true }` 与没传同罪
  const gist = textOption(args, 'gist');
  if (!gist) {
    return {
      content: [{ type: 'text', text: '❌ Error: gist is required' }],
      isError: true,
    };
  }

  // 字段形状与 CLI 入口共用一份定义（lib/fields.js）
  const fields = turnFields(args);
  const result = appendLogBlock(pocketDir, fields);

  let output = `✅ **T${result.tId} added:** ${gist}`;
  const { describeWhenLine } = require('./lib/when');
  const whenLine = describeWhenLine(result.when);
  if (whenLine) {
    // 把这一轮真正记下的时间回给 Agent：它下一步就该确认这个时间对不对。
    output += `\n⏱ ${whenLine}`;
  }
  if (result.whenSkipped) {
    // Agent 给了 when，却因为 pocket 停在 v1 没落盘；不说就等于把话吞了
    output += `\n⚠️ ${result.whenSkipped}`;
  }
  // 本轮新建的块缺了 verify 会判 ERROR 的小节：当场给修法
  if (result.missingSections && result.missingSections.length > 0) {
    output += `\n🧾 T${result.tId} is missing ${result.missingSections.join(' / ')} — verify counts that as an ERROR. Lite has no log amend: edit that block in log.md directly and add the missing "### ${result.missingSections.join('" / "### ')}" section(s).`;
  }

  if (args.verify !== false) {
    const verifyResult = verify(pocketDir);
    if (verifyResult.errorCount > 0) {
      output += `\n\n⚠️ **Verification found ${verifyResult.errorCount} error(s).** Run context_pocket_verify for details.`;
    }
  }

  return {
    content: [{ type: 'text', text: output }],
  };
}
