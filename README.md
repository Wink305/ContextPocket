# ContextPocket

> **Durable project memory for AI coding agents.** ContextPocket records the parts of a development turn that still matter tomorrow — as plain Markdown inside your repository — so the next session, the next model, or a different agent can continue from the same timeline.

**[简体中文](README.zh-CN.md)** · [Documentation](docs/) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version: 3.2 family](https://img.shields.io/badge/version-3.2%20family-blueviolet.svg)](CHANGELOG.md)
[![Pocket format: v2](https://img.shields.io/badge/format-v2-blue.svg)](docs/format-spec.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

---

## The problem

AI coding sessions are getting longer, but their memory is still short-lived:

- **Switch agents or models** — the new session starts without the context the old one had.
- **Hit the context limit** — earlier decisions, constraints and traps get compressed away.
- **Inherit an AI-assisted project** — it is hard to tell what was already done, and why.
- **Ask “why is this file like this?”** — the answer is buried in a chat log on someone else's machine.

Built-in memory is per-vendor, opaque, and often server-side. ContextPocket takes the opposite approach: **the project owns its memory, in plain text, next to the code.**

## What ContextPocket does

- Records each development turn as a `T<n>` block: what you asked, what the agent did, which files changed, what was decided, what is still uncertain.
- Keeps the living facts apart from the timeline: current state, requirements, ADRs, preferences, and 🔒 red lines.
- Generates a **handoff** view for the next session or agent.
- Connects turns ↔ files ↔ decisions, so you can ask *what happened around this turn* or *which decisions touched this file*.
- Stays readable without the tool: every file is Markdown, every id is stable, and history is append-only.

```text
agent turn
   │
   ├── ContextPocket/log.md             T12 · what happened (append-only)
   ├── ContextPocket/state.md           what is true now
   ├── ContextPocket/requirements.md    what is still open
   ├── ContextPocket/decisions.md       why it is this way
   ├── ContextPocket/absolute.md        🔒 rules that must never be lost
   └── ContextPocket/handoff.md         the next session starts here
```

No server. No database. No vendor lock-in.

---

## Choose your edition

3.2 is a family of four independent packages. They share the **same** `ContextPocket/` folder and **format v2** data, so moving between them needs no pocket migration.

| Edition | Package / command | Role | Best for | Footprint |
|---|---|---|---|---|
| **xi** | `context-pocket-xi` | Lightweight: one project, one agent, record out of the box | Small projects, scripts, quick trials | 5 core files · 11 commands / tools |
| **quan** | `context-pocket-quan` | General: the default personal memory across sessions and agents | Solo developers, long-running projects | 10 core files · 29 commands / tools |
| **yuan** | `context-pocket-yuan` | Deep work: multi-pocket workspaces and long-term audits | Complex repositories, long efforts | Stable · 10 commands / tools · workspace / repo map / search index |
| **hai** | — | Collaboration: shared memory, review and audit | Teams, multiple writers | Planned |

**Start with `quan` unless:**

- you only want a small, zero-cache log → **xi**;
- you work across several repositories or want lifecycle tools → **yuan**;
- you need team review and shared writers → wait for **hai**.

**Legacy names removed in 3.2:** `context-pocket` / `context-pocket-mcp` no longer exist; use `context-pocket-quan` / `context-pocket-quan-mcp`. The lite aliases `context-pocket-lite` / `context-pocket-lite-mcp` are gone too; use `context-pocket-xi` / `context-pocket-xi-mcp`.

### Download

`main` tracks the 3.2 family. Each archive contains its own `package.json`, README and license; **no npm registry release is involved** — install from a GitHub Release archive or a git clone.

| Edition | Display version | Release / archive |
|---|---|---|
| **quan** | `3.2-quan` | [ContextPocket-3.2-Quan](https://github.com/Wink305/ContextPocket/releases/tag/ContextPocket-3.2-Quan) · `ContextPocket-3.2-Quan.zip` |
| **xi** | `3.2-xi` | [ContextPocket-3.2-Xi](https://github.com/Wink305/ContextPocket/releases/tag/ContextPocket-3.2-Xi) · `ContextPocket-3.2-Xi.zip` |
| **yuan** | `3.2-yuan` | [ContextPocket-3.2-Yuan](https://github.com/Wink305/ContextPocket/releases/tag/ContextPocket-3.2-Yuan) · `ContextPocket-3.2-Yuan.zip` |
| **hai** | Planned | — |

Previous stable releases: [`2.13`](https://github.com/Wink305/ContextPocket/releases/tag/2.13) · [`2.13-lite`](https://github.com/Wink305/ContextPocket/releases/tag/2.13-lite).

---

## Quick start

### 1. Get the code

```bash
git clone https://github.com/Wink305/ContextPocket.git
cd ContextPocket
```

Or download and extract the archive for the edition you chose.

### 2. Install one entry point

**CLI (recommended for developers)** — from the cloned/extracted folder:

```bash
npm link
context-pocket-quan help
```

`npm link` registers the canonical command plus its legacy aliases. The package has **never been published to the npm registry**; `npm install -g context-pocket-quan` is intentionally not available yet — use a clone or a Release archive.

**No install** — call the script directly:

```bash
node /path/to/ContextPocket/bin/context-pocket.js status --dir /path/to/your/project
```

**Skill folder only** — copy the folder into your agent's skills directory:

```bash
cp -r . ~/.cursor/skills/context-pocket-quan/
```

**MCP** — point your client at the stdio server:

```json
{
  "mcpServers": {
    "context-pocket-quan": {
      "command": "node",
      "args": ["/absolute/path/to/ContextPocket/mcp-server.js"]
    }
  }
}
```

If you used `npm link`, `"command": "context-pocket-quan-mcp"` with `"args": []` works too.

### 3. Activate

In a project without a `ContextPocket/` folder, the configured agent offers to initialize one on the first substantive turn. From the CLI:

```bash
context-pocket-quan bootstrap --dir /path/to/your/project
```

`bootstrap` auto-detects the project type, scans the tree, copies templates, and pre-fills `code-map.md` / `state.md`. It is idempotent, so running it again re-registers the project without touching history.

### 4. Work normally

The agent records each turn. No slash commands, no extra step.

When you switch agents or models, the new session reads:

```text
ContextPocket/index.md
```

or asks for a fresh handoff:

```bash
context-pocket-quan handoff --dir .
```

---

## A typical day

| You want to… | The agent runs | What you get |
|---|---|---|
| Start in a new project | `bootstrap` | Pocket ready, auto-recording on |
| See where things stand | `status` | T-range, open requirements, ADRs, ❓, archive state |
| Resume in another agent | `handoff` | `handoff.md` with red lines, must-confirm items, next steps |
| Find an earlier turn | `search <keyword>` | Matching T-blocks / ADRs / requirements / preferences |
| Know who changed a file | `why <path>` | Turns that changed it, then turns that only mention it |
| Inspect one turn **and its surroundings** | `recall T<n> --with-context` | The turn, its references, later changes to the same files |
| Check the pocket is healthy | `verify` | 15 checks; credential shapes block the commit hook, PII warns |
| Fix a missing section | `log amend <Tn>` | Filled only where content is missing, never overwritten |
| Mark a rule that must survive | `absolute add` | A 🔒 entry that is never compressed |
| Merge another machine's pocket | `merge --from <path> --dry-run` | A reviewable merge report before anything is written |

The full intent → command map lives in [SKILL.md](SKILL.md).

---

## The editions in depth

### xi — record first, stay small

- 5 core Markdown files, 11 commands / MCP tools.
- Search always scans the Markdown; graph and index are derived on read — no cache to maintain.
- Best when the pocket should stay tiny and the agent only needs a reliable timeline.

More: [lite/README.md](lite/README.md).

### quan — the default personal memory

- 10 core files, 29 commands / MCP tools.
- Sourced multi-hop graph: `search <kw> --expand 2`, `why <file> --expand 2`, and `--as-of <T>` historical slices.
- Knowledge notes: `distill --knowledge` builds K candidates from explicit Pitfalls / Uncertain / Decisions plus tag or file anchors; `--apply` writes `knowledge.md` as drafts, `--activate` promotes after review. `search --type K` finds them; `graph` shows `k:K1` with `derived-from` edges.
- Search index, graph cache (`graph/4`), handoff budgets, merge reviews, hub registry, isolation, and the Git safety net.
- `--edition-mode solo|agent` changes the interaction style, not the data.

More: [SKILL.md](SKILL.md) · [SKILL-advanced.md](SKILL-advanced.md) · [SKILL-reference.md](SKILL-reference.md).

### yuan — long-running workspaces (stable)

- Registers several pockets in `contextpocket.workspace.json` and keeps cross-pocket ids qualified (`api:T12`).
- `workspace status` reports index, repo-map and workspace-graph health without running `audit` first.
- `map` scans JS/JSX/TS/TSX/Python into a repo map; unchanged files reuse cached symbols by size + mtime, and `map verify` compares metadata only.
- `context build` / `explain` assemble a budgeted view from red lines, facts and related material; every fact names its pocket (`api:T5`, `api:R3`, `[api] src/login.js`).
- `context build --expand 1|2` adds cross-pocket graph neighbors from explicit `pocket:Tn` references (`Path: api:T5 → x-ref → web:T9`); `--as-of <date|pocket:Tn>` slices the graph by WHEN date. The derived graph lives in `.contextpocket/workspace-graph.json` and rebuilds only changed pockets.
- `--graph-edges duplicate|shared-file|tag|near|all` opts into derived cross-pocket edges (same ADR/req/preference, shared path, same tag, or temporally near turns); all are weak, bounded and off by default.
- Knowledge base: `workspace knowledge build|apply|list|view|verify` writes `knowledge/K-*.md` from cross-pocket evidence; plans by default, writes drafts unless `--activate`, and leaves duplicates / conflicts for humans. `context build` includes active K notes in Related (`--no-knowledge` disables), and `workspace status` / `audit` report K health.
- Lifecycle: `recap`, `audit`, `decay` (`--apply` archives the reported prefix), `forget`, `consolidate` (per pocket and cross-pocket), `merge`, `capture` (local file or local `gh pr view` / `gh run view`).
- `--edition-mode focus|audit|migrate` provides budget presets; explicit flags always win.
- Stable API: 10 commands / 10 MCP tools, `edition.json` frozen. Still not published to npm; use the release archive or a git clone.

More: [lang/README.md](lang/README.md) · [lang/SKILL.md](lang/SKILL.md).

### hai — shared memory for teams (planned)

The repository carries a private skeleton only; there is no installable command yet. The intended scope is shared writers, review, and audit on top of the same v2 pocket format.

---

## Core workflows

### Handoff

`handoff` writes a three-tier resume card:

- **0 · Start here** — red lines, must-confirm items, next steps. Never trimmed.
- **1 · On demand** — decisions, pitfalls, open requirements.
- **2 · Pointers** — where to read more.

`handoff --max-tokens <N>` trims only the optional parts and records what was dropped.

### Verify, drift, repair

```bash
context-pocket-quan verify            # files, ids, refs, index, 🔒, secrets, attachments
context-pocket-quan verify --drift    # + cognition drift / code newer than the last record
context-pocket-quan repair --dry-run  # inspect id collisions before renumbering
```

`verify` never guesses. A credential-shaped string is an error and blocks the commit hook; personal data is a warning. `repair` renumbers colliding T-ids, lists prose that still names an old id, and only rewrites references with `--apply-refs`.

### Search and relationships

```bash
context-pocket-quan search token --expand 2 --as-of T40
context-pocket-quan search token --rank bm25
context-pocket-quan why src/auth.js --expand 2
context-pocket-quan recall T12 --with-context
context-pocket-quan graph --type file
```

- `search` / `recall` share the same time-window vocabulary: `--since` / `--until` / `--from` / `--to`.
- `search --rank bm25` is an opt-in ordering: the hit set is unchanged, only the order is scored by BM25. The default field-weight order is untouched.
- `why` separates **changed** from **mentioned only**, so `--limit` drops weak evidence first.
- Graph context is sourced and derived; Markdown remains the source of truth.

### Merge two machines or agents

```bash
context-pocket-quan merge --from /path/to/other/ContextPocket --dry-run
context-pocket-quan merge --from /path/to/other/ContextPocket
```

One-way and read-only on the source. Turns are renumbered; ADRs, requirements, 🔒 red lines and non-conflicting preferences are merged. `state.md`, `code-map.md` and conflicts go to `merge-<date>.md`; code-map suggestions list files that exist in the target but differ. `merge report --apply <id>` replays the safe review items: requirement status, preferences, source-only state lines, and **missing** code-map descriptions (files already in the target tree without a real description). Code-map descriptions that already differ stay manual.

### Long-term lifecycle (yuan)

```bash
context-pocket-yuan workspace init
context-pocket-yuan workspace add api ../api
context-pocket-yuan context build --query "token refresh"
context-pocket-yuan context build --query "token refresh" --expand 1 --as-of 2026-11-02
context-pocket-yuan context build --query "token refresh" --expand 2 --graph-edges all
context-pocket-yuan recap --since T40
context-pocket-yuan audit
context-pocket-yuan decay --max-age-days 180
context-pocket-yuan forget --before T20 --apply
```

`forget` archives the oldest prefix only; `--apply` is required to write. Archived turns remain searchable and recallable. `decay` is read-only and prints the exact `forget` command it suggests.

### Isolated runs

Three switches, strongest last:

| Switch | How |
|---|---|
| Env var | `CONTEXTPOCKET_ISOLATED=1 context-pocket-quan ...` |
| Marker file | create `.contextpocket-isolate` in the project root |
| Physical | move `ContextPocket/` out of the project |

While isolated, every CLI command and MCP tool is refused before a pocket file is opened. `status` only reports the isolation state.

---

## What lives in the pocket

```text
project-root/
└── ContextPocket/
    ├── readme.md          project identity + format version
    ├── index.md           lightweight index
    ├── state.md           current state, next steps, pitfalls
    ├── requirements.md    R-ids with implementation references
    ├── preferences.md     development preferences
    ├── decisions.md       ADRs
    ├── code-map.md        module / file map
    ├── log.md             append-only T-block timeline
    ├── log-archive.md     archived turns
    ├── absolute.md        🔒 never-compressed rules
    ├── handoff.md         generated resume card
    ├── config.md          optional configuration
    └── assets/            search index, graph cache, archived attachments
```

A minimum T-block:

```markdown
## T12 · Refresh token rotation · [api] [security]
--- WHEN: 2026-11-22 10:30 ---

### User
- Rotate refresh tokens on every use.

### Action
- src/auth/refresh.js — issue a new token and revoke the old one.
- tests/auth/refresh.test.js — cover reuse detection.

### Decisions & Constraints
- Reuse detection is required by the security review.
```

`### User` and `### Action` are required; the other sections are written when they have something to say. The `--- WHEN: … ---` line records when the turn happened — a day-only value stays `(day)`, and stated wording is kept verbatim.

Full format: [docs/format-spec.md](docs/format-spec.md).

---

## Privacy & security

- The pocket is **plain-text Markdown**; no executable code, no network calls, no upload.
- `ContextPocket/` is added to `.gitignore` by default at bootstrap (opt out with `--gitignore false`).
- `verify` scans for credential and PII shapes; vendor-shaped keys block the commit hook.
- 🔒 `absolute.md` is discipline-based, not encryption; it prevents compression, not a deliberate filesystem read.
- Isolated runs keep experiments and CI from polluting real history.

See [SECURITY.md](SECURITY.md) for the supported versions and vulnerability reporting.

---

## Compatibility and migration

| From | To | Action |
|---|---|---|
| `2.13` | `3.2-quan` | Same pocket format; switch command names. |
| `2.13-lite` | `3.2-xi` | Same lightweight model; command names change. |
| `context-pocket` | `context-pocket-quan` | Alias removed in 3.2; install and call the quan name. |
| `context-pocket-lite` | `context-pocket-xi` | Alias removed in 3.2; install and call the xi name. |
| v1 pocket | v2 pocket | Run `migrate --to latest`; `verify` warns until you do. |

All editions read and write format v2. Switching editions does not copy, convert or lock the pocket.

More: [docs/MIGRATION.md](docs/MIGRATION.md) · [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) · [docs/FAQ.md](docs/FAQ.md).

---

## Command index

`quan` exposes 29 CLI commands; each has an MCP equivalent and accepts `--json`. This is the complete index — every entry supports `--help` for flags and examples.

```bash
context-pocket-quan bootstrap --help
context-pocket-quan install-hook --help
context-pocket-quan uninstall-hook --help
context-pocket-quan verify --help
context-pocket-quan sync --help
context-pocket-quan status --help
context-pocket-quan recall --help
context-pocket-quan diff --help
context-pocket-quan search --help
context-pocket-quan why --help
context-pocket-quan graph --help
context-pocket-quan check-conflicts --help
context-pocket-quan log append --help
context-pocket-quan log amend --help
context-pocket-quan absolute add --help
context-pocket-quan req add --help
context-pocket-quan decision add --help
context-pocket-quan state update --help
context-pocket-quan preferences update --help
context-pocket-quan code-map update --help
context-pocket-quan handoff --help
context-pocket-quan index --help
context-pocket-quan distill --help
context-pocket-quan import --help
context-pocket-quan merge --help
context-pocket-quan hub --help
context-pocket-quan archive --help
context-pocket-quan repair --help
context-pocket-quan migrate --help
```

`xi` exposes 11 of these under `context-pocket-xi` (no index/graph cache). `yuan` exposes its own 10 under `context-pocket-yuan`.

---

## Contributing

PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the release checklist and local development.

```bash
npm run lint       # syntax-check every JS file
npm test           # full test suite
npm run smoke      # MCP stdio smoke test
npm run smoke-live # real CLI end-to-end smoke test
npm run bench      # 10 pockets × 1000 turns: search / context / audit latency
```

The four editions share a byte-identical core under `shared/`; `node scripts/sync-core.js` is the drift gate.

## License

[MIT](LICENSE) © 2024 ContextPocket Contributors

## Acknowledgments

- T-block format inspired by [Conventional Comments](https://conventionalcomments.org/)
- Built from the pain points of agent built-in memory systems
- Thanks to every contributor and early user

---

⭐ If ContextPocket helps you keep a project coherent, a Star is appreciated.
