---
name: ContextPocket-Yuan
description: >
  Workspace memory layer for multi-pocket projects. Adds a workspace manifest, cross-pocket
  search, a repo map, a dated cross-pocket graph with explicit and derived edges,
  budgeted context assembly, audit / recap / decay / forget / consolidate, and local
  PR/CI capture on top of the standard ContextPocket/ Markdown format.
  Per-turn recording stays in quan / xi; yuan reads and organises.
version: 3.1
format: v1
tags: [dev-tools, context, memory, workspace, repo-map, agent-handoff]
---

# ContextPocket Yuan（渊）— workspace memory

> **Skill format**: v1 (this document's layout). **Data format**: v2 — the same
> `ContextPocket/` folder and T-block schema as xi / quan. Yuan adds a workspace layer;
> it never invents a second storage format.
>
> **Companion**: [`SKILL.md`](../SKILL.md) is the per-turn recording contract (quan).
> Yuan does **not** replace it. If you are recording a turn, use quan / xi.
> This file tells you how to read, search and maintain **several pockets at once**.
>
> **Status**: 3.1 stable — 10 commands / 10 MCP tools, `edition.json` frozen.
> Still not published to npm; install from a release archive or a git clone.

---

## When to use yuan

Use yuan when at least one of these is true:

- the project has **more than one pocket** (api / web / infra / docs), or you keep
  several related repos under one workspace;
- the session needs a **budgeted handoff** ("fit the important context into 2k / 6k tokens");
- you need a **repo map** (files + top-level symbols) next to the turn log;
- you need **workspace-level cleanup**: audit, recap, decay, forget, consolidate, merge.

Do not use yuan for everyday per-turn writes. `log append`, `log amend`,
`absolute add`, `req add`, `decision add`, `state update` belong to quan / xi.
Yuan reads the files those commands produce.

---

## Execution modes

### Mode 1 · MCP (preferred)

```json
{
  "mcpServers": {
    "context-pocket-yuan": {
      "command": "context-pocket-yuan-mcp"
    }
  }
}
```

Tools (10): `context_pocket_workspace`, `context_pocket_map`, `context_pocket_context`,
`context_pocket_recap`, `context_pocket_audit`, `context_pocket_decay`,
`context_pocket_forget`, `context_pocket_consolidate`, `context_pocket_merge`,
`context_pocket_capture`.

### Mode 2 · CLI

```bash
node <skill-dir>/bin/context-pocket-yuan.js <command> [action] [options]
```

Every command accepts `--json` (one JSON line on stdout), `--dir <workspace-root>`,
and `--help`. Exit code is non-zero only when the command reports `ok: false` or
drift (verify / map verify).

### Mode 3 · Pure skill (no Node)

Read the pocket Markdown directly. Workspace features (index, repo map, cross-pocket
search) are unavailable; fall back to opening each `ContextPocket/` folder listed in
`contextpocket.workspace.json`.

If several modes are available: **MCP > CLI > pure skill**.

---

## Setup

A workspace is a directory containing `contextpocket.workspace.json`. Pockets are
registered by relative path; each pocket is a normal `ContextPocket/` folder.

```bash
context-pocket-yuan workspace init --name payments
context-pocket-yuan workspace add api ./services/api
context-pocket-yuan workspace add web ./apps/web
context-pocket-yuan workspace list
```

- Cross-pocket ids are **always qualified**: `api:T12`, `web:ADR-2`.
- A bare `T12` is refused outside single-pocket commands. Yuan never guesses a pocket.
- `workspace add` accepts a project root or a `ContextPocket/` path.

---

## Start-of-turn routine

1. **Health first, not audit.**

   ```bash
   context-pocket-yuan workspace status --json
   ```

   Read `health.index`, `health.repoMap` and `health.graph`:

   - `index.present=false` → no search cache yet; `workspace index` builds it.
   - `index.fresh=false` → a source pocket changed; the next search rebuilds automatically,
     or run `workspace index`.
   - `repoMap.present=false` → no map; `map update` builds it.
   - `repoMap` existing does not prove freshness; `map verify` reports drift.
   - `graph.present=false` → no workspace graph yet; `context build --expand 1` builds it.
   - `graph.fresh=false` → a pocket changed; the next `--expand` rebuilds only that pocket.
     `status` and `audit` never build the graph themselves.

2. **Assemble the context, do not dump the log.**

   ```bash
   context-pocket-yuan context build --query "token refresh" --max-tokens 6000
   ```

   Read **0 · Start here** first. It carries a STOP CONDITION: confirm every ❓,
   obey every 🔒, then act. Sections:

   | Section | Content | Trim order |
   |---|---|---|
   | 0 · Start here | 🔒 red lines / ❓ must-confirm / Next | never trimmed |
   | 1 · Facts | state / open requirements / ADRs / recent turns | trimmed second |
   | 2 · Related | workspace search + repo map (+ graph with `--expand`) | trimmed first |

   Every fact names its source: `api:R3 — …`, `api:ADR-2 — …`, `api:T5 — …`,
   `api — State: …`. Repo-map rows are `[api] services/api/src/login.js — …`.
   Budget trims are always printed; never pretend a trimmed section was read.

3. **Record the turn with quan / xi.** Yuan is read-mostly. After the write, the next
   `workspace search` / `context build` sees the new turn; the index refreshes by
   source mtime + size.

---

## Intent → command

| Intent | Command | Notes |
|---|---|---|
| See pockets + cache health | `workspace status` | includes index fresh/present + repo map files/symbols |
| Find a turn across pockets | `workspace search <kw>` | BM25 index; `--pocket`, `--type`, `--no-index` |
| Read one turn | `workspace recall api:T12` | qualified id only |
| Build / refresh the index | `workspace index [--rebuild]` | derived cache, safe to delete |
| Build / inspect the repo map | `map update` / `map view` | unchanged files reuse cached symbols |
| Check map drift | `map verify` | compares path + size + mtime only |
| Budgeted handoff | `context build` | see section table above |
| Cross-pocket graph neighbors | `context build --expand 1\|2` | builds/refreshes the graph cache |
| Derived cross-pocket edges | `context build --expand 2 --graph-edges all` | duplicate / shared-file / tag / near; opt-in |
| Temporal-near window | `--graph-near-days 3` | only with `--graph-edges near` |
| Graph at a past date | `context build --expand 1 --as-of 2026-11-02` | `pocket:Tn` also accepted |
| Explain the budget | `context explain` | per-section tokens + 2k/6k/12k simulation |
| Period review | `recap --since T10 --until T30` | read-only; oldest turns dropped first |
| Workspace health/activity/open items | `audit` | read-only; includes index + map drift |
| Cold-turn retention | `decay` | report only by default |
| Archive the cold prefix | `decay --apply` | same prefix semantics as `forget` |
| Archive by explicit selector | `forget --before T10` / `--before-date` / `--keep-last` | plan by default; `--apply` writes |
| Duplicate records | `consolidate` | per pocket **and** across pockets |
| Merge two pockets | `merge <source> --into <target>` | dry run by default |
| Record a PR / CI summary | `capture <file>` / `capture --pr 42` / `capture --run <id>` | local file or local gh |
| Deep check / safe repair | `workspace verify --deep` / `workspace repair --apply` | repair only rebuilds the repo map |

---

## Lifecycle contracts

### workspace graph (`--expand` / `--as-of`)

- Only explicit qualified references become edges: a `web:T1` written in a T-block
  yields `api:T5 --x-ref--> web:T1`. Bare `T5`, same-tag, shared-file and
  "close in time" guesses are **not** edges.
- The cache is `.contextpocket/workspace-graph.json`, a derived workspace cache.
  Delete it and the next `--expand` rebuilds it; pockets are never modified.
- Rebuild is per pocket: only pockets whose graph source files changed
  (`size + mtime`; log / archive / decisions / requirements / code-map / preferences)
  are re-derived. Cross-pocket edges are recomputed from cached
  `crossRefs`, so one changed pocket does not force a full re-parse.
- `--as-of` uses **WHEN dates**, never numeric T ids across pockets and never file
  mtime. `--as-of <YYYY-MM-DD>` or `--as-of <pocket>:Tn` (that turn's WHEN).
  Nodes without a date are invisible under `--as-of`.
- Derived cross-pocket edges are opt-in:

  | `--graph-edges` | Edge | Rule |
  |---|---|---|
  | `duplicate` | `duplicate-adr` / `duplicate-req` / `duplicate-pref` | same normalized ADR title / requirement text / preference key+value |
  | `shared-file` | `shared-file` | same relative path in another pocket |
  | `tag` | `same-tag` | same tag name in another pocket |
  | `near` | `temporal-near` | different pockets, shared tag/file, WHEN dates within `--graph-near-days` (default 7) |
  | `all` | all four | everything above |

  All derived edges are `weak`, default off, and require `--expand`. They are
  bounded: at most 5 pockets per key, 20 near pairs per key, 400 near pairs and
  2000 derived edges in total. The Graph section prints a `Derived:` summary and
  up to 8 example edges, so duplicate ADRs / requirements stay visible even when
  they are already seeds.
- Default `context build` output is byte-identical to 3.0: the Graph section,
  derived edges, cache writes and as-of filtering all require an explicit
  `--expand` (and `--graph-edges` for derived edges).
- `status` / `audit` only inspect graph freshness; they never build it.

### decay / forget

- Only the **oldest continuous prefix** is ever archived. No holes in the middle.
- `decay` keeps the newest `--keep-last` turns (default 50) and never recommends
  below `--min-turns` (default 10).
- `decay --apply` archives exactly the reported candidates, via quan's
  `archiveLog`; it refuses to archive every turn.
- Turns without a `WHEN` date are reported as `undated` and never aged by file mtime.
- Archived turns remain searchable: `recall` / `search` / `recap` read both
  `log.md` and `log-archive.md`.

### consolidate

- Per pocket: duplicate ADRs (same title), requirements (same text), preferences
  (same key + value). ADRs / requirements are **always manual**.
- Cross-pocket: the same ADR title / requirement text / preference key appearing
  in **two or more pockets** is reported under `crossPocket`.
- `--apply` only removes **exact duplicate preference lines inside one pocket** and
  refreshes the `index.md` count. It never deletes across pockets and never picks
  a winner for conflicting values.

### merge

- `merge <source> --into <target>` renumbers source turns, skips duplicates, and
  writes human decisions to `merge-<date>.md`. Dry run by default.
- The source pocket stays read-only.

### capture

Three local sources, one write path:

```bash
context-pocket-yuan capture pr.md --pocket api
context-pocket-yuan capture --pr 42 --pocket api
context-pocket-yuan capture --run 123456 --pocket api --repo owner/name
```

- Only the title, up to 5 bullets and the first link are written — never the whole
  body or log.
- `--pr` uses `gh pr view --json title,body,url,number,state`.
- `--run` uses `gh run view --json …` plus `gh run view --log-failed`; only the last
  few failure lines are kept.
- The captured text is scanned for credentials; error-level secrets refuse the write.
- Dry run by default; `--apply` writes the T-block.

---

## Edition modes

`--edition-mode focus | audit | migrate` only supplies **defaults**:

| Mode | Budget | Repo map | Search limit |
|---|---|---|---|
| `focus` | 1.5k | off | 5 |
| `audit` | 12k | on | 20 |
| `migrate` | 50k | on | no limit |

Explicit `--max-tokens`, `--no-repo-map`, `--limit` always win. Do not describe a
mode as a different data format; it is only a preset.

---

## Safety rules

- **Never edit pocket Markdown from yuan.** Writes go through quan / xi.
- **Default to the plan.** `decay`, `forget`, `consolidate`, `merge`, `capture` are
  dry runs until `--apply`. Read the plan out loud before applying anything destructive.
- **Never auto-delete ADRs or requirements.** They carry ids and references; yuan
  reports them for manual merging.
- **Never archive every turn.** At least one T-block must remain in `log.md`.
- **No server.** The only network-shaped step is the local `gh` CLI, and only when
  the user passes `--pr` / `--run`. If `gh` is missing or unauthenticated, stop and
  ask for a saved summary file instead of retrying blindly.
- **Secrets stay out.** `capture` refuses error-level credentials; do not paste them
  into a `--gist` or `--tags` either.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `No contextpocket.workspace.json found` | wrong directory | pass `--dir <workspace-root>` or run `workspace init` |
| `Pocket not found` / `Pocket is missing on disk` | manifest points at a moved folder | `workspace list`, then re-add; `repair` never removes pockets automatically |
| `index is stale` | a pocket changed after the last build | `workspace index` (or let search rebuild) |
| `repo map cache is missing` | never built | `map update` |
| `map verify` reports drift | files added/removed/changed | `workspace repair --apply` rebuilds the map |
| `graph cache is missing` | never used `--expand` | `context build --expand 1` builds it |
| `graph is stale` | a pocket changed after the last build | the next `--expand` rebuilds that pocket |
| `--as-of requires --expand` | as-of without expansion | add `--expand 1` or `--expand 2` |
| `--graph-edges requires --expand` | derived edges without expansion | add `--expand 1` or `--expand 2` |
| `unknown --graph-edges value` | typo in the edge list | use `duplicate`, `shared-file`, `tag`, `near` or `all` |
| `that turn has no WHEN date` | `--as-of pocket:Tn` on an undated turn | pass an explicit `YYYY-MM-DD` |
| `gh CLI not found` | gh not installed | save the PR/CI summary to a file, then `capture <file>` |
| Bare `T12` refused | cross-pocket id | use `pocket:T12` |

---

## Relationship to other editions

- **xi** — 5 files, 11 commands, zero caches. Use it for small pockets.
- **quan** — full single-pocket maintenance; owns per-turn recording.
- **yuan** — this workspace layer; reads xi/quan pockets unchanged.
- **hai** — planned collaboration edition; not part of this package.

Upgrading a pocket from xi to quan (or adding it to a yuan workspace) requires **no
data migration**: the folder name, file names and format v2 are identical. See
[`lite/README.md`](../lite/README.md) for the xi → quan exit guide.
