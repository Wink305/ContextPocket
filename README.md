# ContextPocket

> **[简体中文](README.zh-CN.md)** · [Documentation](docs/) · [Changelog](CHANGELOG.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Skill Format: v1](https://img.shields.io/badge/format-v1-blue.svg)](SKILL.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> **SKILL docs** are split into 3 files: [SKILL.md](SKILL.md) (daily-read main) · [SKILL-advanced.md](SKILL-advanced.md) (templates / archive / edge cases) · [SKILL-reference.md](SKILL-reference.md) (Layout + per-file templates + log.md T-block spec).

📌 **When to use**

- Switching agents or models? The new session starts from zero.
- Long session hit the token limit? History gets compressed and lost.
- Inheriting someone else's AI project? No clue what was done before.

✨ **What it does**

- Automatically records every dev conversation turn into your project's `ContextPocket/` folder.
- Next agent reads it once and picks up progress in 5 seconds.
- Captures: requirements, code changes, decisions, pitfalls, preferences.

🚀 **How to use**

1. **Install** — pick one of the three methods in [Quick Start](#1-install) (CLI command, no-install script call, or skill-directory copy)
2. **Activate** — automatic; nothing to type (see [Quick responses](#-quick-responses) below)
3. **Work normally** — the agent auto-records, and a new agent / model picks recording back up on its own

---

## 🚀 Quick Start

### 1. Install

Three modes available — auto-detected, no extra config needed.

| Mode | Requirements | Reliability | Best for |
|------|-------------|-------------|----------|
| **MCP mode** | MCP-compatible agent (Trae, Claude Desktop) | ⭐⭐⭐⭐⭐ 10/10 | Best experience |
| **CLI mode** | Node.js 14+ (zero extra deps) | ⭐⭐⭐⭐ 9.5/10 | Most developers |
| **Skill-only** | Nothing, just the folder | ⭐⭐⭐⭐ 8/10 | Compatibility fallback |

Fetch the code first — method (b) can point at any folder that holds these files:

```bash
git clone https://github.com/Wink305/ContextPocket.git
cd ContextPocket
```

Then pick **one** of the three install methods below.

#### (a) Install it as a command — `context-pocket` on your PATH

This is the only method that makes the bare `context-pocket <cmd>` form used across this README work.

**From a clone — works today** (`package.json` is in the repo, so `npm link` registers the CLI globally from your local directory):

```bash
# macOS / Linux / Windows (PowerShell or cmd) — run inside the cloned repo
npm link
```

Or install it globally from the local folder instead:

```bash
npm install -g .
```

**From the registry — once published.** `npm install -g context-pocket` is the intended final form, but the package is **not published to the npm registry yet**; use one of the clone-based commands above until it is (check with `npm view context-pocket`).

`package.json` declares two binaries, so linking installs both:

| Command | Entry point | What it is |
|---------|-------------|------------|
| `context-pocket` | `bin/context-pocket.js` | the CLI |
| `context-pocket-mcp` | `mcp-server.js` | the MCP stdio server |

Verify:

```bash
context-pocket help
```

Windows note: `npm link` generates `context-pocket.cmd` / `context-pocket-mcp.cmd` shims, so the commands work in PowerShell and cmd unchanged. Remove later with `npm uninstall -g context-pocket`.

#### (b) No install at all — call the script with `node`

Nothing is registered anywhere; this works on any machine with Node.js 14+ and only needs the files on disk. Replace the path with where you actually put the repo:

```bash
# POSIX (bash / zsh)
node /path/to/ContextPocket/bin/context-pocket.js status --dir /path/to/your/project
```

```powershell
# Windows / PowerShell
node C:\Users\<you>\ContextPocket\bin\context-pocket.js status --dir C:\path\to\your\project
```

Every `context-pocket <cmd>` in this README or in [docs/FAQ.md](docs/FAQ.md) can be run this way by swapping the prefix for `node <path>/bin/context-pocket.js`.

#### (c) Skill-directory copy — no Node.js needed at all

If your agent loads skills from a folder (MiniMax Code, Claude Code, Cursor, Continue), copying the folder in is enough: the agent reads the SKILL docs and drives the same subcommands for you, and the skill-only mode above works even with no Node.js installed.

POSIX (bash / zsh):

```bash
# MiniMax Code / Claude Code / similar
cp -r . ~/.minimax/skills/context-pocket/

# Cursor / Continue / IDE plugins
cp -r . ~/.cursor/skills/context-pocket/
```

Windows / PowerShell:

```powershell
# MiniMax Code / Claude Code / similar
Copy-Item -Recurse -Force . "$env:USERPROFILE\.minimax\skills\context-pocket"

# Cursor / Continue / IDE plugins
Copy-Item -Recurse -Force . "$env:USERPROFILE\.cursor\skills\context-pocket"
```

Windows / cmd.exe:

```bat
xcopy . "%USERPROFILE%\.cursor\skills\context-pocket\" /E /I /Y
```

> ⚠️ Method (c) alone does **not** put `context-pocket` on your PATH. Combine it with (a) or (b) if you also want to run the CLI yourself.

**For MCP mode:** add this to your MCP config (works with every install method — point `args` at the absolute path of `mcp-server.js`):

```json
{
  "mcpServers": {
    "context-pocket": {
      "command": "node",
      "args": ["/absolute/path/to/ContextPocket/mcp-server.js"]
    }
  }
}
```

On Windows, either use forward slashes or escape the backslashes in the JSON string:

```json
{
  "mcpServers": {
    "context-pocket": {
      "command": "node",
      "args": ["C:\\Users\\<you>\\ContextPocket\\mcp-server.js"]
    }
  }
}
```

After install method (a) you may instead use the installed bin directly: `"command": "context-pocket-mcp"` with `"args": []`.

See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for the full list of supported agents.

### 2. Activate

Activation is **automatic** — there is no command to type. In a project that has no `ContextPocket/` yet, the agent offers to bootstrap it on the first substantive turn; if one already exists, it reads `index.md` + `state.md` and keeps recording.

The agent will automatically:
- Create a `ContextPocket/` folder at the project root
- From CLI/MCP mode: run `bootstrap` to auto-detect project type, scan directory tree, copy all templates from `templates/`, and pre-fill `code-map.md` and `state.md`
- Start auto-recording

### 3. Work normally

Every time you chat with the agent, it will **automatically** append a `T<n>` block to `log.md`, recording:
- What you said (User)
- What the agent did (Action — with specific file paths)
- Code changes / decisions made

You don't need to do anything special.

### 4. Switch / Hand off

When switching agents or models, have the new session read the pocket:

```
Read ContextPocket/index.md
```

The new agent picks recording back up automatically — up and running in 5 seconds.

---

## ⚡ Quick responses

**There are no slash commands to memorize.** Say what you want in plain language — the agent infers the intent and runs the right `context-pocket` subcommand or MCP tool, then answers in one line. The full intent → action mapping lives in [SKILL.md](SKILL.md).

| You say (any phrasing) | The agent runs | It replies |
|------------------------|-----------------|------------|
| First time in this project · "start recording here" · "set up this project" · "onboard me to this repo" | `bootstrap` (idempotent) | `✅ ContextPocket ready, auto-recording on` |
| "What's the status?" · "How far along are we?" | `status` | One-line summary |
| "This is a red line — never change X" · "This must be preserved" | `absolute add` | Written to `absolute.md`, never compressed |
| "Hand this off" · "I'm switching models" · "Give this to someone else" | `handoff` | `handoff.md` generated |
| "Check for anything missing" · "Check before I commit" · "Is it healthy?" | `verify` | Pass — or each issue with a runnable fix command |
| "Fill in T7" · "I forgot to tell you that line" | `log amend` | T7 filled in |
| "That turn was yesterday afternoon" · "It took us from 9 to 11" | `log append --when` / `log amend <Tn> --when` | The turn's time line, echoed back as `⏱ 2026-10-03 09:00 → 2026-10-03 11:30` — a day it only knows as a day stays `(day)`, and the user's own words stay verbatim |
| "Who changed this file?" · "Why does it look like this?" | `why <path>` | Matching turns, labelled `[changed]` (it's in that turn's Action section) or `[mentioned only]` (Uncertain / Attachments / Conflicts … — it was talked about, not modified); changed turns come first |
| "How did we fix that bug last time?" · "Search for X" | `search <keyword>` | The matching T-blocks |
| "What did T7 actually say?" | `recall T<n>` | The full T-block |
| "What changed between T5 and T9?" | `diff Ta Tb` | The delta |
| "Anything I should confirm?" · "Anything I'm unsure about?" | Reads the `❓` lines directly (no tool) | The list, then "Confirm one by one?" |
| "Any contradictions?" | `check-conflicts` | Severity-ranked result |
| "Did git miss anything?" | `sync` (`--auto` to write) | How many turns were backfilled |
| "How do I use this thing?" | Answers inline — **never** "see README.md" | An inline answer |

> 💡 Prefer the plain phrasing; it reads better than a command name. Naming the subcommand explicitly (`context-pocket verify`) also works if you want zero ambiguity.

---

## 💻 CLI Commands (Node.js Required)

All commands below work via CLI when Node.js 14+ is available. Type `context-pocket …` if you used install method **(a)**; otherwise prefix with `node <path>/ContextPocket/bin/context-pocket.js` — install method **(b)**. Pass `--dir <project-root>` to target a project.

| Command | What it does |
|---------|--------------|
| `context-pocket bootstrap --dir <root>` | Auto-detect project type, scan tree, copy templates, pre-fill code-map & state. Registers the project in `~/.contextpocket/hub.json`; add `--no-hub` (MCP `noHub: true`) to build the pocket without touching the hub |
| `context-pocket verify --dir <root>` | 15-check health check: files, IDs, refs, index consistency, 🔒 integrity, log size vs `archive_at`, credential/PII shapes in the markdown (vendor keys = error and block the pre-commit hook; personal data = warning only), attachment existence (a `### Attachments` line naming a file that is not on disk is an error — placeholders, URLs, absolute paths and entries already marked `[missing: …]` are skipped), and — as a warning that never blocks a commit — a data format left behind the registry (`lib/validator.js:74`) |
| `context-pocket verify --drift --dir <root>` | Add the two tree-scanning drift checks: cognition drift (paths in recent T-blocks vs working tree) + code-newer-than-log (files modified after the last record; works without git). Add `--drift-last-n <N>` to tune lookback |
| `context-pocket status --dir <root>` | One-line summary (T-range, reqs, ADRs, ❓, archive status) |
| `context-pocket recall <T-id> --dir <root>` | View full details of one T-block |
| `context-pocket diff <Ta> <Tb> --dir <root>` | Compare two turns: req changes, ADR additions, file changes |
| `context-pocket search <keyword> --dir <root> [--limit N] [--offset N] [--no-index]` | Keyword search over the whole history: T-blocks (gist, tags, every section, archived turns included), ADRs, requirements and preferences. Auto-uses the `assets/search-index.json` index; `--no-index` scans the markdown instead — both paths match and order identically, so `--limit`/`--offset` page the same list (`--limit 0` = all). Matching: latin words split on separators, Chinese is indexed as adjacent two-character pairs, and **every** query term must hit. A phrase inside a longer Chinese run therefore works (`时间分页` finds 「给搜索加时间分页」) and a reordered one does not (`分页时间`); one lone Chinese character only matches where that character stands alone |
| `context-pocket why <file-path> --dir <root>` | Reverse lookup: which T-blocks mention this file, split by evidence — `[changed]` (path in that turn's Action section) vs `[mentioned only]` (elsewhere: Uncertain / Attachments / Conflicts / Pitfalls …). Changed turns are listed first, so `--limit` drops the weak ones, never the real edits (Inspired by ThoughtDAG) |
| `context-pocket check-conflicts --dir <root>` | 6-dimension conflict scan with severity (critical / warning / info) |
| `context-pocket log append --dir <root> --gist "..." --tags "..." [--when "..."] [--author "..."]` | Append one T-block to log.md (pass `--user "<what the user asked>"` — a block without it fails verify and blocks commits). `--when` is optional: the block is stamped with the moment you record it, and `--when` only overrides that when the turn actually happened at another time. `--author "<who is recording>"` signs the turn in a `### Author` section — use it when several agents share one pocket; omit it and the block simply has no author, the tool never guesses one. Every append also compares this turn against what the pocket already says and writes what it **newly** collides with into the block's `### Conflicts` section prefixed `[auto]` (`--no-conflict-check` opts out and the tool says so). The scan reports, it never blocks the record |
| `context-pocket log amend <Tn> --dir <root> --user "..." [--when "..."] [--author "..."]` | Fill in sections **missing** from an existing T-block. Never overwrites existing content — `--when` will add a missing time line or sharpen a day-only one, but refuses to rewrite a moment that was already recorded, and `--author` only adds a missing `### Author` section |
| `context-pocket absolute add --dir <root> --text "..." [--gist "..."]` | Append a 🔒 red-line entry to absolute.md (verbatim, never compressed) |
| `context-pocket req add --dir <root> --text "..."` | Add a requirement (auto-assigns next R-id) |
| `context-pocket decision add --dir <root> --title "..."` | Add an ADR |
| `context-pocket handoff --dir <root>` | Generate handoff.md summary |
| `context-pocket state update --dir <root> --summary "..."` | Update current state |
| `context-pocket preferences update --dir <root> --key "..." --value "..."` | Update a preference |
| `context-pocket code-map update --dir <root>` | Rescan project directory, update code-map.md |
| `context-pocket archive --dir <root> [--keep-last N] [--dry-run]` | Archive old T-blocks (you trigger it; it is never automatic) with verify → archive → verify → rollback. `--keep-last` defaults to `recent_keep` in `config.md` (30) |
| `context-pocket migrate --dir <root> [--to v<N>\|latest] [--dry-run] [--list]` | Format migration along the registered hop chain (`v1 → v2 → v3` in one call; `--to` accepts `v2` / `2` / `latest`). Backs up first, verifies before each hop, restores the backup if any hop or the post-check fails. Two hops are registered: `v1 → v1` (a no-op format self-check) and **`v1 → v2`**, which really rewrites content — every T-block in `log.md` / `log-archive.md` gets a `--- WHEN: <date> (day) ---` line from the SESSION date above it, a block with no date above it is left untouched, and blocks that already have a line are skipped so re-running changes nothing. A v1 folder shows one `format-upgrade` WARNING in `verify` until you run it — a warning, so the commit hook never blocks on it |
| `context-pocket repair --dir <root> [--dry-run] [--apply-refs] [--author "..."]` | Renumber T-ids that collide after two agents wrote the same turn number (the write lock is per-machine — see "Will multiple users/agents conflict?"). The colliding block **and every block after it** shift up one, so ids keep increasing with file order, because `log.md` is append-only. Prose is never rewritten: every line still naming an old number is *listed* (that number can point at either of the two colliding blocks — only a reader knows which), and `--apply-refs` is what actually substitutes them, in one simultaneous pass so a `T3→T4` + `T4→T5` cascade cannot move one reference twice. Only a **standalone** `T<n>` is a reference — `GPT4` / `RTX4090` / `UTF8` are words that contain the shape, not ids — and attachment file names (`T04-diagram.png`, `assets/T04-diagram.png`) are never rewritten even under `--apply-refs`: renaming a file is two halves (`mv`, then edit the text) and doing only the second leaves a broken link plus lost zero-padding, so those are listed in `fileNames` with the exact `mv` command to run. Derived counters (the `· T<n>` header of state/requirements/decisions/preferences/code-map/handoff, and `index.md`) are realigned automatically; `log-archive.md` is reported but never touched (it declares itself read-only). The move itself becomes an `[auto]` T-block, and if `verify` comes out worse the whole repair rolls back |
| `context-pocket sync --dir <root> [--auto] [--dry-run] [--last-n <N>] [--quiet]` | Git safety net: detect staged changes unrecorded in recent T-blocks (hook uses `--auto`). Coverage needs strong evidence — the path in a turn's **Action** section; a file only named in Uncertain / Attachments / Conflicts still counts as unrecorded, and the report says which turn mentioned it so you can `log amend` instead of getting a fresh `[auto]` block |
| `context-pocket install-hook --dir <root>` | Install Git pre-commit hook (v3: skip when no pocket → auto-fill missed → verify) |
| `context-pocket uninstall-hook --dir <root>` | Remove our pre-commit hook, preserve other hooks |
| `context-pocket index --dir <root> [--rebuild]` | Build / refresh the search index (`assets/search-index.json`). Markdown files are always the source of truth; the index is a derived cache |
| `context-pocket distill --dir <root> [--dry-run]` | Distill old turns: emit a `digest-<date>.md` report listing decisions / pitfalls / preferences worth merging back into the living docs (inspired by Basic Memory) |
| `context-pocket import --dir <root> --file <session.jsonl> [--source auto\|claude-code\|codex]` | Import a past agent session as `[imported]` T-blocks so a mid-stream adoption doesn't lose history |
| `context-pocket hub [list\|pref\|remove] --dir <root>` | User-level hub: list registered projects / read+write global prefs / unregister this project |
| `context-pocket help [--json]` | Show all commands. With `--json` the same table comes back as one line of `{groups:[{group,commands:[{command,summary}]}]}`, so an agent can discover the command surface without parsing colored text |

> 💡 In MCP mode, each CLI command has an equivalent MCP tool (e.g. `context_pocket_bootstrap`).
>
> 💡 Every command accepts `--json`: stdout becomes exactly one parseable line (`{"ok":true,…}`, or `{"ok":false,"error":"…"}` with a non-zero exit) instead of formatted text — that is what the agent/hook side should read.
>
> 💡 One concept, one name on both sides: MCP `tId` ⇄ CLI `--t-id` (`diff` uses `tA`/`tB` ⇄ `--t-a`/`--t-b`, MCP `filePath` ⇄ CLI `--file-path`). The positional form (`context-pocket recall 3`) is the canonical way to write it; `--t`, `--id`, `--file`, `-f` stay accepted as aliases, so a plausible guess never comes back as "T-id is required".
>
> 💡 A flag with no value counts as **not given**. `context-pocket state update --summary --json` writes nothing and exits 1 instead of storing the word `true` in `state.md` — the same rule the writer applies to `--gist`, now shared by both entry points (`lib/fields.js` `textOption`).
>
> 💡 `--no-index` sits on both ends of the cache and is safe on both: on `search` it means "ignore the cache for this query", on `log append` / `log amend` it means "don't refresh the cache after this write". Markdown stays the source of truth either way, so the next search rebuilds the cache and returns the very same hits — including archived turns, measured to come back in the same order on both paths. Bulk loops use it to skip a refresh per turn, and the size of that saving depends on scale: ≈15 ms/turn at 30 turns (a bare CLI call already costs ≈112 ms of Node startup), ≈0.18 s/turn at 800 turns — so it pays off mainly in the resident MCP server or a long append loop, not in one-shot CLI use (`log append --help`).
>
> 💡 `context-pocket --version` (also accepted: `-v`, `context-pocket version`) prints the number straight out of `package.json` — it needs no `ContextPocket/` folder and writes nothing. An MCP client reads the same number from `initialize`'s `serverInfo.version`; both entry points go through `lib/version.js`, so `package.json` is the only place a version is written.

---

## 📋 Use Cases

| Scenario | Pain point | How ContextPocket solves it |
|----------|-----------|------------------------------|
| Switch agent platforms | New agent knows nothing | Read `ContextPocket/` and continue |
| Switch model versions | Conversation history disappears | Same — data is model-agnostic |
| Long session token overflow | History gets compressed/lost | Critical content is already on disk |
| Multi-agent collaboration | Agents have inconsistent state | Share one `ContextPocket/`; concurrent writers on one machine are serialized by the write lock, cross-machine merges are settled by `repair`, and `log append --author` says who recorded what |
| Inherit someone else's project | Don't know what was done before | Read `handoff.md`, 5 min onboarding |

---

## 📁 File Structure

```
project-root/
└── ContextPocket/
    ├── readme.md          # Project identity card + format version
    ├── index.md           # Lightweight index (~20 lines)
    ├── state.md           # Current state + next steps + run commands + pitfalls
    ├── requirements.md    # Requirements list (R-ids, with impl references)
    ├── preferences.md     # Dev preferences
    ├── decisions.md       # Architecture Decision Records (ADRs)
    ├── code-map.md        # Detailed code/module map
    ├── log.md             # Conversation timeline (one T-block per turn)
    ├── log-archive.md     # Archive (created when log.md > archive_at lines)
    ├── absolute.md        # 🔒 Never-compressed absolute-keep area
    ├── handoff.md         # Handoff summary (generated by the handoff step)
    ├── config.md          # Optional: custom configuration
    ├── pocket-snapshot-*.md  # Snapshot files (max 3 kept)
    └── assets/
        ├── search-index.json   # Search index (auto-generated, safe to delete + rebuild)
        └── archive/            # Archived attachments (moved here on archive)
```

### T-block example

```markdown
## T5 · User confirmed database choice · [requirement-change] [arch-decision]
--- WHEN: 2026-10-03 14:47 ---

### Author
- agent-A

### User
- PostgreSQL or MongoDB? I lean PG

### Action
- 修改 decisions.md — 新增 ADR-3，记录 PG 选型理由

### Decisions & Constraints
- PostgreSQL over MongoDB: user prefers relational + team familiarity
  → see ADR-3

### Uncertain
- ❓ Will full-text search be needed? If yes, may add ES later
```

The `--- WHEN: … ---` line (format v2, right under the heading) is when that turn happened. `log append` writes the moment you record it; pass `--when` when the user said something else — `--when "09:00 → 11:30"` for a stretch of time, `--when "2026-10-03"` when only the day is known (it stores `(day)`, never a fake midnight), `--when "上周三下午"` to keep the user's words verbatim. `recall` shows it, and a folder still on v1 simply has no such line until `migrate --to latest` — passing `--when` there still records the turn (log.md is P0) but says why the time did not land (`whenSkipped` in `--json`), rather than swallowing it.

`### Author` is there only when someone was told who wrote the turn (`log append --author`). It is a section like any other, not a structural line, so it changed nothing about the format version: a v1 folder may already have one, and a block without it is not incomplete — the tool never fills in a name it was not given.

---

## 🎯 Design Principles

| Principle | Meaning |
|-----------|---------|
| **Completeness > Brevity** | Better to over-record than miss — a missed turn breaks the handoff chain |
| **Always P0: log.md** | Even under token pressure, the conversation timeline must never stop |
| **T-numbers monotonically increase** | T1, T2, T3... never reset, fully traceable |
| **🔒 red-line confirmation** | When user says "must", the agent asks "mark as 🔒?" |
| **Conflicts visible, never silently overwritten** | When contradictions appear, keep both, mark superseded |
| **Agent-agnostic** | All files are pure-text Markdown, readable by any agent |

---

## 🗂 Project Type Templates

On first activation, the agent asks (or auto-detects) the project type and pre-fills different fields:

| Type | Focus areas |
|------|-------------|
| **frontend** | bundler, framework, state management, design tokens, build config |
| **backend** | API style, auth scheme, DB + migrations dir, cache, queue/worker |
| **fullstack** | Both above + API boundary, shared types location, proxy config |
| **data** | data sources, pipeline steps, schedule, notebook env, output storage |
| **mobile** | platform, min SDK/OS, build target, store/CDN, deep links |

---

## 🔧 Advanced Configuration (Optional)

Create `ContextPocket/config.md` to customize behavior:

```markdown
# Config
- project_type: fullstack
- mode: full                  # full = 10 core files (+2 created on demand); lite = 5 core files only
- archive_at: 800             # log.md line count at which status/verify say "archive is due" (archiving itself is never automatic)
- recent_keep: 30             # how many recent full T-blocks archive keeps in log.md (override per run with --keep-last)
- language: en                # recording language (zh / en / follow user)
- quiet: true                 # true = one-line confirmation per turn
- secret_scan: true           # verify scans the pocket's markdown for credential/PII shapes (sk-ant-…, AKIA…, private-key
                              # blocks, JWT, ID numbers, card numbers, `password: xxxx`). Vendor-shaped keys are an ERROR —
                              # i.e. they block the pre-commit hook; personal data is a WARNING and never blocks. Set to
                              # false only when the pocket is *supposed* to hold such strings (a key-rotation runbook)
- gitignore: true             # value used at initialization (bootstrap --gitignore false records false
                              # and leaves ContextPocket/ out of .gitignore). Editing it later does NOT
                              # rewrite .gitignore — edit that file yourself
- tags_default: [requirement-change, code-logic, arch-decision, bug, preference, dependency, test, ui, api, deploy, docs, pitfall, conflict, correction]
```

**Lite mode**: For scripts/small projects — creates only the 5 core files; others are created on demand.

---

## 🛡 Privacy & Security

- `ContextPocket/` is **pure-text Markdown**, no executable code
- **Auto-ignored** in `.gitignore` (project-local data; manually push if desired)
- No upload, no network — everything stays in your project directory
- `absolute.md` (🔒 area) replaces on-device encryption — relies on **discipline**, not technology, to prevent compression

---

## 🌐 User-level Hub (cross-project registry)

Each project has its own `ContextPocket/`, but you probably want one place that knows about every project you've enabled ContextPocket on — plus a cross-project set of preferences that follow you.

- **Location**: `~/.contextpocket/hub.json` (a small JSON, indexed by project path)
- **Contents**: registered projects (path → name / type / latest T / last-active) + user-level global preferences
- **Design**: the hub is **only a registry**. Project data always lives inside each project's `ContextPocket/`. A hub failure (full disk, permission denied) will not affect normal recording.
- **Two ways to share across machines**:
  1. **Env var**: `export CONTEXTPOCKET_HOME=/path/to/synced/folder` (point it at a cloud drive / Dropbox / iCloud / git bare repo). All machines share one `hub.json`.
  2. **Git into the repo**: at `bootstrap` add `--gitignore: false` (or the MCP equivalent `gitignore: false`) to commit the entire `ContextPocket/` directory, including project-local preferences.
- **Commands**: `context-pocket hub list` · `context-pocket hub pref --key <k> --value <v>` · `context-pocket hub remove`
- **Opting out of the registry**: `bootstrap --no-hub` (MCP `noHub: true`) creates the pocket and writes nothing under `CONTEXTPOCKET_HOME`. Use it for throwaway projects, CI jobs and scripted one-shot bootstraps, so the hub keeps only the projects you actually work in. The pocket itself is complete and fully usable; `hub list` just won't show it. Register it later by running the same command without `--no-hub` (bootstrap is idempotent — it re-registers and leaves your recorded history untouched).

---

## 🆚 Comparison with Alternatives

| Tool | Characteristic | ContextPocket advantage |
|------|----------------|--------------------------|
| Agent built-in memory | Lost across models | ✅ Model-agnostic |
| Manual notes | Easy to miss | ✅ Auto-captured |
| Git commit messages | Code-only | ✅ Records intent + decisions + traps |
| Obsidian/Notion | External, out of sync | ✅ Lives with the project |
| Custom scripts | High maintenance | ✅ Out-of-the-box |

---

## ❓ FAQ

**Q: Do I have to use MiniMax Code?**

No. Any agent that supports skill loading works (Claude Code / Cursor / Continue, etc.). All files are plain Markdown, readable in any text editor. See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for the full list.

**Q: What if my project is already in progress when I start using this?**

Fully compatible. The first activation (`bootstrap`) scans the existing project, builds the code map, and starts recording from T1. Past conversations won't be "back-filled" (the agent has no memory of them), but the code state will continue.

**Q: I started using this mid-project — can I recover the conversations I had with Claude Code / Codex?**

Yes. Find the session file (`~/.claude/projects/<project>/<session>.jsonl` or `~/.codex/sessions/<id>.jsonl`) and ask the agent to import it — it runs:

```bash
context-pocket import --file ~/.claude/projects/<project>/<session>.jsonl --dir <root>
```

It continues numbering from your current latest T, tags every imported block `[imported]`, and writes them into `log.md`. Tool noise is skipped automatically. Source type is auto-detected; force a specific source with `--source claude-code` or `--source codex`. `--limit N` caps how many turns get imported (default 100), `--truncate N` caps each field (default 400).

**Q: Will multiple users/agents conflict?**

Two different situations, and the answer is different for each:

- **Several agents on one machine** — writing at the same time is safe. Every write takes a lock
  *before* it reads the latest T and appends (`withPocketLock` in `lib/io.js`), so concurrent
  agents queue and each gets its own T-id. The lock file lives in `os.tmpdir()` keyed by the
  pocket path, so its scope is exactly one machine.
- **Several machines sharing one `ContextPocket/` through git** — still designed for **serial
  handoff**: one agent works → commits → the next pulls. Two clones writing at the same moment
  each compute `latestT + 1` from their own copy and both write, say, `T9`; after the merge
  `log.md` contains two `## T9` blocks. `verify` flags that as an error and names the fix, and
  `context-pocket repair --dry-run` → `context-pocket repair` renumbers the colliding block (and
  everything after it) back into a legal sequence, lists the prose that still names the old
  numbers, and records the move as an `[auto]` T-block. Two things it deliberately never rewrites:
  a reference has to be a standalone `T<n>`, so words that merely contain the shape (`GPT4`,
  `RTX4090`, `UTF8`) stay untouched; and attachment file names (`assets/T04-diagram.png`) are not
  references — renaming one is `mv` plus a text edit, and doing only the text half would leave a
  broken link and drop the zero-padding, so repair lists them separately with the exact `mv`
  command instead. The prose references themselves are *not* rewritten
  unless you add `--apply-refs`, because a line saying `T9` may have meant either block, and
  only a reader knows which.

Either way, sign the turn when more than one agent shares a pocket: `log append --author agent-A`
puts the writer in the block's `### Author` section. And since every append already compares the
turn against what the pocket says, a second agent contradicting the first one shows up in that
block's `### Conflicts` section prefixed `[auto]` — the disagreement becomes part of the history
instead of silently overwriting it.

**Q: What happens under tight token budgets?**

Degrade in P0→P6 priority: `log.md` always writes, `index.md` last. See SKILL.md "Per-turn rules" for details.

More questions: see [docs/FAQ.md](docs/FAQ.md).

---

## 🧩 Contributing

PRs welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

### Local development

```bash
git clone https://github.com/Wink305/ContextPocket.git
cd context-pocket
npm link                 # gives you the `context-pocket` command from this checkout
# edit templates/ or SKILL.md
# when submitting a PR, include project type + size you tested with
```

npm scripts (all zero-dependency):

| Script | Command it runs | Notes |
|--------|-----------------|-------|
| `npm run lint` | `node --check` over every `.js` file in the repo | Walks `bin/`, `lib/`, `scripts/`, root; no test runner, no glob library |
| `npm run smoke` | `node mcp-smoke.js` | Drives the MCP server over stdio. With no argument it bootstraps a throwaway pocket in your OS temp dir, isolates `CONTEXTPOCKET_HOME` there and deletes it on exit, so it runs standalone. Target a specific project with `npm run smoke -- /path/to/project` (then set `CONTEXTPOCKET_HOME=<hub-dir>` unless you want the hub writes to land in your real `~/.contextpocket`) |
| `npm test` | `node tests/run.js` | Requires the test runner under `tests/` |

### Adding a new template

Add a `.md` file under `templates/`, ensuring:
1. Placeholders wrapped in `<...>` for easy identification
2. Add a row to the "Bootstrapping from templates" table in [SKILL-advanced.md](SKILL-advanced.md)
3. Pre-fill for at least one project type

---

## 📄 License

[MIT](LICENSE) © 2024 ContextPocket Contributors

---

## 🙏 Acknowledgments

- T-block format inspired by [Conventional Comments](https://conventionalcomments.org/)
- Project born from pain points with various agent built-in memory systems
- Thanks to all contributors and early users

---

⭐ If this project helped you, a Star would be appreciated!