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
const fs = require('fs');
const { findPocketDir, readConfig, stripPlaceholders, toTId, intOption } = require('./lib/core');
const { POCKET_DIR_NAME } = require('./lib/constants');
const { parseAll } = require('./lib/parser');
const { verify } = require('./lib/validator');
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
} = require('./lib/writer');
const { bootstrap } = require('./lib/bootstrap');
const { recall, diff, searchAny, why, checkConflicts } = require('./lib/query');
const { runMigration, listMigrations } = require('./lib/migrate');
const { repairLogIds } = require('./lib/repair');
const { describeWhen, describeWhenLine } = require('./lib/when');
const { installPreCommitHook, uninstallPreCommitHook } = require('./lib/hooks');
const { sync: syncPocket } = require('./lib/sync');
const { buildIndex } = require('./lib/indexer');
const { distill } = require('./lib/distill');
const { importSession } = require('./lib/importer');
const { sectionFields, turnFields, hasAnySection, textOption, toList } = require('./lib/fields');
const { afterWrite } = require('./lib/lifecycle');
const {
  getHubDir,
  getHubFile,
  registerProject,
  removeProject,
  listProjects,
  setGlobalPref,
  getGlobalPref,
} = require('./lib/userhub');

// ============================================================
// 版本
// ============================================================

// package.json 是版本的唯一来源（lib/version.js），CLI 的 --version 读同一处。
const { pkgVersion } = require('./lib/version');
const SERVER_VERSION = pkgVersion().version;

// ============================================================
// MCP stdio transport
// ============================================================//
// MCP 的 stdio 传输是"换行分隔的 JSON-RPC"：每条消息一行、内部不得有裸换行，
// 行与行之间没有 Content-Length 头（那是 LSP 的 base protocol）。
// 规范原文：「Messages are delimited by newlines, and MUST NOT contain
// embedded newlines.」之前这里按 Content-Length 解析，真实客户端（Claude
// Desktop / Cursor / Qoder 等）发来的 initialize 行永远匹配不到头部，
// 于是握手无响应、工具列表为空 —— MCP 模式整体不可用。

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
      name: 'context-pocket',
      version: SERVER_VERSION,
    },
    instructions:
      'ContextPocket project memory. Start with context_pocket_status to see what the pocket '
      + 'holds, context_pocket_recall to fetch a specific T-block, and context_pocket_log_append '
      + 'to record a turn. Never hand-edit the markdown files.',
  });
}

// ============================================================
// 工具定义
// ============================================================

const TOOLS = [
  // --- Setup ---
  {
    name: 'context_pocket_bootstrap',
    description: 'Initialize ContextPocket/ with template files (10 core in full mode, 5 in lite). Auto-detects project type. Idempotent: if ContextPocket/ already exists nothing is overwritten — it reports that and recording continues. Side effect worth naming: by default the project is also added to the user-level hub (~/.contextpocket/hub.json), so pass noHub=true for throwaway directories, script runs and CI projects that should leave nothing in your home.',
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
        noHub: {
          type: 'boolean',
          description: 'Do not register this project in the user hub (~/.contextpocket/hub.json). Default false = register it, which is what `hub list` and the MCP server\'s project resolution rely on.',
          default: false,
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
    description: 'Run health check on ContextPocket. 15 checks by default: file existence, T/R/ADR id continuity, T-block section format, reference integrity, index consistency, 🔒 integrity, code map drift, handoff staleness, header T agreement, implausible IDs, log size vs archive_at, format-version lag, the credential/PII scan, and attachment existence (a `### Attachments` line naming a file that is not on disk is an error — template placeholders, URLs, absolute paths, `../` paths and entries already written as `[missing: T<n> <file>]` are skipped, and `log-archive.md` is scanned too). The scan grades by what a leak costs: vendor-shaped keys (sk-ant-, AKIA-, ghp_, private-key blocks, JWT) come back as errors, which block the pre-commit hook and make archive/migrate refuse; personal data (ID numbers, card numbers, phone numbers, `password: xxxx`) is warning-only and never blocks. Findings are masked (first 6 chars + length) — never quote a value you find here into the next T-block. Set "- secret_scan: false" in config.md to disable. Pass drift=true to enable the two tree-scanning drift checks: log-cognition-drift (paths referenced in recent T-blocks vs working tree) and code-newer-than-log (files whose mtime is later than the last record — the missed-log net for projects without git). Both report warnings/info only, never errors.',
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
          description: 'Enable the two tree-scanning drift checks: log-cognition-drift (paths in recent T-blocks vs working tree) and code-newer-than-log (files modified after the last record). Slower (walks the project tree).',
          default: false,
        },
        driftLastN: {
          type: 'number',
          description: 'When drift=true, how many recent T-blocks to compare (default: 5). Same window as CLI `verify --drift-last-n`; the older name lastN is still accepted.',
          default: 5,
        },
        lastN: {
          type: 'number',
          description: 'Deprecated alias for driftLastN in this tool (in context_pocket_sync lastN means something else).',
          default: 5,
        },
      },
    },
  },
  {
    name: 'context_pocket_recall',
    description: 'Show full details of a specific T-block (gist, tags, all sections). Archived turns (log-archive.md) are included and marked *(archived)*.',
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
    description: 'Keyword search over the whole history: T-blocks (gist + every section, archived turns included), ADRs, requirements and preferences. Indexed and scanned searches return the same matches in the same order; page with limit/offset.',
    inputSchema: {
      type: 'object',
      required: ['keyword'],
      properties: {
        keyword: {
          type: 'string',
          description: 'Keyword to search for',
        },
        limit: {
          type: 'number',
          description: 'Maximum matches to return (default 50; 0 = every match). CLI equivalent: --limit',
          default: 50,
        },
        offset: {
          type: 'number',
          description: 'Matches to skip before returning, for paging (CLI equivalent: --offset)',
          default: 0,
        },
        noIndex: {
          type: 'boolean',
          description: 'Skip the cached inverted index and scan the markdown (CLI equivalent: --no-index). Use to cross-check index freshness.',
          default: false,
        },
      },
    },
  },
  {
    name: 'context_pocket_why',
    description: 'Reverse lookup: which T-blocks mentioned this file path? Inspired by ThoughtDAG why_file/why_check. Searches every section of every turn, archived turns included. Each hit carries evidence: "changed" when the path is in that turn\'s Action section, "mentioned" when it only appears elsewhere (Uncertain / Attachments / Conflicts / Pitfalls) — which is NOT a record of changing the file. "changed" hits come first, then "mentioned", newest first inside each group.',
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
    description: 'Git safety net: detect staged file changes that were NOT recorded in recent T-blocks ("agent forgot to log"), and optionally auto-record them as a [auto] T-block. Coverage counts strong evidence only: the path must appear in a recent turn\'s Action section. Files mentioned solely in other sections come back as unrecorded with mentionedIn[] naming the turn/section, so you can log amend that turn instead of writing an [auto] block. Use auto=true to fill the gap.',
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
        author: {
          type: 'string',
          description: 'Who is recording this turn (CLI equivalent: --author) — your own agent id, '
            + 'not the user. Several agents share one ContextPocket/, so this is what makes two '
            + 'people\'s turns distinguishable after the fact; it lands in the block\'s ### Author '
            + 'section. Do not invent a value: omit it and the block simply has no author.',
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
        commits: {
          type: 'string',
          description: 'Commit hashes created this turn (CLI equivalent: --commits)',
        },
        conflicts: {
          type: 'string',
          description: 'Conflicts with earlier decisions/preferences (CLI equivalent: --conflicts)',
        },
        attachments: {
          type: 'string',
          description: 'Attached files, stored under assets/ (CLI equivalent: --attachments)',
        },
        uncertain: {
          type: 'string',
          description: 'Points still needing user confirmation (CLI equivalent: --uncertain)',
        },
        pitfalls: {
          type: 'string',
          description: 'Pitfalls discovered (alias: pitfall)',
        },
        pitfall: {
          type: 'string',
          description: 'Alias of pitfalls',
        },
        preferences: {
          type: 'string',
          description: 'User preferences noted',
        },
        when: {
          type: 'string',
          description: 'When this turn happened (CLI equivalent: --when). Omit it to record the '
            + 'moment you are writing — that is the only time the tool can know for sure. '
            + 'Pass a value only when the user stated a different time: a range '
            + '("2026-10-03 09:00 → 11:30"), a single date ("2026-10-03"), or their verbatim '
            + 'words ("上周三下午"), which are stored as-is and never computed into a timestamp. '
            + 'Written as a --- WHEN: --- line in format v2 pockets. In a v1 pocket the line is '
            + 'not written (the block is still recorded) and the result text says why — run '
            + 'context_pocket_migrate { to: "latest" } first if the time matters.',
        },
        verify: {
          type: 'boolean',
          description: 'Run verify after appending',
          default: true,
        },
        conflictCheck: {
          type: 'boolean',
          description: 'Before writing, run the six-dimension conflict scan as if this block were '
            + 'already in log.md, and record whatever it newly finds in this block\'s Conflicts '
            + 'section with an [auto] prefix (CLI equivalent: --no-conflict-check to disable). '
            + 'Default true — an unrecorded conflict is invisible, since log.md is the only truth. '
            + 'It never blocks the write; findings are reported back so you can react.',
          default: true,
        },
      },
    },
  },
  {
    name: 'context_pocket_log_amend',
    description: 'Fill in sections that are MISSING from an already-written T-block (e.g. a turn appended without `user`). Never overwrites existing content. Use this to resolve "missing User/Action section" errors from context_pocket_verify.',
    inputSchema: {
      type: 'object',
      required: ['tId'],
      properties: {
        tId: {
          type: 'integer',
          description: 'T-number of the block to amend (e.g. 7)',
        },
        author: {
          type: 'string',
          description: 'Fill a MISSING ### Author section (who recorded the turn). Like every other '
            + 'amend field, it never overwrites an author already on that block.',
        },
        user: {
          type: 'string',
          description: "The user's original request for that turn",
        },
        action: {
          type: 'string',
          description: 'What was done in that turn',
        },
        commits: {
          type: 'string',
          description: 'Commit hashes from that turn (comma-separated; CLI equivalent: --commits)',
        },
        decisions: {
          type: 'string',
          description: 'Decisions or constraints from that turn',
        },
        pitfalls: {
          type: 'string',
          description: 'Pitfalls from that turn (alias: pitfall)',
        },
        pitfall: {
          type: 'string',
          description: 'Alias of pitfalls',
        },
        preferences: {
          type: 'string',
          description: 'Preferences from that turn',
        },
        conflicts: {
          type: 'string',
          description: 'Conflicts from that turn',
        },
        uncertain: {
          type: 'string',
          description: 'Uncertain items from that turn',
        },
        attachments: {
          type: 'string',
          description: 'Attachment references from that turn',
        },
        when: {
          type: 'string',
          description: 'Time for that turn, same forms as context_pocket_log_append '
            + '(CLI equivalent: --when). Added only if the block has no time line, or replaces a '
            + 'day-only line left by the v1→v2 migration. A timestamp recorded at the time is '
            + 'history — amend refuses to overwrite it; record a correction as a new T<n>-fix turn.',
        },
      },
    },
  },
  {
    name: 'context_pocket_absolute_add',
    description: 'Append a 🔒 red-line entry to absolute.md — verbatim, never compressed, never archived. Use ONLY for architecture / tech / code constraints a future agent must not violate (e.g. "never use ORM", "do NOT change the /api/v1 response shape"). NOT for schedule or scope emphasis.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description: "The user's requirement, saved verbatim",
        },
        gist: {
          type: 'string',
          description: 'Short summary used for conflict keyword matching (default: first sentence of text)',
        },
        tId: {
          type: 'integer',
          description: 'Associate with a specific T-number (default: latest T)',
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
          description: 'Pitfall to append (alias: pitfalls)',
        },
        pitfalls: {
          type: 'string',
          description: 'Alias of pitfall',
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
          description: 'Keep latest N T-blocks in log.md (default: config.md recent_keep)',
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
    description: 'Migrate ContextPocket data format along the registered one-hop steps (v1 → v2 → v3 in a single call). Backs up first, verifies before each hop, bumps the format stamp after each, and restores the backup if any hop or the final check fails — never half-migrated. Use list=true to see the registry and the computed path, dryRun=true for the full plan without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Target version, e.g. "v2" or "2"; "latest" (default) = newest version reachable in the registry',
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
  {
    name: 'context_pocket_repair',
    description: 'Renumber T-blocks whose T-ids collide after two agents wrote to the same turn number. The write lock lives in os.tmpdir() (lib/io.js) so it only protects one machine: two clones can both compute latestT+1 and both write T9, and log.md ends up with two `## T9` blocks. verify detects that as an ERROR (its fix line names this tool), and hand-editing the markdown is what the skill forbids, so repair is the way out: the colliding block and every block after it shift up one, so ids stay increasing with file order (log.md is append-only). References are the honest part: a body line saying `T9` may have meant either block, so by default they are LISTED, not rewritten — add applyRefs=true to substitute every stale ref by the same mapping (applied simultaneously, so a T9→T10 / T10→T11 cascade does not move one ref twice). A reference has to be a STANDALONE `T<n>`: `GPT4`, `RTX4090`, `UTF8` are words that merely contain the shape and are never matched. Attachment file names (`T04-diagram.png`, `assets/T04-x.png`) are a third category and are NEVER rewritten, applyRefs included — renaming is two halves (`mv` the file, then edit the text), and doing only the second half manufactures a broken link plus lost zero-padding, so the tool just lists them in `fileNames` with the exact `mv` command for you to run. Derived counters (the `· T<n>` header line of state/requirements/decisions/preferences/code-map/handoff, and index.md) are realigned automatically. log-archive.md is reported only, never modified — it declares itself read-only. The renumbering itself is recorded as a new [auto] T-block so the pocket states that the tool moved numbers. Rolls back everything if verify ends up worse or duplicates remain. dryRun=true returns the plan without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          description: 'Show the renumber plan and the stale references without touching files',
          default: false,
        },
        applyRefs: {
          type: 'boolean',
          description: 'Rewrite stale standalone `T<n>` references in the pocket too. Default false: they are listed so a reader decides which of the two colliding blocks each one meant. This never renames attachment files or rewrites their names in the text — those arrive separately in `fileNames` with an `mv` command.',
          default: false,
        },
        author: {
          type: 'string',
          description: 'Sign the record block (who ran the repair). Omit it and the record block simply has no author.',
        },
      },
    },
  },
  // --- Git Hooks ---
  {
    name: 'context_pocket_install_hook',
    description: 'Install a git pre-commit hook (v3: three-step). Step 0 skips the checks when the repo has no ContextPocket/ directory, so installing the hook before bootstrap never blocks every commit. Step 1 runs context-pocket sync --auto to auto-fill missed T-blocks from staged changes. Step 2 runs context-pocket verify --quiet; blocks commit only if verify finds errors (warnings allow). Upgrades an older hook automatically.',
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
        recentKeep: {
          type: 'number',
          description: 'How many recent T-blocks in log.md count as "new" and are skipped (default: recent_keep from config.md)',
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
      case 'context_pocket_log_amend':
        result = toolLogAmend(args || {});
        break;
      case 'context_pocket_absolute_add':
        result = toolAbsoluteAdd(args || {});
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
      case 'context_pocket_repair':
        result = toolRepair(args || {});
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
  // noHub=true 关掉唯一那个写到用户家目录的副作用（~/.contextpocket/hub.json）
  const noHub = !!args.noHub;

  // 与 CLI 同规则：已有 ContextPocket/ 是"早就在记了"，不是失败。激活是全自动的，
  // 把它报成错误会让 agent 以为不能继续记录。lib/bootstrap 的拒绝覆盖保护原样保留。
  const existingPocket = path.join(projectDir, POCKET_DIR_NAME);
  if (fs.existsSync(existingPocket) && fs.statSync(existingPocket).isDirectory()) {
    let hubRegistered = false;
    if (!noHub) {
      try {
        registerProject(projectDir, {});
        hubRegistered = true;
      } catch (e) { /* hub 不可用不影响 */ }
    }
    return {
      content: [{
        type: 'text',
        text: (() => {
          const lines = [
            'ℹ️ **ContextPocket/ already exists** — nothing to create, keep recording.',
            '',
            `- **Path:** ${existingPocket}`,
            '- **Next:** read `index.md` + `state.md` to pick up where the last session left off.',
          ];
          if (noHub) lines.push(`- **Hub:** skipped (noHub) — nothing was written to ${getHubFile()}`);
          else if (hubRegistered) lines.push(`- **Hub:** registered in ${getHubFile()}`);
          return lines.join('\n');
        })(),
      }],
    };
  }

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

  // 初始化里"没做成但不致命"的部分必须交给调用方（agent），否则它以为模板内容本来如此
  if (result.warnings && result.warnings.length > 0) {
    lines.push(`⚠ **${result.warnings.length} warning(s) during initialization:**`);
    for (const w of result.warnings) {
      lines.push(`- ${w}`);
    }
    lines.push('');
  }

  // 注册到用户级 hub（best-effort，失败不影响 bootstrap）
  if (noHub) {
    lines.push(`- **Hub:** skipped (noHub) — nothing was written to ${getHubFile()}`);
    lines.push('');
  } else {
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
  // 归档不会自己发生，所以阈值要在状态里说出口，否则 log.md 无声长到几千行
  const archiveAt = Number(config.archive_at);
  const due = Number.isFinite(archiveAt) && archiveAt > 0 && data.log.lineCount >= archiveAt;
  lines.push(`- **Log:** ${data.log.blocks.length} T-blocks${data.index.hasArchive ? ' (+ archive)' : ''}`
    + (due ? ` — ⚠ ${data.log.lineCount}/${archiveAt} lines, archive is due (\`context_pocket_archive\`)` : ''));
  lines.push(`- **Requirements:** ${data.requirements.openCount} open / ${data.requirements.doneCount} done / ${data.requirements.cancelledCount} cancelled`);
  if (data.requirements.uncertainCount > 0) {
    lines.push(`  - ❓ ${data.requirements.uncertainCount} uncertain`);
  }
  lines.push(`- **Decisions:** ${data.decisions.count} ADRs`);
  lines.push(`- **Absolute:** ${data.absolute.count} entries`);
  lines.push(`- **Mode:** ${config.mode} · language: ${config.language}`);

  // 过滤 state.md 里的模板占位符（bootstrap 预填、尚未填写），
  // 否则一个刚初始化的项目会显示成"有下一步"，内容却是 <2-3 lines: ...>
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
  const drift = !!args.drift;
  // 回看窗口与 CLI 同名：`verify --drift-last-n` ⇄ `driftLastN`。旧名 lastN 继续认，
  // 但它在 context_pocket_sync 里指的是另一件事（同步看几轮），所以以 driftLastN 为准
  const lastN = intOption(args.driftLastN !== undefined ? args.driftLastN : args.lastN, 5);
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
  // 与 CLI 同一份归一：裸 parseInt 会把 "abc" 变成 NaN 再当合法编号传给 recall
  const tId = toTId(args.tId);

  if (Number.isNaN(tId)) {
    return {
      content: [{ type: 'text', text: '❌ Error: tId is required (positive integer, e.g. 7 or "T7")' }],
      isError: true,
    };
  }

  const result = recall(pocketDir, tId);
  if (!result) {
    return {
      content: [{ type: 'text', text: `❌ Error: T${tId} not found` }],
      isError: true,
    };
  }

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

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function toolDiff(args) {
  const pocketDir = getPocketDir();
  const tA = toTId(args.tA);
  const tB = toTId(args.tB);

  if (Number.isNaN(tA) || Number.isNaN(tB)) {
    return {
      content: [{ type: 'text', text: '❌ Error: both tA and tB are required (positive integers)' }],
      isError: true,
    };
  }

  const result = diff(pocketDir, tA, tB);

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
  // 缓存缺失 / 坏 JSON / INDEX_VERSION 对不上 / 签名过期都是当场重建然后继续走索引，
  // 只有连重建都做不成才是全量扫描；noIndex:true 是显式要这一次不信缓存。
  // 与 CLI 的 --no-index 同一份逻辑，两条路径的命中与排序相同，所以 limit/offset 翻的是同一份结果。
  const { results, total, hasMore, offset, limit } = searchAny(pocketDir, keyword, {
    useIndex: args.noIndex !== true,
    limit: args.limit,
    offset: args.offset,
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
  const lastN = intOption(args.lastN, 5);

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

  const files = result.unrecorded.map(c => {
    if (!c.mentionedIn || c.mentionedIn.length === 0) return `- ${c.path}`;
    const where = c.mentionedIn.map(m => `T${m.tId}/${m.section}`).join(', ');
    return `- ${c.path} — *only mentioned in ${where}, never in Action*`;
  }).join('\n');
  const mentionHint = result.mentionedOnly && result.mentionedOnly.length
    ? '\n\n> ℹ️ ' + result.mentionedOnly.length + ' of these already appear in another section of a recent T-block. If you really changed them, prefer `log amend T<n> --action "…"` over an [auto] block — the turn exists, only its Action section is incomplete.'
    : '';

  if (result.dryRun) {
    lines.push(`📋 **Plan (dry-run):** ${result.unrecorded.length} staged file(s) not recorded in recent T-blocks:`);
    lines.push(files + mentionHint);
    lines.push('');
    lines.push(`Would auto-record T${result.nextT} with tag \[auto\]. *(dry-run: no files modified)*`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (result.auto && result.filled) {
    lines.push(`✅ **Auto-recorded:** added T${result.tId} [auto] covering ${result.unrecorded.length} staged file(s):`);
    lines.push(files + mentionHint);
    lines.push('');
    lines.push('Review the auto T-block and expand with real details if needed.');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // report-only
  lines.push(`⚠️ **Unrecorded staged changes:** ${result.unrecorded.length} file(s) not covered by recent T-blocks:`);
  lines.push(files + mentionHint);
  lines.push('');
  lines.push('Call again with `auto: true` to auto-record, or record manually.');
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

  // 字段形状与 CLI 入口共用一份定义（lib/fields.js），见该文件头的原因说明
  const fields = turnFields(args);
  // 写时冲突闸默认开，与 CLI 的 --no-conflict-check 同一语义
  if (args.conflictCheck === false) fields.conflictCheck = false;
  const result = appendLogBlock(pocketDir, fields);

  // 副作用：更新 hub 活跃信息 + 刷新搜索索引（都 best-effort，不阻断记录）
  afterWrite(pocketDir, { latestT: result.tId, gist });

  let output = `✅ **T${result.tId} added:** ${gist}`;
  const whenLine = describeWhenLine(result.when);
  if (whenLine) {
    // 把这一轮真正记下的时间回给 Agent：它下一步就该确认这个时间对不对。
    // 与 CLI 同一句话（lib/when.js 的 describeWhenLine），两个入口不该各说一套
    output += `\n⏱ ${whenLine}`;
  }
  if (result.whenSkipped) {
    // Agent 给了 when，却因为 pocket 停在 v1 没落盘；不说就等于把话吞了
    output += `\n⚠️ ${result.whenSkipped}`;
  }
  // 检出的冲突已经写进本块的 Conflicts 节；Agent 必须当场看到，否则下一轮还会撞同一次
  if (result.conflictsWritten > 0) {
    output += `\n⚔️ ${result.conflictsWritten} conflict(s) recorded in T${result.tId}'s Conflicts section:`;
    for (const f of result.autoConflicts.filter((x) => x.severity === 'critical' || x.severity === 'warning')) {
      output += `\n- [${f.severity}] ${f.message}`;
    }
  }
  if (result.conflictCheckError) {
    output += `\n⚠️ This turn was NOT conflict-checked: ${result.conflictCheckError}`;
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

function toolLogAmend(args) {
  const pocketDir = getPocketDir();

  const tId = toTId(args.tId);
  if (Number.isNaN(tId)) {
    return {
      content: [{ type: 'text', text: '❌ Error: tId (integer) is required' }],
      isError: true,
    };
  }

  const payload = sectionFields(args);

  if (!hasAnySection(payload)) {
    return {
      content: [{ type: 'text', text: '❌ Error: pass at least one section to fill' }],
      isError: true,
    };
  }

  const result = amendLogBlock(pocketDir, tId, payload);

  if (!result.success) {
    return {
      content: [{ type: 'text', text: `❌ Error: ${result.error}` }],
      isError: true,
    };
  }

  afterWrite(pocketDir);

  let output;
  if (result.unchanged && !result.when) {
    output = `ℹ️ **T${tId} unchanged** — those sections already exist and are never overwritten.`;
  } else if (result.unchanged) {
    output = `ℹ️ **T${tId} unchanged**`;
  } else {
    output = `✅ **T${tId} amended** — filled: ${result.filled.join(', ')}`;
  }
  if (result.when) {
    output += `\n⏱ ${result.when}`;
  }
  if (result.skipped.length > 0) {
    output += `\n\nAlready present, left untouched: ${result.skipped.join(', ')}`;
  }

  return { content: [{ type: 'text', text: output }] };
}

function toolAbsoluteAdd(args) {
  const pocketDir = getPocketDir();

  const text = textOption(args, 'text');
  if (!text) {
    return {
      content: [{ type: 'text', text: '❌ Error: text is required' }],
      isError: true,
    };
  }

  const result = addAbsoluteEntry(pocketDir, {
    text,
    gist: textOption(args, 'gist'),
    createdAt: intOption(args.tId, undefined),
  });

  return {
    content: [{
      type: 'text',
      text: `✅ **🔒 Added to absolute.md** (${result.count} entries) · T${result.tId}\n\n` +
            'Never compressed, never archived. Treat as binding for future turns.',
    }],
  };
}

function toolReqAdd(args) {
  const pocketDir = getPocketDir();
  const text = textOption(args, 'text');
  if (!text) {
    return {
      content: [{ type: 'text', text: '❌ Error: text is required' }],
      isError: true,
    };
  }

  const result = addRequirement(pocketDir, {
    text,
    // tags/impl 走 toList：MCP 传数组，`true`/空串这类缺值形状一律归成 []，
    // status 走 textOption：它会变成 requirements.md 里的 `## <status>` 分组标题
    tags: toList(args.tags),
    status: textOption(args, 'status') || 'Open',
    uncertain: !!args.uncertain,
    impl: toList(args.impl),
  });

  const prefix = args.uncertain ? '❓ ' : '';
  return {
    content: [{ type: 'text', text: `✅ **${prefix}R${result.rId} added:** ${text}` }],
  };
}

function toolDecisionAdd(args) {
  const pocketDir = getPocketDir();
  const title = textOption(args, 'title');

  if (!title) {
    return {
      content: [{ type: 'text', text: '❌ Error: title is required' }],
      isError: true,
    };
  }

  const result = addDecision(pocketDir, {
    title,
    // 五节都会原样进 decisions.md：`{ context: true }` 落盘就是 `- Context: true`
    context: textOption(args, 'context') || '',
    options: textOption(args, 'options') || '',
    decision: textOption(args, 'decision') || '',
    consequences: textOption(args, 'consequences') || '',
    supersedes: textOption(args, 'supersedes') || 'none',
  });

  return {
    content: [{ type: 'text', text: `✅ **ADR-${result.adrId} added:** ${title}` }],
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

  // 与 CLI 对齐：一个字段都没给就直接报错，而不是"成功"地什么都不改。
  // 三个字段都只收文本 —— `{ summary: true }` 会在 state.md 里留下一行 `- true`。
  const summary = textOption(args, 'summary');
  const nextStep = textOption(args, 'nextStep');
  const pitfall = textOption(args, 'pitfall', 'pitfalls');
  if (summary === undefined && nextStep === undefined && pitfall === undefined) {
    return {
      content: [{ type: 'text', text: '❌ Error: pass at least one of summary / nextStep / pitfall (each needs a value)' }],
      isError: true,
    };
  }

  const result = updateState(pocketDir, {
    summary,
    appendSummary: !!args.appendSummary,
    nextStep,
    pitfall,
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

  const key = textOption(args, 'key');
  const value = textOption(args, 'value');
  if (!key) {
    return {
      content: [{ type: 'text', text: '❌ Error: key is required' }],
      isError: true,
    };
  }
  if (value === undefined) {
    return {
      content: [{ type: 'text', text: '❌ Error: value is required (an empty or boolean value writes a meaningless line)' }],
      isError: true,
    };
  }

  const result = updatePreferences(pocketDir, {
    key,
    value,
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
    keepLast: intOption(args.keepLast),
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
  afterWrite(pocketDir, { index: !args.dryRun });

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

function toolRepair(args) {
  const pocketDir = getPocketDir();
  const result = repairLogIds(pocketDir, {
    dryRun: !!args.dryRun,
    applyRefs: !!args.applyRefs,
    author: args.author,
  });

  const lines = [];

  if (!result.success) {
    lines.push(`❌ **Repair failed:** ${result.error}`);
    if (result.renumbered && result.renumbered.length > 0) {
      lines.push('');
      lines.push('*(rolled back — nothing was changed)*');
    }
    return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
  }

  if (!result.changed) {
    lines.push(`✅ **Nothing to repair:** ${result.message}`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // 编号变了 → 派生索引必须重建（旧索引里的 T 号已经指错块）
  if (!result.dryRun) afterWrite(pocketDir, { latestT: result.latestTAfter, index: true });

  lines.push(result.dryRun
    ? `📋 **Repair plan (dry-run):** ${result.message}`
    : `✅ **Repair completed:** ${result.message}`);
  lines.push('');
  lines.push('**Renumbered:**');
  for (const c of result.renumbered) {
    lines.push(`- T${c.from} → T${c.to} (log.md:${c.line}) ${c.heading}`);
  }

  if (result.references.length > 0) {
    const shown = result.references.slice(0, 20);
    lines.push('');
    lines.push(result.applyRefs
      ? `**References rewritten (${result.references.length}):**`
      : `**References still naming an old T-id (${result.references.length}; NOT rewritten — pass applyRefs=true after you decide which block each one meant):**`);
    for (const r of shown) {
      lines.push(`- ${r.file}:${r.line} T${r.from} → T${r.to} ${r.text.slice(0, 90)}`);
    }
    if (result.references.length > shown.length) {
      lines.push(`- … +${result.references.length - shown.length} more`);
    }
  }

  const fileNames = result.fileNames || [];
  if (fileNames.length > 0) {
    lines.push('');
    lines.push(`**Attachment file names still carry an old id (${fileNames.length}) — never rewritten:** renaming means \`mv\` on the file, and repair does not move history. `
      + 'Run the mv, then `verify` to confirm the links hold.');
    for (const f of fileNames.slice(0, 20)) {
      lines.push(`- ${f.file}:${f.line} ${f.command}`);
    }
    if (fileNames.length > 20) lines.push(`- … +${fileNames.length - 20} more`);
  }

  if (result.stillShadowed && result.stillShadowed.length > 0) {
    lines.push('');
    lines.push(`⚠️ T${result.stillShadowed.join(', T')} also exist in log-archive.md: recall/search shows the log.md block and hides the archived one. `
      + 'The archive declares itself read-only, so repair does not renumber it.');
  }

  if (result.recordTId) {
    lines.push('');
    lines.push(`📝 Record block: T${result.recordTId} — the pocket itself now states that the tool moved these numbers.`);
  }

  if (result.dryRun) {
    lines.push('');
    lines.push('*(dry-run: no files were modified)*');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function toolMigrate(args) {
  const pocketDir = getPocketDir();

  if (args.list) {
    const info = listMigrations(pocketDir, args.to);
    const lines = [];
    lines.push('## ContextPocket · Migration');
    lines.push(`- **Current version:** ${info.currentVersion || '(unknown)'}`);
    lines.push(`- **Target version:** ${info.targetVersion}`);
    lines.push(`- **Latest registered:** ${info.latestVersion}`);
    lines.push(`- **Status:** ${info.isLatest ? 'up to date' : 'upgrade available'}`);

    if (info.error) {
      lines.push('');
      lines.push(`❌ **${info.error}**`);
      return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
    }

    if (info.path.length > 0 && !info.isLatest) {
      lines.push('');
      lines.push('**Migration path:**');
      for (const step of info.path) {
        lines.push(`- ${step.from} → ${step.to}: ${step.name}`);
      }
    }

    lines.push('');
    lines.push('**Registered steps:**');
    for (const s of info.available) {
      lines.push(`- ${s.from} → ${s.to}: ${s.name}${s.hasRun ? '' : ' (builtin)'}`);
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
    lines.push(`- Steps: ${result.planned.length}${result.planned.length > 1 ? ' (multi-hop, all-or-nothing)' : ''}`);
    for (const [i, step] of result.planned.entries()) {
      lines.push(`  ${i + 1}. ${step.from} → ${step.to}: ${step.name}`);
    }
    lines.push('');
    lines.push('*(dry-run: no files were modified)*');
  } else {
    lines.push('✅ **Migration complete!**');
    lines.push(`- From: ${result.fromVersion} → To: ${result.toVersion}`);
    lines.push(`- Steps executed: ${result.steps.length}`);
    for (const [i, step] of result.steps.entries()) {
      lines.push(`  ${i + 1}. ${step.from} → ${step.to}: ${step.name}`);
    }
    lines.push(`- Backup: ${result.backupPath}`);
    lines.push('');
    lines.push('*A failed hop rolls the whole pocket back and deletes that backup.*');
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
    lines.push('✅ **Pre-commit hook upgraded to v3 (pocket lookup + sync + verify)**');
  } else if (result.action === 'already-installed') {
    lines.push('ℹ️ **Pre-commit hook already installed**');
  }
  lines.push(`- Hook path: ${result.hookPath}`);
  lines.push('');
  lines.push('Before each commit the hook will:');
  lines.push('1. check a `ContextPocket/` exists here — if not it prints a hint and skips (an');
  lines.push('   un-bootstrapped repo never gets its commits blocked)');
  lines.push('2. `context_pocket_sync` (auto) — record staged files missed in recent T-blocks');
  lines.push('3. `context_pocket_verify` — block on errors, allow warnings');
  if (!findPocketDir(projectDir)) {
    lines.push('');
    lines.push(
      `⚠️  No \`${POCKET_DIR_NAME}/\` in this project yet — the hook will skip every commit until you run \`context_pocket_bootstrap\`.`
    );
  }

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
  lines.push(`✅ **Search index ${result.unchanged ? 'already up to date' : result.rebuilt ? 'built' : 'refreshed'}**`);
  lines.push(`- Docs indexed: ${result.docsCount} (T-blocks + ADRs + reqs + prefs)`);
  lines.push(`- Terms: ${result.termsCount}`);
  if (!result.rebuilt) {
    lines.push(`- Delta: +${result.added} added · ~${result.updated} updated · -${result.removed} removed · ${result.reused} reused`);
    lines.push(`- Re-tokenized: ${result.retokenized} of ${result.docsCount} docs`);
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
  const recentKeep = intOption(args.recentKeep, undefined);

  const result = distill(pocketDir, { dryRun, recentKeep });

  const lines = [];

  if (result.nothing) {
    lines.push('ℹ️ **Nothing to distill yet:**');
    lines.push('- No log-archive.md and no old turns in log.md.');
    lines.push('- Distill becomes useful once archiving has moved old T-blocks out (context_pocket_archive).');
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
    limit: intOption(args.limit, 100),
    truncate: intOption(args.truncate, 400),
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
    // key / value 都只收文本（schema 写的就是 type: 'string'）：`{ value: true }` 存进
    // hub.json 后，下一个项目会把它当字符串 "true" 读出来用
    const key = textOption(args, 'key');
    const value = textOption(args, 'value');

    // 无 key → 列出全部全局偏好
    if (!key) {
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

    // 给了 value 却不是文本（true / 空串）：不能悄悄降级成"读取"，那会让人以为写进去了
    if (args.value !== undefined && value === undefined) {
      return {
        content: [{ type: 'text', text: '❌ Error: value was given without a value — nothing was stored' }],
        isError: true,
      };
    }

    // key + value → 设置；仅 key → 读取
    if (value === undefined) {
      const v = getGlobalPref(key);
      lines.push(v === null
        ? `(no global pref "${key}")`
        : `- ${key}: ${v}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    const r = setGlobalPref(key, value);
    lines.push(`✅ **Global preference ${r.isNew ? 'added' : 'updated'}:**`);
    lines.push(`- ${key}: ${value}`);
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
