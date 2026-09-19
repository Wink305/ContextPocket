---
name: ContextPocket
description: >
  Persist complete per-turn dev context into <project-root>/ContextPocket/ so any AI agent
  can restore full understanding. Auto-records requirements, code changes, decisions, pitfalls,
  and preferences. Supports cross-agent handoff, model switches, and long-running projects.
version: 1.0.0
format: v1
tags: [dev-tools, context, memory, productivity, agent-handoff]
---

# ContextPocket — cross-agent dev-context sync

> **Skill format**: v1 · **For**: AI coding agents (MiniMax Code, Claude Code, Cursor, etc.) · **See**: README.md for human-facing overview
>
> This `SKILL.md` is the daily-read **main file**. Two companion files split off the bulk:
> - [`SKILL-advanced.md`](./SKILL-advanced.md) — Bootstrapping, Project type templates, Archiving, Edge cases（含版本迁移）。Open when you hit a template / project type / archive question.
> - [`SKILL-reference.md`](./SKILL-reference.md) — Full Layout + per-file templates + log.md T-block spec + filled example + config.md fields. Open when you need an exact field format / template content.

Persist **complete** per-turn dev context into `<project-root>/ContextPocket/` so any AI agent can restore full understanding. Agent-agnostic. Completeness first.

---

## Usage boundary

ContextPocket does NOT store secrets, credentials, or production data — it stores **dev context** (what was done, why, what's locked in). Use it as a project-local memory layer, not as a database.

- **What to record:** every substantive turn (new requirement, code change, conflict, decision, preference, pitfall, attachment).
- **What NOT to record:** tokens, secrets, production data, build artifacts, transient logs.
- **Who reads it:** any AI agent in the project, including future model switches. Markdown is the only truth source so it's agent-agnostic.
- **When a model switches** (e.g. Sonnet → Opus, or different vendor): the new model has zero conversation memory. It **MUST** re-read `ContextPocket/` before touching the project. This is the only way cross-model continuity works.
- **Search auto-uses the index** (`ContextPocket/assets/search-index.json`). The index is a derivable cache — you can delete it at any time and `context-pocket index --rebuild` (CLI) or `context_pocket_index` (MCP) will rebuild it. Search without `--no-index` / without `context_pocket_search_no_index` falls back to a slower full scan if the index is missing.
- **User-level hub** (`~/.contextpocket/` or `$CONTEXTPOCKET_HOME/hub/`): a tiny cross-project registry that records which projects have ContextPocket + global preferences. **All hub operations are best-effort**: a hub failure (network, missing dir) must never block / break ContextPocket writes in the project itself. Each project's `ContextPocket/` is always self-sufficient.

---

## Execution modes (auto-detected)

The Skill auto-detects which mode is available and falls back gracefully. Always check for `bin/context-pocket.js` and `mcp-server.js` next to this file.

### Mode 1: MCP mode (best reliability)
- Configure your agent to load `mcp-server.js` from the Skill directory.
- All writes go through MCP tools (`context_pocket_*`). Never manually edit markdown files.
- Tools cover: `log_append`, `state_update`, `preferences_update`, `code_map_update`, `req_add`, `decision_add`, `handoff`, `archive`, `verify`, `check_conflicts`, `search`, `search_no_index`, `index`, `distill`, `import`, `hub`.

### Mode 2: CLI mode (good reliability)
- Script path: `<skill-dir>/bin/context-pocket.js`
- Invoke: `node <skill-dir>/bin/context-pocket.js <command> --dir <project-root>`
- All commands are subcommands (`log append`, `state update`, etc.). Use `--json` for machine-readable output. Use `--no-index` on `search` to skip the index cache.

### Mode 3: Pure skill mode (compatibility fallback)
- Manually write the markdown files following the rules in **Per-turn rules** + **Pre-reply safety hook**.
- No tool enforcement — you are the enforcement. The T-number check and 3-question self-check are your safety net.
- Suitable when neither Node.js nor MCP is available (e.g. closed-environment agents).

If multiple modes are available, **prefer MCP > CLI > Pure Skill** in that order.

---

## Commands

> **Full command list** (all 19 commands + `/help` menu + smart language routing). Each command name maps 1:1 to a CLI subcommand and an MCP tool.

### `/openpocket`
Enable auto-save for this project. Idempotent. Creates `ContextPocket/` from `templates/` (see `SKILL-advanced.md` Bootstrapping for the copy strategy; full templates in `SKILL-reference.md`). Detects existing format version and prompts for migration if needed.

### `/putintopocket`
Manually record one substantive turn (use when /openpocket is not active). Triggers a single log append + code-map refresh.

### `/sync` (Git safety net + manual catch-up)
- **Git safety net**: in MCP/CLI mode, commit pending ContextPocket changes so they survive a session crash.
- **Manual catch-up**: in Pure Skill mode, use this when you suspect a turn was missed. It walks recent conversation windows and backfills missing T-blocks.

### `/statuspocket`
One-line health summary (T range, R counts, ADR count, last verification, search index mtime).

### `/diff <Ta> <Tb>` (what changed between two turns, read-only)
Diffs requirements / state / decisions between two T-ids. Useful before applying an old handoff.

### `/recall <Tn>` (fetch one turn, read-only)
Returns the full T-block. Use to revisit a specific turn's decisions and pitfalls without reading the whole log.

### `/questions` (collect all open ❓ items)
Lists every `❓` line across `requirements.md`, `state.md`, and recent T-blocks. Always ask the user to confirm before acting on these.

### `/check-conflicts`
Scans all 6 conflict dimensions (stack / requirement / ADR / naming / deployment / API). Reports ⚠️ items, marks old entries `(superseded by T<n>)`, prompts user for adjudication.

### `/handoff`
Generates `handoff.md` (concise summary for the next agent / model). Use before model switch, end of session, or before a long absence.

### `/verify` (pre-handoff health check)
Validates file integrity (T-number continuity, references valid, file size sane) before a formal handoff. Returns ⚠️ list.

### `/searchpocket <keyword>`
Full-text + tag search. Auto-uses `assets/search-index.json` if present (rebuilt lazily). Use `--no-index` (CLI) or `context_pocket_search_no_index` (MCP) to force a slow full scan.

### `/digest` (distill old content back into the living docs)
Run on `log-archive.md` (or any markdown inside `ContextPocket/`) to generate a **read-only** distill report (`ContextPocket/.distill-report.md`). The agent then:
1. Reads the report section by section.
2. Judges each item against current requirements / decisions / pitfalls.
3. **Manually merges** the keepers into `state.md` / `requirements.md` / `decisions.md` / `absolute.md`.
4. Deletes the report when done.

**Hard rule**: the distill command only writes the report. It never touches the live docs. The agent does the merging.

### `/import <session.jsonl>` (backfill past agent conversations)
Import a JSONL session log (claude-code / codex auto-detected by file shape). Dry-run by default; `--apply` to write. Imported T-blocks are tagged `[imported]` so future agents know the provenance. Run after `/openpocket` if you want this turn recorded too.

### `/exportpocket`
Generates a single `pocket-snapshot-<date>.md` (concatenation of all current files). Keep latest 3; older ones auto-removed on next `/exportpocket`.

### `/resetpocket`
**Destructive.** Wipes `ContextPocket/` after user confirmation. Does NOT touch the project source. Use only when starting fresh.

### `/help` (分类菜单导航 — 像 CLI 分层帮助)
Main menu + category navigation, like a CLI's `--help` with sub-menus.

The default reply is the **main menu** (ASCII frame with the 8 categories). Agent also accepts natural language: "怎么用"→`/help`、`"还有什么功能"`→`/help all`、`"出问题了"`→`/help 8`、`"T 编号是什么"`→`/help 6` 等。**Never** respond with "see README.md" — 始终内联回答。

`/help` 的回复由 Agent 根据上面"主菜单 / 分类简要说明 / 完整命令列表 / 单命令详细说明"的规则**内联生成**，直接引用本文件 **Commands** 区（`### /openpocket` …）与 `docs/FAQ.md` 的对应条目即可，不要再外跳到其他模板文件。

---

## Per-turn rules (after `/openpocket`)

> **⚠️ Pure Skill Mode Enforcement — READ BEFORE EVERY TURN**
>
> In Pure Skill mode, the agent writes files manually. The biggest failure mode is **forgetting to append under token pressure**. The following rules are **NOT optional suggestions** — they are the enforcement mechanism that keeps the log from going stale. Treat them as non-negotiable.

### Mode-specific write behavior

**In MCP mode:** use MCP tools for ALL writes. Never manually edit markdown files.
- Append log → `context_pocket_log_append`
- Add requirement → `context_pocket_req_add`
- Add decision → `context_pocket_decision_add`
- Generate handoff → `context_pocket_handoff`
- Update state → `context_pocket_state_update`
- Update preferences → `context_pocket_preferences_update`
- Update code-map → `context_pocket_code_map_update`
- Archive → `context_pocket_archive`
- Verify → `context_pocket_verify`

**In CLI mode:** use CLI commands for ALL writes. Never manually edit markdown files.
- Script path: `<skill-dir>/bin/context-pocket.js`
- Invoke: `node <skill-dir>/bin/context-pocket.js <command> --dir <project-root>`
- `log append` / `req add` / `decision add` / `handoff` / `state update` / `preferences update` / `code-map update` / `archive` / `verify`

**In pure skill mode:** manually write files following all rules below. This is the baseline.

---

### What counts as a substantive turn (triggers append)

**Substantive** = at least one of:
- ≥ 2 sentences of new information
- Involves code, requirements, decisions, or file operations
- States a constraint, preference, or requirement
- Provides an attachment

**NOT substantive** (skip append):
- Pure acknowledgment: "好的" / "继续" / "ok" / "嗯" / "yes" / "go ahead"
- Repeating a previous question
- Meta-conversation about ContextPocket itself (e.g. "how do I use /putintopocket")

If the turn is NOT substantive → do nothing to ContextPocket files, consume no T-number. Move on.

### Per-turn update priority (when token budget is tight, degrade in this order)

| Priority | File | Rule |
|----------|------|------|
| **P0 — MUST always** | `log.md` | **必须追加。不能跳过。** 即使 token 耗尽，P0 优先于任何其他输出。 |
| **P1 — MUST if files changed** | `code-map.md` | 有文件新增/修改/删除时必须更新。 |
| **P2 — if state changed** | `state.md` | 状态/运行方式/环境/坑点有变化时更新。 |
| **P3 — if requirements changed** | `requirements.md` | 需求 open/done/cancelled/❓/impl 有变化时更新。 |
| **P4 — if major decision made** | `decisions.md` | 有重大架构/技术决策时新增 ADR。 |
| **P5 — if preferences changed** | `preferences.md` | 偏好有变化时更新。 |
| **P6 — last** | `index.md` | 更新 T 范围、计数、文件指针。 |

Token 不够时从 P6 往下降级，**P0 永远不能跳过**。

### Steps

1. **Conflict check** (before writing): compare this turn's info against current `requirements.md` / `state.md` / `decisions.md` / recent T-blocks for directional contradictions. If found → plan a `### Conflicts` section + mark old items `(superseded by T<n>)` + one-line user reminder.
   - **In CLI/MCP mode:** after writing, run `context-pocket check-conflicts` (or `context_pocket_check_conflicts`) to scan all 6 dimensions.
2. **Append** one complete block to `log.md` (P0). **MUST be done before the reply is sent.**
   - **Write ONLY this turn's content.** Omit every empty subsection (no attachments this turn → no `### Attachments`; no commits → no `### Commits`; etc.). **Never carry over the previous block's sections, filenames, or ❓/🔒 items into the new block** — a stray section from the prior block is a bug, not style.
   - Insert session divider if the date changed.
   - Save attachments → `assets/`. Reference in block.
   - Action bullets must specify file paths + operation type.
   - Record commits in `### Commits` if any.
3. **Update** files in priority order (P1→P6):
   - **Read old content before overwriting.** Preserve still-valid entries.
   - `code-map.md`: update Structure (add/remove/modify entries, `reqs:` links), Recently Changed, Key Relationships.
     - **In CLI/MCP mode:** run `context-pocket code-map update --dir <project-root>` to auto-rescan and preserve existing descriptions.
   - `state.md`: update Summary / Next Steps / How to Run / Environment / **Pitfalls**.
     - **In CLI/MCP mode:** run `context-pocket state update --summary "..." --next-step "..." --pitfall "..."`.
   - `requirements.md`: add (next R-id) / complete / cancel / confirm ❓ items; update `impl:` lists.
   - `decisions.md`: new ADR if a non-trivial decision was made this turn.
   - `preferences.md`: add/modify preference lines.
     - **In CLI/MCP mode:** run `context-pocket preferences update --key "<key>" --value "<value>"`.
   - `index.md`: update T range, item counts, file pointers.
4. **Strong-requirement detection**:
   - Triggers: `必须` / `一定` / `绝不允许` / `不能改` / `务必` / `MUST` / `NEVER` / strong emphasis / **equivalent in any language**.
   - **Semantic filter — only prompt for 🔒 when it is an architecture / tech / code "red-line" constraint**, e.g. "must use X library", "never use ORM", "do NOT change the API shape", "keep this file as-is". These are the constraints a future agent must not silently violate.
   - **Do NOT prompt** for pure schedule / scope / process emphasis, e.g. "must ship by Friday", "this is urgent", "prioritize this feature". These are time/scope, not architectural red-lines → record normally in log/state, no 🔒 prompt.
   - When in doubt about category, **ask the user to confirm whether it's a red-line** rather than auto-prompting.
   - On `yes` → append 🔒 to `absolute.md` (verbatim).
   - **Never auto-mark.**
5. **Quiet**: respect `config.md quiet` — true = max one short confirmation line; false = brief per-file report.

### Pre-reply safety hook (the anti-forgetting check) — MUST RUN BEFORE EVERY SUBSTANTIVE REPLY

Because every command above relies on the agent following this prose, the biggest failure mode is **forgetting to append under token pressure or after a long turn**. This hook is the safety net:

#### Step 1: Turn-start T-number check (Pure Skill mode only)

**Before processing any user message in Pure Skill mode, run this check:**

1. Read `log.md` and find the **current latest T-number** (e.g. `T12`).
2. Read the **current conversation window** — does it contain any substantive content (user request, agent reasoning, code changes)?
3. **If the conversation window has substantive content BUT the latest T-number is NOT newer than what was recorded at the start of this conversation window → the previous turn was NOT appended.** This is a MISSING T-block.
   - **MUST** append the missing turn(s) immediately.
   - **MUST** inform the user: `"⚠️ 检测到 T{n} 未记录，正在补档……"` before continuing.
   - **MUST NOT** proceed with the current request until the missing block is appended.
4. **If this is the first turn of a new conversation** (no prior substantive content in window) → no action needed for this check.

> **Why this check matters**: In Pure Skill mode, without MCP/CLI enforcement, the agent may skip appending when distracted or token-pressured. The T-number comparison catches this reliably because the conversation window preserves evidence of what was discussed.

#### Step 2: Pre-reply 3-question self-check

**After processing the current turn and BEFORE sending the reply, run this check (silently, no user-facing output):**

1. **Did this turn change anything?** new code / requirement / decision / preference / attachment / a strong "must" statement?
   - Yes → **MUST** append the T-block to `log.md` (P0) **before** sending the reply.
2. **Does code-map need it?** files created/modified/deleted this turn?
   - Yes → **MUST** update `code-map.md` now, not "later".
3. **Are the priority files consistent?** state / requirements / decisions / index reflect this turn?
   - Yes → done. **No / unsure → do it, don't skip.** If genuinely token-starved, keep P0 (`log.md`) and defer the rest, then recommend `/sync`.

**MUST-rules:**
- When in doubt, **write**. An over-recorded block is cheap; a missing turn is a broken handoff.
- If a turn clearly couldn't be recorded, tell the user in the Quiet line: `"(ContextPocket 本轮未记全，稍后可 /sync)"`.
- **The agent MUST NOT respond to the next user message until missing T-blocks are appended.**
- **The agent MUST append at least the T-block (P0) even if token budget is nearly exhausted.** Defer P1-P6 if needed, but P0 is non-negotiable.
- This hook makes auto-save **explicit** rather than purely memory-based — the agent re-checks itself instead of trusting it "remembered".

---

## Corrections

- Never edit a previous T-block. Append `## T<n>-fix · <what> · [correction]`.
- Reference: `Corrects T<a>: <said X, actually Y>`.
- Update `state.md` / `requirements.md` / `code-map.md` / `decisions.md` to reflect correction.

---

## Cross-agent / model-switch handoff

A **model switch** is a handoff: the new model has no conversation memory and must re-read `ContextPocket/` first (see Usage boundary).

- New agent / new model flow:
  1. Sees `ContextPocket/readme.md` in project root (project identity card at a glance).
  2. Reads `index.md` → knows which files to open.
  3. **Drift check**: compare `code-map.md` with actual directory tree. Update code-map if stale.
  4. **First read: `code-map.md`** (understands what the project is and where everything is).
  5. Then `state.md` (current situation + how to run + environment + **pitfalls — read these carefully**).
  6. Then `requirements.md` + `preferences.md` + `decisions.md` (what to do, how the user wants it, what's locked in).
  7. Open `log.md` / `handoff.md` for recent history. Use `/searchpocket <词>` / `/recall T<n>` / `/diff Ta Tb` to find specifics.
  8. Open `assets/` for referenced files.
  9. **Before acting on any ❓ item → ask user to confirm** (`/questions` lists them all).
  10. If agent supports ContextPocket → `/openpocket` to enable auto-save; run `/verify` before a formal handoff.
- **Serial handoff only.**