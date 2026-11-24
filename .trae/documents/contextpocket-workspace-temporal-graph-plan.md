# ContextPocket Yuan · 工作区时间图（阶段 A）实施计划

## Summary

在 yuan 增加一个**派生的跨口袋时间图**，把“api 在 T5 引用了 web:T9”从 verify 的校验项变成可遍历的边，并让 `context build/explain` 在显式 `--expand` 时把跨口袋邻居带进 Related 段。

本计划只做阶段 A：

- 跨口袋边只做**显式限定引用** `pocket:Tn`（`x-ref`）。
- 图缓存放工作区 `.contextpocket/workspace-graph.json`，按口袋增量重建。
- 时间过滤使用 WHEN 日期（不引入 format v3，不按 mtime 猜时间）。
- 不新增顶层命令，yuan 仍是 10 命令 / 10 工具。
- 不做 duplicate / shared-file / same-tag / temporal-near 边，留给阶段 B。

## 实施状态（已完成）

阶段 A 已按本计划落地：

- `shared/graph-core.js`：`parseCrossRefs` / `activeOnDate` / `buildAdjacency` / `expandByDate` / `blockText`，零依赖纯函数；已同步 `lib/` 与 `lang/lib/`（28 文件 / 64 副本）。
- `lang/lib/workspace-graph.js`：限定节点与边、`crossRefs` 缓存、按口袋签名的 `ensureWorkspaceGraph`、只读 `inspectWorkspaceGraph`、`resolveAsOfDate`。
- `lang/lib/context.js`：`--expand 1|2` 的 Graph 段、`--as-of`、默认 `expand=0` 输出不变；`sources.graph` / `sections.related.graph` / `explain` 行。
- `lang/lib/workspace.js` / `lang/lib/audit.js`：只读 `graph` 健康（present / fresh / nodes / crossPocketEdges / danglingCrossRefs）。
- CLI / MCP：`context` 增加 `expand` / `as-of`；命令面仍是 10 / 10。
- 测试：`tests/unit.js`（graph-core 纯函数）、`tests/lang.js`（x-ref、Graph 段、as-of、默认不建图、增量、悬空、status/audit、MCP）；`lite/tests/metrics.js` 基线按实测更新。
- 基准：`scripts/bench-workspace.js` 增加跨口袋引用、图全量 / fresh / 增量耗时、context expand 与图统计。
- 文档：`lang/README.md`、`lang/SKILL.md`、`CHANGELOG.md`、根 README 中英、四版本路线图。

## 实施状态（阶段 B 已完成）

阶段 B 在阶段 A 之上加入**显式开启的派生跨口袋边**，不做 PPR / 子命令：

- `--graph-edges duplicate|shared-file|tag|near|all`（必须搭配 `--expand`，默认不开启）；`--graph-near-days` 默认 7。
- 派生边：`duplicate-adr` / `duplicate-req` / `duplicate-pref`、`shared-file`、`same-tag`、`temporal-near`；全部 `evidence=weak`、`scope=cross`，只在对应 group 开启时参与 BFS。
- 偏好节点：`pocket:pref:<key>`，用 `preferences.md` 头部 `# Preferences · T<n>` 锚定；缓存升到 `version=2`，签名加入 `preferences.md`。
- 有界：同 key 最多 5 个口袋；near 每 key 20 对 / 总计 400 对；派生边总数 2000；`stats.truncated` 标记截断。
- Graph 段增加 `Derived: N edge(s) — ...` 汇总与最多 8 条示例；桥接节点（file / tag / pref）只在跨口袋命中时进入结果。
- 归一化与 `consolidate` 共用 `normalizeKey`；修正 `DEFAULT_RESULT_TYPES` 的需求类型为 `R`。
- 测试：graph-core 纯函数、派生边统计、`--graph-edges` 各 group、near 窗口、默认关闭、CLI/MCP schema 与参数守卫；基准新增 `context edges` 与派生边计数。
- 仍未做（阶段 C）：有界 PPR、`workspace graph build|view|verify` 子命令。

## Current State Analysis

### 已有能力

- [lib/links.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/links.js) 已有单口袋图缓存：`assets/graph.jsonl`、`GRAPH_SCHEMA='graph/3'`、源文件 sha1 签名、stale/corrupt 自愈。
- [shared/links-core.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/shared/links-core.js) 已有 `deriveLinks`、`expandGraph`、`rankNeighbors`、`activeAt`，但节点 id 是裸 `T5` / `adr:ADR-1`，时间轴是**口袋内数字 T id**，不能直接跨口袋比较。
- [lang/lib/context.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lang/lib/context.js) 的 Related 只有 workspace search + repo map，没有图。
- [lang/lib/diagnostics.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lang/lib/diagnostics.js) 已用一个正则扫描跨口袋引用，但这个信息只用于 verify 的 error/warning，没有成为边。
- [lang/lib/workspace.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lang/lib/workspace.js) 已有 `cacheDir(root)`、`readManifest`、`resolvePocket`、`parsePocketAll`；`workspace status` 已有 index / repo-map 健康摘要。
- [lang/lib/recap.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lang/lib/recap.js) 的 `whenDate(block)` 已统一处理 instant/day/range；`stated:` 返回空串。
- [lang/lib/repomap.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lang/lib/repomap.js) 已有 `.contextpocket/repo-map.json`，节点带 `pocket` / `path`。

### 缺口

1. 没有工作区级图缓存；跨口袋引用无法被 `context` 遍历。
2. 单口袋图的数字 T 有效期无法跨口袋比较，需要额外的 **WHEN 日期轴**。
3. `context` 的 Related 无法解释“为什么这个 web 轮次和 api 当前事实有关”。
4. `audit` 看不到图的节点/边/跨口袋边/悬空引用。
5. 大 workspace 下没有图的构建/增量重建基准。

## Scope & Decisions

### 本阶段做

- `shared/graph-core.js`：日期轴图原语 + 跨口袋引用解析 + 有界 BFS。
- `lang/lib/workspace-graph.js`：跨口袋图构建、缓存、增量、检查、扩展。
- `context build/explain --expand 1|2 [--as-of <date|pocket:Tn>]`：Graph 段进入 Related，随 Related 一起被预算裁剪。
- `workspace status` / `audit` 只读展示图健康。
- 基准与测试。

### 本阶段不做

- 不新增 `workspace graph` 子命令。
- 不做 duplicate / shared-file / same-tag / temporal-near 边。
- 不做全局 PageRank；只用确定性 BFS。
- 不修改 format v2，不引入时区字段。
- 不改 xi 的任何行为。

## Data Model

### 节点

工作区图节点 id 一律限定：

```json
{
  "id": "api:T5",
  "pocket": "api",
  "type": "T",
  "rawId": "T5",
  "label": "login flow",
  "archived": false,
  "date": "2026-11-02",
  "validFrom": 5,
  "validTo": null
}
```

- `T`：`pocket:T5`
- correction：`pocket:T5-fix`
- ADR：`pocket:adr:ADR-1`
- 需求：`pocket:req:R1`
- 文件：`pocket:file:src/a.js`
- tag：`pocket:tag:auth`

`date` 规则：

- 所有节点优先用 `validFrom` 数字回查该口袋的 T→日期表；
- T 节点的日期来自该轮 WHEN；
- ADR / 需求节点的日期来自 `recordedAt` / `validFrom` 对应轮次；
- file / tag 以及找不到日期的节点为 `date: null`；
- `stated:` 没有数值日期，按 `date: null` 处理。

### 边

阶段 A 只新增一种跨口袋边：

```json
{
  "from": "api:T5",
  "to": "web:T9",
  "type": "x-ref",
  "evidence": "strong",
  "basis": "qualified-ref",
  "date": "2026-11-02",
  "source": "api",
  "tId": 5
}
```

单口袋边保留原字段，只给 `from` / `to` 加口袋前缀，并加 `scope: "intra"`。跨口袋边加 `scope: "cross"`。

### 时间过滤

- `--as-of` 接受 `YYYY-MM-DD` 或 `pocket:Tn`。
- `pocket:Tn` 解析成该轮的 WHEN 日期；该轮没有日期时直接报错：
  `--as-of api:T5: that turn has no WHEN date; pass a date instead`
- 裸 `T5` 报错：
  `--as-of must be YYYY-MM-DD or pocket:Tn (got T5)`
- `as-of` 下：`date === null` 的节点不参与；`date <= as-of` 的节点参与。
- 边只要两端节点参与即可遍历；`x-ref` 自身日期只用于展示，不额外收紧。
- 绝不使用文件 mtime。

## Proposed Changes

### 1. 新增 `shared/graph-core.js`

纯函数、零 require，加入 `shared/manifest.json`，目标 `lib` + `lang/lib`（不进 lite）。

导出：

```js
CROSS_REF_RE
parseCrossRefs(text)        // [{ pocket, tId }] 去重、保持首次出现顺序
blockText(block)            // gist + sections 的纯文本，供引用扫描与 verify 共用
activeOnDate(record, date)  // date=null 时恒 true；date 非空时 null 日期不活跃
buildAdjacency(nodes, edges, options)
expandByDate(graph, seeds, depth, options)
```

`parseCrossRefs` 语义：只认 `[a-z][a-z0-9_-]*:T\d+`，大小写不敏感；`web:T3` 与 `web:t3` 归一成同一目标；同一段文本重复引用只保留一条。

`expandByDate`：

- `options.asOf`：日期串或 null。
- `options.depth`：1–2（上层已校验）。
- `options.maxNodes`：默认 50。
- `options.maxDegree`：默认 32，每个节点只保留排序后的前 N 条邻边。
- `options.exclude`：种子集合，结果不重复事实。
- `options.resultTypes`：默认 `['T', 'correction', 'ADR', 'req']`，file/tag 只作为过路节点，不直接输出。
- 邻接是双向的，但保留 `direction: 'outgoing' | 'incoming'`。
- 邻居排序：`id` → `type` → `direction`，保证确定性。
- 结果排序：`distance` → `scope cross 优先` → `date` 新在前 → `id`。
- 返回 `{ depth, asOf, results, hasMore }`，每项含 `id/type/label/archived/distance/scope/path`。

### 2. 修改 `lang/lib/diagnostics.js`

- 删除本地 `REF_RE` 与 `blockText`，改为从 `./graph-core` 导入。
- `verifyWorkspace` 的跨口袋引用循环改用 `parseCrossRefs(text)`。
- 行为与报错文本保持不变；这是去重，不是语义变更。

### 3. 新增 `lang/lib/workspace-graph.js`

职责：构建 / 读取 / 检查 / 增量 / 扩展。依赖：

- `readManifest/resolvePocket/parsePocketAll/cacheDir`（`./workspace`）
- `deriveLinks`、`GRAPH_SOURCE_FILES`（`./links`）
- `whenDate`（`./recap`）
- `parseCrossRefs`、`blockText`、`expandByDate`（`./graph-core`）
- `writeAtomic`（`./io`）

常量：

```js
const WORKSPACE_GRAPH_VERSION = 1;
const WORKSPACE_GRAPH_FILE = 'workspace-graph.json';
```

#### 缓存结构

```json
{
  "version": 1,
  "generatedAt": "2026-11-23T...",
  "workspace": "payments",
  "pockets": {
    "api": {
      "path": "services/api",
      "signature": { "log.md": "mtime:size", "...": "..." },
      "nodes": 42,
      "edges": 80,
      "crossRefs": [
        { "fromT": 5, "toPocket": "web", "toT": 9, "date": "2026-11-02" }
      ],
      "builtAt": "..."
    }
  },
  "nodes": [],
  "edges": [],
  "stats": {
    "nodes": 0,
    "edges": 0,
    "crossPocketEdges": 0,
    "danglingCrossRefs": 0,
    "byType": {}
  }
}
```

#### 函数

```js
workspaceGraphPath(root)
pocketSignature(pocketDir)          // 对 GRAPH_SOURCE_FILES 做 mtimeMs:size，读 0 字节
readWorkspaceGraph(root)            // 只读缓存；版本/JSON 不合法返回 null
inspectWorkspaceGraph(root)         // 呈现状态，不重建；返回 present/fresh/nodes/edges/crossPocketEdges/stalePockets/path
ensureWorkspaceGraph(root, opts)    // 懒构建 + 增量；返回 { graph, cacheStatus, rebuiltPockets, stats, path }
expandWorkspaceGraph(graph, seeds, depth, opts)
seedIdsFromSearch(rows)
seedIdsFromStatus(status)
resolveAsOfDate(root, value)        // 'YYYY-MM-DD' 原样；'pocket:Tn' 回查 WHEN；其余报错
```

`ensureWorkspaceGraph` 流程：

1. 读 manifest；读缓存。
2. 对每个口袋算 `pocketSignature`。
3. `stalePockets` = 新增 / 路径变化 / 签名变化 / 缓存缺失。
4. 对 stale 口袋：
   - `deriveLinks(pocketDir)` 拿单口袋节点/边；
   - `parsePocketAll(pocketDir)` 建 `T→日期` 表；
   - 节点加限定 id + `date`；
   - 边加限定 id + `scope: 'intra'`；
   - 扫描该口袋所有 T-block 文本，生成 `crossRefs`（只保留指向其他口袋的引用）。
5. 对 fresh 口袋：复用缓存里的节点/边/crossRefs。
6. 用全部 `crossRefs` 重建跨口袋边：
   - 目标节点不存在 → 跳过，`danglingCrossRefs++`；
   - 边去重 key：`from|to|x-ref`；
   - 加 `evidence: 'strong'`、`scope: 'cross'`、`basis: 'qualified-ref'`。
7. 全部节点按 id、边按 `from|to|type` 稳定排序。
8. `writeAtomic` 写缓存；返回 `cacheStatus: 'fresh' | 'partial' | 'rebuilt'`。
9. 缓存版本不符、JSON 损坏 → 视为全量 stale，直接重建，不报错中断。

`inspectWorkspaceGraph`：

- 只读缓存 + 重新算签名；
- `fresh = stalePockets.length === 0 && version 匹配`；
- `present=false` 时不报错；
- 返回 `stalePockets` 名称数组。

`resolveAsOfDate`：

- 日期形态直接返回；
- `pocket:Tn`：`readManifest` → 找到口袋 → `parsePocketAll` → `whenDate(block)`；
- 空日期报错；
- 裸 `Tn` / 非法形态按上面的错误文本报错。

### 4. 修改 `lang/lib/context.js`

`buildRelated(root, query, mapEnabled, graphOptions, status)`：

- 原有 Search / Repo map 完全不变。
- `status` 由 `buildContext` / `buildExplain` 传入（两者本来就已经调用 `statusWorkspace`），用于无 query 时生成种子。
- 新增 `### Graph`，仅当 `graphOptions.expand > 0`。
- 种子：
  - 有 query：`seedIdsFromSearch(search.results)`；
  - 无 query 或结果不足：`seedIdsFromStatus(status)` 的 recent / open requirements / ADRs；
  - 去重后最多 50 个。
- `ensureWorkspaceGraph(root)` 后 `expandWorkspaceGraph(...)`，`maxNodes: 30`。
- 每条：
  `- web:T9 · web endpoint (1 hop, cross)`
  `  Path: api:T5 → x-ref → web:T9 [api:T5 · 2026-11-02]`
- `exclude` 包含种子，避免重复 Facts。
- 返回对象新增 `graphNeighbors`、`graphPresent`、`graphCrossEdges`。
- Graph 文本并入 `related.content`，因此 `assemble` 仍只裁 Related → Facts，不新增裁剪层。

`buildContext` / `buildExplain`：

- 新增参数校验：
  - `expand`: 0/1/2，默认 0；其他报错。
  - `asOf`: 交给 `resolveAsOfDate`。
- `--as-of` 只在 `expand > 0` 时有效；给了 as-of 但 expand=0 报错：
  `--as-of requires --expand`
- `explain` 的 related 增加 `graph: { enabled, neighbors, crossPocketEdges, asOf }`。
- `renderExplain` 增加一行 Graph 统计。
- 默认（expand=0）输出逐字不变，现有测试不受影响。

### 5. 修改 `lang/lib/audit.js`

- `auditWorkspace` 增加 `const graph = inspectWorkspaceGraph(root)`（只读）。
- `health.graph = graph`。
- `totals.crossPocketEdges = graph.present ? graph.crossPocketEdges : 0`。
- `render` Health 段增加：
  - `- graph: fresh · 120 node(s) · 4 cross-pocket edge(s)`
  - 缺失：`- graph: missing (run "context build --expand 1")`
  - 过期：`- graph: stale (run "context build --expand 1" to rebuild)`
- 不因为图缺失/过期改变 `ok` 或 exit code；图是可选派生缓存。

### 6. 修改 `lang/lib/workspace.js` 的 `workspaceHealth`

- 延迟 require `./workspace-graph`，与 index/repo map 一致，避免模块环。
- `health.graph = inspectWorkspaceGraph(root)`。
- 返回字段：`present/fresh/nodes/edges/crossPocketEdges/builtAt/stalePockets/path`。
- 失败时降级为 `{ present:false, error }`，不影响 status。

### 7. 修改 CLI 与 MCP

[lang/bin/context-pocket-yuan.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lang/bin/context-pocket-yuan.js)：

- `cmdContext` 读取 `options.expand`、`options['as-of']`，传入 `buildContext/buildExplain`。
- `cmdStatus` 增加 `graph:` 行（读 `result.health.graph`）。
- `cmdAudit` 不需要新旗标；结果里已带 graph。

[lang/mcp-server-yuan.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lang/mcp-server-yuan.js)：

- `context_pocket_context` schema 增加：
  ```json
  "expand": { "type": "integer", "enum": [1, 2], "description": "Add cross-pocket graph neighbors (builds the derived graph on first use)" },
  "asOf": { "type": "string", "description": "YYYY-MM-DD or pocket:Tn; requires expand" }
  ```
- `toolContext` 透传 `expand` / `asOf`。

[lang/lib/help.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lang/lib/help.js)：

- context usage 增加 `--expand <1|2>`、`--as-of <date|pocket:Tn>`。
- audit 说明增加 Graph 健康行。
- `TOOL_DESCRIPTIONS.context_pocket_context` 与 `context_pocket_audit` 同步。

### 8. `lang/edition.json`

- `derivedCaches` 追加 `"workspace-graph"`。
- `commands` / `tools` 保持 10，不新增命令。

### 9. 基准

[scripts/bench-workspace.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/scripts/bench-workspace.js)：

- 合成日志中每隔 100 轮加入一条跨口袋引用（如 `depends on svcN:Tn`），确保有真实 `x-ref` 边。
- 新增：
  - `ensureWorkspaceGraph(root)` cold 构建时间；
  - `graphNodes` / `graphCrossEdges`；
  - `context build --expand 2` 的 cold / warm 延迟；
  - 单口袋变更后的增量重建时间与 `rebuiltPockets`。
- 输出与 `--json` 都增加这些字段；不设硬阈值。

### 10. 测试

`tests/unit.js`：

- `parseCrossRefs`：限定 id、去重、大小写、忽略裸 `T1` 与非 T 目标。
- `activeOnDate`：null / 点日期 / 无日期节点。
- `expandByDate`：确定性、双向、maxDegree、maxNodes、resultTypes 过滤、exclude。

`tests/lang.js` 新增：

1. **跨口袋图 + context expand**：api T1 引用 `web:T1`；`context build --expand 1 --query ... --json` 的 content 含 `web:T1`、`x-ref`、`api:T1 → web:T1`。
2. **as-of 日期过滤**：web T1 日期 `2026-11-02`；`--as-of 2026-11-01` 不出现，`--as-of 2026-11-03` 出现。
3. **as-of 限定 id**：`--as-of api:T1` 使用该轮 WHEN；无 WHEN 的轮次报错；裸 `T1` 报错；`--as-of` 但没有 `--expand` 报错。
4. **默认不变**：`context build`（无 expand）不出现 Graph 段，也不创建 `.contextpocket/workspace-graph.json`。
5. **增量**：直接调用 `ensureWorkspaceGraph`；第二次 `cacheStatus='fresh'`；改 web 后 `rebuiltPockets=['web']`。
6. **悬空引用**：指向 `web:T99` 的引用不建边，`stats.danglingCrossRefs=1`；audit 不炸。
7. **status / audit 健康**：`workspace status --json` 的 `health.graph.present`；`audit --json` 的 `health.graph.crossPocketEdges`。
8. **MCP**：`context_pocket_context` 传 `expand:1` 能返回 Graph 段；`tools/list` schema 含 `expand`/`asOf`。

### 11. 文档

- `lang/README.md`：context 段落增加 `--expand` / `--as-of` 与 Graph 段说明。
- `lang/SKILL.md`：context 意图行补 Graph 去重与 `as-of` 规则。
- `CHANGELOG.md` [Unreleased]：新增“工作区时间图（阶段 A）”小节。
- `.trae/documents/contextpocket-3.0-four-editions.md`：阶段 2.5 增加一行图缓存。
- `README.md` / `README.zh-CN.md`：yuan 版本详解补一句“context --expand 带跨口袋来源”。

## Assumptions & Decisions

1. **时间轴用日期，不用数字 T**：数字 T 只在同一口袋内可比；跨口袋必须用 WHEN 日期。`stated:` 与无 WHEN 视为无日期。
2. **图是可选派生缓存**：默认 context / status / audit 不建图；`--expand` 首次构建，`workspace status` / `audit` 只读检查。
3. **只做显式 x-ref**：不做时间接近推断，不做 shared-file / duplicate / tag 边。避免第一版就引入噪音。
4. **不新增命令**：扩展 `context` 的旗标；`commands` / `tools` 仍是 10。
5. **缓存放工作区**：`.contextpocket/workspace-graph.json`，不写各口袋的 `assets/graph.jsonl`。
6. **增量粒度是口袋**：一个口袋变化只重建该口袋子图；跨口袋边由缓存的 `crossRefs` 全量重算（成本低）。
7. **有界扩展**：`maxNodes=30`（context）、`maxDegree=32`、`depth=1|2`；结果类型只输出 T/correction/ADR/req。
8. **xi 不动**：不把 graph-core 复制进 `lite/lib`，xi 继续 5 文件、零缓存。

## Verification

1. `node tests/run.js` 全绿。
2. `npm run lint` 全绿。
3. `node scripts/sync-core.js` 显示新增 `graph-core.js` 后仍逐字一致（预计 28 文件 / 64 副本）。
4. `npm run smoke` / `npm run smoke-live` 全绿。
5. `node scripts/bench-workspace.js --pockets 10 --turns 1000 --runs 3`：
   - 报告 graph build cold/warm、graph nodes/cross edges；
   - context expand 2 的 cold/warm；
   - 单口袋变更后的增量重建时间。
6. 包体积/文件数基线按实测更新 `lite/tests/metrics.js`（预计 full 文件数 82）。

## Out of Scope（阶段 C）

- 候选子图上的有界 PPR。
- `workspace graph build|view|verify` 子命令。

阶段 B 已完成：`duplicate-adr` / `duplicate-req` / `duplicate-pref`、`shared-file`、`same-tag`、`temporal-near` 均由 `--graph-edges` 显式开启。
