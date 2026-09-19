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

1. **Install** — drop the folder into your agent's skill directory
2. **Activate** — run `/openpocket` at the project root
3. **Work normally** — the agent auto-records; run `/openpocket` again to resume on a new agent

---

## 🚀 Quick Start

### 1. Install

Three modes available — auto-detected, no extra config needed.

| Mode | Requirements | Reliability | Best for |
|------|-------------|-------------|----------|
| **MCP mode** | MCP-compatible agent (Trae, Claude Desktop) | ⭐⭐⭐⭐⭐ 10/10 | Best experience |
| **CLI mode** | Node.js 14+ (zero extra deps) | ⭐⭐⭐⭐ 9.5/10 | Most developers |
| **Skill-only** | Nothing, just the folder | ⭐⭐⭐⭐ 8/10 | Compatibility fallback |

Drop the folder into your agent's skill directory:

```bash
# MiniMax Code / Claude Code / similar
~/.minimax/skills/context-pocket/

# Cursor / Continue / IDE plugins
~/.cursor/skills/context-pocket/
```

**For MCP mode:** add this to your MCP config:

```json
{
  "mcpServers": {
    "context-pocket": {
      "command": "node",
      "args": ["path/to/context-pocket/mcp-server.js"]
    }
  }
}
```

See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for the full list of supported agents.

### 2. Activate

In any project root, tell the agent:

```
/openpocket
```

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

When switching agents or models, in the new session say:

```
/openpocket
```

Or even more directly:

```
Read ContextPocket/index.md
```

New agent is up and running in 5 seconds.

---

## 📚 Core Commands

| Command | What it does |
|---------|--------------|
| `/openpocket` | **Activate** — turn on auto-recording, create/restore `ContextPocket/` |
| `/statuspocket` | One-line status: current T-number, open reqs, ❓ count |
| `/putintopocket` | Save previous turn **verbatim** to the 🔒 absolute-keep area |
| `/recall T<n>` | View the complete record of one turn |
| `/diff T<a> T<b>` | Compare what changed between two turns |
| `/searchpocket <keyword>` | Search all context for a keyword |
| `/questions` | List all pending ❓ items |
| `/check-conflicts` | Scan all context for potential conflicts (6 dimensions, severity-ranked) |
| `/handoff` | Generate single-file handoff summary `handoff.md` |
| `/verify` | Pre-handoff health check: files present, no broken refs |
| `/sync` | Git safety net: detect staged changes unrecorded in recent T-blocks, auto-fill `[auto]` T-block |
| `/sync --auto` | Agent mode: auto-fill directly (hook invokes with `--auto` by default) |
| `/digest` | Distill: scan archive + old turns, extract still-valid decisions / pitfalls / preferences into a `digest-<date>.md` report |
| `/import <jsonl>` | Import a past agent session (claude-code / codex / auto) into log.md, tagged `[imported]` |
| `/exportpocket` | Export full snapshot file, shareable with teammates |
| `/resetpocket` | Archive old data, rebuild empty context |
| `/help` | Show help (default: brief; `/help all` for full menu) |

> 💡 For your first project, you only need to remember `/openpocket` and `/help`. Look up the rest as needed.

For detailed help on any command, just type `/help <command-name>` — the agent will explain it inline.

---

## 💻 CLI Commands (Node.js Required)

All commands below work via CLI when Node.js 14+ is available. Pass `--dir <project-root>` to target a project.

| Command | What it does |
|---------|--------------|
| `context-pocket bootstrap --dir <root>` | Auto-detect project type, scan tree, copy templates, pre-fill code-map & state |
| `context-pocket verify --dir <root>` | Full health check: files, refs, index consistency, 🔒 integrity |
| `context-pocket verify --drift --dir <root>` | Add cognition drift check (log.md vs working tree, AOCI-style). Add `--drift-last-n <N>` to tune lookback |
| `context-pocket status --dir <root>` | One-line summary (T-range, reqs, ADRs, ❓, archive status) |
| `context-pocket recall <T-id> --dir <root>` | View full details of one T-block |
| `context-pocket diff <Ta> <Tb> --dir <root>` | Compare two turns: req changes, ADR additions, file changes |
| `context-pocket search <keyword> --dir <root>` | Full-text search across all T-blocks (gist, tags, notes). Auto-uses the `assets/search-index.json` index; pass `--no-index` to fall back to a full scan |
| `context-pocket why <file-path> --dir <root>` | Reverse lookup: which T-blocks mentioned this file? (Inspired by ThoughtDAG) |
| `context-pocket check-conflicts --dir <root>` | 6-dimension conflict scan with severity (critical / warning / info) |
| `context-pocket log append --dir <root> --gist "..." --tags "..."` | Append one T-block to log.md |
| `context-pocket req add --dir <root> --text "..."` | Add a requirement (auto-assigns next R-id) |
| `context-pocket decision add --dir <root> --title "..."` | Add an ADR |
| `context-pocket handoff --dir <root>` | Generate handoff.md summary |
| `context-pocket state update --dir <root> --summary "..."` | Update current state |
| `context-pocket preferences update --dir <root> --key "..." --value "..."` | Update a preference |
| `context-pocket code-map update --dir <root>` | Rescan project directory, update code-map.md |
| `context-pocket archive --dir <root> [--keep-last N] [--dry-run]` | Archive old T-blocks with verify → archive → verify → rollback |
| `context-pocket migrate --dir <root> [--to v<N>] [--dry-run] [--list]` | Format migration with backup + rollback |
| `context-pocket sync --dir <root> [--auto] [--dry-run] [--last-n <N>] [--quiet]` | Git safety net: detect staged changes unrecorded in recent T-blocks (hook uses `--auto`) |
| `context-pocket install-hook --dir <root>` | Install Git pre-commit hook (v2: auto-fill missed → verify, two-step) |
| `context-pocket uninstall-hook --dir <root>` | Remove our pre-commit hook, preserve other hooks |
| `context-pocket index --dir <root> [--rebuild]` | Build / refresh the search index (`assets/search-index.json`). Markdown files are always the source of truth; the index is a derived cache |
| `context-pocket distill --dir <root> [--dry-run]` | Distill old turns: emit a `digest-<date>.md` report listing decisions / pitfalls / preferences worth merging back into the living docs (inspired by Basic Memory) |
| `context-pocket import --dir <root> --file <session.jsonl> [--source auto\|claude-code\|codex]` | Import a past agent session as `[imported]` T-blocks so a mid-stream adoption doesn't lose history |
| `context-pocket hub [list\|pref\|remove] --dir <root>` | User-level hub: list registered projects / read+write global prefs / unregister this project |
| `context-pocket help` | Show all commands |

> 💡 In MCP mode, each CLI command has an equivalent MCP tool (e.g. `context_pocket_bootstrap`).

---

## 📋 Use Cases

| Scenario | Pain point | How ContextPocket solves it |
|----------|-----------|------------------------------|
| Switch agent platforms | New agent knows nothing | Read `ContextPocket/` and continue |
| Switch model versions | Conversation history disappears | Same — data is model-agnostic |
| Long session token overflow | History gets compressed/lost | Critical content is already on disk |
| Multi-agent collaboration | Agents have inconsistent state | Share one `ContextPocket/` |
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
    ├── handoff.md         # Handoff summary (generated on /handoff)
    ├── config.md          # Optional: custom configuration
    ├── pocket-snapshot-*.md  # Snapshot files (max 3 kept)
    └── assets/
        ├── search-index.json   # Search index (auto-generated, safe to delete + rebuild)
        └── archive/            # Archived attachments (moved here on archive)
```

### T-block example

```markdown
## T5 · User confirmed database choice · [requirement-change] [arch-decision]

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

On `/openpocket`, the agent asks (or auto-detects) project type and pre-fills different fields:

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
- mode: full                  # full = 12 files; lite = 5 core files only
- archive_at: 800             # log.md line count that triggers archiving
- recent_keep: 30             # how many recent full T-blocks to keep on archive
- language: en                # recording language (zh / en / follow user)
- quiet: true                 # true = one-line confirmation per turn
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

Fully compatible. `/openpocket` scans the existing project, builds the code map, and starts recording from T1. Past conversations won't be "back-filled" (the agent has no memory of them), but the code state will continue.

**Q: I started using this mid-project — can I recover the conversations I had with Claude Code / Codex?**

Yes. Find the session file (`~/.claude/projects/<project>/<session>.jsonl` or `~/.codex/sessions/<id>.jsonl`) and run:

```
/import ~/.claude/projects/<project>/<session>.jsonl
```

It continues numbering from your current latest T, tags every imported block `[imported]`, and writes them into `log.md`. Tool noise is skipped automatically. Source type is auto-detected; force a specific source with `--source claude-code` or `--source codex`.

**Q: Will multiple users/agents conflict?**

ContextPocket is designed for **serial handoff**: one agent works → saves → hands off → next reads. Two agents should NOT write simultaneously.

**Q: What happens under tight token budgets?**

Degrade in P0→P6 priority: `log.md` always writes, `index.md` last. See SKILL.md "Per-turn rules" for details.

**Q: Can I use it without slash commands?**

Yes, but you'll lose much of the automation. Saying "read ContextPocket/" still loads it for the agent. But slash commands trigger the full workflow.

More questions: see [docs/FAQ.md](docs/FAQ.md).

---

## 🧩 Contributing

PRs welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

### Local development

```bash
git clone https://github.com/Wink305/ContextPocket.git
cd context-pocket
# edit templates/ or SKILL.md
# when submitting a PR, include project type + size you tested with
```

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