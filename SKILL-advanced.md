# ContextPocket Skill — Advanced

> 按需加载。`SKILL.md` 是日常必读主体，本文件涵盖：模板引导（Bootstrapping）/ 项目类型预填（Project type templates）/ 归档（Archiving）/ 边界情况（Edge cases，含版本迁移）。

---

## Bootstrapping from templates

The Skill ships a `templates/` folder alongside this file. **When creating a new `ContextPocket/`, copy the corresponding template file and fill it in** instead of handwriting from prose. This keeps first-use format consistent and reduces drift.

Template → target mapping (all under this Skill's `templates/` dir):

| template | → creates |
|----------|-----------|
| `readme.md` | `ContextPocket/readme.md` |
| `config.md` | `ContextPocket/config.md` |
| `index.md` | `ContextPocket/index.md` |
| `state.md` | `ContextPocket/state.md` |
| `requirements.md` | `ContextPocket/requirements.md` |
| `preferences.md` | `ContextPocket/preferences.md` |
| `decisions.md` | `ContextPocket/decisions.md` |
| `code-map.md` | `ContextPocket/code-map.md` |
| `absolute.md` | `ContextPocket/absolute.md` |
| `log.md` | `ContextPocket/log.md` (keep the `# ContextPocket · LOG` header, drop the worked T1 block after first use) |
| `log-archive.md` | `ContextPocket/log-archive.md` (created only when archiving — template in `templates/on-demand/`) |
| `handoff.md` | `ContextPocket/handoff.md` (created only on /handoff — template in `templates/on-demand/`) |

- `assets/` and `assets/archive/` are directories — create empty, no template.
- If `templates/` is missing (e.g. the agent only read the prose) → fall back to the inline templates in [`SKILL-reference.md`](./SKILL-reference.md). Both paths must produce the same layout.
- Fill placeholders (`<n>`, `<date>`, `<slug>`) with real values; delete unused example blocks from log.md after the first real turn.
- `templates/on-demand/` 下的模板（如 log-archive.md、handoff.md）不在 bootstrap 时复制，在需要时（归档、首次生成 handoff 等）才从 on-demand 目录复制。

---

## Project type templates (pre-fill on /openpocket)

After `project_type` is set, pre-fill these fields so the next agent gets type-specific context:

| type | state.md extra fields | code-map.md focus |
|------|----------------------|-------------------|
| **frontend** | bundler (vite/webpack), framework (react/vue…), state mgmt, component lib, design tokens, preview cmd | component tree, route table, theme files, build config |
| **backend** | API style (REST/GraphQL), auth scheme, DB + migrations dir, cache, worker/queue | route→handler→model map, middleware chain, DB schema files, API contracts |
| **fullstack** | both, plus: API boundary, shared types location, proxy config | both maps + `shared/` contract files |
| **data** | data sources, pipeline steps, schedule, notebook env, output storage | pipeline DAG (script→output), schema registry, config files |
| **mobile** | platform (iOS/Android/both), min SDK/OS, build target (dev/prod), store/CDN, deep links | screen→component map, network layer, local storage, native modules |

Pre-fill as `· (not set)` placeholders; replace as the project clarifies.

---

## Archiving (log.md > `config.md archive_at`, default 800 lines)

**归档前验证**：归档前先跑一次 /verify 的核心检查（文件完整性 + 引用有效性），确保当前状态健康。如果有 ⚠️，先修复再归档，或提醒用户确认。

**保留策略**：`recent_keep`（config.md，默认 30）个**完整 T 块**保留在 log.md，其余按整块切割迁移到 `log-archive.md`。归档过程不可逆——archive 文件只会追加，永不回写。

**触发条件**：
- 自动：log.md 行数（含分割条）≥ `archive_at`
- 手动：`/archive`（无参数时按当前阈值执行；带 `<number>` 时强制把行数阈值临时调到该值执行一次）

**操作流程（Agent 必读）**：
1. 读 `config.md archive_at`（缺省 800）+ `recent_keep`（缺省 30）
2. 跑归档前验证（见上）
3. 在 `log.md` 末尾的 SESSION divider 上方计算"最近 N 个 T 块的起始行"
4. 把更早的所有行（含 SESSION dividers）整段迁到 `log-archive.md` 末尾（首次归档时先复制 `templates/on-demand/log-archive.md` 头）
5. log.md 顶部保留 `# ContextPocket · LOG` 标题 + 第一个 SESSION divider 在被保留的最近 T 块之上
6. 重建 `index.md`（更新 log-archive.md 起始 T-id）
7. 跑 `index --rebuild`（CLI）或 `context_pocket_index`（MCP）刷新 search index

---

## Edge cases

- Files missing → recreate from template; note gap in `index.md`.
- `config.md` missing/unreadable → use defaults, note in one line.
- T-number gap → continue from highest T.
- R-id reuse → never reuse; if a gap appears, continue from the highest existing R-id.
- `assets/` file not found → `[missing: T<n> <file>]`; don't block.
- `/openpocket` twice → idempotent.
- No git → skip .gitignore and Commits sections silently.
- Large attachments → save; note size; don't truncate.
- `index.md` corrupted → rebuild from directory listing.
- `handoff.md` stale → regenerate on next `/handoff`; note in `index.md`.
- `code-map.md` out of date → receiving agent **must** compare with actual tree and update before starting work.
- `pocket-snapshot-*.md` → keep latest 3, delete older on next `/exportpocket` (tell the user).
- User says "undo that requirement" → mark `[x] (cancelled, T<n>)` in requirements.md, note in log.md.
- Turn is NOT substantive (pure ack) → skip all ContextPocket writes, no T-number consumed.
- ADR that turns out wrong → never delete; add a new ADR: "Supersedes ADR-n: <why>".
- Conflict detected but user insists on the old behavior → record BOTH: new T-block notes "user confirmed keeping old approach", remove the `superseded` mark.

### Version migration

**格式版本检测**：
- `/openpocket` 时读取 `readme.md` 的 format 版本
- 如果当前 skill 支持的版本 > 数据版本 → 提示用户有新版，可选迁移
- 迁移前必须先归档（保护现场），然后按需执行 migration script

**已知的格式版本**：
- v1（首发版）：12 文件布局，基础 4 个新增能力（Path B：indexer / hub / distill / import）

**新增字段**（可选，未填写视为默认）：
- `config.md` 加 `gitignore: true`（控制 `ContextPocket/` 是否进 git；`false` 让 pocket 进 git 跨设备同步）
- `requirements.md` 等保留兼容：旧版项目没有 hub 注册表也能跑；indexer 仅在 CLI / MCP 调用 search 时触发重建

**降级策略**：如果 migration 不可逆（如字段语义改变），必须先在 `index.md` / `decisions.md` 留一条 ADR 记录"为何不可逆"再执行。