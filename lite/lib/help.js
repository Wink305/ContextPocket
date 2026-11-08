'use strict';

/**
 * ContextPocket Lite — 帮助文本单源
 *
 * 与主包 lib/help.js 同一套结构（COMMAND_HELP / HELP_GROUPS / HELP_OPTIONS /
 * TOOL_DESCRIPTIONS / SERVER_INSTRUCTIONS），命令面收窄到 8 条：
 * bootstrap / status / log append / recall / search / why / verify / graph。
 *
 * 帮助文本承诺的行为是契约：这里写了什么，CLI 与 MCP 就得兑现什么。
 * lite/tests/core.js 钉着「help --json 的命令数 === 8」「CLI 命令 ↔ MCP 工具
 * 一一对应」，任何一处私自加命令都会红。
 */

// ============================================================
// 主帮助页（context-pocket-lite help）
// ============================================================

const HELP_GROUPS = [
  {
    group: 'Setup commands',
    commands: [
      ['bootstrap', 'Initialize ContextPocket/ in your project (5 core files, zero caches)'],
    ],
  },
  {
    group: 'Inspection commands',
    commands: [
      ['status', 'Show current status summary'],
      ['recall <T-id>', 'Show one T-block in full; without a T-id, --since/--until/--from/--to list a window of turns'],
      ['search <kw>', 'Search turns + ADRs + reqs + prefs (--limit/--offset to page)'],
      ['why <file>', 'Reverse lookup: which T-blocks changed or merely mentioned this file'],
      ['verify', 'Run health check on ContextPocket/ (structure + secret scan)'],
      ['graph', 'Derived link graph (T ↔ file ↔ ADR), runtime-derived — no cache file in Lite'],
    ],
  },
  {
    group: 'Write commands',
    commands: [
      ['log append', 'Append a new T-block to log.md'],
    ],
  },
];

const HELP_COL = 20;

const HELP_OPTIONS = [
  ['--dir <path>', 'Specify project directory (default: cwd)'],
  ['--json', 'Machine-readable output: one JSON line on stdout, no colors, same exit codes (1 on verify errors)'],
  ['--version', 'Print the installed version and exit (aliases: -v, "context-pocket-lite version"); works without a ContextPocket/ directory'],
];

// ============================================================
// 各命令的 --help（唯一文本源）
// ============================================================

const COMMAND_HELP = {
  "bootstrap": { argv: ["bootstrap"], text: `
  Usage: context-pocket-lite bootstrap [options]

  Initialize ContextPocket/ with 5 core template files
  (index.md / log.md / state.md / code-map.md / readme.md).
  Nothing is overwritten: if ContextPocket/ already exists this is a no-op
  (exit 0) — read index.md + state.md and keep recording.

  Lite creates no config.md, no assets/ directory and no derived caches:
  a freshly bootstrapped pocket is exactly 5 plain Markdown files.

  Options:
    --project-type <type>  Project type: frontend/backend/fullstack/data/mobile
                           (auto-detected if not specified)
    --language <zh|en>     Default language for tags and prompts (default: zh)
    --gitignore <bool>     true = ignore ContextPocket/ in .gitignore (default);
                           false = commit ContextPocket/ (sync across machines via git)
    --dir <path>           Project directory (default: cwd)
` },
  "status": { argv: ["status"], text: `
  Usage: context-pocket-lite status [options]

  Show the pocket at a glance: latest T, T-block count, log size vs the
  archive threshold, and the next steps / pitfalls recorded in state.md.

  Options:
    --dir <path>   Project directory (default: cwd)
    --json         One JSON line on stdout
` },
  "verify": { argv: ["verify"], text: `
  Usage: context-pocket-lite verify [options]

  Run the Lite health check on ContextPocket/: file existence (the 5 core
  files), T-id continuity, implausible ids, T-block section format
  (User/Action required), header T agreement, log size vs archive_at, and
  the credential/PII scan.

  The credential scan decides severity by what a leak costs: vendor-shaped keys
  (sk-ant-…, AKIA…, ghp_…, private-key blocks, JWT) are ERRORS. Personal data
  (ID numbers, card numbers, phone numbers, password: xxxx) is a WARNING and
  never blocks. Findings print a masked prefix only. Set
  "- secret_scan: false" in config.md to switch the check off.

  Not in Lite (full package territory): reference integrity, index-count
  consistency, code-map drift, handoff staleness, --drift tree scans,
  cross-turn conflict detection, format-version lag.

  Options:
    --quiet        Only show errors and warnings
    --dir <path>   Project directory
` },
  "recall": { argv: ["recall"], text: `
  Usage: context-pocket-lite recall <T-id> [options]
         context-pocket-lite recall --since <T> --until <T> --from <date> --to <date>

  Show one T-block in full (gist, tags, every section, raw text). Archived
  turns (log-archive.md) are included and marked.

  Without a T-id, pass a time window instead to list the turns in it
  (T-id window: --since/--until; date window: --from/--to, yyyy-mm-dd,
  closed intervals, listed in T-id order). A T-id and a window cannot be
  combined.

  --with-context (single T-id only) appends the read-only inbound context
  derived from log.md, decisions.md and code-map.md: who referenced this
  turn, later changes to the files it modified, related ADRs. Derived on
  the fly, never cached, never written.

  Options:
    --with-context        Append inbound links (single T-id form only)
    --since <T> / --until <T>    T-id window bounds (closed)
    --from <date> / --to <date>  Date window bounds (yyyy-mm-dd, closed)
    --limit <N> / --offset <N>   Page the window listing (default limit 50; 0 = all)
    --dir <path>          Project directory
    --json                One JSON line on stdout
` },
  "search": { argv: ["search"], text: `
  Usage: context-pocket-lite search <keyword> [options]

  Keyword search over the whole history: T-blocks (gist + every section,
  archived turns included), ADRs, requirements and preferences.

  Lite always scans the markdown sources on the fly — no index cache —
  with the same tokenizer, matching and ranking as the full package's
  "search --no-index", so results are identical in content and order.

  "T7" style queries jump straight to that turn.

  Options:
    --since <T> / --until <T>    T-id window bounds (closed)
    --from <date> / --to <date>  Date window bounds (yyyy-mm-dd, closed)
    --limit <N> / --offset <N>   Page the results (default limit 50; 0 = all)
    --dir <path>          Project directory
    --json                One JSON line on stdout
` },
  "why": { argv: ["why"], text: `
  Usage: context-pocket-lite why <file-path> [options]

  Reverse lookup: which T-blocks referenced this file path? Searches every
  section of every turn, archived turns included.

  Each hit carries evidence: "changed" when the path is in that turn's
  Action section, "mentioned" when it only appears elsewhere
  (Uncertain / Attachments / Conflicts / Pitfalls) — which is NOT a record
  of changing the file. "changed" hits come first, newest first inside
  each group.

  Options:
    --file-path <p> / --file <p> / -f <p>   Same as passing the path positionally
    --limit <N>           Max hits (default: 10)
    --dir <path>          Project directory
    --json                One JSON line on stdout
` },
  "graph": { argv: ["graph"], text: `
  Usage: context-pocket-lite graph [options]

  Show the link graph derived from log.md, log-archive.md, decisions.md and
  code-map.md: turns, files and ADRs as nodes; modifies / mentions /
  references / decided-in / supersedes / last-changed as edges, each citing
  its source file and T-id, with weak evidence marked.

  Lite derives the graph at runtime on every call — zero writes, zero cache
  files, so there are no rebuild / verify subcommands here (those manage the
  full package's assets/graph.jsonl cache). Same derivation rules, same
  output shape: "what is connected to what" beyond a single turn.

  Options:
    --type <edge-type>    Filter to one edge type (modifies / mentions /
                          references / decided-in / supersedes / last-changed)
    --limit <N>           Max edges shown (default: 100; 0 = all)
    --dir <path>          Project directory
    --json                One JSON line on stdout
` },
  "log append": { argv: ["log", "append"], text: `
  Usage: context-pocket-lite log append --gist "one-line summary" [options]

  Append a new T-block to log.md. Auto-assigns the T-id, writes the session
  separator when the date changes, and updates the index.md header.
  Always use this instead of manually editing log.md.

  Sections are written in canonical order (only those with content):
  Author, User, Action, Commits, Decisions & Constraints, Pitfalls,
  Preferences, Conflicts, Attachments, Uncertain.
  User and Action are required — verify counts their absence as an ERROR.

  --when accepts "2026-10-03 09:00 → 11:30", "2026-10-03", a date range,
  or free text (stored verbatim as stated:). Default: the write moment.
  On a v1 pocket the line is skipped and the reason is reported back.

  Lite has no write-time conflict gate (the six-dimension conflict engine
  lives in the full package): the result always reports
  conflictCheckSkipped: true. Pass conflicts manually if you know of one.

  Options:
    --gist <text>     One-line summary (required)
    --tags <a,b>      Tags (comma-separated)
    --author <text>   Who recorded this turn
    --user <text>     What the user asked (required by verify)
    --action <text>   What was done (required by verify)
    --commits <a,b>   Commit ids
    --decisions <t>   Decisions & constraints
    --pitfalls <t>    Pitfalls (alias: --pitfall)
    --preferences <t> Preferences
    --conflicts <t>   Conflicts
    --attachments <t> Attachments
    --uncertain <t>   Open questions
    --when <text>     When this turn happened
    --verify          Run verify after appending (exit 1 on errors)
    --dir <path>      Project directory
    --json            One JSON line on stdout
` },
};

function commandHelp(key) {
  const entry = COMMAND_HELP[key];
  if (!entry) throw new Error('commandHelp: unknown command "' + key + '"');
  return entry.text;
}

const SERVER_INSTRUCTIONS = "ContextPocket Lite project memory. Start with context_pocket_status to see what the pocket holds, context_pocket_recall with a tId to fetch a specific T-block (add withContext for read-only inbound links; or use sinceT/untilT/fromDate/toDate to list a window of turns), and context_pocket_log_append to record a turn. Never hand-edit the markdown files.";

const TOOL_DESCRIPTIONS = {
  context_pocket_bootstrap: `Initialize ContextPocket/ with 5 core template files (index/log/state/code-map/readme). Auto-detects project type. Idempotent: if ContextPocket/ already exists nothing is overwritten — it reports that and recording continues. Lite creates no config.md and no assets/ directory: a fresh pocket is exactly 5 plain Markdown files, zero derived caches.`,
  context_pocket_status: `Get current ContextPocket status summary (latest T, T-block count, log size vs archive threshold, next steps).`,
  context_pocket_verify: `Run the Lite health check on ContextPocket/: file existence (the 5 core files), T-id continuity, implausible ids, T-block section format (User/Action required), header T agreement, log size vs archive_at, and the credential/PII scan. The scan grades by what a leak costs: vendor-shaped keys (sk-ant-, AKIA-, ghp_, private-key blocks, JWT) are errors; personal data (ID numbers, card numbers, phone numbers, \`password: xxxx\`) is warning-only and never blocks. Findings are masked — never quote a value you find here into the next T-block. Set "- secret_scan: false" in config.md to disable.`,
  context_pocket_recall: `Show full details of a specific T-block (gist, tags, all sections). Archived turns (log-archive.md) are included and marked *(archived)*. Omit tId and pass a time window instead (sinceT/untilT by T-id, fromDate/toDate by WHEN date) to list the turns in that window in T-id order; page with limit/offset. Window semantics are identical to context_pocket_search: a date window excludes turns with no WHEN line, a T-id window does not. tId and a window cannot be combined. Set withContext on a single-turn recall to append read-only inbound context derived from log.md, decisions.md and code-map.md (referencing turns, later changes to the same files, related ADRs); withContext cannot be combined with a window.`,
  context_pocket_search: `Keyword search over the whole history: T-blocks (gist + every section, archived turns included), ADRs, requirements and preferences. Lite scans the markdown sources on the fly (no index cache) with the same matching and ranking as the full package's no-index path; page with limit/offset.`,
  context_pocket_why: `Reverse lookup: which T-blocks mentioned this file path? Searches every section of every turn, archived turns included. Each hit carries evidence: "changed" when the path is in that turn's Action section, "mentioned" when it only appears elsewhere (Uncertain / Attachments / Conflicts / Pitfalls) — which is NOT a record of changing the file. "changed" hits come first, then "mentioned", newest first inside each group.`,
  context_pocket_graph: `Inspect the link graph derived from log.md, log-archive.md, decisions.md and code-map.md: turns, files and ADRs as nodes; modifies / mentions / references / decided-in / supersedes / last-changed as edges, each citing its source file and T-id, with weak evidence marked. Use it to answer "what is connected to what" beyond a single turn (recall withContext gives one turn's inbound slice; this shows the whole picture, filterable with type). Lite derives the graph at runtime on every call — no cache file, nothing is ever written; there is no rebuild/verify action here (those manage the full package's assets/graph.jsonl cache).`,
  context_pocket_log_append: `Append a new T-block to log.md. Auto-assigns T-ID, updates index. Always use this instead of manually editing log.md. Lite has no write-time conflict gate (that engine lives in the full package); pass conflicts manually if you know of one.`,
};

module.exports = {
  HELP_GROUPS,
  HELP_COL,
  HELP_OPTIONS,
  COMMAND_HELP,
  commandHelp,
  SERVER_INSTRUCTIONS,
  TOOL_DESCRIPTIONS,
};
