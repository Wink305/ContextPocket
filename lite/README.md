# ContextPocket Lite

> ContextPocket 2.0 的轻量版：面向小型项目与日常对话记忆，让读写更快、更简单。零依赖、零缓存、8 条命令、8 个 MCP 工具。

`context-pocket-lite` builds on ContextPocket 2.0's node-based context design. It reads and writes the **exact same `ContextPocket/` folder of plain Markdown** — same T-block format, same file names, same Node schema v2 — with a smaller command surface and no derived caches. It is optimized for small projects and everyday conversation memory; the full package keeps the broader maintenance and indexing tools for larger, longer-lived pockets.

## What it is

An AI coding session produces decisions, fixes and preferences that evaporate when the chat closes. ContextPocket records each turn as a numbered T-block (`## T7 · <gist> · [tags]`) inside a project-local `ContextPocket/` folder. Any agent or model can pick the context back up in seconds — with Lite, through 8 commands:

| Command | What it does |
| --- | --- |
| `bootstrap` | Create `ContextPocket/` with exactly 5 core files (no `assets/`, no caches) |
| `status` | One-glance health: latest T, block count, mode |
| `log append` | Record a turn (User / Action / Result / Verify sections) |
| `recall <T-id>` | Replay a turn, with optional time-window mode |
| `search <kw>` | Full scan over T-blocks, FIX, ADR, requirements, preferences |
| `why <file>` | Reverse lookup: which turns touched this file |
| `verify` | Structure + safety health check (secret scan included) |
| `graph` | Runtime-derived link graph — derived fresh, never cached |

The MCP server exposes the same 8 operations as tools (`context_pocket_bootstrap`, `context_pocket_status`, `context_pocket_verify`, `context_pocket_recall`, `context_pocket_search`, `context_pocket_why`, `context_pocket_graph`, `context_pocket_log_append`) — CLI and MCP are symmetric by design.

## What Lite deliberately does not do

* **No caches.** Search always scans (`viaIndex: false`); graph is derived at call time and writes nothing. A Lite pocket is 5 Markdown files, full stop.
* **No write-time conflict gate.** `log append` reports `conflictCheckSkipped: true` honestly instead of pretending to have checked.
* **No maintenance plane.** Archive, migrate, repair, amend, hub registration — those live in the full package. A pocket outgrown by Lite is a valid full-package pocket; run `context-pocket` against it whenever you want.
* **Version line is independent.** Lite starts at `2.0.0` (displayed as `2.0-lite`), versioned separately from the full package.

## Install

```bash
npm install -g context-pocket-lite
```

Requires Node ≥ 14. Zero runtime dependencies.

## CLI usage

```bash
context-pocket-lite bootstrap
context-pocket-lite log append \
  --gist "搭建登录页骨架" \
  --user "帮我做一个登录页" \
  --action "创建 src/login.jsx，含表单校验" \
  --result "组件就位，可渲染" \
  --tags login --files src/login.jsx --when 2026-11-08
context-pocket-lite recall 1
context-pocket-lite search 登录
context-pocket-lite why src/login.jsx
context-pocket-lite verify
context-pocket-lite graph
```

Every command supports `--json` (single JSON line, no colors) and `--dir <path>` for non-`cwd` pockets. `--help` on any command prints its full option list.

## MCP usage

```json
{
  "mcpServers": {
    "context-pocket-lite": {
      "command": "context-pocket-lite-mcp"
    }
  }
}
```

Stdio transport, newline-delimited JSON-RPC, protocol versions `2025-06-18` / `2025-03-26` / `2024-11-05`. The server resolves the pocket from `process.cwd()`; run it from your project root.

## Compatibility guarantee

The format layer (parser, WHEN lines, constants, io) is kept byte-identical to the full package, and the repo's cross-test suite locks it: `deriveLinks`, `buildContext` and scan-path search results must be `deepStrictEqual` between Lite and the full package on the same pocket. If they ever diverge, the test fails before anything ships.

## License

MIT
