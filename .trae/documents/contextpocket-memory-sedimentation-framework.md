# ContextPocket 记忆沉淀 / 知识库 · 基础框架

> 状态：基础设计稿（供后续模型继续扩展，不是最终实施计划）
> 适用版本：ContextPocket 3.1 之后
> 范围：Quan（根包，单口袋） + Yuan（`lang/`，多口袋工作区）；Xi 不动
> 核心原则：**沉淀与节点深度绑定，知识库不是独立文件层，而是节点图上的晋升与溯源变换。**

## 1. 背景与目标

现有 `lib/distill.js` 只把旧轮次蒸馏成一次性 `digest-<date>.md` 报告，报告本身不进入记忆结构：
不能检索、不能遍历、不能跨口袋关联、不能表达“这条知识从哪来、何时失效、是否被推翻”。

目标是把“沉淀”变成 ContextPocket 的一等记忆层：

- 原始轮次 `T` 仍是 append-only 的事实层。
- 沉淀产物是持久的知识节点 `K`，与 `T` / `ADR` / `R` / `file` / `tag` / `pref` 在同一张图里。
- 每条 `K` 必须能沿 `derived-from` 边回到证据；没有来源的只能停留在 draft。
- 知识库的 Markdown 是内容和显式来源的真相源；图是派生关系，不手工维护第二套边。

## 2. 分层记忆模型

| 层 | 内容 | 生命周期 | 真相源 |
|---|---|---|---|
| L0 原始记忆 | `T` / `correction` 轮次 | append-only，不删除 | `log.md` / `log-archive.md` |
| L1 活文档 | state / requirements / decisions / preferences / absolute | 人工/Agent 维护的当前操作真相 | 各自 Markdown |
| L2 蒸馏候选 | digest 报告里的候选簇 | 临时，可重建 | 由 L0/L1 派生 |
| L3 知识库 | `K` 节点 + 正文 | 持久，状态机管理 | `knowledge.md`（Quan）/ `knowledge/`（Yuan） |
| L4 检索层 | search / context / graph / audit / handoff | 派生缓存 | 由 L0-L3 重算 |

沉淀动作发生在 **L2 → L3**：把候选子图结晶成 `K` 节点，并固化 `derived-from` 证据边。
L4 负责让 `K` 被搜到、被上下文引用、被图谱遍历、被审计检查。

## 3. 节点与边契约

### 3.1 节点

现有：`T`、`correction`、`ADR`、`R`、`file`、`tag`、`pref`。

新增：`K`（Knowledge）。

`K` 节点至少包含：

- `id`：Quan 为口袋内 `K<n>`；Yuan 为工作区级 `K-<n>`（建议 4 位补零）
- `title`
- `kind`：`concept` / `decision` / `how-to` / `pitfall` / `reference`
- `status`：`draft` / `active` / `stale` / `superseded` / `archived`
- `confidence`：`confirmed` / `inferred` / `disputed`
- `sources`：限定引用数组，如 `api:T5`、`api:ADR-2`、`api:R3`、`api:file:src/a.js`
- `tags`
- `validFrom` / `validTo`：使用来源的 WHEN 日期，不用文件 mtime
- `supersedes` / `supersededBy`
- `scope`：`pocket` 或 `workspace`

### 3.2 边

| 边 | 方向 | 证据强度 | 含义 |
|---|---|---|---|
| `derived-from` | K → T / ADR / R / file / tag / pref | strong | 知识从哪些原始节点沉淀而来 |
| `covers` | K → tag / file / R | strong | 知识覆盖的主题 |
| `supersedes` | K → K | strong | 新知识取代旧知识 |
| `duplicate-of` | K ↔ K | weak | 归一化 key 相同，待合并/待审 |
| `contradicts` | K ↔ K | weak | 说法冲突，只报告不自动裁决 |
| `related-to` | K ↔ K | weak | 共享 tag/file/ADR 的有界关联 |

硬约束：

1. 一个 `K` 至少有一条 `derived-from` 边，否则最多 `draft`。
2. 一个主题默认一个 active `K`；同 key 的多个候选先 `duplicate-of`，由人或 Agent 决定合并。
3. 冲突不自动选边：双方标 `disputed`，连 `contradicts`，进入审计。
4. 永不物理删除 `K`，只做 `superseded` / `archived` 状态迁移。

## 4. Markdown 契约

### 4.1 Quan：单文件 `ContextPocket/knowledge.md`

```md
# Knowledge · K2

## K1 · JWT refresh strategy
- Kind: decision
- Status: active
- Confidence: confirmed
- Sources: T5, ADR-2, R3
- Tags: auth, token
- Updated: 2026-11-03

### Summary
Refresh token 采用轮换 + 短 TTL。

### Decisions
- 旧 token 在刷新后立即失效。

### Pitfalls
- 并发刷新会导致误判重放。

### Open questions
- 是否需要设备指纹？
```

- `# Knowledge · K<n>` 头部记录当前最大 K 号。
- 每条 `## K<n> · 标题` 是一个知识节点。
- `Sources:` 用口袋内裸 id；图构建时再限定成 `pocket:Tn` / `pocket:adr:ADR-n`。
- 文件可选：不存在时 `verify` / `search` / `graph` 不报错。
- 轻量：不建独立缓存；`parser` 扫描该文件，`graph` 把 K 节点并入现有 `graph/3`（预计升到 `graph/4`）。

### 4.2 Yuan：目录 `knowledge/`

```text
knowledge/
  index.md
  K-0001-jwt-refresh-strategy.md
  K-0002-token-rotation-pitfall.md
```

`knowledge/index.md` 是人类索引：

```md
# Knowledge Index · K2

| Id | Title | Kind | Status | Sources | Updated |
|---|---|---|---|---|---|
| K-0001 | JWT refresh strategy | decision | active | 3 | 2026-11-03 |
| K-0002 | Token rotation pitfall | pitfall | active | 1 | 2026-11-04 |
```

单条笔记：

```md
# K-0001 · JWT refresh strategy
- Kind: decision
- Status: active
- Confidence: confirmed
- Sources: api:T5, api:ADR-2, api:file:src/auth.js, web:T9
- Tags: auth, token
- Updated: 2026-11-03
- Supersedes: K-0000

### Summary
...

### Facts / Decisions / How-to / Pitfalls / Open questions
...
```

- `Sources:` 必须是工作区限定 id，跨口袋天然成立。
- 正文不写边；`derived-from` / `covers` / `duplicate-of` 由工具从 `Sources`、`Tags`、正文引用确定性派生。
- 派生缓存：`.contextpocket/knowledge-index.json`（签名、元数据、K 号水位）。
- 工作区图缓存 `.contextpocket/workspace-graph.json` 加入 K 节点/边（预计 `version=3`）。

## 5. 沉淀算法（L2 → L3）

1. **取候选子图**
   - 来源：旧 `T`（archive + 近期）、ADR、需求、偏好、文件、tag。
   - 继续复用 `distill` 的候选分类：decisions / pitfalls / preferences / uncertain。
2. **主题聚类**
   - 按确定性 key 聚类，优先级建议：显式 `tag` → 文件路径 → ADR 标题 → 需求文本 → 偏好 key → 归一化标题。
   - key 归一化复用 `normalizeKey`（`shared/graph-core.js` / `lang/lib/consolidate.js`）。
3. **生成/更新 K**
   - 每个簇生成一个 `K` 草案：标题、kind、sources、tags、正文摘要。
   - 已有同 key active K：追加 sources，按需合并正文；不覆盖人工正文。
4. **冲突与重复**
   - 同 key 不同结论：双方 `disputed` + `contradicts`，进入审计。
   - 不同 key 但高度重叠：`duplicate-of` 弱边，等待人工合并。
5. **时间**
   - `validFrom` = 簇内来源最新 WHEN；旧 K 被新来源推翻时 `validTo` = 新证据 WHEN。
   - 不使用文件 mtime。
6. **写入策略**
   - 默认 plan-first：只生成候选/差异，`apply` 才写 Markdown。
   - 永不自动删除或自动裁决冲突。

## 6. Quan 与 Yuan 的绑定深度

### Quan（轻量）

- 存储：单文件 `ContextPocket/knowledge.md`。
- 图：K 节点并入现有单口袋图缓存（`graph/3` → `graph/4`）；不新增缓存文件。
- 检索：`search` / `indexer` 索引 K 条目；`graph` 返回 K 邻居；`handoff` 可带 knowledge 摘要。
- 校验：`verify` 检查 K 标题、必需元数据、Sources 是否指向存在的节点、重复 key、orphan K。
- 入口：不新增顶层命令；扩展现有 `distill` 的晋升模式（候选 → knowledge.md），保持 29 命令 / 29 工具。
- 不跨口袋：K 只属于当前口袋。

### Yuan（重量级、完整）

- 存储：工作区根 `knowledge/`，`index.md` + 每主题一个 `K-*.md`。
- 图：K 节点进入工作区图，跨口袋 `derived-from`、`covers`、`duplicate-of`、`contradicts`、`related-to`。
- 索引：`knowledge-index.json` 增量；BM25 工作区索引新增 `K` 文档类型；`search --type K`。
- 上下文：`context build/explain --expand` 可从 T 走到 K，也可从 K 回溯证据；Related 或独立 Knowledge 段展示。
- 审计：orphan / stale / disputed / duplicate / broken-source / index-stale 健康项；`workspace status` 显示 K 数量与健康。
- 生命周期：`build`（候选/刷新）→ `apply`（写入）→ `verify` → `audit`；支持 `supersede` / `archive`。
- 入口：不新增顶层命令；扩展 `workspace` 的 `knowledge` 动作（build/apply/list/view/verify），MCP 仍走 `context_pocket_workspace`，保持 10 命令 / 10 工具。
- 去重：复用 `normalizeKey`、`crossPocketGroups`；冲突只标记。
- 有界：同 key 最多取固定数量来源；K 正文长度上限；相关 K 边 top-k；审计分页/汇总。

## 7. 与现有模块的接入点

### Quan

- `lib/distill.js`：候选提取 + 晋升模式。
- `lib/parser.js`：新增 `parseKnowledge(pocketDir)`；`parseAll` 返回可选 `knowledge`。
- `lib/links.js` / `shared/links-core.js`：K 节点、`derived-from` / `covers` / `duplicate-of` 边；`GRAPH_SCHEMA` 升级。
- `lib/indexer.js` / `lib/search.js`：K 文档。
- `lib/validator.js` / `lib/verify.js`：K 结构、来源、重复、orphan。
- `lib/handoff.js`：knowledge 摘要。
- `bin/context-pocket.js` / `mcp-server.js` / `lib/help.js`：distill 参数与描述。
- `tests/cli.js` / `tests/pocket.js` / `mcp-smoke.js` / `tests/shared.js`。

### Yuan

- `lang/lib/workspace.js`：工作区知识目录约定/可选 manifest 字段。
- 新增 `lang/lib/workspace-knowledge.js`：build/apply/list/view/verify、K 号分配、note 读写。
- `lang/lib/workspace-index.js`：K 文档类型、增量签名。
- `lang/lib/workspace-graph.js`：K 节点/边、缓存版本升级、`expandWorkspaceGraph` 支持 K。
- `lang/lib/context.js`：Related / Knowledge 段。
- `lang/lib/audit.js`：知识健康。
- `lang/lib/consolidate.js`：归一化与跨口袋分组复用。
- `lang/bin/context-pocket-yuan.js` / `lang/mcp-server-yuan.js` / `lang/lib/help.js`：`workspace knowledge` 动作。
- `tests/lang.js`、`scripts/bench-workspace.js`。
- `lang/edition.json` 命令/工具计数保持不变（10/10）。

### Shared

- `shared/graph-core.js`：如需 K 节点的日期/边过滤扩展，保持零依赖。
- `shared/parser.js`：仅当 Quan/Yuan 共用 Markdown 解析时扩展。
- 同步机制：`node scripts/sync-core.js --write`；新增 shared 文件必须进 `shared/manifest.json`。

## 8. 不变量与非目标

- 不引入 format v3；口袋核心格式保持 v2，`knowledge.md` 是可选扩展。
- 不引入 LLM 调用、向量库、外部服务；提取必须确定性、可重放。
- 不按 mtime 猜时间；只用 WHEN / 显式日期。
- 不自动删除、不自动合并冲突、不自动把 draft 升 active。
- 不新增顶层命令；Quan 扩 `distill`，Yuan 扩 `workspace`。
- Xi 完全不动（5 文件、11 命令、零缓存）。
- 默认输出不变：没有知识库/未显式开启时，现有 `context` / `search` / `graph` 行为不变。

## 9. 待下一模型展开的设计问题

1. K 号作用域：Quan 口袋内 `K<n>`、Yuan 工作区 `K-<n>` 是否足够？是否需要 `pocket:K<n>` 限定投影？
2. Quan 的 `knowledge.md` 是单文件活文档，还是允许 `knowledge/` 目录？当前建议单文件。
3. 主题 key 的优先级与冲突：tag 优先还是 ADR/需求优先？是否允许一个 K 有多个 key？
4. `kind` 是否需要更细（glossary/runbook/faq）？是否需要 `audience` / `scope` 字段？
5. 晋升是“候选差异 + apply”还是“直接 append 草稿”？建议 plan-first。
6. 冲突判定：同 key 不同正文是否一律 disputed？是否需要句级 claim 拆分？
7. K 正文长度上限、单 K 来源上限、相关 K 边 top-k 的具体数值。
8. Yuan 的 `knowledge/index.md` 是唯一索引真相，还是允许 `knowledge/index.json`？建议 Markdown 真相 + 派生缓存。
9. 是否需要 `K` 的 PPR/排序权重；Quan 轻量是否只用 BFS。
10. 归档/遗忘：`forget` / `decay` 是否影响 K？建议 K 独立于 T 归档，但 broken source 需审计。

## 10. 建议验收场景

### Quan

1. 造 3-5 个 T，含决策、坑、偏好、tag、文件引用。
2. 运行沉淀晋升，生成 `ContextPocket/knowledge.md`，含 2-3 个 K。
3. `verify` 通过；删除一个来源 T 后 `verify` 报 broken source。
4. `search` / `graph` / `handoff` 能看到 K 条目与来源。
5. 无 `knowledge.md` 时，所有旧命令输出不变。

### Yuan

1. 两个口袋，含共享 tag/文件、重复 ADR/需求。
2. 沉淀晋升，生成 `knowledge/index.md` + K 笔记，K 的 `Sources` 同时含两个口袋。
3. `workspace search --type K` 命中；`context --expand` 出现 K；`workspace graph` 有 K 节点与 `derived-from` 边。
4. `audit` 报 orphan / disputed / duplicate / stale；`verify` 报 broken source。
5. 修改一个 K 笔记或一个来源口袋，只有受影响的索引/图节点重建。

## 11. 交接提示词（可直接复制给下一个模型）

```text
你在继续设计 ContextPocket 的“记忆沉淀 / 知识库”功能。先读这份基础框架：
c:\Users\13401\Desktop\项目\ContextPocket-git\.trae\documents\contextpocket-memory-sedimentation-framework.md

项目背景：
- ContextPocket 3.1，Quan（根包，单口袋，29 命令）和 Yuan（lang/，多口袋工作区，10 命令）共用 format v2。
- Xi（lite/）完全不动：5 文件、11 命令、零缓存。
- 现有 lib/distill.js 只生成一次性 digest 报告，没有持久知识库。
- 核心原则：沉淀必须深度绑定节点。K（Knowledge）是持久节点，通过 derived-from 边连到 T/ADR/R/file/tag/pref；Markdown 是内容和显式 Sources 的真相源，图是派生关系。
- Quan 轻量：单文件 ContextPocket/knowledge.md，K 节点并入现有单口袋图（graph/3 → graph/4），不新增顶层命令。
- Yuan 重量级：工作区 knowledge/ 目录（index.md + K-*.md），K 节点进 workspace graph，knowledge-index.json 增量，接入 search/context/audit，不新增顶层命令，走 workspace 的 knowledge 动作。
- 不引入 LLM/向量库/format v3；不自动删除、不自动合并冲突；默认 plan-first；时间只用 WHEN，不用 mtime。

你的任务：
把这份基础框架扩展成可执行的实施计划，至少包含：
1. 最终文件契约（Quan knowledge.md、Yuan knowledge/index.md + K-*.md 的完整字段与示例）。
2. K 节点/边在现有 graph-core、links-core、workspace-graph 中的具体扩展点与缓存版本迁移策略。
3. 沉淀提取、主题聚类、去重、冲突、stale/superseded 状态机的确定性算法。
4. Quan / Yuan 的模块改动清单（精确到文件）、命令/MCP 参数（不新增顶层命令）。
5. 测试矩阵：parser、graph、search、context、audit、verify、MCP、增量、benchmark。
6. 分阶段实施顺序与每阶段验收标准。
7. 风险、边界情况、待决策问题。

约束：
- 先框架、后命令；命令只是现有能力的投影。
- 不要写代码，不要修改仓库文件；只输出计划。
- 保持中文，结论优先，给出精确路径。
```

---

（完）
