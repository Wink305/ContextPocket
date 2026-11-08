---
name: ContextPocket Lite
description: >
  Persist per-turn dev context into <project-root>/ContextPocket/ with the lightweight
  edition of ContextPocket 2.0's node-based context design. Optimized for small projects
  and everyday conversation memory: 8 commands / 8 MCP tools, zero caches, zero dependencies.
  Same pocket format as the full package — a Lite pocket can be handed to the full
  package at any time for archive / migrate / repair / index / hub.
version: 2.1.0-Lite-preview
format: v2
tags: [dev-tools, context, memory, productivity, agent-handoff, lite]
---

# ContextPocket Lite — 轻量跨 Agent 开发上下文同步

> **Skill format**: v2 · **For**: AI coding agents (MiniMax Code, Claude Code, Cursor, etc.) · **For humans**: [README.md](./README.md)

Persist per-turn dev context into `<project-root>/ContextPocket/` so any AI agent can restore understanding. Lite builds on ContextPocket 2.0's node-based context design and shares its schema; it is optimized for small projects and everyday conversation memory, with simpler and lighter read/write paths. It keeps the format layer byte-identical to the full package and cuts derivable or maintenance-heavy features: no search index, no graph cache, no hub, no conflict engine, and no maintenance commands.

---

## Usage boundary

ContextPocket does NOT store secrets, credentials, or production data — it stores **dev context** (what was done, why, what's locked in).

- **What to record:** every substantive turn (new requirement, code change, decision, preference, pitfall).
- **What NOT to record:** tokens, secrets, production data, build artifacts.
- **Secret scan is a safety floor and stays on** (`verify` runs it even in Lite): if a key-shaped string lands in the pocket, `verify` reports it as ERROR. Never "fix" that by deleting the check — replace the value with a placeholder.
- **Who reads it:** any AI agent in the project, including future model switches. A new model with zero conversation memory MUST re-read `ContextPocket/` before touching the project.

---

## Execution modes (auto-detected)

Check for `bin/context-pocket-lite.js` and `mcp-server-lite.js` next to this file.

### Mode 1: MCP mode (best reliability)
- Configure your agent to load `mcp-server-lite.js` from the Skill directory (stdio, JSON-RPC).
- 8 tools: `context_pocket_bootstrap`, `context_pocket_status`, `context_pocket_verify`, `context_pocket_recall`, `context_pocket_search`, `context_pocket_why`, `context_pocket_graph`, `context_pocket_log_append`.
- Never manually edit markdown files while a tool exists for the job.

### Mode 2: CLI mode (good reliability)
- Script path: `<skill-dir>/bin/context-pocket-lite.js`
- Invoke: `node <skill-dir>/bin/context-pocket-lite.js <command> --dir <project-root>`
- Use `--json` for machine-readable output — including `help --json`, which returns the whole command table as `{groups:[{group,commands:[{command,summary}]}]}` (that list is the same 8 the MCP server registers).

### Mode 3: Pure skill mode (compatibility fallback)
- Manually write the markdown files following the T-block spec below.
- No tool enforcement — you are the enforcement.

If multiple modes are available, **prefer MCP > CLI > Pure Skill** in that order.

---

## The 8 commands

| Command | Key options | Notes |
| --- | --- | --- |
| `bootstrap` | `--language zh\|en`, `--project-type`, `--gitignore false` | Creates exactly 5 files; refuses to overwrite an existing pocket |
| `status` | — | Latest T, block count, mode |
| `log append` | `--gist` (required), `--user`, `--action`, `--result`, `--verify-section`, `--tags`, `--files`, `--when`, `--no-verify` | The only write command. Gist must be text. `--verify` runs a verify pass after the write (default on) |
| `recall <T-id>` | `--with-context`, `--since-t/--until-t`, `--from/--to`, `--limit` | Window mode replays a time range instead of one turn |
| `search <kw>` | `--since-t/--until-t`, `--from/--to`, `--limit`, `--offset` | Always a full scan; `viaIndex` is always `false`. Results are page-shaped (`total`, `hasMore`) |
| `why <file>` | `--limit` | Which turns changed / mentioned this file |
| `verify` | `--quiet` | 7 checks: file existence, T-id continuity, T-block format, header T, implausible ids, log size, secret leaks. Errors block commits; warnings do not |
| `graph` | `--type`, `--limit` | Runtime-derived link graph. `derived: runtime`, zero cache files. No rebuild/verify subcommands — there is no cache to manage |

**Not in Lite** (they live in the full package): `log amend`, `req`/`decision`/`absolute`/`preference` writers, `sync`, `diff`, `check-conflicts`, `code-map update`, `state update`, `handoff`, `archive`, `migrate`, `repair`, `install-hook`, `index`, `distill`, `import`, `hub`. To fix a mistake in an existing T-block, edit `log.md` directly — Lite has no amend.

---

## Per-turn rules

1. **Before working**: read `ContextPocket/log.md` (or run `status` + `recall` on the latest turns). If the pocket doesn't exist, run `bootstrap`.
2. **After each substantive turn**: `log append` with at minimum `--gist`, `--user`, `--action`. A T-block missing its `User` or `Action` section is a verify ERROR — fill it in the same turn, by hand if needed.
3. **`--when` is the timestamp line.** Omit it and the block gets no `--- WHEN: ---` line; time-window recall/search will then skip that turn. Give at least a date (`2026-11-08`).
4. **`--files` on Action** is what makes `why` and `graph` work. List every file the turn touched.
5. **`log append` does not conflict-check in Lite** (the return says `conflictCheckSkipped: true`). If two agents write concurrently, renumbering is manual: Lite only reads and appends, `repair` lives in the full package.
6. **Log size**: `verify` warns as `log.md` approaches `archive_at`. Archiving is a full-package operation — Lite never moves history on its own.

---

## Pocket layout (5 files, format v2)

```
ContextPocket/
  log.md        # T-blocks: '## T7 · <gist> · [tags]' + WHEN line + sections
  index.md      # file → what it is (one line per file)
  state.md      # current state: latest T, focus, locked decisions
  code-map.md   # project structure tree + per-file purpose
  readme.md     # project identity: format version, mode, language
```

T-block skeleton (v2 — the WHEN line is mandatory for new blocks):

```markdown
## T7 · 搭建登录页骨架 · [login]
--- WHEN: 2026-11-08 14:47 ---

### User
- 帮我做一个登录页

### Action
- 创建 src/login.jsx，含表单校验

### Result
- 组件就位，可渲染

### Verify
- npm test 通过
```

No `assets/` directory ever exists in a Lite pocket. If you see one, the full package has operated on this pocket — that's fine, both packages interoperate on the same format.

---

## Upgrade path

A Lite pocket **is** a full-package pocket. When a project needs archives, search index, conflict gate, requirement/ADR tracking or multi-machine repair: install `context-pocket`, point it at the same directory, and run `context-pocket migrate --to latest` if the readme says an older format. Nothing to convert by hand.
