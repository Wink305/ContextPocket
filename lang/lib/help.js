'use strict';

/**
 * ContextPocket yuan — 帮助文本单源
 *
 * CLI 人类帮助、--json 命令表、MCP 工具描述都从这里取，避免三处各写一份。
 */

const HELP_GROUPS = [
  {
    group: 'Workspace commands',
    commands: [
      ['workspace', 'Manage a workspace of multiple pockets (init/add/remove/list/status/search/index/recall)'],
      ['merge', 'Merge one workspace pocket into another (dry run by default)'],
      ['capture', 'Capture a local PR / CI summary as a T-block (plan by default)'],
    ],
  },
  {
    group: 'Context commands',
    commands: [
      ['map', 'Scan and inspect the repo map (update/view/verify)'],
      ['context', 'Assemble or explain a budgeted context view (build/explain)'],
      ['recap', 'Read-only recap for a T or date range across pockets'],
      ['audit', 'Workspace audit: health, activity and open items'],
    ],
  },
  {
    group: 'Lifecycle commands',
    commands: [
      ['consolidate', 'Find duplicate ADRs / requirements / preferences (safe apply)'],
      ['decay', 'Report cold turns and retention candidates (read-only)'],
      ['forget', 'Archive the oldest turns (plan by default; --apply moves them)'],
    ],
  },
];

const COMMAND_HELP = {
  workspace: `
  Usage: context-pocket-yuan workspace <action> [options]

  Actions:
    init [--name <name>]            Create contextpocket.workspace.json at --dir
    add <name> <path>               Register a project root or ContextPocket/ directory
    remove <name>                   Unregister a pocket (data untouched)
    list                            List registered pockets and latest T
    status                          Per-pocket latest T / open reqs / ADRs
    search <keyword> [--limit <n>]  BM25 search across pockets; builds the local index on demand
    index [--rebuild]               Build/refresh .contextpocket/search-index.json
    recall <pocket:Tn>              Read one turn from a named pocket
    verify [--deep]                 Check manifest, pockets, refs, repo map, reviews
    repair [--apply]                Plan safe fixes; --apply rebuilds the repo map

  Search options:
    --pocket <a,b>   Only these pocket names
    --type <types>   Comma-separated types: T, FIX, ADR, R, pref, absolute
    --no-index       Force a live scan (skip the local index)
    --rebuild-index  Rebuild the index before searching
    --edition-mode   focus / audit / migrate search-limit presets

  Options:
    --dir <path>    Workspace root (default: cwd; searches upward for the manifest)
    --json          One JSON line on stdout
`,
  map: `
  Usage: context-pocket-yuan map <action> [options]

  Actions:
    update          Scan JS/JSX/TS/TSX/Python files and write .contextpocket/repo-map.json
    view            Print the current map (builds it if the cache is missing)
    verify          Compare the cache with the tree; non-zero exit on drift

  Options:
    --limit <n>     Rows shown by view (default 20; 0 = all)
    --dir <path>    Workspace root
    --json          One JSON line on stdout
`,
  context: `
  Usage: context-pocket-yuan context build|explain [options]

  build assembles:
    0 · Start here   red lines / must-confirm / next steps (never trimmed)
    1 · Facts       state / open requirements / ADRs / recent turns
    2 · Related     workspace search + repo map

  explain reports per-section token estimates and what would be trimmed at
  the requested budget plus 2k / 6k / 12k, without dumping the full context.

  Options:
    --max-tokens <n>   Approximate budget (default: workspace manifest)
    --query <text>     Include workspace search hits
    --no-repo-map      Skip the repo map section
    --edition-mode <m> focus / audit / migrate presets (explicit flags win)
    --dir <path>       Workspace root
    --json             One JSON line on stdout
`,
  recap: `
  Usage: context-pocket-yuan recap [options]

  Read-only period recap across pockets. Current state / open requirements /
  ADRs stay; turns are filtered by T range or date window.

  Options:
    --since <Tn>        First T id (number)
    --until <Tn>        Last T id (number)
    --from <date>       First date (YYYY-MM-DD)
    --to <date>         Last date (YYYY-MM-DD)
    --pockets <a,b>     Only these pocket names
    --max-tokens <n>    Approximate budget (default 4000)
    --edition-mode <m>  focus / audit / migrate budget presets (explicit max-tokens wins)
    --dir <path>        Workspace root
    --json              One JSON line on stdout
`,
  forget: `
  Usage: context-pocket-yuan forget (--before <Tn> | --before-date <date> | --keep-last <n>) [options]

  Move the oldest turns from log.md to log-archive.md. Archived turns stay
  searchable (recall / search / recap read both files). The cut is always a
  prefix: forgetting never removes a turn from the middle of log.md.

  Selectors (exactly one):
    --before <Tn>          Archive turns with id < n
    --before-date <date>   Archive turns dated before YYYY-MM-DD
                           (a turn without a WHEN date stops the cut)
    --keep-last <n>        Keep only the newest n turns

  Options:
    --apply             Write the archive (default: print the plan only)
    --pockets <a,b>     Only these pocket names
    --dir <path>        Workspace root
    --json              One JSON line on stdout
`,
  consolidate: `
  Usage: context-pocket-yuan consolidate [--apply] [options]

  Report duplicate records per pocket:
    ADR           same title (conflicting decisions are flagged)
    requirements  same text
    preferences   same key, same value = duplicate; different value = conflict

  apply only removes exact duplicate preference lines and refreshes the
  index.md count. ADRs and requirements carry ids / references, so they are
  always reported for manual merging — never removed automatically.

  Options:
    --apply             Remove exact duplicate preference lines
    --pockets <a,b>     Only these pocket names
    --dir <path>        Workspace root
    --json              One JSON line on stdout
`,
  merge: `
  Usage: context-pocket-yuan merge <source> --into <target> [--apply] [options]

  Merge one workspace pocket into another. Source turns are renumbered,
  duplicate turns / ADRs / requirements are skipped, and anything that needs
  a human decision goes to merge-<date>.md. The default is a dry run.

  Options:
    --apply             Write the merge (default: dry run)
    --include-archive   Also merge the source log-archive.md
    --dir <path>        Workspace root
    --json              One JSON line on stdout
`,
  audit: `
  Usage: context-pocket-yuan audit [options]

  Read-only workspace audit:
    Health    verify --deep, repo map drift, index freshness, pending reviews
    Activity  turns / new ADRs / closed requirements in the selected range
    Open      open requirements, ❓ items, conflicts, pending merge reviews

  Nothing is written: the index and repo map are only inspected.

  Options:
    --since <Tn>        First T id
    --until <Tn>        Last T id
    --from <date>       First date (YYYY-MM-DD)
    --to <date>         Last date (YYYY-MM-DD)
    --pockets <a,b>     Only these pocket names
    --dir <path>        Workspace root
    --json              One JSON line on stdout
`,
  decay: `
  Usage: context-pocket-yuan decay [options]

  Read-only retention report. A turn is cold when it has a WHEN date older
  than --max-age-days and is outside the newest --keep-last turns. Only the
  oldest continuous prefix is reported, so the suggested forget command can
  be applied verbatim. Open requirements / ❓ / ADRs are also flagged when
  the turn they point at is cold. Turns without a WHEN date are reported as
  undated and never aged by file mtime.

  Options:
    --max-age-days <n>  Cold threshold in days (default 180)
    --keep-last <n>     Always keep the newest n turns (default 50)
    --min-turns <n>     Do not recommend forget below this many turns (default 10)
    --pockets <a,b>     Only these pocket names
    --today <date>      Override today (YYYY-MM-DD; tests / backfill)
    --dir <path>        Workspace root
    --json              One JSON line on stdout
`,
  capture: `
  Usage: context-pocket-yuan capture <file> --pocket <name> [--apply] [options]

  Turn a locally saved PR / CI summary into a standard T-block. Only the
  title, list bullets (max 5) and the first link are captured — the body is
  not copied. The captured text is scanned for credentials; error-level
  secrets refuse the write. Default is a plan; --apply writes.

  Options:
    --pocket <name>     Target pocket (required unless the workspace has one)
    --kind <pr|ci>      Summary kind (default pr)
    --gist <text>       Override the extracted title
    --tags <a,b>        Extra tags (kind is always added)
    --url <url>         Override the extracted link
    --when <text>       Forwarded to the T-block WHEN line
    --apply             Write the T-block (default: plan only)
    --dir <path>        Workspace root
    --json              One JSON line on stdout
`,
};

const HELP_OPTIONS = [
  ['--dir <path>', 'Workspace root (default: cwd; searches upward for contextpocket.workspace.json)'],
  ['--edition-mode <mode>', 'focus (least context) / audit (full evidence) / migrate (full export) presets'],
  ['--json', 'Machine-readable output: one JSON line on stdout'],
];

function commandHelp(key) {
  return COMMAND_HELP[key] || '';
}

const TOOL_DESCRIPTIONS = {
  context_pocket_workspace: 'Manage a ContextPocket workspace of multiple pockets: init/add/remove/list/status/search/recall/index/verify/repair. search uses a local BM25 index across pockets (set noIndex=true to force a live scan) and can filter by pockets/types; action=index builds or rebuilds .contextpocket/search-index.json. verify --deep checks cross-pocket refs, repo map drift and pending merge reviews; repair only applies safe fixes. Cross-pocket references use qualified ids like api:T12.',
  context_pocket_map: 'Scan JS/JSX/TS/TSX/Python for files and top-level symbols; cache at .contextpocket/repo-map.json. update builds, view prints, verify reports drift.',
  context_pocket_context: 'Assemble or explain a token-budgeted context view from the workspace: red lines and must-confirm first, then facts, then search/repo-map related material. action=explain returns per-section token estimates and budget trims without the full context. Trimmed sections are always reported.',
  context_pocket_recap: 'Read-only recap across pockets for a T range or date window. Current state, open requirements and ADRs stay; turns are filtered and the oldest are dropped first when the budget is tight.',
  context_pocket_forget: 'Plan how to archive the oldest turns of each pocket into log-archive.md (--before Tn, --before-date, or --keep-last). Archived turns stay searchable; apply=true writes, the default only reports the plan. The cut is always a prefix of log.md.',
  context_pocket_consolidate: 'Find duplicate records across pockets: ADRs by title (conflicting decisions flagged), requirements by text, preferences by key. apply=true removes only exact duplicate preference lines and refreshes the index count; ADRs and requirements are always reported for manual merging.',
  context_pocket_merge: 'Merge one workspace pocket into another by name. Source turns are renumbered, duplicates are skipped, and conflicts go to merge-<date>.md. dry-run by default; apply=true writes.',
  context_pocket_audit: 'Read-only workspace audit: verify --deep health, repo map drift, index freshness, pending merge reviews, activity in a T/date range, and current open items (requirements, ❓ items, conflicts, reviews).',
  context_pocket_decay: 'Read-only retention report: cold turns outside the newest N (by maxAgeDays), a prefix-safe forget suggestion, and cold open requirements / ❓ items / ADRs. Turns without WHEN dates are reported as undated, never aged by file mtime.',
  context_pocket_capture: 'Capture a locally saved PR / CI summary as a standard T-block in one workspace pocket. Only the title, up to 5 list bullets and the first link are captured; credentials in the captured text refuse the write. dry-run by default; apply=true writes.',
};

const SERVER_INSTRUCTIONS = 'ContextPocket Yuan workspace memory. Use context_pocket_workspace with action=status to see pockets, action=verify (deep=true) to check cross-pocket refs and caches, action=search to find turns, action=index to build the BM25 cache, context_pocket_context to assemble a budgeted handoff, context_pocket_recap for a read-only period summary, context_pocket_audit for a workspace health/activity/open-items view, context_pocket_decay for cold-turn retention candidates, context_pocket_capture to record a local PR/CI summary, context_pocket_forget to plan (or apply) archiving the oldest turns, context_pocket_consolidate to find duplicate ADRs / requirements / preferences, and context_pocket_merge to merge one pocket into another (dry run by default). Cross-pocket ids are pocket:Tn.';

module.exports = {
  HELP_GROUPS,
  COMMAND_HELP,
  HELP_OPTIONS,
  commandHelp,
  TOOL_DESCRIPTIONS,
  SERVER_INSTRUCTIONS,
};
