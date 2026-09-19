# ContextPocket Skill — Reference

> 纯参考资料。`SKILL.md` 是日常必读主体，本文件汇集所有需要"精确字段定义 / 完整模板注释 / CLI 参数表"的细节，方便 Agent 按需查阅。

---

## Layout

```
ContextPocket/
├── readme.md         # entry point + format version + project identity
├── config.md         # optional settings (defaults shown below)
├── index.md          # lightweight file map + T range (~20 lines)
├── state.md          # state + next steps + how to run + environment + pitfalls
├── requirements.md   # open / done / cancelled / ❓ (R-ids, impl files)
├── preferences.md    # dev preferences
├── decisions.md      # ADR: major architecture decisions with rationale
├── code-map.md       # DETAILED file/module map
├── absolute.md       # 🔒 never trimmed
├── log.md            # append-only timeline
├── log-archive.md    # (created when log.md > archive_at lines)
├── handoff.md        # (generated on /handoff)
├── pocket-snapshot-<date>.md  # (generated on /exportpocket, keep latest 3)
└── assets/
    └── archive/
```

### readme.md
```markdown
# ContextPocket · format: v1
> project: <name> · <one line: what this project does> · stack: <tech, e.g. Express+PostgreSQL+TS> · type: <frontend|backend|fullstack|data|mobile> · stage: <prototype/dev/production>

Read `index.md` to find all files. Quick resume: read `handoff.md` (if exists).
If you support this skill: type `/openpocket` to enable auto-save.
Model switch? Re-read ContextPocket/ before touching the project — the new model has no memory.
```
> The `>` line is the **project identity card**: any agent scanning the project root learns what the project is at a glance. Update when stack/stage/type changes.

### config.md — template (optional; defaults apply when absent)
```markdown
# Config
- project_type: <frontend|backend|fullstack|data|mobile>   # 决定预填模板
- mode: full               # full = 全套 12 文件；lite = 只建核心 5 个（readme/state/code-map/log/index），其余用到才建
- archive_at: 800            # log.md 超过多少行触发归档
- recent_keep: 30            # 归档时保留最近多少个完整 T 块
- language: zh               # LOG/INDEX 记录语言（zh / en / follow user）
- quiet: true                # true = 每轮最多一行确认；false = 详细报告
- gitignore: true            # true = .gitignore 加入 ContextPocket/ 忽略；false = 让 pocket 进 git 跨设备同步
- tags_default: [需求变更, 代码逻辑, 架构决策, Bug, 偏好, 依赖, 测试, UI, API, 部署, 文档, 坑点, 冲突, correction]
```
> If `config.md` is missing or unreadable → use defaults and note it in one line. User can edit it anytime; the agent picks up changes on the next `/openpocket`.
>
> **标签语言**：标签语言与 `language` 配置一致。
> - `language: zh` → 中文标签（需求变更, 代码逻辑, 架构决策, Bug, 偏好, 依赖, 测试, UI, API, 部署, 文档, 坑点, 冲突, correction）
> - `language: en` → 英文标签（requirement-change, code-logic, arch-decision, bug, preference, dependency, test, ui, api, deploy, docs, pitfall, conflict, correction）
> - 标签列表在 `tags_default` 中可自定义

> **Lite mode** (`mode: lite` in `config.md`): only create the **5 core files** on bootstrap:
> - `readme.md`, `state.md`, `code-map.md`, `log.md`, `index.md`
> - `requirements.md`, `preferences.md`, `decisions.md`, `absolute.md` are created **on demand** — the first time the agent actually needs that category.
> - This is ideal for small/script projects where the full 12-file layout is overkill.
> - **Even in Lite mode, all per-turn MUST-rules still apply** (T-number check, P0 append, etc.). The only difference is which files exist.

### index.md — template (~20 lines, pure router)
```markdown
# Index · T<n> · <date>
- state.md → state, next steps, run commands, environment, pitfalls
- requirements.md → open/done/cancelled/❓ (N items, R1–R<m>)
- preferences.md → M prefs
- decisions.md → N ADRs
- code-map.md → K files/modules documented
- absolute.md → N 🔒 entries
- log.md → T<a>–T<b>
- log-archive.md → T1–T<a-1> (if exists)
- handoff.md → last generated: <date>
- assets/ → T<nn>-<slug>.<ext>
```

### state.md — template
```markdown
# State · T<n> · <date>

## Summary
- <2-4 lines: what works, in progress, broken>

## Next Steps
- <2-3 lines: what to do first when picking up>

## How to Run
- build: <command>
- dev: <command + port>
- test: <command>
- deploy: <command>

## Environment
- DB: <type + address>
- Env vars: <list from .env>
- Services: <redis, rabbitmq, etc.>
- Ports: <list>

## Pitfalls
- <known traps: "do NOT change X because …", "port 5432 conflicts with …", env quirks, subtle bugs>
```
> **Pitfalls**: append one line every time a trap/quirk/subtle bug is discovered. This section saves the next agent from re-discovering the same坑.

### requirements.md — template
```markdown
# Requirements · T<n> · next_id: R<m>

## Open
- [ ] R1 <req> [tags] (opened T<n>) · impl: src/a.ts, src/b.ts
- [ ] ❓ R2 <inferred — user did not confirm> [tags] (opened T<n>)

## Done
- [x] R3 <req> [tags] (opened T<n>, completed T<m>) · impl: src/c.ts

## Cancelled
- [x] R4 <req> (cancelled T<n>): <reason>
```
> **R-ids are sequential and permanent** (never reused). `impl:` lists the files implementing this requirement — update it whenever work on the requirement touches files. This gives requirement→code traceability; code-map.md mirrors it with `reqs:` tags on entries.

### preferences.md — template
```markdown
# Preferences · T<n>

- <coding style>
- <tooling>
- <architecture>
- <naming>
- <testing>
- <deployment>
```

### decisions.md — template (ADR)
```markdown
# Decisions · T<n>

> Major architecture/tech decisions. One entry per decision, permanent (never compressed).
> Add an entry when a NON-trivial decision is made with real trade-offs (tech choice, architecture, data model, deployment strategy).
> Small per-turn choices stay in log.md Decisions & Constraints; only the big ones come here.

## ADR-1 · <title, e.g. "Use Express over NestJS"> · T1
- Context: <what problem / what was on the table>
- Options: <A / B / C with one-line pros>
- Decision: <chosen + why>
- Consequences: <what this locks in, what becomes harder later>
- Supersedes: <none / ADR-x + why>
```

### code-map.md — template (critical for new agents)

`templates/code-map.md` 提供的是完整骨架模板（Structure / Key Relationships / Recently Changed 三节）。Agent 应根据项目类型填充对应内容。

Use this exact structure. The directory tree sits inside a fenced code block; keep the `→`, `key:`, `deps:` lines aligned.

````markdown
# Code Map · T<n> · <date>

> Module/file map with roles, key functions, deps, reqs, and last-changed T#.
> Update every turn when files are created/modified/deleted.

## Structure
```
src/
├── server.ts        → entry point, initializes Express, mounts routes, connects DB
│                      key: app.listen(3000), cors setup, error handler
│                      deps: routes/, db.ts, middleware/
│                      reqs: R1
│                      T15: refactored error handling
├── db.ts            → PostgreSQL connection pool (pg), 5 max
│                      key: createPool(), query(), queryBatch()
│                      reqs: R1, R3
│                      T1: created
├── routes/
│   ├── tasks.ts     → /api/tasks CRUD, pagination
│   │                   key: GET/POST/PUT/DELETE, soft-delete
│   │                   deps: db.ts, middleware/auth.ts
│   │                   reqs: R2
│   │                   T8: pagination, T12: soft-delete
│   └── users.ts     → /api/users, profile update
│                      deps: db.ts, middleware/auth.ts
│                      T5: created
├── models/
│   └── task.ts      → Task type + validation
│                      T3: created, T12: added deletedAt
└── middleware/
    └── auth.ts      → JWT verification
                       key: verifyToken(), requireAuth()
                       T6: created

tests/
└── tasks.test.ts    → 14 tests, vitest
                       T8: created

Dockerfile           → multi-stage, node:20-alpine, EXPOSE 3000
                       T1: created, T20: healthcheck
```

## Key Relationships
- server.ts → routes/* → db.ts
- middleware/auth.ts guards /api/*
- models/task.ts = single source of truth for Task shape

## Recently Changed (last 5)
- T20: Dockerfile — added healthcheck
- T15: server.ts — refactored error handling
- T12: routes/tasks.ts — soft-delete; models/task.ts — deletedAt
- T8: routes/tasks.ts — pagination; tests/ — created
- T6: middleware/auth.ts — created
````

### absolute.md — template
```markdown
# 🔒 Absolute
> Never compressed or trimmed.
```

### log.md — per-turn block format
Append to the **end**. Never rewrite existing blocks.

**Session divider**: before appending, check the date of the last T-block. If it differs from today, insert one line first:
```
--- SESSION: <YYYY-MM-DD> ---
```

```markdown
## T<n> · <one-line gist> · [tag1] [tag2]

### User
- <user's full request — all parts, all conditions>

### Action
- <操作类型> <file path> — <what was done>
  - e.g. `新增 src/routes/orders.ts` — 创建订单 CRUD 路由
  - e.g. `修改 src/db.ts` — 连接池上限 5→10，加了 retry 逻辑
  - e.g. `删除 src/legacy.ts` — 旧接口已废弃，无引用
  - e.g. `配置 .env` — 新增 DB_URL, JWT_SECRET
- <concrete: function names, API endpoints, code patterns>

### Commits
- <git hash (short)> — <commit message> · (only if commits were made this turn; omit otherwise)

### Decisions & Constraints
- <why this approach, what was rejected>
- <NON-trivial decisions with real trade-offs → also create an ADR entry in decisions.md>

### Pitfalls
- <trap/quirk discovered this turn → also append to state.md Pitfalls>

### Preferences
- <any preference expressed this turn>

### Conflicts
- ⚠️ <contradicts T<a>/R<m>/ADR-x: <what was said before vs now> — marked for user> · (only when a conflict was detected; omit otherwise)

### Attachments
- ![T<n> <label>](assets/T<nn>-<slug>.<ext>) — <what it shows>
- T<n> <label>: assets/T<nn>-<slug>.<ext> — <what this file is>

### Uncertain
- ❓ <inferred but unconfirmed>
```

**Action 节规则（必须遵守）：**
- 每个 bullet 以**操作类型 + 文件路径**开头：`新增` / `修改` / `删除` / `重命名` / `配置` / `创建`。
- 不能写"改了代码"、"更新了一些文件"——必须写到具体路径。
- 如果本轮没有文件操作（纯讨论/决策），Action 写 `无文件变更` 即可。

**Commits 节规则：**
- 如果项目是 git 仓库且本轮产生了 commit，记录 short hash + message，方便新 agent 用 `git log` / `git show` 回溯代码。
- 本轮无 commit → 省略该节。

**Conflict 节规则（冲突检测）：**

检测维度（逐项对比）：
- 技术栈是否变化（编程语言、框架、数据库、核心库）？
- 已完成/进行中的需求是否被推翻或取消？
- 架构决策（ADR）是否被反转？
- 命名规范 / 编码风格是否冲突？
- 部署方式 / 环境配置是否改变？
- 🔒 absolute.md 中的绝对保留项是否被触碰？
- API 接口形状（请求/响应格式）是否改变？

检测到冲突后的处理：
- 在 T-block 中加 `### Conflicts` 节
- 在旧条目上标 `(superseded by T<n>)`
- 用一行提醒用户，由用户裁决

**Naming (strict):**
- Block headers & in-text refs: `T1`, `T2`, … `T12` (no padding). R-ids: `R1`, `R2`, …
- Asset filenames: `T01`, `T02`, … `T12` (zero-padded; ≥100 → 3 digits).

**Tags**: free-form, from `config.md tags_default` or user-defined. 标签语言跟随 `language` 配置，以上为默认中文标签（需求变更, 代码逻辑, 架构决策, Bug, 偏好, 依赖, 测试, UI, API, 部署, 文档, 坑点, 冲突, correction）。

**Completeness > brevity**. Omit empty subsections.

### Filled example (first-use reference in log.md)

```markdown
## T1 · Initial setup: user described project goal and tech stack · [需求变更] [架构决策]

### User
- Building a REST API for a to-do app, Express + PostgreSQL, deployed on Docker
- Must use TypeScript, no plain JS

### Action
- 新增 src/server.ts — Express 入口，挂载 routes，启动 DB 连接
- 新增 src/db.ts — pg 连接池（max 5）
- 新增 src/routes/、src/models/、src/middleware/ 目录结构
- 新增 Dockerfile — node:20-alpine 多阶段构建

### Commits
- a1b2c3d — initial scaffold: express + pg + docker

### Decisions & Constraints
- Express over NestJS: 用户偏好简洁（已记 ADR-1）
- pg pool, no ORM: "keep it lightweight"

### Preferences
- TypeScript strict, no any
- No ORM, raw SQL
- Docker deployment

### Attachments
- T1 project-structure.png: assets/T01-project-structure.png — 初始目录结构

### Uncertain
- ❓ "keep it lightweight" 是否适用于所有依赖还是仅 DB 层
```