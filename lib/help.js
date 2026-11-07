'use strict';

/**
 * ContextPocket — 帮助文本单源
 *
 * 帮助文本承诺的行为是契约：说好了 `state update` 零参能用，入口就不能拒收
 * （1.2.2 的 P3 缺陷就是"帮助说能、守卫说不能"）。此前同一段说明在
 * CLI 各命令的 --help 与 MCP 工具描述里各存一份，改一处漏一处不会报错，
 * 只会让某个入口开始说谎。
 *
 * 现在文本只在这里定义一次：
 *   - COMMAND_HELP          —— CLI `context-pocket <command> --help` 的全部输出
 *   - HELP_GROUPS/OPTIONS   —— `context-pocket help` 主帮助页（人类与 --json 同源渲染）
 *   - TOOL_DESCRIPTIONS     —— MCP tools/list 的工具级描述
 *   - SERVER_INSTRUCTIONS   —— MCP initialize 回包的 instructions
 * 入口只做渲染（颜色、排版），不许再内联文本。tests/help.js 钉着
 * "各入口输出 === 本文件内容"，任何一处私自改写都会红。
 */

// ============================================================
// 主帮助页（context-pocket help）
// ============================================================

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

/** 名称列宽（含尾随空格），人类帮助与测试用同一个常量对齐 */
const HELP_COL = 20;

const HELP_OPTIONS = [
  ['--dir <path>', 'Specify project directory (default: cwd)'],
  ['--json', 'Machine-readable output: one JSON line on stdout, no colors, same exit codes (1 on verify errors / critical conflicts)'],
  ['--version', 'Print the installed version and exit (aliases: -v, "context-pocket version"); works without a ContextPocket/ directory'],
];

// ============================================================
// 各命令 --help（键 = 命令名；argv = 触发它要敲的参数，测试按它跑子进程）
// ============================================================

const COMMAND_HELP = {
  "bootstrap": { argv: ["bootstrap"], text: `
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
` },
  "verify": { argv: ["verify"], text: `
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
` },
  "sync": { argv: ["sync"], text: `
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
` },
  "status": { argv: ["status"], text: `
  Usage: context-pocket status [options]

  Show current status summary: latest T, requirement counts, decisions, next steps.

  Options:
    --dir <path>   Project directory
` },
  "recall": { argv: ["recall"], text: `
  Usage: context-pocket recall <T-id>

  Show full details of a specific T-block.

  Options:
    --t-id <n>     T-id as an option instead of positional (MCP name: tId).
                   --t <n> and --id <n> are accepted aliases.
    --dir <path>   Project directory
` },
  "diff": { argv: ["diff"], text: `
  Usage: context-pocket diff <T-a> <T-b>

  Compare two T-blocks. Shows changes in requirements, decisions (ADRs), and files.

  Options:
    --t-a <n>      First T-block (MCP name: tA) — instead of the positional pair
    --t-b <n>      Second T-block (MCP name: tB)
    --dir <path>   Project directory
` },
  "search": { argv: ["search"], text: `
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
` },
  "why": { argv: ["why"], text: `
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
` },
  "check-conflicts": { argv: ["check-conflicts"], text: `
  Usage: context-pocket check-conflicts

  Scan for conflicts across 6 dimensions:
    1. Tech stack   2. Requirements   3. ADRs
    4. Style        5. Deployment     6. 🔒 Absolute

  Severity levels: critical / warning / info

  Options:
    --dir <path>   Project directory
` },
  "log append": { argv: ["log","append"], text: `
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
` },
  "log amend": { argv: ["log","amend"], text: `
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
` },
  "absolute add": { argv: ["absolute","add"], text: `
  Usage: context-pocket absolute add --text <verbatim> [--gist <short>]

  Append a 🔒 red-line entry to absolute.md — verbatim, never compressed,
  never archived. Use this for architecture / tech / code constraints a future
  agent must not silently violate (NOT for schedule or scope emphasis).

  Options:
    --text <text>        The user's requirement, saved verbatim (required)
    --gist <text>        Short summary used for conflict keyword matching
                         (default: first sentence of --text)
    --t-id <n>           Associate with a specific T (default: next T to record — latest + 1).
                         Same one T id as everywhere else: --t <n> / --id <n> work too
    --dir <path>         Project directory

  Example:
    context-pocket absolute add --text "绝不改动 /api/v1 的响应字段" --gist "API v1 形状冻结"
` },
  "req add": { argv: ["req","add"], text: `
  Usage: context-pocket req add <text> [options]

  Options:
    --tags <csv>         Comma-separated tags
    --status <Open|Done|Cancelled>  Default: Open
    --uncertain          Mark as inferred / unconfirmed (❓)
    --impl <csv>         Comma-separated implementing files
    --dir <path>         Project directory
` },
  "decision add": { argv: ["decision","add"], text: `
  Usage: context-pocket decision add --title <text> [options]

  Options:
    --title <text>       Decision title (required)
    --context <text>     Problem / what was on the table
    --options <text>     Options considered (A / B / C)
    --decision <text>    Chosen option + why
    --consequences <text>  What this locks in
    --supersedes <text>  ADR-x + why, or "none"
    --dir <path>         Project directory
` },
  "handoff": { argv: ["handoff"], text: `
  Usage: context-pocket handoff [options]

  Generate handoff.md — a single-file summary for the next agent to get up to speed.

  Options:
    --dir <path>         Project directory
` },
  "archive": { argv: ["archive"], text: `
  Usage: context-pocket archive [options]

  Archive old T-blocks to log-archive.md.
  Runs verify before and after. Rolls back on failure.

  Options:
    --keep-last <N>      Keep latest N T-blocks in log.md (default: config.md recent_keep)
    --dry-run            Show what would be archived, don't modify files
    --dir <path>         Project directory
` },
  "repair": { argv: ["repair"], text: `
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
` },
  "state update": { argv: ["state","update"], text: `
  Usage: context-pocket state update [options]

  Update state.md. Updates the T-number in the header automatically.
  With no options at all, only refreshes the T-number in the header — body sections stay untouched.

  Options:
    --summary <text>     Replace Summary section with this text
    --append-summary     Append to Summary instead of replacing
    --next-step <text>   Append a next step
    --pitfall <text>     Append a pitfall (alias: --pitfalls)
    --dir <path>         Project directory
` },
  "preferences update": { argv: ["preferences","update"], text: `
  Usage: context-pocket preferences update --key <k> --value <v>

  Update or add a preference entry. Updates the T-number in the header.

  Options:
    --key <text>         Preference key (e.g. "coding style", "tooling")
    --value <text>       Preference value
    --dir <path>         Project directory
` },
  "code-map update": { argv: ["code-map","update"], text: `
  Usage: context-pocket code-map update [options]

  Rescan project directory and update code-map.md.
  Preserves existing descriptions; marks new files as TODO.

  Options:
    --dir <path>         Project directory
` },
  "migrate": { argv: ["migrate"], text: `
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
` },
  "install-hook": { argv: ["install-hook"], text: `
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
` },
  "uninstall-hook": { argv: ["uninstall-hook"], text: `
  Usage: context-pocket uninstall-hook [options]

  Uninstall the ContextPocket pre-commit hook (sync + verify).
  If other hook content exists, only removes the managed ContextPocket section.

  Options:
    --dir <path>         Project directory
` },
  "index": { argv: ["index"], text: `
  Usage: context-pocket index [--rebuild]

  Build or refresh the derived search index over your ContextPocket
  (T-blocks from log.md + log-archive.md, ADRs, requirements, preferences).

  The index lives in ContextPocket/assets/search-index.json and is a cache:
  markdown files remain the single source of truth. search auto-refreshes
  it when sources change, so you rarely need to run this manually.

  Options:
    --rebuild       Ignore the existing index and rebuild from scratch
    --dir <path>    Project directory
` },
  "distill": { argv: ["distill"], text: `
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
` },
  "import": { argv: ["import"], text: `
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
` },
  "hub": { argv: ["hub"], text: `
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
` },
};

/** 取某个命令的 --help 全文（含首尾换行，入口直接 console.log） */
function commandHelp(key) {
  const entry = COMMAND_HELP[key];
  if (!entry) throw new Error('commandHelp: unknown command "' + key + '"');
  return entry.text;
}

// ============================================================
// MCP 侧
// ============================================================

/** initialize 回包的 instructions */
const SERVER_INSTRUCTIONS = "ContextPocket project memory. Start with context_pocket_status to see what the pocket holds, context_pocket_recall to fetch a specific T-block, and context_pocket_log_append to record a turn. Never hand-edit the markdown files.";

/** tools/list 的工具级描述（参数级描述留在 mcp-server.js 的 schema 里） */
const TOOL_DESCRIPTIONS = {
  context_pocket_bootstrap: `Initialize ContextPocket/ with template files (10 core in full mode, 5 in lite). Auto-detects project type. Idempotent: if ContextPocket/ already exists nothing is overwritten — it reports that and recording continues. Side effect worth naming: by default the project is also added to the user-level hub (~/.contextpocket/hub.json), so pass noHub=true for throwaway directories, script runs and CI projects that should leave nothing in your home.`,
  context_pocket_status: `Get current ContextPocket status summary (latest T, requirements, decisions, etc.)`,
  context_pocket_verify: `Run health check on ContextPocket. 15 checks by default: file existence, T/R/ADR id continuity, T-block section format, reference integrity, index consistency, 🔒 integrity, code map drift, handoff staleness, header T agreement, implausible IDs, log size vs archive_at, format-version lag, the credential/PII scan, and attachment existence (a \`### Attachments\` line naming a file that is not on disk is an error — template placeholders, URLs, absolute paths, \`../\` paths and entries already written as \`[missing: T<n> <file>]\` are skipped, and \`log-archive.md\` is scanned too). The scan grades by what a leak costs: vendor-shaped keys (sk-ant-, AKIA-, ghp_, private-key blocks, JWT) come back as errors, which block the pre-commit hook and make archive/migrate refuse; personal data (ID numbers, card numbers, phone numbers, \`password: xxxx\`) is warning-only and never blocks. Findings are masked (first 6 chars + length) — never quote a value you find here into the next T-block. Set "- secret_scan: false" in config.md to disable. Pass drift=true to enable the two tree-scanning drift checks: log-cognition-drift (paths referenced in recent T-blocks vs working tree) and code-newer-than-log (files whose mtime is later than the last record — the missed-log net for projects without git). Both report warnings/info only, never errors.`,
  context_pocket_recall: `Show full details of a specific T-block (gist, tags, all sections). Archived turns (log-archive.md) are included and marked *(archived)*.`,
  context_pocket_diff: `Compare two T-blocks. Shows changes in requirements (added/completed/cancelled), decisions (new ADRs), and files.`,
  context_pocket_search: `Keyword search over the whole history: T-blocks (gist + every section, archived turns included), ADRs, requirements and preferences. Indexed and scanned searches return the same matches in the same order; page with limit/offset.`,
  context_pocket_why: `Reverse lookup: which T-blocks mentioned this file path? Inspired by ThoughtDAG why_file/why_check. Searches every section of every turn, archived turns included. Each hit carries evidence: "changed" when the path is in that turn's Action section, "mentioned" when it only appears elsewhere (Uncertain / Attachments / Conflicts / Pitfalls) — which is NOT a record of changing the file. "changed" hits come first, then "mentioned", newest first inside each group.`,
  context_pocket_check_conflicts: `Scan for conflicts across 6 dimensions: tech stack, requirements, ADRs, style, deployment, and 🔒 absolute. Three severity levels: critical / warning / info.`,
  context_pocket_sync: `Git safety net: detect staged file changes that were NOT recorded in recent T-blocks ("agent forgot to log"), and optionally auto-record them as a [auto] T-block. Coverage counts strong evidence only: the path must appear in a recent turn's Action section. Files mentioned solely in other sections come back as unrecorded with mentionedIn[] naming the turn/section, so you can log amend that turn instead of writing an [auto] block. Use auto=true to fill the gap.`,
  context_pocket_log_append: `Append a new T-block to log.md. Auto-assigns T-ID, updates index. Always use this instead of manually editing log.md.`,
  context_pocket_log_amend: `Fill in sections that are MISSING from an already-written T-block (e.g. a turn appended without \`user\`). Never overwrites existing content. Use this to resolve "missing User/Action section" errors from context_pocket_verify.`,
  context_pocket_absolute_add: `Append a 🔒 red-line entry to absolute.md — verbatim, never compressed, never archived. Use ONLY for architecture / tech / code constraints a future agent must not violate (e.g. "never use ORM", "do NOT change the /api/v1 response shape"). NOT for schedule or scope emphasis.`,
  context_pocket_req_add: `Add a new requirement. Auto-assigns R-ID and updates index.`,
  context_pocket_decision_add: `Add a new ADR (Architecture Decision Record). Auto-assigns ADR number.`,
  context_pocket_handoff: `Generate handoff.md — a single-file summary for the next agent to get up to speed.`,
  context_pocket_state_update: `Update state.md. Updates T-number automatically. Can update summary, next steps, and pitfalls.`,
  context_pocket_preferences_update: `Update or add a preference entry in preferences.md. Updates T-number automatically.`,
  context_pocket_code_map_update: `Rescan project directory and update code-map.md. Preserves existing descriptions; marks new files as TODO.`,
  context_pocket_archive: `Archive old T-blocks to log-archive.md. Runs verify before and after. Rolls back on failure.`,
  context_pocket_migrate: `Migrate ContextPocket data format along the registered one-hop steps (v1 → v2 → v3 in a single call). Backs up first, verifies before each hop, bumps the format stamp after each, and restores the backup if any hop or the final check fails — never half-migrated. Use list=true to see the registry and the computed path, dryRun=true for the full plan without writing.`,
  context_pocket_repair: `Renumber T-blocks whose T-ids collide after two agents wrote to the same turn number. The write lock lives in os.tmpdir() (lib/io.js) so it only protects one machine: two clones can both compute latestT+1 and both write T9, and log.md ends up with two \`## T9\` blocks. verify detects that as an ERROR (its fix line names this tool), and hand-editing the markdown is what the skill forbids, so repair is the way out: the colliding block and every block after it shift up one, so ids stay increasing with file order (log.md is append-only). References are the honest part: a body line saying \`T9\` may have meant either block, so by default they are LISTED, not rewritten — add applyRefs=true to substitute every stale ref by the same mapping (applied simultaneously, so a T9→T10 / T10→T11 cascade does not move one ref twice). A reference has to be a STANDALONE \`T<n>\`: \`GPT4\`, \`RTX4090\`, \`UTF8\` are words that merely contain the shape and are never matched. Attachment file names (\`T04-diagram.png\`, \`assets/T04-x.png\`) are a third category and are NEVER rewritten, applyRefs included — renaming is two halves (\`mv\` the file, then edit the text), and doing only the second half manufactures a broken link plus lost zero-padding, so the tool just lists them in \`fileNames\` with the exact \`mv\` command for you to run. Derived counters (the \`· T<n>\` header line of state/requirements/decisions/preferences/code-map/handoff, and index.md) are realigned automatically. log-archive.md is reported only, never modified — it declares itself read-only. The renumbering itself is recorded as a new [auto] T-block so the pocket states that the tool moved numbers. Rolls back everything if verify ends up worse or duplicates remain. dryRun=true returns the plan without writing.`,
  context_pocket_install_hook: `Install a git pre-commit hook (v3: three-step). Step 0 skips the checks when the repo has no ContextPocket/ directory, so installing the hook before bootstrap never blocks every commit. Step 1 runs context-pocket sync --auto to auto-fill missed T-blocks from staged changes. Step 2 runs context-pocket verify --quiet; blocks commit only if verify finds errors (warnings allow). Upgrades an older hook automatically.`,
  context_pocket_uninstall_hook: `Uninstall the ContextPocket pre-commit hook. If other hook content exists, only removes the ContextPocket section.`,
  context_pocket_index: `Build or refresh the derived search index (T-blocks + ADRs + requirements + preferences) at ContextPocket/assets/search-index.json. Markdown files remain the source of truth; the index is a cache that auto-refreshes on search, so this tool is mostly for forcing a rebuild after bulk edits or imports.`,
  context_pocket_distill: `Distill old content: scan log-archive.md plus old turns in log.md and extract candidate decisions / pitfalls / preferences / open ❓ items worth promoting back into the living docs (decisions.md / state.md / preferences.md). Writes a digest report ContextPocket/digest-<date>.md — review it, merge still-valid items with their T references, then delete the report.`,
  context_pocket_import: `Import past agent conversation sessions (claude-code / codex JSONL, auto-detected) as [imported] T-blocks. T numbers continue from the current latest. Useful when enabling ContextPocket on a project that already has agent history.`,
  context_pocket_hub: `User-level memory hub at ~/.contextpocket/hub.json (redirect the folder with the CONTEXTPOCKET_HOME env var to share it across machines). Actions: list registered projects (default), set/get global preferences, or unregister a project. The hub is only a registry — project data always lives in each project's ContextPocket/.`,
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
