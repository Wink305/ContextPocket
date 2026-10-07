---
name: ContextPocket
description: >
  Persist complete per-turn dev context into <project-root>/ContextPocket/ so any AI agent
  can restore full understanding. Auto-records requirements, code changes, decisions, pitfalls,
  and preferences — activates on its own, with no commands for the user to type or remember.
  Supports cross-agent handoff, model switches, and long-running projects.
version: 1.2.0
format: v1
tags: [dev-tools, context, memory, productivity, agent-handoff]
---

# ContextPocket — cross-agent dev-context sync

> **Skill format**: v1 — this document's own layout version. Not the data format: `ContextPocket/readme.md` says `format: v2` for newly created pockets, and v1 folders upgrade with `context-pocket migrate --to latest` ([docs/MIGRATION.md](./docs/MIGRATION.md)). · **For**: AI coding agents (MiniMax Code, Claude Code, Cursor, etc.) · **See**: README.md for human-facing overview
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
- **Search auto-uses the index** (`ContextPocket/assets/search-index.json`). The index is a derivable cache — you can delete it at any time and `context-pocket index --rebuild` (CLI) or `context_pocket_index` (MCP) will rebuild it. A search with no index (missing, corrupt, stale, or written by an older index format) **rebuilds it on the spot and still answers from it**; it only falls back to a full scan when even that fails. `--no-index` (MCP `noIndex: true`) is the deliberate scan — same matches, same order. On `log append` / `log amend` the same flag means the other end of the cache: skip the *refresh* after that write — the next search rebuilds it and finds the turn anyway, so bulk re-logging loops can use it safely.
- **User-level hub** (`~/.contextpocket/hub.json`, or `$CONTEXTPOCKET_HOME/hub.json` where `CONTEXTPOCKET_HOME` is the *directory* that holds it): a tiny cross-project registry that records which projects have ContextPocket + global preferences. **All hub operations are best-effort**: a hub failure (network, missing dir) must never block / break ContextPocket writes in the project itself. Each project's `ContextPocket/` is always self-sufficient. `bootstrap` is the only command that writes there; `noHub: true` (CLI `--no-hub`) skips that one write — use it for throwaway/temporary directories and CI runs, and leave it off for projects the user actually works in, since `hub list` and MCP project resolution rely on the entry.

---

## Execution modes (auto-detected)

The Skill auto-detects which mode is available and falls back gracefully. Always check for `bin/context-pocket.js` and `mcp-server.js` next to this file.

### Mode 1: MCP mode (best reliability)
- Configure your agent to load `mcp-server.js` from the Skill directory.
- All writes go through MCP tools (`context_pocket_*`). Never manually edit markdown files.
- Tools cover: `bootstrap`, `status`, `verify`, `sync`, `log_append`, `log_amend`, `absolute_add`, `recall`, `diff`, `search`, `why`, `check_conflicts`, `state_update`, `preferences_update`, `code_map_update`, `req_add`, `decision_add`, `handoff`, `archive`, `migrate`, `repair`, `install_hook`, `uninstall_hook`, `index`, `distill`, `import`, `hub` (27 tools).
- `search` takes a `noIndex` boolean — there is **no** separate `search_no_index` tool.

### Mode 2: CLI mode (good reliability)
- Script path: `<skill-dir>/bin/context-pocket.js`
- Invoke: `node <skill-dir>/bin/context-pocket.js <command> --dir <project-root>`
- All commands are subcommands (`log append`, `state update`, etc.). Use `--json` for machine-readable output — including `help --json`, which returns the whole command table as `{groups:[{group,commands:[{command,summary}]}]}` (that list is the same 27 the MCP server registers). Use `--no-index` on `search` to skip the index cache.

### Mode 3: Pure skill mode (compatibility fallback)
- Manually write the markdown files following the rules in **Per-turn rules** + **Pre-reply safety hook**.
- No tool enforcement — you are the enforcement. The T-number check and 3-question self-check are your safety net.
- Suitable when neither Node.js nor MCP is available (e.g. closed-environment agents).

If multiple modes are available, **prefer MCP > CLI > Pure Skill** in that order.

---

## Quick responses (triggered by intent — no slash commands)

> **There are no ContextPocket slash commands.** Users talk to the agent in natural language; the agent infers intent and calls the right tool. This is deliberate: short command names like `/verify`, `/import`, `/diff`, `/search` collide with agent built-ins, and forcing users to memorize a command table is friction with no payoff.
>
> **Rule: never tell the user to "type /xxx".** If the user asks how to use this skill, answer inline. If they say `/openpocket` or any other slash name out of habit, treat it as the nearest intent below and just do it.

| What the user says (any phrasing) | What the agent does | One-line reply |
|---|---|---|
| First time in a project · "开始记一下" · "给我建个记录" · "接手这个项目" | `bootstrap` (idempotent) | `✅ ContextPocket ready, auto-recording on` |
| "现在什么情况" · "进度到哪了" · "什么状态" | `status` | one-line summary |
| "这条记成红线" · "绝不能改 X" · "这个必须保留" | `absolute add` | `✅ written to absolute.md — never compressed` |
| "交接一下" · "我要换模型了" · "把这个交给别人" | `handoff` | `✅ handoff.md generated` |
| "查一下有没有漏" · "提交前检查一下" · "健康吗" | `verify` | pass / or a list of issues **each with a runnable fix command** |
| "代码是不是改了没记" · "没进 git 的项目也能查漏了吗" | `verify` with `drift: true` (`--drift`) | warning naming the files whose mtime is later than the last record (works without git; never blocks a commit) |
| "补一下 T7" · "刚才漏了用户那句话" | `log amend` | `✅ T7 filled: User` |
| "这文件谁改的" · "为什么长这样" | `why <path>` | matching turns, split by evidence: `[changed]` (in that turn's Action) vs `[mentioned only]` (Uncertain / Attachments / Conflicts — talked about, not modified) |
| "上次那个 bug 怎么修的" · "搜一下 X" | `search <kw>` | matching T-blocks |
| "T7 当时说了什么" · "回看一下那轮" | `recall T<n>` | the full T-block |
| "T5 到 T9 变了啥" | `diff Ta Tb` | the delta |
| "有什么待确认的" · "有没有我不确定的" | read `❓` lines directly (no tool) | the list, then "逐条确认吗?" |
| "有没有前后矛盾" | `check-conflicts` | severity-ranked result |
| "log.md 里有两个 T9" · "两个 Agent 写的号撞了" · "合并之后编号乱了" | `repair` (`--dry-run` first, MCP: `context_pocket_repair`) | the renumber plan + the list of prose still naming an old id. Never hand-edit the numbering and never `git commit --no-verify` around it — see SKILL-advanced.md「并发与撞号（多 Agent）」 |
| "git 有没有漏记的" | `sync` (`--auto` to write) | "补了 N 个" |
| "把旧会话导进来" | `import` | "导入了 N 轮" |
| "把旧的提炼一下" | `distill` | report written; **agent then judges + merges by hand** |
| "导出给同事" | agent writes the snapshot file itself (no tool) | the file path |
| "重新开始" | `archive --keep-last N`, then rebuild | **confirm with the user first** |
| "这玩意儿怎么用" | answer inline from this table + `docs/FAQ.md` — **never** reply "see README.md" |

> Bare names above are the CLI subcommand (`context-pocket <name>`) and the MCP tool (`context_pocket_<name>`) for the same capability. Prefer MCP > CLI > pure-skill, per Execution modes.

### Activation

No command to run. Activation is automatic:

- **Project has no `ContextPocket/`** → offer to `bootstrap` on the first substantive turn.
- **Project already has `ContextPocket/`** → read `index.md` + `state.md` before doing anything, then keep recording. This is the model-switch path (see Cross-agent handoff).
- **Both** → say it in one line, then get to work. Never make setup a prerequisite for answering the user.

---

## Per-turn rules (once ContextPocket is active)

> **⚠️ Pure Skill Mode Enforcement — READ BEFORE EVERY TURN**
>
> In Pure Skill mode, the agent writes files manually. The biggest failure mode is **forgetting to append under token pressure**. The following rules are **NOT optional suggestions** — they are the enforcement mechanism that keeps the log from going stale. Treat them as non-negotiable.

### Mode-specific write behavior

**In MCP mode:** use MCP tools for ALL writes. Never manually edit markdown files.
- Append log → `context_pocket_log_append`
- Fill a half-written turn → `context_pocket_log_amend`
- Add 🔒 red line → `context_pocket_absolute_add`
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
- `log append` / `log amend` / `absolute add` / `req add` / `decision add` / `handoff` / `state update` / `preferences update` / `code-map update` / `archive` / `verify`

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
- Meta-conversation about ContextPocket itself (e.g. "这玩意儿怎么用")

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
   - **In CLI/MCP mode the scan is part of the write**: `log append` runs the same 6-dimension check on the block it is about to save and writes what this turn **newly** collides with into that block's `### Conflicts`, prefixed `[auto]` (MCP: same, unless you pass `conflictCheck: false`). So do **not** copy those findings in yourself — they would be recorded twice. Do add what only a reader can see (API-shape changes, business-semantic contradictions) via `--conflicts`; your own lines stay first, verbatim.
   - `context-pocket check-conflicts` / `context_pocket_check_conflicts` is still the command for the **whole-pocket** picture (existing contradictions, not just this turn's). And if an append answers `conflictCheckSkipped` or a `conflictCheckError` (`⚠️ 本轮没做冲突检查…`), that turn went in unchecked — run the scan then, and tell the user it was not the tool that checked it.
2. **Append** one complete block to `log.md` (P0). **MUST be done before the reply is sent.**
   - **Write ONLY this turn's content.** Omit every empty subsection (no attachments this turn → no `### Attachments`; no commits → no `### Commits`; etc.). **Never carry over the previous block's sections, filenames, or ❓/🔒 items into the new block** — a stray section from the prior block is a bug, not style.
   - Insert session divider if the date changed.
   - Save attachments → `assets/`. Reference in block.
   - **Action bullet format: `<操作> <文件路径> — <做了什么>`** (em-dash separator). Example: `修改 src/auth/session.ts — 修复登录 500 的空指针`
     - This format is not cosmetic. `context-pocket sync` (the git safety net) and `context-pocket why` read file paths out of Action lines: a path in **Action** is strong evidence that this turn touched that file. Files the parser cannot see there are treated as **unrecorded**, so every commit re-creates a redundant `[auto]` T-block.
     - One bullet may name several files: `新增 src/a.ts、src/b.ts — 补齐导出`. The parser also picks up bare paths anywhere in an Action line, so prose like `新增 src/login.ts 并改了 config.js` still counts as covered.
     - A path that only appears **outside** Action (`### Decisions` / `### Uncertain` / `### Attachments` / `### Conflicts` …) is weak evidence: `sync` still counts the file as unrecorded, and `why` labels that turn `[mentioned only]` instead of `[changed]`. So never rely on another section to record an edit — if you changed it, name it in Action; if you only plan to, `### Uncertain` is the right place (and `sync` will point you at it so you can `log amend` that turn instead of accepting an `[auto]` block).
   - Record commits in `### Commits` if any.
   - **Sign the turn when more than one agent writes into this pocket**: `log append --author "agent-A"` (MCP: `author`) puts the writer in a `### Author` section. If nobody told you who is recording, omit it — the tool never guesses a name, and an unsigned block is not a defect. `log amend <T> --author` can only add the section where it is missing; it will not replace an author already on that block.
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
     - **In CLI mode:** `context-pocket absolute add --text "<user's words>" [--gist "<short>"]`
     - **In MCP mode:** `context_pocket_absolute_add`
     - **In pure skill mode:** write the `## 🔒 T<n> · <gist>` block into `absolute.md` directly.
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
   - Yes → done. **No / unsure → do it, don't skip.** If genuinely token-starved, keep P0 (`log.md`) and defer the rest, then tell the user "这轮只记了一半，回头补齐" — and actually fill it in on the next turn.

**MUST-rules:**
- When in doubt, **write**. An over-recorded block is cheap; a missing turn is a broken handoff.
- **Always pass the user's own words when appending.** `log append` without `--user` produces a T-block that `verify` reports as an ERROR, and the pre-commit hook blocks commits on errors. In MCP mode, pass `user`. If a turn was already appended without it, fix it immediately with `log amend <Tn> --user "..."` / `context_pocket_log_amend` — never leave it, and never hand-edit `log.md`.
- **Pass `--when` only when the user said a different time.** In v2 pockets `log append` stamps the moment you record (`--- WHEN: 2026-10-03 14:47 ---`, `recall` shows it, `--json` returns the verbatim line). If the turn actually happened earlier, pass `--when "2026-10-03 09:00 → 11:30"` (MCP: `when`). Only a day is known → `--when "2026-10-03"` (stores `(day)`, never a fake `00:00`). The user's own words → `--when "上周三下午"` (stored verbatim, never computed). Nothing known → omit the flag; the tool will not guess, and it will not invent a time from file mtimes. Never hand-edit the line: `log amend <T> --when` adds a missing one or replaces a day-only one, and refuses to overwrite a moment that was already recorded — for that, append `## T<n>-fix`. A `format: v1` folder gets no time line at all until the user runs `context-pocket migrate --to latest` (`verify` says so in one WARNING, and the hook never blocks on it); if you passed `--when` there anyway, the T-block is still recorded (log is P0) and the tool answers with the reason — `whenSkipped` in `--json` — so read it instead of assuming the time landed. A time line whose value is `undefined` (`--- WHEN: undefined → undefined ---`, or one endpoint `undefined`) is a 1.1.0 writer defect, not something the user said: `verify` reports it as an ERROR, so delete that line and re-record with `log amend <T> --when "2026-05-01 → 2026-05-03"` (amend only fills lines that are missing, which is why the bad line has to go first). Day-only ranges are legal since this release — `--when "2026-05-01 → 2026-05-03"` stores both endpoints as dates. Only lines the tool cannot have written are flagged: a genuine `--- WHEN: stated: … ---` quote stays untouched even if the user literally said the word "undefined", because an ERROR blocks `archive`, `migrate` and the pre-commit hook and the user's verbatim words must not be what stops them.
- If a turn clearly couldn't be recorded, say so in one line: `"这轮 ContextPocket 只记了一半，下一轮我补齐"` — then do it.
- **The agent MUST NOT respond to the next user message until missing T-blocks are appended.**
- **The agent MUST append at least the T-block (P0) even if token budget is nearly exhausted.** Defer P1-P6 if needed, but P0 is non-negotiable.
- **Never record a credential verbatim — including in a 🔒 entry.** When the user pastes an error containing a key/token, `verify` reports it as an ERROR (`secret-leak`), the pre-commit hook then blocks the commit, and `archive`/`migrate` refuse to run while any error exists. Quote the sentence around it and leave the value out ("报错原文：401 using <Anthropic key，已略> 调用失败"). This deliberately does *not* apply to `absolute add`: a 🔒 entry is by definition the user's exact words, so the tool never rewrites text — a pocket that is *supposed* to hold such a string (a key-rotation runbook) sets `- secret_scan: false` in `config.md` instead. Scan output only ever shows a masked prefix (`sk-ant…(30 chars)`) because your own tool output gets copied into the next T-block.
- **Never do arithmetic on the user's numbers.** You don't have the full picture, so a stated quantity is data you record, not a counter you maintain. When the user says "本地起 3 个 worker" and later "其中一个改成 5 个", `state.md` gets the new sentence quoted in `log.md` and the *stated* value written — never `3 - 1 + 5 = 7`. Same for counts of endpoints, tests, deps, or TODOs: only update a number when the user states a number. Deductions ("he said two of the three are done, so one is left") belong in `### Uncertain`, phrased as an inference, not in `state.md`.
- **Never archive on your own initiative.** `archive_at` is a *warning* threshold, not a trigger: `status` says "archive is due" and `verify` emits a `log-size` warning once `log.md` passes it. When you see it, tell the user in one line and offer `archive`; moving history is their call (the tool refuses to archive while `verify` has errors, and rolls back if the post-archive check fails).
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
  7. Open `log.md` / `handoff.md` for recent history. Use `search` / `recall T<n>` / `diff Ta Tb` to find specifics.
  8. Open `assets/` for referenced files.
  9. **Before acting on any ❓ item → ask user to confirm** (the agent reads the `❓` lines directly).
  10. Say in one line that ContextPocket is active and recording, then continue the work. Run `verify` before any formal handoff.
- **Serial handoff only.**
