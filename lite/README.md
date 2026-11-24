# ContextPocket Hsi（溪）

> ContextPocket 3.1 家族的轻量版：面向小型项目与日常对话记忆，让读写更快、更简单。零依赖、零缓存、11 条命令、11 个 MCP 工具。

`context-pocket-xi` builds on the ContextPocket 3.1 family's node-based context design. It reads and writes the **exact same `ContextPocket/` folder of plain Markdown** — same T-block format, same file names, same Node schema v2 — with a smaller command surface and no derived caches. It is optimized for small projects and everyday conversation memory; the quan package keeps the broader maintenance and indexing tools for larger, longer-lived pockets.

The old package / command name `context-pocket-lite` remains an alias through 3.0 and 3.1 and is removed in 3.2.

## What it is

An AI coding session produces decisions, fixes and preferences that evaporate when the chat closes. ContextPocket records each turn as a numbered T-block (`## T7 · <gist> · [tags]`) inside a project-local `ContextPocket/` folder. Any agent or model can pick the context back up in seconds — with xi, through 11 commands:

| Command | What it does |
| --- | --- |
| `bootstrap` | Create `ContextPocket/` with exactly 5 core files (no `assets/`, no caches) |
| `status` | One-glance health: latest T, block count, mode |
| `log append` | Record a turn (User / Action / Decisions & Constraints / … sections) |
| `log amend <T-id>` | Fill sections that are missing; never overwrites existing text |
| `recall <T-id>` | Replay a turn, with optional time-window mode |
| `search <kw>` | Full scan over T-blocks, FIX, ADR, requirements, preferences (`--expand` adds graph-linked turns) |
| `why <file>` | Reverse lookup: which turns touched this file (`--expand` adds linked turns) |
| `diff <T-a> <T-b>` | Requirements, ADRs and files that changed between two turns |
| `verify` | Structure + safety health check (secret scan included) |
| `graph` | Runtime-derived link graph (turns ↔ files ↔ ADRs ↔ tags ↔ requirements, 10 edge types) — derived fresh, never cached |
| `handoff` | Write `handoff.md`: latest T, current state, recent turns, resume pointer |

The MCP server exposes the same 11 operations as tools (`context_pocket_bootstrap`, `context_pocket_status`, `context_pocket_verify`, `context_pocket_recall`, `context_pocket_search`, `context_pocket_why`, `context_pocket_diff`, `context_pocket_graph`, `context_pocket_log_append`, `context_pocket_log_amend`, `context_pocket_handoff`) — CLI and MCP are symmetric by design.

## What xi deliberately does not do

* **No caches.** Search always scans (`viaIndex: false`); graph is derived at call time and writes nothing. An xi pocket is 5 Markdown files, plus `handoff.md` if you run `handoff`.
* **No write-time conflict gate.** `log append` reports `conflictCheckSkipped: true` honestly instead of pretending to have checked.
* **No maintenance plane.** Archive, migrate, repair, sync, hub registration — those live in the quan package. A pocket outgrown by xi is a valid quan pocket; run `context-pocket-quan` against it whenever you want.
* **Version line is independent.** xi shares the 3.1 family release line but keeps its own display version (`3.1-xi`). Stable releases display two parts plus the edition suffix (`3.1-xi`); hotfix prereleases display the full string — the suffix carries meaning.
* **`log amend` only fills gaps.** It adds sections that are missing; it never overwrites content already on the block (including a recorded timestamp).

Download the [ContextPocket-3.1-xi release archive](https://github.com/Wink305/ContextPocket/releases). The ZIP contains the package files and does not involve an npm registry release.

## Install

```bash
npm install -g context-pocket-xi
```

Requires Node ≥ 14. Zero runtime dependencies.

## CLI usage

```bash
context-pocket-xi bootstrap
context-pocket-xi log append \
  --gist "搭建登录页骨架" \
  --user "帮我做一个登录页" \
  --action "创建 src/login.jsx，含表单校验" \
  --decisions "表单校验走前端，提交接口稍后接" \
  --tags login --when "2026-11-08 14:47"
context-pocket-xi log amend 1 --pitfalls "校验库体积偏大"
context-pocket-xi recall 1
context-pocket-xi search 登录 --expand 2
context-pocket-xi why src/login.jsx
context-pocket-xi diff 1 2
context-pocket-xi verify
context-pocket-xi graph --type modifies
context-pocket-xi handoff
```

Every command supports `--json` (single JSON line, no colors) and `--dir <path>` for non-`cwd` pockets. `--help` on any command prints its full option list.

## MCP usage

```json
{
  "mcpServers": {
    "context-pocket-xi": {
      "command": "context-pocket-xi-mcp"
    }
  }
}
```

Stdio transport, newline-delimited JSON-RPC, protocol versions `2025-06-18` / `2025-03-26` / `2024-11-05`. The server resolves the pocket from `process.cwd()`; run it from your project root.

## When to upgrade to quan（泉）

xi is deliberately the 5-file, 11-command, zero-cache edition. Upgrade when at least
one of these becomes true:

- **You need maintenance, not just reading.** `archive`, `migrate`, `repair`, `sync`,
  `distill`, `import`, `merge`, `hub search` live in quan.
- **The pocket is outgrowing full scans.** xi scans on every search and derives the
  graph on every call. quan keeps a search index and a graph cache for large pockets.
- **You want write-time conflict checks.** quan's `log append` runs the six-dimension
  conflict scan as part of the write; xi honestly reports `conflictCheckSkipped: true`.
- **One pocket is no longer enough.** If the project is a monorepo or several services,
  jump to **yuan** (`context-pocket-yuan`), which adds a workspace of multiple pockets,
  a repo map and budgeted context assembly on top of the same format.

### How to upgrade

1. Get the quan package (the `ContextPocket-*-quan.zip` release, or `npm link` from the
   repository root). Nothing has been published to the npm registry yet.
2. Run it against the **existing project root**:

   ```bash
   context-pocket-quan status --dir /path/to/project
   ```

3. Keep using the same command names. The old `context-pocket` alias still forwards to
   quan through 3.1 and is removed in 3.2.
4. Stop using `context-pocket-xi` in that project. There is **no migration command** and
   no data conversion step.

### What does not change

- Folder name `ContextPocket/`, every file name, the T-block schema, `format: v2`.
- Existing T / ADR / R ids, `pocket:Tn` style references, `--json` shapes.
- Nothing is copied, renamed or rewritten. quan reads an xi pocket directly.

### The one caveat

xi only reads `log.md`. If you later run quan's `archive`, those turns move to
`log-archive.md`: quan and yuan still read them, xi will not. That is a visibility
difference, not a data migration. Until you need archiving, you can move between xi
and quan freely in both directions.

## Compatibility guarantee

The shared format layer and core graph/search behavior are checked against the full package on the same pocket: both packages must derive the **identical graph** (every node, edge and temporal field, byte for byte) and the same direct search results — the compat suite asserts full-graph identity, not a shared subset. Expansion walks the same graph with the same 100-node safety cap; when the cap truncates, `search` / `why` say so (`expansionTruncated` in JSON, a visible note in human and MCP output). What remains Lite-specific is deliberately trimmed capability, not divergent semantics: no `--as-of` historical slice and single-edge `via` metadata instead of full path provenance.

## License

MIT
