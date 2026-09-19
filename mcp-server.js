#!/usr/bin/env node
'use strict';

/**
 * ContextPocket MCP Server
 *
 * Exposes ContextPocket tools via the Model Context Protocol (MCP).
 * Zero-dependency implementation using stdio transport.
 *
 * Usage (in MCP config):
 *   {
 *     "command": "node",
 *     "args": ["path/to/mcp-server.js"],
 *     "cwd": "<project-root>"
 *   }
 */

const path = require('path');
const { findPocketDir, readConfig, getProjectRoot } = require('./lib/core');
const { parseAll } = require('./lib/parser');
const { verify } = require('./lib/validator');
const {
  appendLogBlock,
  addRequirement,
  addDecision,
  generateHandoff,
  archiveLog,
  updateState,
  updatePreferences,
  updateCodeMap,
} = require('./lib/writer');
const { bootstrap } = require('./lib/bootstrap');
const { recall, diff, search, why, checkConflicts } = require('./lib/query');
const { runMigration, listMigrations, detectFormatVersion } = require('./lib/migrate');
const { installPreCommitHook, uninstallPreCommitHook } = require('./lib/hooks');
const { sync: syncPocket } = require('./lib/sync');
const { buildIndex, searchWithIndex } = require('./lib/indexer');
const { distill } = require('./lib/distill');
const { importSession } = require('./lib/importer');
const {
  getHubDir,
  getHubFile,
  registerProject,
  touchProject,
  removeProject,
  listProjects,
  setGlobalPref,
  getGlobalPref,
} = require('./lib/userhub');

// ============================================================
// MCP stdio transport
// ============================================================

let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

function processBuffer() {
  while (true) {
    // MCP 规范：Content-Length 按 UTF-8 字节计 → 头部解析必须按字节，
    // 不能把 buffer 当 JS 字符串处理（中文/emoji 字节数 > 字符数）。
    const headerMatch = buffer.toString('latin1').match(/Content-Length:\s*(\d+)\r\n\r\n/i);
    if (!headerMatch) break;

    const contentLength = parseInt(headerMatch[1], 10);
    const headerByteLen = Buffer.byteLength(headerMatch[0], 'latin1');
    const bodyStart = headerMatch.index + headerByteLen;
    const bodyEnd = bodyStart + contentLength;

    if (buffer.length < bodyEnd) break;

    const body = buffer.slice(bodyStart, bodyStart + contentLength).toString('utf-8');
    buffer = buffer.slice(bodyEnd);

    try {
      const message = JSON.parse(body);
      handleMessage(message);
    } catch (e) {
      sendError(null, -32700, 'Parse error: ' + e.message);
    }
  }
}

function sendMessage(message) {
  const body = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n`;
  process.stdout.write(header + body);
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

function handleMessage(msg) {
  if (msg.jsonrpc !== '2.0') {
    sendError(msg.id || null, -32600, 'Invalid Request: jsonrpc version mismatch');
    return;
  }

  if (msg.id === undefined) {
    if (msg.method === 'notifications/initialized') {
      // 客户端初始化完成，不用做什么
    }
    return;
  }

  switch (msg.method) {
    case 'initialize':
      handleInitialize(msg.id, msg.params || {});
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
  sendResponse(id, {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: 'context-pocket',
      version: '1.0.0',
    },
  });
}

// ============================================================
// 工具定义
// ============================================================

const TOOLS = [
  // --- Setup ---
  {
    name: 'context_pocket_bootstrap',
    description: 'Initialize ContextPocket/ directory with template files. Auto-detects project type. Run this first to set up a new project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectType: {
          type: 'string',
          description: 'Project type: frontend/backend/fullstack/data/mobile (auto-detected if not specified)',
        },
        mode: {
          type: 'string',
          enum: ['full', 'lite'],
          description: 'full = all 10 core files; lite = 5 core files only',
          default: 'full',
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
    description: 'Get current ContextPocket status summary (latest T, requirements, decisions, etc.)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'context_pocket_verify',
    description: 'Run health check on ContextPocket. Checks file existence, ID continuity, references, code map drift. Pass drift=true to enable AOCI-style cognition drift detection (log.md vs working tree).',
    inputSchema: {
      type: 'object',
      properties: {
        quiet: {
          type: 'boolean',
          description: 'Only show errors and warnings',
          default: false,
        },
        drift: {
          type: 'boolean',
          description: 'Enable cognition drift check: compares files referenced in recent T-blocks against the working tree. Slower (walks the project tree).',
          default: false,
        },
        lastN: {
          type: 'number',
          description: 'When drift=true, how many recent T-blocks to compare (default: 5)',
          default: 5,
        },
      },
    },
  },
  {
    name: 'context_pocket_recall',
    description: 'Show full details of a specific T-block (gist, tags, all sections).',
    inputSchema: {
      type: 'object',
      required: ['tId'],
      properties: {
        tId: {
          type: 'integer',
          description: 'T-block ID number',
        },
      },
    },
  },
  {
    name: 'context_pocket_diff',
    description: 'Compare two T-blocks. Shows changes in requirements (added/completed/cancelled), decisions (new ADRs), and files.',
    inputSchema: {
      type: 'object',
      required: ['tA', 'tB'],
      properties: {
        tA: {
          type: 'integer',
          description: 'Earlier T-block ID',
        },
        tB: {
          type: 'integer',
          description: 'Later T-block ID',
        },
      },
    },
  },
  {
    name: 'context_pocket_search',
    description: 'Search all T-blocks by keyword. Searches gist and all section content.',
    inputSchema: {
      type: 'object',
      required: ['keyword'],
      properties: {
        keyword: {
          type: 'string',
          description: 'Keyword to search for',
        },
      },
    },
  },
  {
    name: 'context_pocket_why',
    description: 'Reverse lookup: which T-blocks mentioned this file path? Inspired by ThoughtDAG why_file/why_check. Searches Action/Changes/Pitfalls/Notes/Commits/User sections. Returns most recent first.',
    inputSchema: {
      type: 'object',
      required: ['filePath'],
      properties: {
        filePath: {
          type: 'string',
          description: 'File path or partial path (e.g. "lib/parser.js" or "CHANGELOG.md")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of T-blocks to return (default: 10)',
          default: 10,
        },
      },
    },
  },
  {
    name: 'context_pocket_check_conflicts',
    description: 'Scan for conflicts across 6 dimensions: tech stack, requirements, ADRs, style, deployment, and 🔒 absolute. Three severity levels: critical / warning / info.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'context_pocket_sync',
    description: 'Git safety net: detect staged file changes that were NOT recorded in recent T-blocks ("agent forgot to log"), and optionally auto-record them as a [auto] T-block. Use auto=true to fill the gap.',
    inputSchema: {
      type: 'object',
      properties: {
        auto: {
          type: 'boolean',
          description: 'Auto-record unlogged staged files as a [auto] T-block',
          default: false,
        },
        dryRun: {
          type: 'boolean',
          description: 'Show the plan without writing anything',
          default: false,
        },
        lastN: {
          type: 'integer',
          description: 'Look back over the last N T-blocks when checking coverage',
          default: 5,
        },
      },
    },
  },
  // --- Write ---
  {
    name: 'context_pocket_log_append',
    description: 'Append a new T-block to log.md. Auto-assigns T-ID, updates index. Always use this instead of manually editing log.md.',
    inputSchema: {
      type: 'object',
      required: ['gist'],
      properties: {
        gist: {
          type: 'string',
          description: 'One-line summary of this turn',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for this turn (e.g. 需求变更, 代码逻辑, Bug)',
        },
        user: {
          type: 'string',
          description: 'User\'s request text',
        },
        action: {
          type: 'string',
          description: 'What was done (action type + file + description)',
        },
        decisions: {
          type: 'string',
          description: 'Decisions or constraints from this turn',
        },
        pitfalls: {
          type: 'string',
          description: 'Pitfalls discovered',
        },
        preferences: {
          type: 'string',
          description: 'User preferences noted',
        },
        verify: {
          type: 'boolean',
          description: 'Run verify after appending',
          default: true,
        },
      },
    },
  },
  {
    name: 'context_pocket_req_add',
    description: 'Add a new requirement. Auto-assigns R-ID and updates index.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description: 'Requirement description',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for this requirement',
        },
        uncertain: {
          type: 'boolean',
          description: 'Mark as inferred/unconfirmed (❓)',
          default: false,
        },
        impl: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files implementing this requirement',
        },
        status: {
          type: 'string',
          enum: ['Open', 'Done', 'Cancelled'],
          default: 'Open',
        },
      },
    },
  },
  {
    name: 'context_pocket_decision_add',
    description: 'Add a new ADR (Architecture Decision Record). Auto-assigns ADR number.',
    inputSchema: {
      type: 'object',
      required: ['title', 'context', 'options', 'decision'],
      properties: {
        title: {
          type: 'string',
          description: 'Decision title (e.g. "Use Express over NestJS")',
        },
        context: {
          type: 'string',
          description: 'Problem / what was on the table',
        },
        options: {
          type: 'string',
          description: 'Options considered (A / B / C with brief pros)',
        },
        decision: {
          type: 'string',
          description: 'Chosen option + why',
        },
        consequences: {
          type: 'string',
          description: 'What this locks in, what becomes harder',
        },
        supersedes: {
          type: 'string',
          description: 'Which ADR this supersedes (e.g. "ADR-1 + reason") or "none"',
          default: 'none',
        },
      },
    },
  },
  {
    name: 'context_pocket_handoff',
    description: 'Generate handoff.md — a single-file summary for the next agent to get up to speed.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'context_pocket_state_update',
    description: 'Update state.md. Updates T-number automatically. Can update summary, next steps, and pitfalls.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Text to set/append to Summary section',
        },
        appendSummary: {
          type: 'boolean',
          description: 'Append to Summary instead of replacing',
          default: false,
        },
        nextStep: {
          type: 'string',
          description: 'Next step to append',
        },
        pitfall: {
          type: 'string',
          description: 'Pitfall to append',
        },
      },
    },
  },
  {
    name: 'context_pocket_preferences_update',
    description: 'Update or add a preference entry in preferences.md. Updates T-number automatically.',
    inputSchema: {
      type: 'object',
      required: ['key', 'value'],
      properties: {
        key: {
          type: 'string',
          description: 'Preference key (e.g. "coding style", "tooling")',
        },
        value: {
          type: 'string',
          description: 'Preference value',
        },
      },
    },
  },
  {
    name: 'context_pocket_code_map_update',
    description: 'Rescan project directory and update code-map.md. Preserves existing descriptions; marks new files as TODO.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // --- Maintenance ---
  {
    name: 'context_pocket_archive',
    description: 'Archive old T-blocks to log-archive.md. Runs verify before and after. Rolls back on failure.',
    inputSchema: {
      type: 'object',
      properties: {
        keepLast: {
          type: 'integer',
          description: 'Keep latest N T-blocks in log.md',
          default: 20,
        },
        dryRun: {
          type: 'boolean',
          description: 'Show what would be archived, don\'t modify files',
          default: false,
        },
      },
    },
  },
  {
    name: 'context_pocket_migrate',
    description: 'Migrate ContextPocket data format to a new version. Auto-backs up before migrating. Rolls back on failure.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Target version (default: latest)',
        },
        dryRun: {
          type: 'boolean',
          description: 'Show migration plan, don\'t modify files',
          default: false,
        },
        list: {
          type: 'boolean',
          description: 'List available migrations without executing',
          default: false,
        },
      },
    },
  },
  // --- Git Hooks ---
  {
    name: 'context_pocket_install_hook',
    description: 'Install a git pre-commit hook (v2: two-step). Step 1 runs context-pocket sync --auto to auto-fill missed T-blocks from staged changes. Step 2 runs context-pocket verify --quiet; blocks commit only if verify finds errors (warnings allow). Upgrades v1 hook automatically.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'context_pocket_uninstall_hook',
    description: 'Uninstall the ContextPocket pre-commit hook. If other hook content exists, only removes the ContextPocket section.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // --- Long-term memory ---
  {
    name: 'context_pocket_index',
    description: 'Build or refresh the derived search index (T-blocks + ADRs + requirements + preferences) at ContextPocket/assets/search-index.json. Markdown files remain the source of truth; the index is a cache that auto-refreshes on search, so this tool is mostly for forcing a rebuild after bulk edits or imports.',
    inputSchema: {
      type: 'object',
      properties: {
        rebuild: {
          type: 'boolean',
          description: 'Ignore the existing index and rebuild from scratch',
          default: false,
        },
      },
    },
  },
  {
    name: 'context_pocket_distill',
    description: 'Distill old content: scan log-archive.md plus old turns in log.md and extract candidate decisions / pitfalls / preferences / open ❓ items worth promoting back into the living docs (decisions.md / state.md / preferences.md). Writes a digest report ContextPocket/digest-<date>.md — review it, merge still-valid items with their T references, then delete the report.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          description: 'Report counts only, do not write the digest file',
          default: false,
        },
      },
    },
  },
  {
    name: 'context_pocket_import',
    description: 'Import past agent conversation sessions (claude-code / codex JSONL, auto-detected) as [imported] T-blocks. T numbers continue from the current latest. Useful when enabling ContextPocket on a project that already has agent history.',
    inputSchema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          description: 'Path to the session .jsonl file (required)',
        },
        source: {
          type: 'string',
          enum: ['auto', 'claude-code', 'codex'],
          description: 'Session source (default: auto-detect)',
          default: 'auto',
        },
        limit: {
          type: 'integer',
          description: 'Maximum turns to import (default: 100)',
          default: 100,
        },
        truncate: {
          type: 'integer',
          description: 'Max characters per imported field (default: 400)',
          default: 400,
        },
        dryRun: {
          type: 'boolean',
          description: 'Show what would be imported, do not write',
          default: false,
        },
      },
    },
  },
  {
    name: 'context_pocket_hub',
    description: 'User-level memory hub at ~/.contextpocket/hub.json (redirect the folder with the CONTEXTPOCKET_HOME env var to share it across machines). Actions: list registered projects (default), set/get global preferences, or unregister a project. The hub is only a registry — project data always lives in each project\'s ContextPocket/.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'pref', 'remove'],
          description: 'list = registered projects (default); pref = global preferences; remove = unregister this project',
          default: 'list',
        },
        key: {
          type: 'string',
          description: 'Preference key (action=pref): with value sets it, alone reads it',
        },
        value: {
          type: 'string',
          description: 'Preference value (action=pref with key sets the global preference)',
        },
      },
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
      // Setup
      case 'context_pocket_bootstrap':
        result = toolBootstrap(args || {});
        break;

      // Inspection
      case 'context_pocket_status':
        result = toolStatus();
        break;
      case 'context_pocket_verify':
        result = toolVerify(args || {});
        break;
      case 'context_pocket_recall':
        result = toolRecall(args || {});
        break;
      case 'context_pocket_diff':
        result = toolDiff(args || {});
        break;
      case 'context_pocket_search':
        result = toolSearch(args || {});
        break;
      case 'context_pocket_why':
        result = toolWhy(args || {});
        break;
      case 'context_pocket_check_conflicts':
        result = toolCheckConflicts();
        break;

      // Git safety net
      case 'context_pocket_sync':
        result = toolSync(args || {});
        break;

      // Write
      case 'context_pocket_log_append':
        result = toolLogAppend(args || {});
        break;
      case 'context_pocket_req_add':
        result = toolReqAdd(args || {});
        break;
      case 'context_pocket_decision_add':
        result = toolDecisionAdd(args || {});
        break;
      case 'context_pocket_handoff':
        result = toolHandoff();
        break;
      case 'context_pocket_state_update':
        result = toolStateUpdate(args || {});
        break;
      case 'context_pocket_preferences_update':
        result = toolPreferencesUpdate(args || {});
        break;
      case 'context_pocket_code_map_update':
        result = toolCodeMapUpdate();
        break;

      // Maintenance
      case 'context_pocket_archive':
        result = toolArchive(args || {});
        break;
      case 'context_pocket_migrate':
        result = toolMigrate(args || {});
        break;

      // Git Hooks
      case 'context_pocket_install_hook':
        result = toolInstallHook();
        break;
      case 'context_pocket_uninstall_hook':
        result = toolUninstallHook();
        break;

      // Long-term memory
      case 'context_pocket_index':
        result = toolIndex(args || {});
        break;
      case 'context_pocket_distill':
        result = toolDistill(args || {});
        break;
      case 'context_pocket_import':
        result = toolImport(args || {});
        break;
      case 'context_pocket_hub':
        result = toolHub(args || {});
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

  const result = bootstrap(projectDir, {
    projectType: args.projectType,
    mode: args.mode,
    language: args.language,
    // gitignore: false → 让 ContextPocket/ 进 git（跨设备同步）
    gitignore: args.gitignore,
  });

  const lines = [];
  lines.push('✅ **ContextPocket initialized!**');
  lines.push('');
  lines.push(`- **Project type:** ${result.projectType}`);
  lines.push(`- **Mode:** ${result.mode}`);
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

  // 注册到用户级 hub（best-effort，失败不影响 bootstrap）
  try {
    registerProject(projectDir, {
      projectType: result.projectType,
      mode: result.mode,
      latestT: 0,
    });
    lines.push(`- **Hub:** registered in ${getHubFile()}`);
    lines.push('');
  } catch (e) {
    // hub 不可用（只读 home 等）→ 静默跳过
  }

  lines.push('**Next steps:**');
  lines.push('1. Edit ContextPocket/readme.md with project info');
  lines.push('2. Run context_pocket_verify to check health');
  lines.push('3. Run context_pocket_install_hook to enable pre-commit checks');

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
  lines.push('**ContextPocket Status**');
  lines.push('');
  lines.push(`- **Latest:** T${data.log.latestT}`);
  lines.push(`- **Log:** ${data.log.blocks.length} T-blocks${data.index.hasArchive ? ' (+ archive)' : ''}`);
  lines.push(`- **Requirements:** ${data.requirements.openCount} open / ${data.requirements.doneCount} done / ${data.requirements.cancelledCount} cancelled`);
  if (data.requirements.uncertainCount > 0) {
    lines.push(`  - ❓ ${data.requirements.uncertainCount} uncertain`);
  }
  lines.push(`- **Decisions:** ${data.decisions.count} ADRs`);
  lines.push(`- **Absolute:** ${data.absolute.count} entries`);
  lines.push(`- **Mode:** ${config.mode} · language: ${config.language}`);

  if (data.state.nextSteps.length > 0) {
    lines.push('');
    lines.push('**Next Steps:**');
    for (const step of data.state.nextSteps.slice(0, 5)) {
      lines.push(`- ${step}`);
    }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function toolVerify(args) {
  const pocketDir = getPocketDir();
  const drift = !!args.drift;
  const lastN = args.lastN || 5;
  const result = verify(pocketDir, { drift, lastN });
  const { results, errorCount, warningCount, infoCount } = result;
  const quiet = args.quiet || false;

  const lines = [];
  lines.push('**ContextPocket · Verify**');
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
        if (r.fix && r.severity !== 'info') {
          lines.push(`  - Fix: ${r.fix}`);
        }
      }
      lines.push('');
    }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function toolRecall(args) {
  const pocketDir = getPocketDir();
  const tId = args.tId;

  if (!tId) {
    return {
      content: [{ type: 'text', text: '❌ Error: tId is required' }],
      isError: true,
    };
  }

  const result = recall(pocketDir, parseInt(tId, 10));
  if (!result) {
    return {
      content: [{ type: 'text', text: `❌ Error: T${tId} not found` }],
      isError: true,
    };
  }

  const lines = [];
  lines.push(`## T${result.id} · ${result.gist}`);
  if (result.tags && result.tags.length > 0) {
    lines.push(result.tags.map(t => `[${t}]`).join(' '));
  }
  if (result.session) {
    lines.push(`*Session: ${result.session}*`);
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

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function toolDiff(args) {
  const pocketDir = getPocketDir();
  const tA = args.tA;
  const tB = args.tB;

  if (!tA || !tB) {
    return {
      content: [{ type: 'text', text: '❌ Error: both tA and tB are required' }],
      isError: true,
    };
  }

  const result = diff(pocketDir, parseInt(tA, 10), parseInt(tB, 10));

  const lines = [];
  lines.push(`## Diff: T${result.tA} → T${result.tB}`);
  lines.push(`*${result.gistA} → ${result.gistB}*`);
  lines.push('');

  // Requirements
  lines.push('### 📋 Requirements');
  if (result.requirements.added.length === 0 &&
      result.requirements.completed.length === 0 &&
      result.requirements.cancelled.length === 0) {
    lines.push('*(no changes)*');
  } else {
    for (const r of result.requirements.added) {
      lines.push(`- ➕ R${r.id}: ${r.text} (opened T${r.openedAt})`);
    }
    for (const r of result.requirements.completed) {
      lines.push(`- ✅ R${r.id}: ${r.text} (completed T${r.completedAt})`);
    }
    for (const r of result.requirements.cancelled) {
      lines.push(`- ❌ R${r.id}: ${r.text} (cancelled T${r.cancelledAt})`);
    }
  }
  lines.push('');

  // Decisions
  lines.push('### 🧠 Decisions');
  if (result.decisions.added.length === 0) {
    lines.push('*(no new ADRs)*');
  } else {
    for (const adr of result.decisions.added) {
      lines.push(`- ➕ ADR-${adr.id}: ${adr.title} (T${adr.createdAt})`);
    }
  }
  lines.push('');

  // Files
  lines.push('### 📁 Files');
  if (result.files.added.length === 0 &&
      result.files.removed.length === 0 &&
      result.files.modified.length === 0) {
    lines.push('*(no file changes detected)*');
  } else {
    for (const f of result.files.added) {
      lines.push(`- ➕ ${f}`);
    }
    for (const f of result.files.removed) {
      lines.push(`- ➖ ${f}`);
    }
    for (const f of result.files.modified) {
      lines.push(`- 🔄 ${f}`);
    }
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

  // 优先倒排索引（覆盖 T-block + ADR + R + prefs，历史增长后依然即时）；
  // 索引不可用时回退全量扫描
  let results = searchWithIndex(pocketDir, keyword);
  if (results === null) {
    results = search(pocketDir, keyword);
  }

  const lines = [];
  lines.push(`## Search: "${keyword}"`);
  lines.push(`${results.length} match${results.length !== 1 ? 'es' : ''} found`);
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
      } else {
        const tagsStr = r.tags && r.tags.length > 0
          ? ' ' + r.tags.map(t => `[${t}]`).join('')
          : '';
        lines.push(`- **T${r.id}**${tagsStr}: ${r.gist}`);
        printHighlights(r);
      }
    }
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

  const limit = args.limit || 10;
  const results = why(pocketDir, filePath, { limit });

  const lines = [];
  lines.push(`## Why: "${filePath}"`);
  lines.push(`${results.length} T-block${results.length !== 1 ? 's' : ''} referenced this file`);
  lines.push('');

  if (results.length === 0) {
    lines.push('*(no references found)*');
  } else {
    for (const r of results) {
      const tagsStr = r.tags.length > 0
        ? ' ' + r.tags.map(t => `[${t}]`).join('')
        : '';
      lines.push(`- **T${r.id}**${tagsStr}: ${r.gist}`);
      if (r.references.length > 0) {
        for (const ref of r.references.slice(0, 3)) {
          const snippet = ref.text.length > 80 ? ref.text.slice(0, 80) + '...' : ref.text;
          lines.push(`  - *[${ref.section}]* ${snippet}`);
        }
      }
    }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function toolCheckConflicts() {
  const pocketDir = getPocketDir();
  const result = checkConflicts(pocketDir);

  const lines = [];
  lines.push('## ContextPocket · Conflict Scan');
  lines.push(`🔴 **critical:** ${result.criticalCount}`);
  lines.push(`🟡 **warning:** ${result.warningCount}`);
  lines.push(`🔵 **info:** ${result.infoCount}`);
  lines.push('');

  for (const cat of result.categories) {
    const hasCritical = cat.items.some(i => i.severity === 'critical');
    const hasWarning = cat.items.some(i => i.severity === 'warning');
    const icon = hasCritical ? '🔴' : hasWarning ? '🟡' : '🟢';

    lines.push(`### ${icon} ${cat.name}`);
    for (const item of cat.items) {
      const sevIcon = item.severity === 'critical' ? '🔴'
        : item.severity === 'warning' ? '🟡' : '🔵';
      lines.push(`- ${sevIcon} ${item.message}`);
      if (item.detail) {
        const detailLines = item.detail.split('\n');
        for (const dl of detailLines) {
          lines.push(`  - ${dl}`);
        }
      }
    }
    lines.push('');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

// --- Git safety net ---

function toolSync(args) {
  const pocketDir = getPocketDir();
  const auto = !!args.auto;
  const dryRun = !!args.dryRun;
  const lastN = args.lastN || 5;

  const result = syncPocket(pocketDir, { auto, dryRun, lastN });

  const lines = [];
  lines.push('**ContextPocket · Git Safety Net (sync)**');
  lines.push('');

  if (result.skipped) {
    lines.push(`ℹ️ **Skipped:** ${result.reason}`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (result.error) {
    lines.push(`❌ **Error:** ${result.error}`);
    return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
  }

  if (result.clean) {
    lines.push(`✅ **No unrecorded changes** — ${result.changedCount} staged file(s), all covered by recent T-blocks.`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  const files = result.unrecorded.map(c => `- ${c.path}`).join('\n');

  if (result.dryRun) {
    lines.push(`📋 **Plan (dry-run):** ${result.unrecorded.length} staged file(s) not recorded in recent T-blocks:`);
    lines.push(files);
    lines.push('');
    lines.push(`Would auto-record T${result.nextT} with tag \[auto\]. *(dry-run: no files modified)*`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (result.auto && result.filled) {
    lines.push(`✅ **Auto-recorded:** added T${result.tId} [auto] covering ${result.unrecorded.length} staged file(s):`);
    lines.push(files);
    lines.push('');
    lines.push('Review the auto T-block and expand with real details if needed.');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // report-only
  lines.push(`⚠️ **Unrecorded staged changes:** ${result.unrecorded.length} file(s) not covered by recent T-blocks:`);
  lines.push(files);
  lines.push('');
  lines.push('Call again with `auto: true` to auto-record, or record manually.');
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// --- Write ---

function toolLogAppend(args) {
  const pocketDir = getPocketDir();

  if (!args.gist) {
    return {
      content: [{ type: 'text', text: '❌ Error: gist is required' }],
      isError: true,
    };
  }

  const result = appendLogBlock(pocketDir, {
    gist: args.gist,
    tags: args.tags || [],
    user: args.user ? [args.user] : [],
    action: args.action ? [args.action] : [],
    decisions: args.decisions ? [args.decisions] : [],
    pitfalls: args.pitfalls ? [args.pitfalls] : [],
    preferences: args.preferences ? [args.preferences] : [],
  });

  // 副作用：更新 hub 活跃信息 + 刷新搜索索引（都 best-effort，不阻断记录）
  try {
    touchProject(getProjectRoot(pocketDir), { latestT: result.tId, gist: args.gist });
  } catch (e) { /* hub 不可用 */ }
  try {
    buildIndex(pocketDir, {});
  } catch (e) { /* 索引在下次 search 时懒刷新 */ }

  let output = `✅ **T${result.tId} added:** ${args.gist}`;

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

function toolReqAdd(args) {
  const pocketDir = getPocketDir();

  if (!args.text) {
    return {
      content: [{ type: 'text', text: '❌ Error: text is required' }],
      isError: true,
    };
  }

  const result = addRequirement(pocketDir, {
    text: args.text,
    tags: args.tags || [],
    status: args.status || 'Open',
    uncertain: !!args.uncertain,
    impl: args.impl || [],
  });

  const prefix = args.uncertain ? '❓ ' : '';
  return {
    content: [{ type: 'text', text: `✅ **${prefix}R${result.rId} added:** ${args.text}` }],
  };
}

function toolDecisionAdd(args) {
  const pocketDir = getPocketDir();

  if (!args.title) {
    return {
      content: [{ type: 'text', text: '❌ Error: title is required' }],
      isError: true,
    };
  }

  const result = addDecision(pocketDir, {
    title: args.title,
    context: args.context || '',
    options: args.options || '',
    decision: args.decision || '',
    consequences: args.consequences || '',
    supersedes: args.supersedes || 'none',
  });

  return {
    content: [{ type: 'text', text: `✅ **ADR-${result.adrId} added:** ${args.title}` }],
  };
}

function toolHandoff() {
  const pocketDir = getPocketDir();
  const result = generateHandoff(pocketDir);

  return {
    content: [
      {
        type: 'text',
        text: `✅ **Handoff generated:** T${result.tId} · ${result.date}\n\nFile: ContextPocket/handoff.md`,
      },
    ],
  };
}

function toolStateUpdate(args) {
  const pocketDir = getPocketDir();
  const result = updateState(pocketDir, {
    summary: args.summary,
    appendSummary: !!args.appendSummary,
    nextStep: args.nextStep,
    pitfall: args.pitfall,
  });

  const lines = [];
  lines.push('✅ **state.md updated**');
  lines.push(`- Updated fields: ${result.updatedFields.join(', ')}`);
  lines.push(`- Latest T: T${result.latestT}`);

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function toolPreferencesUpdate(args) {
  const pocketDir = getPocketDir();

  if (!args.key) {
    return {
      content: [{ type: 'text', text: '❌ Error: key is required' }],
      isError: true,
    };
  }
  if (args.value === undefined) {
    return {
      content: [{ type: 'text', text: '❌ Error: value is required' }],
      isError: true,
    };
  }

  const result = updatePreferences(pocketDir, {
    key: args.key,
    value: args.value,
  });

  const action = result.isNew ? 'added' : 'updated';
  return {
    content: [{
      type: 'text',
      text: `✅ **Preference ${action}:**\n- ${result.key}: ${result.value}\n- Latest T: T${result.latestT}`,
    }],
  };
}

function toolCodeMapUpdate() {
  const pocketDir = getPocketDir();
  const result = updateCodeMap(pocketDir);

  const lines = [];
  lines.push('✅ **code-map.md updated**');
  lines.push(`- Added: ${result.addedCount} files`);
  lines.push(`- Removed: ${result.removedCount} files`);
  lines.push(`- Existing: ${result.existingCount} files`);

  if (result.added.length > 0) {
    lines.push('');
    lines.push('**New files (add descriptions):**');
    for (const f of result.added.slice(0, 10)) {
      lines.push(`- ${f}`);
    }
    if (result.added.length > 10) {
      lines.push(`- ... and ${result.added.length - 10} more`);
    }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

// --- Maintenance ---

function toolArchive(args) {
  const pocketDir = getPocketDir();
  const result = archiveLog(pocketDir, {
    keepLast: args.keepLast || 20,
    dryRun: !!args.dryRun,
  });

  const lines = [];

  if (result.skipped) {
    lines.push('ℹ️ **Archive skipped**');
    lines.push(result.reason);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (args.dryRun) {
    lines.push('📋 **Archive plan (dry-run)**');
  } else {
    lines.push('✅ **Archive completed!**');
  }
  lines.push(`- Archived: ${result.archivedCount} blocks (T${result.firstArchivedId}–T${result.lastArchivedId})`);
  lines.push(`- Kept: ${result.keptCount} blocks (T${result.firstKeptId}–T${result.lastKeptId})`);
  lines.push('');

  if (result.summary.length > 0) {
    lines.push('**Archive summary:**');
    for (const line of result.summary) {
      lines.push(`- ${line}`);
    }
  }

  if (args.dryRun) {
    lines.push('');
    lines.push('*(dry-run: no files were modified)*');
  }

  // 归档改变了 T-block 分布 → 静默刷新索引（best-effort）
  if (!args.dryRun) {
    try {
      buildIndex(pocketDir, {});
    } catch (e) { /* 索引在下次 search 时懒刷新 */ }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function toolMigrate(args) {
  const pocketDir = getPocketDir();

  if (args.list) {
    const info = listMigrations(pocketDir, args.to);
    const lines = [];
    lines.push('## ContextPocket · Migration');
    lines.push(`- **Current version:** ${info.currentVersion || '(unknown)'}`);
    lines.push(`- **Target version:** ${info.targetVersion}`);
    lines.push(`- **Status:** ${info.isLatest ? 'up to date' : 'upgrade available'}`);

    if (info.path.length > 0 && !info.isLatest) {
      lines.push('');
      lines.push('**Migration path:**');
      for (const step of info.path) {
        lines.push(`- ${step.from} → ${step.to}: ${step.name}`);
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  const result = runMigration(pocketDir, {
    to: args.to,
    dryRun: !!args.dryRun,
  });

  const lines = [];

  if (result.skipped) {
    lines.push('ℹ️ **Migration skipped**');
    lines.push(result.reason);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (args.dryRun) {
    lines.push('📋 **Migration plan (dry-run)**');
    lines.push(`- From: ${result.fromVersion}`);
    lines.push(`- To: ${result.toVersion}`);
    lines.push(`- Steps: ${result.planned.length}`);
    for (const step of result.planned) {
      lines.push(`  - ${step.from} → ${step.to}: ${step.name}`);
    }
    lines.push('');
    lines.push('*(dry-run: no files were modified)*');
  } else {
    lines.push('✅ **Migration complete!**');
    lines.push(`- From: ${result.fromVersion} → To: ${result.toVersion}`);
    lines.push(`- Steps executed: ${result.steps.length}`);
    lines.push(`- Backup: ${result.backupPath}`);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

// --- Git Hooks ---

function toolInstallHook() {
  const projectDir = process.cwd();
  const result = installPreCommitHook(projectDir);

  const lines = [];
  if (result.action === 'created') {
    lines.push('✅ **Pre-commit hook installed**');
  } else if (result.action === 'appended') {
    lines.push('✅ **Pre-commit hook appended to existing hook**');
  } else if (result.action === 'upgraded') {
    lines.push('✅ **Pre-commit hook upgraded to v2 (sync + verify)**');
  } else if (result.action === 'already-installed') {
    lines.push('ℹ️ **Pre-commit hook already installed**');
  }
  lines.push(`- Hook path: ${result.hookPath}`);
  lines.push('');
  lines.push('Before each commit the hook will:');
  lines.push('1. `context_pocket_sync` (auto) — record staged files missed in recent T-blocks');
  lines.push('2. `context_pocket_verify` — block on errors, allow warnings');

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function toolUninstallHook() {
  const projectDir = process.cwd();
  const result = uninstallPreCommitHook(projectDir);

  const lines = [];
  switch (result.action) {
    case 'deleted':
      lines.push('✅ **Pre-commit hook removed**');
      break;
    case 'removed-section':
      lines.push('✅ **ContextPocket section removed from pre-commit hook**');
      break;
    case 'not-found':
      lines.push('ℹ️ **No pre-commit hook found**');
      break;
    case 'not-installed':
      lines.push('ℹ️ **ContextPocket hook not found in pre-commit**');
      break;
  }
  lines.push(`- Hook path: ${result.hookPath}`);

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

// --- Long-term memory ---

function toolIndex(args) {
  const pocketDir = getPocketDir();
  const result = buildIndex(pocketDir, { rebuild: !!args.rebuild });

  const lines = [];
  lines.push(`✅ **Search index ${result.rebuilt ? 'built' : 'refreshed'}**`);
  lines.push(`- Docs indexed: ${result.docsCount} (T-blocks + ADRs + reqs + prefs)`);
  lines.push(`- Terms: ${result.termsCount}`);
  if (!result.rebuilt) {
    lines.push(`- Delta: +${result.added} added · ~${result.updated} updated · -${result.removed} removed · ${result.reused} reused`);
  }
  lines.push(`- Took: ${result.tookMs}ms`);
  lines.push(`- File: ${path.relative(process.cwd(), result.path) || result.path}`);
  lines.push('');
  lines.push('Markdown files remain the single source of truth —');
  lines.push('the index is a derived cache you can rebuild anytime.');

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function toolDistill(args) {
  const pocketDir = getPocketDir();
  const dryRun = !!args.dryRun;

  const result = distill(pocketDir, { dryRun });

  const lines = [];

  if (result.nothing) {
    lines.push('ℹ️ **Nothing to distill yet:**');
    lines.push('- No log-archive.md and no old turns in log.md.');
    lines.push('- Distill becomes useful after /archive moves old T-blocks out.');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  lines.push(`## 📦 Distill scan: T${result.tRange.min}–T${result.tRange.max} (${result.scannedBlocks} blocks)`);
  lines.push('');
  lines.push(`- Candidate decisions  (→ decisions.md):  ${result.candidates.decisions.length}`);
  lines.push(`- Candidate pitfalls   (→ state.md):      ${result.candidates.pitfalls.length}`);
  lines.push(`- Candidate preferences(→ preferences.md):${result.candidates.preferences.length}`);
  lines.push(`- Open ❓ in archive   (→ confirm):       ${result.candidates.uncertain.length}`);

  if (dryRun) {
    lines.push('');
    lines.push('*(dry-run: no report file written — rerun without dryRun to save)*');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  lines.push('');
  lines.push(`✅ **Digest report generated: ${path.basename(result.outFile)}**`);
  lines.push('');
  lines.push('Next: review the report, merge still-valid items into the living docs');
  lines.push('(decisions.md / state.md / preferences.md) with their T references,');
  lines.push('then delete the report.');

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function toolImport(args) {
  const pocketDir = getPocketDir();

  if (!args.file) {
    return {
      content: [{ type: 'text', text: '❌ Error: file is required (path to a session .jsonl file)' }],
      isError: true,
    };
  }

  const result = importSession(pocketDir, {
    file: args.file,
    source: args.source || 'auto',
    limit: args.limit ? parseInt(args.limit, 10) : 100,
    truncate: args.truncate ? parseInt(args.truncate, 10) : 400,
    dryRun: !!args.dryRun,
  });

  if (result.dryRun) {
    const lines = [];
    lines.push(`## 📋 Import plan (dry-run): ${result.plannedTurns} turn(s) from ${result.source} session`);
    for (const p of result.preview) {
      lines.push(`- ${p.ts ? `[${p.ts}] ` : ''}${p.gist}`);
    }
    lines.push('');
    lines.push('*(dry-run: nothing written — rerun without dryRun to import)*');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (result.imported === 0) {
    return {
      content: [{
        type: 'text',
        text: 'ℹ️ **No importable turns found in this session file.**\nSupported: claude-code / codex session JSONL (source auto-detected).',
      }],
    };
  }

  const lines = [];
  lines.push('✅ **Session imported**');
  lines.push(`- Source: ${result.source}`);
  lines.push(`- Turns: ${result.imported} (T${result.tStart}–T${result.tEnd}, tagged [imported])`);
  lines.push('');
  lines.push('Imported blocks are conversation backfill — skim them with');
  lines.push('context_pocket_recall and enrich gists where needed.');

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function toolHub(args) {
  const action = args.action || 'list';
  const lines = [];

  if (action === 'pref') {
    // 无 key → 列出全部全局偏好
    if (!args.key) {
      const prefs = getGlobalPref() || {};
      const entries = Object.entries(prefs);
      lines.push(`## Global preferences · ${getHubFile()}`);
      lines.push('');
      if (entries.length === 0) {
        lines.push('*(none — set with action=pref, key, value)*');
      } else {
        for (const [k, v] of entries) {
          lines.push(`- ${k}: ${v}`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // key + value → 设置；仅 key → 读取
    if (args.value === undefined) {
      const v = getGlobalPref(args.key);
      lines.push(v === null
        ? `(no global pref "${args.key}")`
        : `- ${args.key}: ${v}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    const r = setGlobalPref(args.key, args.value);
    lines.push(`✅ **Global preference ${r.isNew ? 'added' : 'updated'}:**`);
    lines.push(`- ${args.key}: ${args.value}`);
    lines.push(`- Stored in: ${getHubFile()}`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (action === 'remove') {
    const removed = removeProject(process.cwd());
    lines.push(removed
      ? `✅ **Removed from hub: ${process.cwd()}**`
      : `ℹ️ **Not registered in hub: ${process.cwd()}**`);
    lines.push('(project ContextPocket/ data untouched)');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // list（默认）
  const projects = listProjects();
  lines.push(`## ContextPocket Hub · ${projects.length} project(s) · ${getHubDir()}`);
  lines.push('');
  if (projects.length === 0) {
    lines.push('*(no projects registered — run context_pocket_bootstrap in a project)*');
  } else {
    for (const { key, project } of projects) {
      const active = (project.lastActiveAt || '').slice(0, 10);
      lines.push(`- **${project.name || '?'}** · T${project.latestT || 0} · ${project.projectType || '?'} · last active ${active}`);
      lines.push(`  - ${key}`);
    }
  }
  lines.push('');
  lines.push('Multi-machine: point CONTEXTPOCKET_HOME at a synced folder,');
  lines.push('or commit ContextPocket/ per project (bootstrap gitignore: false).');

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

// 错误输出到 stderr，不干扰 stdio 协议
process.stderr.write('ContextPocket MCP server started\n');
