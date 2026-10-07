# ContextPocket Skill — Advanced

> 按需加载。`SKILL.md` 是日常必读主体，本文件涵盖：模板引导（Bootstrapping）/ 项目类型预填（Project type templates）/ 归档（Archiving）/ 边界情况（Edge cases，含版本迁移）。

---

## Bootstrapping from templates

**Trigger is automatic — the user runs nothing.** On the first substantive turn in a project that has no `ContextPocket/`, the agent offers to bootstrap and then runs `context-pocket bootstrap` (MCP: `context_pocket_bootstrap`) itself. The user may say "开始记一下" / "给我建个记录" / "接手这个项目", or say nothing at all. In a project that already has a `ContextPocket/`, the agent skips the offer, reads `index.md` + `state.md`, and keeps recording. Never tell the user to type a command to activate.

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
| `log-archive.md` | `ContextPocket/log-archive.md` — **`archive` 自己写这个文件**（头部与模板一致）。只有在不支持工具的纯文本 Agent 手工建文件时才复制 `templates/on-demand/log-archive.md` |
| `handoff.md` | `ContextPocket/handoff.md` — **`handoff` 自己生成这个文件**（内容全部来自 state/index/log/requirements 的真值，不带占位符）。手工路径才复制 `templates/on-demand/handoff.md` |

- `assets/` 和 `assets/archive/` 是目录 —— 建空目录即可，无模板。
- 如果 `templates/` 缺失（例如 Agent 只读了正文）→ 回退到 [`SKILL-reference.md`](./SKILL-reference.md) 里的内联模板。两条路径必须得到同一套布局。
- 占位符（`<n>`、`<date>`、`<slug>`）一律填真实值；首轮真实记录之后删掉 `log.md` 里的示例块。
- `templates/on-demand/` 下的两个模板**不在 bootstrap 的复制清单里**（代码只读 `templates/` 根目录，见 `lib/bootstrap.js` 的 `coreFiles` 循环与 `lib/writer.js` 的 `readFileOrTemplate`）。它们是给"没有工具、只能自己写文件"的 Agent 的兜底参照，不是运行时依赖。

---

## Project type templates (pre-fill on bootstrap)

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

## Archiving（阈值 `config.md archive_at`，默认 800 行）

**归档永远不会自动发生。** `archive_at` 只决定什么时候*提示*：`log.md` 行数达到阈值时，`status` 显示 "archive is due"，`verify` 报一条 `log-size` warning 并给出可执行命令。搬动历史必须有人（用户或 Agent 明确决定）触发 `archive`。

**保留策略**：`recent_keep`（`config.md`，默认 30）个**完整 T 块**保留在 log.md，其余按整块切割迁移到 `log-archive.md`。不带 `--keep-last` 时 `archive` 就按 `recent_keep` 执行；显式给了 `--keep-last <N>` 则以 `<N>` 为准。归档过程不可逆——archive 文件只会追加，永不回写。

**触发条件**：
- 提示：log.md 行数（含 SESSION 分隔线）≥ `archive_at` → `status` / `verify` 报警，由用户决定何时归档
- 手动：用户说「把旧的归档」「log 太长了」→ `context-pocket archive`（无参数时按 `recent_keep` 保留；带 `--keep-last <N>` 时本轮强制保留 N 个块）。用户说「重新开始」时先跟用户确认，再用 `context-pocket archive --keep-last <N>` 然后重建

**实际流程（`lib/writer.js` 的 `archiveLog`，Agent 必读）**：
1. 读 `config.md` 的 `recent_keep`（缺省 30）作为保留数，除非调用方显式给了 `keepLast`
2. **先跑 `verify`：只要有 error 就当场拒绝归档**（不会把坏状态搬进归档文件）
3. 按"第一个保留块"的起始行切割；切割点会**向前吸收它上面那条 `--- SESSION: … ---`**，让分隔线跟块一起走；若保留段前面一条分隔线都没有，则把最近那条复制一份留在 log.md
4. 把更早的所有行整段（原文，不压缩）追加到 `log-archive.md` 末尾；首次归档时自动写归档头
5. 重写 `log.md`（保留表头 + 保留块），并更新 `index.md` 里 `log.md` / `log-archive.md` 的 T 范围
6. 刷新搜索索引 —— 入口层在写完后调用 `afterWrite(pocketDir, { index: true })`，**不需要再手工跑 `index --rebuild`**
7. **再跑一次 `verify`**；若此时有 error，`log.md` / `log-archive.md` / `index.md` 三份文件自动回滚到归档前

`--dry-run` 只看计划（archivedCount / keptCount / 范围），不碰任何文件。`keep-last` 给 0 或负数会被直接拒绝（那等于"一块都不留"，实现里会取不到保留块）。

---

## Edge cases

- Files missing → recreate from template; note gap in `index.md`.
- `config.md` missing/unreadable → use defaults, note in one line.
- T-number gap → continue from highest T.
- Duplicate T-id (`log.md` 里两个 `## T9`，来自两台机器各写一轮) → `context-pocket repair --dry-run` 看方案再执行；不手改 markdown、不 `--no-verify`。见下面「并发与撞号（多 Agent）」
- R-id reuse → never reuse; if a gap appears, continue from the highest existing R-id.
- `assets/` file not found → `[missing: T<n> <file>]`; don't block. 这条标注不只是礼貌：`verify` 会检查 `### Attachments` 声明的文件在不在磁盘上（找不到 = error，会拦住 pre-commit），已经带 `[missing: …]` 的那一条它跳过不报。
- bootstrap run twice (the user repeats "开始记一下") → idempotent no-op: exit 0, prints the existing path, writes nothing.
- No git → skip .gitignore and Commits sections silently.
- Large attachments → save; note size; don't truncate.
- `index.md` corrupted → rebuild from directory listing.
- `handoff.md` stale → regenerate the next time the user asks to hand off ("交接一下" → `context-pocket handoff`); note in `index.md`.
- `code-map.md` out of date → receiving agent **must** compare with actual tree and update before starting work.
- `pocket-snapshot-*.md` → keep latest 3, delete older the next time the user asks to export ("导出给同事" — the agent writes the snapshot file itself, no tool) (tell the user).
- User says "undo that requirement" → mark `[x] (cancelled, T<n>)` in requirements.md, note in log.md.
- Turn is NOT substantive (pure ack) → skip all ContextPocket writes, no T-number consumed.
- ADR that turns out wrong → never delete; add a new ADR: "Supersedes ADR-n: <why>".
- Conflict detected but user insists on the old behavior → record BOTH: new T-block notes "user confirmed keeping old approach", remove the `superseded` mark.

### 并发与撞号（多 Agent）

锁的边界先说清：`withPocketLock`（`lib/io.js`）把锁文件放在 `os.tmpdir()` 里、按 pocket 路径命名，所以它**只在一台机器内**给写入排队。

- **同一台机器上多个 Agent 并行写**：安全。取锁之后才读 `latestT`、再追加，所以两边不会拿到同一个号。此时唯一要做的是**署名**：`log append --author "agent-A"`（MCP: `author`），否则历史里分不清哪一轮是谁记的。
- **两台机器各有一份克隆**：按**串行交接**用——先 `git pull`，写完立刻提交。两个克隆同时写时各自算出 `latestT + 1`，合并后 `log.md` 里就会出现两个 `## T9`。这不是数据损坏，是坐标坏了：后面的引用、`index.md` 的范围、`recall T9` 全都开始指错东西。
- **撞上了就 `repair`，绝不要手改 markdown**（也不要 `git commit --no-verify` 绕过体检）：

```bash
context-pocket verify --dir <project-root>       # Duplicate T-id: T9（error）
context-pocket repair --dir <project-root> --dry-run   # 看方案：哪些号要动、哪些正文还写着旧号
context-pocket repair --dir <project-root>              # 执行；正文旧号只列不改
context-pocket repair --dir <project-root> --apply-refs # 确认过语义之后才加
```

  - 撞号那块**及其之后的每一块**整体后移一格（`log.md` 只追加，编号必须继续随文件顺序递增），不是只把重复那块塞到一个凭空的大号上。
  - 正文里的旧号**默认只列出来**：一句 `T9` 可能指两块里的任何一块，只有读的人知道是哪一块。`--apply-refs` 才替换，且是同时替换，所以级联（`T3→T4` 与 `T4→T5`）不会把同一处引用挪两次。
  - 两类东西**永远不进替换**。一是**词**：算引用的前提是它是独立的 `T<数字>`，`GPT4`、`RTX4090`、`UTF8` 只是碰巧含了这个形状，改了就是改历史。二是**附件文件名**：`T04-diagram.png`、`assets/T04-diagram.png` 不是引用，改名是两半（先 `mv` 文件、再改文本），工具不替你 `mv`，所以也绝不只改文本那一半——那等于凭空造一条断链，还会丢掉零填充（`T04`→`T4`）。它们单独列在 `fileNames` 里，每条带着现成的 `mv "旧" "新"` 命令，执行完跑一次 `context-pocket verify` 确认链接还在。
  - 派生值自己跟上：`state/requirements/decisions/preferences/code-map/handoff` 头行的 `· T<n>`、以及整份重算的 `index.md`。`log-archive.md` **只报不改**（它自己声明只读）；如果新号与归档里的号同名，repair 会告诉你那块在 `recall/search` 里会被 live 那份遮住。
  - 改动本身写成一个 `[auto]` T-block（可用 `--author` 署名是谁跑的 repair）——编号被工具动过这件事必须留在历史里，而不是让下一个人从号上猜。
  - 写完之后体检更差、或还有撞号，就整份回滚（含 `index.md`），pocket 回到本次运行前的样子。
- **两个 Agent 意见不一致**不需要谁记得去报：每次 `log append` 已经把这一轮和已有记录比过一遍，新撞上的 critical/warning 带 `[auto]` 前缀落进那一块的 `### Conflicts`。你只需补上检测器看不见的那类（接口形状、业务语义），别重复抄工具已经写进去的那几条。

### Version migration

**格式版本检测在 `migrate`，不在 `bootstrap`**（`lib/migrate.js` 的 `detectFormatVersion`）：
- `context-pocket migrate --list` 读 `readme.md` 的 `format:` 行，报告当前版本、登记表里的最新版本（`Latest registered`）与全部可用跳（`Registered steps:`）
- `bootstrap` 只做幂等保护（已有 `ContextPocket/` 时什么都不写、退 0），**不比对格式版本**，也不会因为格式旧而提示
- 迁移前先 `verify` 确认健康，再 `context-pocket migrate --to <version>`（`--dry-run` 预演）。执行时自动备份整个 `ContextPocket/` 到 `ContextPocket.backup-<timestamp>/`，失败自动回滚

**版本链**：一跳一跳登记在 `lib/migrate.js` 的 `MIGRATIONS` 里，路径由 BFS 现算，所以 `v1 → v2 → v3` 一条命令就能走完，`--to v2` 只走前半程。`--to` 接受 `v2` / `2` / `V2` / `latest`，省略即 `latest`（登记表里可达的最高版本，不是写死的 `v1`）。整条链是全有或全无：任何一跳抛错、或跳完之后 `verify` 报 error（哪怕迁移函数没吭声），整个目录回到本次运行前的状态、版本戳也退回去，那份备份在回滚成功后删掉；只有全部走通才保留备份。回滚细节见 [docs/MIGRATION.md](docs/MIGRATION.md)。

**已知的格式版本**：
- v1：10 个核心文件 + 2 个按需文件（`log-archive.md` / `handoff.md`；lite 模式只建 5 个核心文件），T-block / R-id / ADR 基础结构，外加 indexer / hub / distill / import 四项能力
- v2（当前，新建 pocket 的出生格式）：只比 v1 多一条结构行 —— 每个 T-block 在 `## T<n>` 标题下面带一条 `--- WHEN: … ---`（`log append` 写、`recall` 读、`--when` 指定）。文件清单、小节名、编号规则一律没变，所以 v1 目录完全健康，升级是可选的。在还没升的 v1 目录里传 `--when`：块照记（`log.md` 是 P0），这一行不写，工具会回一句原因（`--json` 里的 `whenSkipped`）——别把它当成已经记下了

**登记表里有两跳**（`lib/migrate.js` 的 `MIGRATIONS`）：`v1 → v1` 是同版本自检（退 0、什么都不改），`v1 → v2` 是**真会改写内容的一跳**——扫 `log.md` 与 `log-archive.md`，给每个块按**它自己上方最近的那条 SESSION 日期**补一条 `--- WHEN: <日期> (day) ---`；上方找不到日期的孤块什么都不写（不拿 mtime 冒充、不编日期），已经有时间行的块直接跳过，所以重跑一遍是幂等的。老的 v1 目录一条命令升上来：

```bash
context-pocket verify --dir <project-root>          # 有 error 时 migrate 会拒绝开始
context-pocket migrate --dir <project-root> --to latest --dry-run
context-pocket migrate --dir <project-root> --to latest
```

v1 的 pocket 每次 `verify` 还会看到一条 `format-upgrade` 的 **WARNING**，告诉你有这一跳可走 —— 它是 warning，pre-commit hook 只拦 error，所以"没升级"绝不会拦下提交。新增一跳时按 CONTRIBUTING.md「如何新增一个迁移步骤」登记 `run()`，并把 `templates/readme.md` 的 `format:` 一起抬版本 —— 只改一边会让新项目一出生就带着"有升级可用"，或让老项目永远升不动。

**相对最早版本的字段增补**（可选，未填写视为默认）：
- `config.md` 加 `gitignore: true` —— 记录初始化时采用的取值（`bootstrap --gitignore false` 会写成 false 且不把 `ContextPocket/` 加进 `.gitignore`）；事后改这一行不会重写 `.gitignore`
- 没有 hub 注册表的旧项目照样能跑；搜索索引是派生缓存，**每次写入后**（`lib/lifecycle.js` 的 `afterWrite`）按源文件签名增量刷新，不只是 search 时
- `requirements.md` 等文件在 lite 模式下不存在，第一次真正用到时才从模板建（`readFileOrTemplate`）

**降级策略**：如果 migration 不可逆（如字段语义改变），必须先在 `index.md` / `decisions.md` 留一条 ADR 记录"为何不可逆"再执行。