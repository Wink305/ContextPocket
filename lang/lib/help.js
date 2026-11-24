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
      ['capture', 'Capture a PR / CI summary from a file or local gh (plan by default)'],
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
      ['consolidate', 'Find duplicate records per pocket and across pockets (safe apply)'],
      ['decay', 'Report cold turns and retention candidates (--apply archives them)'],
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
    status                          Per-pocket latest T / open reqs / ADRs + cache health
                                    (index, repo map, workspace graph)
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
    update          Scan JS/JSX/TS/TSX/Python and write .contextpocket/repo-map.json
                    (unchanged files reuse their cached symbols by size + mtime)
    view            Print the current map (builds it if the cache is missing)
    verify          Compare the cache with the tree (size + mtime only); drift exits 1

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
    2 · Related     workspace search + repo map (+ graph with --expand)

  explain reports per-section token estimates and what would be trimmed at
  the requested budget plus 2k / 6k / 12k, without dumping the full context.

  Options:
    --max-tokens <n>   Approximate budget (default: workspace manifest)
    --query <text>     Include workspace search hits
    --no-repo-map      Skip the repo map section
    --expand <1|2>     Add cross-pocket graph neighbors (default 0: off).
                       Builds .contextpocket/workspace-graph.json on first use
                       and rebuilds only pockets whose files changed.
    --as-of <date>     Only include nodes known at this date; accepts
                       YYYY-MM-DD or pocket:Tn (resolved via its WHEN line).
                       Requires --expand.
    --graph-edges <l>  Derived cross-pocket edges to traverse, comma-separated:
                       duplicate, shared-file, tag, near, or all.
                       Requires --expand and is opt-in (default: none).
    --graph-near-days <n>
                       Temporal-near window in days (default 7; only with near).
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

  Report duplicate records per pocket, plus workspace-level duplicates that
  span two or more pockets:
    ADR           same title (conflicting decisions are flagged)
    requirements  same text
    preferences   same key, same value = duplicate; different value = conflict

  apply only removes exact duplicate preference lines **inside one pocket** and
  refreshes the index.md count. Cross-pocket findings and ADRs / requirements
  are always reported for manual merging — never removed automatically.

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
    Health    verify --deep, repo map drift, index / graph freshness,
              pending reviews
    Activity  turns / new ADRs / closed requirements in the selected range
    Open      open requirements, ❓ items, conflicts, pending merge reviews

  Nothing is written: the index, repo map and graph cache are only inspected.

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

  Retention report. A turn is cold when it has a WHEN date older than
  --max-age-days and is outside the newest --keep-last turns. Only the
  oldest continuous prefix is reported, so the suggested forget command can
  be applied verbatim. Open requirements / ❓ / ADRs are also flagged when
  the turn they point at is cold. Turns without a WHEN date are reported as
  undated and never aged by file mtime.

  Default is report-only; --apply archives exactly the reported prefix
  candidates to log-archive.md (same prefix semantics as forget).

  Options:
    --apply             Archive the reported prefix candidates (default: report only)
    --max-age-days <n>  Cold threshold in days (default 180)
    --keep-last <n>     Always keep the newest n turns (default 50)
    --min-turns <n>     Do not recommend forget below this many turns (default 10)
    --pockets <a,b>     Only these pocket names
    --today <date>      Override today (YYYY-MM-DD; tests / backfill)
    --dir <path>        Workspace root
    --json              One JSON line on stdout
`,
  capture: `
  Usage: context-pocket-yuan capture (<file> | --pr <number|url> | --run <id>)
         --pocket <name> [--apply] [options]

  Turn a PR / CI summary into a standard T-block. Three sources, all local:
    <file>          a saved summary file
    --pr <ref>      gh pr view --json title,body,url,number,state
    --run <id>      gh run view --json … plus gh run view --log-failed

  Only the title, list bullets (max 5) and the first link are captured — the
  body / log is not copied wholesale. The captured text is scanned for
  credentials; error-level secrets refuse the write. Default is a plan;
  --apply writes.

  Options:
    --pr <ref>          PR number or URL (uses the local gh CLI)
    --run <id>          GitHub Actions run id (uses the local gh CLI)
    --repo <owner/name> Repository for gh (default: current repo)
    --pocket <name>     Target pocket (required unless the workspace has one)
    --kind <pr|ci>      Summary kind (default: pr from file/pr, ci from run)
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
  context_pocket_workspace: 'Manage a ContextPocket workspace of multiple pockets: init/add/remove/list/status/search/recall/index/verify/repair. status includes cache health (index present/fresh, repo map files/symbols, workspace graph nodes/cross-pocket edges) without running verify first. search uses a local BM25 index across pockets (set noIndex=true to force a live scan) and can filter by pockets/types; action=index builds or rebuilds .contextpocket/search-index.json. verify --deep checks cross-pocket refs, repo map drift and pending merge reviews; repair only applies safe fixes. Cross-pocket references use qualified ids like api:T12.',
  context_pocket_map: 'Scan JS/JSX/TS/TSX/Python for files and top-level symbols; cache at .contextpocket/repo-map.json. update reuses symbols for files whose size + mtime are unchanged, view prints, verify compares metadata only (size + mtime) and reports drift.',
  context_pocket_context: 'Assemble or explain a token-budgeted context view from the workspace: red lines and must-confirm first, then facts, then search/repo-map related material. Every fact and related item names its pocket (pocket:Tn / [pocket]) so the source is traceable. expand=1|2 adds cross-pocket graph neighbors from explicit pocket:Tn references (builds/refreshes .contextpocket/workspace-graph.json incrementally); asOf (YYYY-MM-DD or pocket:Tn) filters nodes to those known at that date and requires expand. graphEdges opts into derived cross-pocket edges (duplicate, shared-file, tag, near, or all; requires expand); graphNearDays sets the temporal-near window (default 7). action=explain returns per-section token estimates and budget trims without the full context. Trimmed sections are always reported.',
  context_pocket_recap: 'Read-only recap across pockets for a T range or date window. Current state, open requirements and ADRs stay; turns are filtered and the oldest are dropped first when the budget is tight.',
  context_pocket_forget: 'Plan how to archive the oldest turns of each pocket into log-archive.md (--before Tn, --before-date, or --keep-last). Archived turns stay searchable; apply=true writes, the default only reports the plan. The cut is always a prefix of log.md.',
  context_pocket_consolidate: 'Find duplicate records per pocket and across pockets: ADRs by title (conflicting decisions flagged), requirements by text, preferences by key. Cross-pocket groups are reported when the same record appears in two or more pockets. apply=true removes only exact duplicate preference lines inside one pocket and refreshes the index count; ADRs, requirements and cross-pocket findings are always reported for manual merging.',
  context_pocket_merge: 'Merge one workspace pocket into another by name. Source turns are renumbered, duplicates are skipped, and conflicts go to merge-<date>.md. dry-run by default; apply=true writes.',
  context_pocket_audit: 'Read-only workspace audit: verify --deep health, repo map drift, index and workspace graph freshness, pending merge reviews, activity in a T/date range, and current open items (requirements, ❓ items, conflicts, reviews). The graph cache is only inspected, never rebuilt.',
  context_pocket_decay: 'Retention report: cold turns outside the newest N (by maxAgeDays), a prefix-safe forget suggestion, and cold open requirements / ❓ items / ADRs. Turns without WHEN dates are reported as undated, never aged by file mtime. apply=true archives exactly the reported prefix candidates (same prefix semantics as forget); the default only reports.',
  context_pocket_capture: 'Capture a PR / CI summary as a standard T-block in one workspace pocket. Sources: a local summary file, a GitHub PR via local gh pr view (pr), or a GitHub Actions run via gh run view plus failed logs (run). Only the title, up to 5 bullets and the first link are captured; credentials in the captured text refuse the write. dry-run by default; apply=true writes.',
};

const SERVER_INSTRUCTIONS = 'ContextPocket Yuan workspace memory. Use context_pocket_workspace with action=status to see pockets plus index / repo-map health, action=verify (deep=true) to check cross-pocket refs and caches, action=search to find turns, action=index to build the BM25 cache, context_pocket_context to assemble a budgeted handoff (every fact names its pocket; expand=1|2 adds cross-pocket graph neighbors from explicit pocket:Tn refs, asOf filters by date, graphEdges opts into duplicate/shared-file/tag/near derived edges), context_pocket_recap for a read-only period summary, context_pocket_audit for a workspace health/activity/open-items view, context_pocket_decay for cold-turn retention candidates (apply=true archives them), context_pocket_capture to record a file / gh PR / CI run summary, context_pocket_forget to plan (or apply) archiving the oldest turns, context_pocket_consolidate to find duplicate records per pocket and across pockets, and context_pocket_merge to merge one pocket into another (dry run by default). Cross-pocket ids are pocket:Tn.';

module.exports = {
  HELP_GROUPS,
  COMMAND_HELP,
  HELP_OPTIONS,
  commandHelp,
  TOOL_DESCRIPTIONS,
  SERVER_INSTRUCTIONS,
};
