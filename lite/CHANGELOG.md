# ContextPocket Lite — Changelog

Lite has its own version line. The full package stays on its own releases; a Lite pocket is a valid full-package pocket at any time.

## [2.11-lite] - 2026-11-16

### ContextPocket Lite 2.11 — 隔离开关（稳定版）

> Lite 独立版本线发 `2.11`（对外 `2.11-lite`）；主包同日发 `2.11`。
> 仍然零缓存、零依赖、11 命令 / 11 工具。

- **隔离开关（`lib/isolate.js`，与主包逐字同源）**：测试项目 / 一次性实验 / CI 评测时，本轮不读旧上下文、也不写回真实历史。三层：环境变量 `CONTEXTPOCKET_ISOLATED`、项目根标记 `.contextpocket-isolate`、物理改名 `ContextPocket.isolated/`。CLI `main()` 与 MCP `tools/call` 各一处拦下所有读写，`status` 唯一例外（只回 `{ok,isolated,source}`）。
- **跟着 `--dir` 走**：CLI 检测目标与命令一致，`recall --dir <被隔离项目>` 从别处 cwd 也拦得住。
- **诚实边界**：纯 Markdown 挡不住主动翻目录的 Agent，物理级保证用第三层；SKILL.md 加 HARD RULE。
- **回归锁**：CLI 三层 + `--dir` 绕过 + 解除恢复用例、MCP 经 wire 拒绝用例、compat 两包 `detectIsolation` 逐字一致；四门禁全绿。
- **升级动作**：无。**破坏性**：无（数据格式仍 v2）。

## [2.10-lite] - 2026-11-15

### ContextPocket Lite 2.10 — 读侧接手视图（稳定版）

> Lite 独立版本线发 `2.10`（对外 `2.10-lite`）；主包同日发 `2.10`。
> 仍然零缓存、零依赖、11 命令 / 11 工具。

- **`handoff --read`**：只输出 `0 · Start here` 接手视图（含 STOP CONDITION 与 ❓ 清单），比对 `generated-at` 与 log 最新 T；过期拒绝输出、退出 1，`--force` 放行、`--full` 全文、`--json` 结构化。不新增命令或 MCP 工具。
- **参数解析修正**：`read` / `force` 补进 `parseArgs` 的布尔集合，修掉 `--read --force` 被吞值的问题。
- **跨 Agent 记忆定位**：产品定位明确为「辅助上下文记忆 + 跨对话、跨 Agent 记忆」；主包新增交接剧本与 T-block 格式规范（format v2 描述性规范 + 金样本 + 独立校验器）。
- **回归锁**：CLI 读侧用例、两包 `readHandoffView` 逐字一致；四门禁全绿。
- **升级动作**：无。**破坏性**：无（数据格式仍 v2）。

## [2.8-lite] - 2026-11-15

### ContextPocket Lite 2.8 — 三段式交接 + 带来源的节点链（稳定版）

> Lite 独立版本线发 `2.8`（对外 `2.8-lite`）；主包同日发 `2.6`。
> 交接摘要改为「必读 / 按需 / 指针」三段，仍然零缓存、零依赖、11 命令 / 11 工具。

- **三段式交接**：`handoff.md` 的 `0 · Start here` 写 STOP CONDITION、项目身份、State、🔒 红线、❓ 待确认与 Next；`1 · On demand` 只在触发条件下展开；`2 · Pointers` 列真值文件与命令。每节硬上限，截断如实提示。
- **节点链**：新增 `lib/handoff-path.js`（与主包逐字同源），以未完需求 + 最近 3 个 T 为种子，按边类型规则表现场行走 `deriveLinks()` 的图；链上带 `[T<n>]` 来源，8 链上限 + `hasMore`。不写缓存、不引向量。
- **失效 ADR 剪枝**：被 `supersedes` 取代的旧决策不进 Key Decisions，链尾标注原因。
- **回归锁**：新增三段结构 / 停止条件测试，以及 compat「两包 handoff.md 逐字一致」；四门禁全绿。
- **升级动作**：重跑一次 `handoff` 重新生成交接摘要。**破坏性**：无（数据格式仍 v2）。

## [2.7-lite] - 2026-11-15

### ContextPocket Lite 2.7 — 省 token 输出分级 + 精确 T-id 捷径（稳定版）

> 把 `2.6-Lite-preview` / `preview2` / `preview3` 三轮预览冻结为稳定 `2.7`（对外 `2.7-lite`）；
> 主包同日发 `2.5`。能力面与 preview3 一致，零缓存、零依赖、11 命令 / 11 工具。

- **省 token 输出分级（只动渲染不动数据）**：`search` / `why` 默认每命中一行（id/gist/tags/证据），`--full` 恢复 snippet 预览；`recall` 默认完整、`--brief` 只看关键事实（User / Action / Decisions & Constraints / Pitfalls / Conflicts），其余折叠成一行指针；`--json` 永远完整。CLI 与 MCP 双侧同源，help / 工具描述 / SERVER_INSTRUCTIONS 写明分级。
- **精确 T-id 块定位捷径（两包同源）**：先按 plausible header 定位目标块、只解析那一块并重建 session，`log.md` 优先、畸形 id 回退全量；无索引 1000 轮夹具 ~5.5×。新增「快路径与索引全量解析逐字一致」回归锁。
- **图扩展安全上限**：`--expand` 种子去重、只认真实节点、最多 100 个，截断如实提示（`expansionTruncated` / `expanded.truncated`）；两包整图逐字同源，compat `deepStrictEqual` 8/8 严格绿。
- **升级动作**：无（数据格式仍 v2）。**破坏性**：无。

## [2.6-Lite-preview3] - 2026-11-14

### 精确 T-id 块定位捷径 + 省 token 输出分级

- **精确 T-id 块定位捷径（两包同源）**：精确 T-id 搜索先按 plausible header 定位目标块、
  只解析那一块，并从最近前置 SESSION 行重建 session，不再逐文件全量解析；`log.md`
  优先，畸形 id（>1e7）回退全量解析。无索引 1000 轮夹具实测 Lite 38.1→6.9ms（~5.5×）、
  完整包 31.6→6.3ms（~5.0×）。索引/关键词/recall 与命中形状不变。新增「快路径与索引
  全量解析逐字一致」回归锁（session/归档优先/补零/畸形/缺失），两包快路径逐字同源。
- **省 token 输出分级（Lite，只动渲染不动数据）**：
  - `search` / `why` 默认每命中一行（id/gist/tags/证据），砍掉冗余 snippet 预览；
    `--full` / `full:true` 恢复预览。
  - `recall` 默认仍完整（精度工具不该默认省）；`--brief` / `brief:true` 只看关键事实
    （User / Action / Decisions & Constraints / **Pitfalls / Conflicts** 保留），其余
    折叠成一行 `… N more sections omitted (…) — omit brief for the full turn.` 指针。
    brief 误用于窗口列表会报错。
  - `--json` 永远完整（highlights / rawText 都在）。CLI 与 MCP 双侧同源接线，
    help / 工具描述 / SERVER_INSTRUCTIONS 写明分级与「数据永远完整」。
  - **compat 不放宽**：分级只在 CLI/MCP presentation 层，library 返回值原样不变，
    `lite/tests/compat.js` 的整图/命中 `deepStrictEqual` 8/8 仍严格绿。
- **回归锁**：`lite/tests/core.js` 新增 token 分级锁——紧凑输出不含 snippet 标记、
  `--full` 含且 `compact.length < full.length`；recall brief 保留关键事实 + 指针、
  藏起 attachment/preference/uncertain 原文且 `brief.length < full.length`；
  `--json` 跨档 `deepStrictEqual` 完全一致。
- **metrics（定版追平）**：体积基线随本次定版复测追平；冷启动锁由严格 `<` 改为
  `1.15×` 噪声带宽（best-of-5 的 ~100ms Node 启动，两包差值与调度噪声同量级，
  严格 `<` 会亚毫秒随机变红），结构性「Lite 更轻」仍由模块数硬锁 17<25 保证。

## [2.6-Lite-preview2] - 2026-11-13

### 精确 T-id 扫描两包同序（性能 + 回归锁）

- **主包 P2 回移**：完整包精确 T-id 现场扫描把只读轮次日志的捷径提前到 `collectDocs`
  之前，不再先解析偏好/决策/需求；Lite 本就是此序，产品代码无改动，随主包版本线
  同步升 `2.6-Lite-preview2`。两包精确命中逐字一致仍由 compat 套件钉死。
- **回归锁**：主包新增读探针测试（精确 T-id 零元数据读取 + 非 T-id 负对照，旧序红/新序绿）。
- **metrics 断言更新**：`lite/tests/metrics.js` 旧「Lite 必须更快」改为单向带宽
  「完整包不得慢过 Lite 2×」；5000 行偏好夹具下回退旧序会慢到 ~6× 当场红。

## [2.6-Lite-preview] - 2026-11-12

### 图扩展安全上限 + 两包整图同源

- **100 节点安全上限**：`search --expand` / `why --expand` 的图扩展与主包同口径 ——
  种子去重、只认图上真实存在的节点、最多返回 100 个节点。截断不再静默：
  `--json` 带 `expansionTruncated`（why 为 `expanded.truncated`），人读输出与
  MCP 输出附可见提示「additional graph context omitted at the 100-node safety limit」。
  直接命中与分页口径不受影响。
- **整图同源**：主包回移了 tag/requirement 派生后，两包对同一份口袋派生逐字一致的
  整图。compat 套件删除 SHARED_*_TYPES 白名单，改为整图 `deepStrictEqual` +
  截断对齐测试；夹具覆盖全部 10 类边 / 6 类节点。
- **占位过滤加固**：code-map 目录占位（`<subdir-1>/` 这类带尾斜杠的形态）此前漏过
  占位过滤，会与主包一起修掉；占位路径不建节点、不建边。
- **写入锁竞态修复**：stale 锁回收改为原子 rename；释放时核对 pid/at 凭据，
  只删自己写的锁，持锁超时被回收后不再误删新持有者的锁。
- **清理**：移除 `when.js` 里从未被调用的 `timePart`；`core.js` 注释改准
  （extractFilesFromBlock 判据两包各收敛一份，主包在 query、Lite 在 core）。
- **截断提示不再依赖 linked 块**：提示文案此前嵌在 `linked.length > 0` 分支里，
  最坏情况（扩展轮次全被 100 节点上限截掉、linked 为空）反而静默。CLI 与 MCP 的
  search / why 四处统一移到分支外，截断必有提示。
- **metrics 测试不再怕 `npm test --silent`**：体积测量依赖 `npm pack --dry-run` 的
  notice 输出，而 `--silent` 会经 `npm_config_loglevel` 环境变量传给内层 npm，
  notice 全被吞掉导致解析失败。pack 调用显式带 `--loglevel=notice`，任何启动方式都稳。

## [2.5] - 2026-11-09

> 2.5 把 Lite 从「8 条命令的读写小包」补齐到能独立完成一次回顾：能补块、能对比两轮、能交接。新增能力全部走现场派生，仍然零缓存、零依赖。对外展示 `2.5-lite`。

### ✨ 能力对齐（与主包同一语义）

- **`log amend <T-id>`**：补齐一个 T-block 里**缺失**的小节（Author / User / Action / Commits / Decisions / Pitfalls / Preferences / Conflicts / Attachments / Uncertain），已有内容一律不覆盖；`--when` 只在块里没有时间行时补上。`log append` 发现新块缺 User/Action 时，提示直接指向 `context_pocket_log_amend` / `log amend`，不再是「手工改 markdown」。
- **`diff <T-a> <T-b>`**：两轮之间的需求（新增 / 完成 / 取消）、新增 ADR、文件（新增 / 删除 / 修改）变化。
- **`handoff`**：生成 `ContextPocket/handoff.md`（最新 T、当前 state、最近几轮、续接指引）。Lite 版把主包里「code-map update / assets」相关提示换成了 Lite 实际存在的做法。
- **`search --expand <1-3>` / `why --expand <1-3>`**：从关键词命中（或文件命中）出发，沿派生图多跳，把「通过文件或 ADR 连过来的轮次」追加在结果之后。扩展轮次单独标记（`linked`、跳数、经过的边），`total` / `hasMore` 仍只统计直接命中，分页口径不变。默认 0 = 行为逐字不变（compat 锁盯着这一点）。

### 🛠 稳健性与质量

- **MCP graph 边类型枚举修正**：`context_pocket_graph` 的 `inputSchema` 与工具内校验此前只认 6 种边，实际派生有 10 种（漏了 `tagged` / `opened-in` / `completed-in` / `implements`），合法过滤值会被误报为未知类型。两处都已补齐。
- **amend 绝不吞时间行**：重写块时保留块头的 `--- WHEN: … ---` 结构行；已记录的时刻不会被覆盖，只有缺失或 v1 迁移留下的 `(day)` 行才允许补/换。
- **CLI 与 MCP 一一对称**：11 条 CLI 命令 ↔ 11 个 MCP 工具，测试同时钉住两边的数量与工具名；三组新能力在两端都跑通（含 `--json`）。

### ⚡ 性能与体积

- **`recall <T-id>` 少读一半文件**：块解析已经带上了来源文件与起始行，`rawText` 只读该文件并校验块头（`T1` 不会匹配 `T10`），校验失败才退回全文扫描。输出逐字节不变，compat / 回归锁全绿。
- 仍然零缓存：`graph`、`handoff`、`--expand` 都在调用时现场派生，不写 `assets/`，不产生索引。

### 📚 文档

- `README.md` / `SKILL.md` 按实际 11 条命令重写：删除不存在的 `--files`、`--result`、`--verify-section`、`--since-t/--until-t` 写法，补上 `log amend` / `diff` / `handoff` / `--expand`，并把 T-block 小节清单改回真实的 10 节。
- 版本抄本同步：`lite/package.json`、`lite/lib/version.js`、`lite/SKILL.md` → `2.5` / `2.5-lite`。

## [2.4] - 2026-11-09

> 补记：2.4 随主包仓库的 `[2.4-lite]` 条目发布，Lite 自己的 changelog 当时漏记，此处按发布内容补回。

### ⚡ 查询优化

- **精确 `T<n>` 搜索走捷径**：只解析活动与归档日志定位单轮，不再为一条 T-id 查询解析无关的决策、需求和偏好文件；搜索结果与完整包强制扫描逐字一致（compat 锁盯着）。

## [2.2] - 2026-11-08

首个稳定版 Lite：8 条命令 / 8 个 MCP 工具，5 个核心 Markdown 文件，运行时派生关联图（无缓存），与主包同一份 Node schema v2 和格式层。
