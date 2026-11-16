# Changelog

All notable changes to ContextPocket will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [2.11-lite] - 2026-11-16

### ContextPocket Lite 2.11 — 隔离开关（稳定版）

> Lite 独立版本线发 `2.11`（对外展示 `2.11-lite`，稳定通道）；主包版本线同日发 `2.11`。
> 仍然零缓存、零依赖、11 命令 / 11 工具。细节见 [`lite/CHANGELOG.md`](lite/CHANGELOG.md)。

- **隔离开关**：测试文件夹里的项目 / 跑一次性实验 / CI 评测时，本轮完全不读旧上下文、也不把测试轮次写回真实历史。三层按强度递增：环境变量 `CONTEXTPOCKET_ISOLATED`、项目根标记 `.contextpocket-isolate`、物理改名 `ContextPocket.isolated/`。CLI `main()` 与 MCP `tools/call` 各一处统一拦下所有读写，`status` 是唯一例外（只回 `{ok,isolated,source}`，不碰历史）。
- **两包同源**：`lib/isolate.js` 与主包逐字一致，`detectIsolation` 结果由 compat `deepStrictEqual` 锁死。
- **诚实边界**：口袋是纯 Markdown，挡不住主动翻目录的 Agent；要物理级保证用第三层。SKILL.md 加 HARD RULE 要求 Agent 隔离态不发起读取。
- **升级动作**：无（数据格式仍 v2）。**破坏性**：无（命令 / 工具面不变）。

## [2.11] - 2026-11-16

### ContextPocket 2.11 — 隔离开关：测试运行完全不读旧上下文

- **隔离开关（新模块 `lib/isolate.js`，两包逐字同源）**：面向「测试文件夹里的项目 / 一次性实验 / CI 评测」——本轮既不能读到之前的上下文，也不能把测试轮次写回真实历史。三层开关按强度递增：① 环境变量 `CONTEXTPOCKET_ISOLATED=1`（一条命令 / 这次 CI，不落盘）；② 项目根标记文件 `.contextpocket-isolate`（touch 即开、删掉即关，向上最多找 5 层）；③ 物理隔离 `ContextPocket/` → `ContextPocket.isolated/`（常规路径下历史不在原位，工具检测到该目录同样进入隔离态）。
- **一处拦住两个入口**：CLI `main()` 在碰任何口袋文件之前统一拦截（`bin/context-pocket.js`），MCP `handleToolsCall` 在工具分发之前统一拦截（`mcp-server.js`）；读、写都不放行。`status` 是唯一例外，只报隔离态本身 `{ok:true,isolated:true,source,reason}`，一个字节的历史都不读；`--version` / `help` 照常。`--json` 出口给机器可读的 `{ok:false,error:'isolated',source,reason,command,message}`，CLI 退 1、MCP `isError:true`。
- **跟着 `--dir` 走**：CLI 隔离检测的目标与命令一致——`getProjectDir(options)` + `findPocketDir`，`recall --dir <被隔离项目>` 从别处 cwd 也拦得住，不会绕过门读到历史。MCP 工具全程以进程 cwd 定位项目（无 per-tool `dir`），故按 cwd 检测。
- **诚实边界**：口袋是纯 Markdown，Agent 有文件系统访问权时没有任何开关能阻止它主动翻目录；要物理级保证用第三层（或把目录移出项目）。SKILL.md / lite SKILL.md 加 HARD RULE，要求 Agent 隔离态把项目当全新、不发起任何读取。
- **回归与基线**：两包 CLI 隔离用例（标记 / env / 物理三层 + `--dir` 绕过回归 + 解除后恢复）、两包 MCP 经 wire 拒绝用例（`isError` + 不漏 gist + `status` 只报隔离）、compat「两包 `detectIsolation` 逐字一致」；metrics 追平 30 / 68 文件与 130.2 / 440.6 kB（新增 `lib/isolate.js` 各 +1，惰性 require 冷启动模块数仍 17）；四门禁全绿。
- **升级动作**：无。**破坏性**：无（数据格式仍 v2，命令 / 工具面不变）。

## [2.10-lite] - 2026-11-15

### ContextPocket Lite 2.10 — 读侧接手视图 + 定位收口

> Lite 独立版本线发 `2.10`（对外展示 `2.10-lite`，稳定通道）；主包版本线同日发 `2.10`。
> 两条版本线仍是独立的，只是数字对齐。细节见 [`lite/CHANGELOG.md`](lite/CHANGELOG.md)。

- **读侧闭环**：`handoff --read` 输出 `0 · Start here` 接手视图，比对 `generated-at` 与 log 最新 T，过期即拒绝并退出非 0；`--force` / `--full` / `--json` 可选。不新增命令或 MCP 工具。
- **定位**：明确为「辅助上下文记忆 + 跨对话、跨 Agent 记忆」，交接只是其中一种用法；仓库描述、topics、双语 README 首屏与独立章节同步。
- **剧本与格式规范**：`docs/handoff-scenario.md`（四幕，明确不含 benchmark 指标）、`docs/format-spec.md` + 金样本 + `scripts/verify-format.js`。
- **升级动作**：无（数据格式仍 v2）。**破坏性**：无。

## [2.10] - 2026-11-15

### ContextPocket 2.10 — 读侧接手视图 + 跨 Agent 剧本 + T-block 格式规范

- **读侧闭环**：新增 `handoff --read`（`lib/handoff-path.js` 的 `readHandoffView()`，两包逐字同源）：默认只给带 STOP CONDITION 的 `0 · Start here`，`generated-at` 落后于 log 最新 T 时拒绝输出并退出 1，`--force` 放行、`--full` 全文、`--json` 结构化，并列出 ❓ 待确认清单。**命令面与 MCP 工具面不变**。
- **参数解析修正**：`read` / `force` / `full` 补进两包 `parseArgs` 的布尔选项集合，否则 `--read --force` 会把 `--force` 吞成前者的值、开关永远不生效。
- **定位收口**：按「辅助上下文记忆 + 跨对话、跨 Agent 记忆」改写双语 README 首屏定位句，新增独立章节串联 T-block 时间线、约束文件、带来源关联图与 handoff 视图；原有记忆主线保留（双轨）。仓库描述与 8 个 topics 同步。
- **交接剧本**：`docs/handoff-scenario.md` 四幕可复现流程（换 Agent 接手 → 并发撞号 repair → `--as-of` 历史切片 → import 外部历史），开头声明不是 benchmark；`tests/pocket.js` 新增端到端回归。
- **开放格式第一步**：`docs/format-spec.md`（format v2 描述性规范：编号只增、只追加、冲突可见、边带来源、session 重建）+ 金样本 + `scripts/verify-format.js`（零依赖、独立实现、16 条校验、支持 `--dir`）。
- **回归与基线**：两包 `readHandoffView` 逐字一致（compat 新锁）、Lite CLI 读侧用例、metrics 追平 29 / 67 文件与 127.3 / 436.0 kB；四门禁全绿。
- **升级动作**：无。**破坏性**：无（数据格式仍 v2，命令 / 工具面不变）。

## [2.8-lite] - 2026-11-15

### ContextPocket Lite 2.8 — 三段式交接 + 带来源的节点链

> Lite 独立版本线发 `2.8`（对外展示 `2.8-lite`，稳定通道）；主包版本线同日发 `2.6`。
> 交接摘要从「一页摊平」升级为「必读 / 按需 / 指针」三段，能力面不变。
> 细节见 [`lite/CHANGELOG.md`](lite/CHANGELOG.md)。

- **交接强化**：`handoff.md` 三段式（0 Start here / 1 On demand / 2 Pointers）+ 开头 STOP CONDITION；每节硬上限，截断如实写出「还有多少、去哪看」。
- **节点链**：以未完需求 + 最近 3 个 T 为种子，按边类型规则表行走关联图，链上每步带 `[T<n>]` 来源；`supersedes` 剪枝，被取代的旧 ADR 不进 Key Decisions。
- **纯派生**：不引入向量、权重学习或缓存，数据格式仍 v2；两包 `handoff.md` 逐字同源（compat 新增回归锁）。
- **升级动作**：重跑一次 `handoff` 重新生成交接摘要。**破坏性**：无。

## [2.6] - 2026-11-15

### ContextPocket 2.6 — 三段式交接 + 带来源的节点链 + 安全政策

- **交接强化**：`handoff.md` 由 12 节平铺改为三段式 —— 首段含 STOP CONDITION、项目身份、State / Pitfalls、🔒 红线、❓ 待确认、Next；按需段放节点链、最近轮次、未完需求、当前有效 ADR、限额 Code Map；指针段列真值文件与命令。
- **节点链（新模块 `lib/handoff-path.js`）**：从「接下来要做的事」出发按边类型死表行走，复用 `deriveLinks()` 与 `activeAt()` 剪掉失效节点，每步带 `direction` / `source` / `[T<n>]`，8 链安全上限 + `hasMore` 如实提示。规则可复现、可审计，不含向量或学出来的权重。
- **失效决策过滤**：被 `supersedes` 取代的旧 ADR 不再进 Key Decisions，链尾标注剪枝原因；parser 字段与图边取并集。
- **文档与安全**：双语 README 首屏补「Handoff, not just memory」定位句；新增 [`SECURITY.md`](SECURITY.md)（支持版本、私下报漏洞、安全模型、不做静态加密声明）；修掉 4 处残留旧版本文案；`CONTRIBUTING.md` 的徽章说明追平。
- **两包同源**：`generateHandoff` 与新增模块在完整包 / Lite 之间逐字同源，`lite/tests/compat.js` 新增「同一口袋 handoff.md 逐字一致」回归锁。
- **升级动作**：重跑一次 `handoff` 重新生成交接摘要（旧文件头部不变，stale 检查不会误报）。**破坏性**：无（数据格式仍 v2，CLI / MCP 命令面与返回形状不变）。

## [2.7-lite] - 2026-11-15

### ContextPocket Lite 2.7 — 省 token 输出分级 + 精确 T-id 捷径（preview 线定版）

> Lite 独立版本线发 `2.7`（对外展示 `2.7-lite`，稳定通道）；主包版本线同日发 `2.5`。
> 把 `2.6-Lite-preview` / `preview2` / `preview3` 三轮预览冻结为稳定版，能力面不变。
> 细节见 [`lite/CHANGELOG.md`](lite/CHANGELOG.md)。

- **省 token 输出分级**：`search` / `why` 默认每命中一行，`recall` 默认仍完整、`--brief` 只看关键事实；`--full` 恢复预览、`--json` 永远完整。只动渲染不动数据，compat 整图/命中 `deepStrictEqual` 仍严格绿。
- **性能**：精确 T-id 块定位捷径（与主包同源），无索引 1000 轮夹具 ~5.5×。
- **图**：`search` / `why` 的 `--expand` 100 节点安全上限、截断如实提示；两包整图逐字同源。
- **升级动作**：无（数据格式仍 v2，零缓存）。**破坏性**：无。

## [2.5] - 2026-11-15

### ContextPocket 2.5 — 关联图两包同源 + 精确 T-id 性能 + 文档分层（preview 线定版）

> 主包版本线发 `2.5`（稳定通道），把 `2.4-preview` / `preview2` / `preview3` 三轮预览冻结为稳定版；
> Lite 同日发 `2.7-lite`。

- **关联图两包同源**：tag / requirement 节点与 tagged / opened-in / completed-in / implements 边回移完整包，两包对同一份口袋派生逐字一致的整图（6 类节点 / 10 类边）；缓存 schema `graph/3`，旧缓存自动重建。
- **性能**：精确 T-id 块定位捷径 + 现场扫描跳过无关元数据，无索引 1000 轮夹具 ~5.0×；索引 / 关键词 / recall 与命中形状不变。
- **稳健性**：写入锁竞态修复（原子 rename 回收 + 凭据核对释放）、code-map 占位过滤加固。
- **文档分层**：CHANGELOG 旧版施工记录逐字移入 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md)，主文件每版只留摘要 + 指针；README 双语补版本线说明。
- **升级动作**：无（数据格式仍 v2；graph 旧缓存判过期自动重建）。**破坏性**：无。

## [2.6-Lite-preview3] - 2026-11-14

### ContextPocket Lite 2.6-Lite-preview3 — 精确 T-id 块定位捷径 + 省 token 输出分级

> Lite 独立版本线发 `2.6-Lite-preview3`（preview 通道）；主包版本线同日发 `2.4-preview3`。
> 两包共享精确 T-id 块定位捷径（性能）；Lite 另加省 token 输出分级——默认渲染精简，
> 数据一个字节不减，所有原文经 `--full` / 不加 `--brief` / `--json` 可达。能力面不变。
> 细节见 [`lite/CHANGELOG.md`](lite/CHANGELOG.md)。

## [2.4-preview3] - 2026-11-14

### 精确 T-id 块定位捷径（两包同源）

- **性能（两包）**：精确 T-id（如 `T300`）搜索新增块定位快路径——先按 plausible
  header 定位到目标块、只解析那一块，并从最近的前置 SESSION 行重建 session，
  不再逐文件全量解析。`log.md` 优先；畸形 id（>1e7）回退逐文件全量解析。
  无索引 1000 轮夹具实测：完整包 31.6→6.3ms（~5.0×）、Lite 38.1→6.9ms（~5.5×）。
  索引路径、关键词搜索、recall 与命中形状均不变。
- **回归锁**：新增「精确 T-id 块定位快路径与索引全量解析逐字一致」测试，覆盖
  session 重建 / 归档优先 / 补零 / 畸形回退 / 缺失；两包快路径逐字同源，
  命中一致性仍由 compat 套件钉死。

## [2.6-Lite-preview2] - 2026-11-13

### ContextPocket Lite 2.6-Lite-preview2 — 精确 T-id 扫描两包同序

> Lite 独立版本线发 `2.6-Lite-preview2`（preview 通道）；主包版本线同日发 `2.4-preview2`。
> 本次只动性能与回归锁，能力面不变；Lite 产品代码无改动，随主包版本线同步升版。
> 细节见 [`lite/CHANGELOG.md`](lite/CHANGELOG.md)。

## [2.4-preview2] - 2026-11-13

### 精确 T-id 现场扫描跳过无关元数据（P2 回移）

- **性能（完整包）**：精确 T-id（如 `T300`）的现场扫描原先先 `collectDocs` 解析
  偏好/决策/需求再走捷径；现将只读轮次日志的捷径提前到 `collectDocs` 之前，
  无索引精确搜索提速 1.5–2.5×，并从「慢于 Lite」翻转为「快于 Lite」。索引路径
  与命中形状不变（compat 套件锁 parity）。
- **回归锁**：新增读探针测试，断言精确 T-id 扫描零元数据读取，并以非 T-id 关键词
  作负对照（旧序红、新序绿）。
- **metrics**：旧「Lite 精确搜索必须更快」断言被本次改动推翻，改为单向带宽
  「完整包不得慢过 Lite 2×」，5000 行偏好夹具下回退旧序仍会当场红。

## [2.6-Lite-preview] - 2026-11-12

### ContextPocket Lite 2.6-Lite-preview — 图扩展安全上限 + 两包整图同源

> Lite 独立版本线发 `2.6-Lite-preview`（preview 通道）；主包版本线同日发 `2.4-preview`。
> 图扩展加 100 节点安全上限、截断如实提示；写入锁竞态、占位过滤两包同修；
> 两包整图逐字同源由 compat 套件钉死。细节见 [`lite/CHANGELOG.md`](lite/CHANGELOG.md)。

## [2.4-preview] - 2026-11-12

### 关联图两包同源 + 写入锁竞态修复

- **图派生回移（完整包）**：Lite 2.4/2.5 先行实现的 `tag` / `requirement` 节点与
  `tagged` / `opened-in` / `completed-in` / `implements` 四类边回移到完整包，
  两包对同一份口袋派生**逐字一致的整图**（6 类节点 / 10 类边）。
  `requirements.md` 成为第五个签名源文件；缓存 schema 升为 `graph/3`，
  `graph/1` / `graph/2` 旧缓存判 corrupt 自动重建。CLI / MCP / help 的边类型
  清单同步补齐；`search --expand` 的需求行（R）现在也能作图扩展种子；
  缓存序列化不再丢需求节点的 `status` 字段。
- **占位过滤加固（两包）**：code-map 树里的 `<entry-file>` / `<subdir-1>/` 等
  模板占位不建节点、不建边；目录占位带尾斜杠的形态此前会漏过过滤，已修。
  需求条目的占位文本 / 占位 impl / 占位标签同样跳过。
- **写入锁竞态修复（两包 io.js）**：stale 锁回收从「直接 unlink」改为「原子
  rename 后删除」，避免误删别人抢先回收后新建的锁；释放锁时核对锁文件里的
  pid/at 凭据，只删自己写的那把 —— 持锁超时被回收后不再误删新持有者的锁。
- **Lite 图扩展安全上限**：`expandFrom` 与主包同口径 —— 种子去重、过滤不存在
  的节点、最多 100 个节点；截断时 `search` / `why` 如实提示（`--json` 的
  `expansionTruncated` / `expanded.truncated`，人读与 MCP 输出带可见说明），
  不再静默丢掉超出的关联轮次。
- **compat 契约升级**：`lite/tests/compat.js` 删除 SHARED_*_TYPES 白名单，
  改为整图 `deepStrictEqual` 一致 + 100 节点截断两包对齐；夹具覆盖全部
  10 类边 / 6 类节点，一致性不再可能靠「两边都空」空转。
- **文档**：README（双语）/ SKILL / lite README / docs/MIGRATION 的节点、边、
  源文件清单与 graph schema 说明同步到 graph/3。

## [2.5-lite] - 2026-11-09

### ContextPocket Lite 2.5 — 补块、对比、交接，仍是零缓存

> Lite 独立版本线发 2.5（对外展示 `2.5-lite`）；主包版本线保持独立（当前 2.3）。

- **能力对齐**：新增 `log amend`（只补缺失小节）、`diff`（两轮之间的需求/ADR/文件变化）、
  `handoff`（生成 `ContextPocket/handoff.md`）；`search` / `why` 新增 `--expand <1-3>`，沿运行时
  派生图把关联轮次追加在结果之后（默认 0，输出逐字不变）。
- **稳健性**：MCP `context_pocket_graph` 的边类型枚举从 6 种补到 10 种；`log amend` 保留
  块头的时间行，已记录的时刻不被覆盖。
- **性能**：`recall <T-id>` 的 `rawText` 只读该块所在文件并校验块头，输出逐字节不变。
- **文档与抄本**：Lite README / SKILL 按 11 条命令更新，清理不存在的选项写法；版本同步为
  `2.5` / `2.5-lite`。细节见 [`lite/CHANGELOG.md`](lite/CHANGELOG.md)。

## [2.4-lite] - 2026-11-09

### Lite 查询优化

- Lite 对精确 `T<n>` 搜索现在只解析活动与归档日志，不再为定位单轮而解析无关的决策、需求和偏好文件；搜索结果与完整包扫描保持一致。

## [2.3] - 2026-11-09

### 多跳图上下文与历史有效期

> ContextPocket-2.3 增加带来源的多跳图上下文与历史时间切片；Lite 同步图节点/边的时间字段，
> 继续保持无缓存、同源 schema。

- **`search` / `why` 多跳扩展**：完整包支持 1–3 跳图上下文，保留原始文本命中顺序，并为每条路径展示边方向、关系、来源与 T-id；弱证据边不参与扩展，最多展示 100 个图节点。
- **历史有效期**：`--as-of <T>` 按图事实的记录时间与有效区间筛选上下文。显式 `Corrects T<n>` 关闭被更正轮次的事实边；ADR `Supersedes` 关闭旧决策的有效期，边界为不包含的 T-id。
- **图缓存 schema 升级**：完整包缓存升级为 `graph/2`，旧版缓存会被判定为过期并自动重建。
- **Lite schema 一致性**：Lite 同步派生 `recordedAt`、`validFrom`、`validTo` 字段；不增加图缓存或多跳扩展，仍只读写 Markdown 源文件。
- **双语使用文档**：更新 CLI、MCP 的 `search` / `why` 用法，以及 2.3 / 2.3 Lite 下载入口。

**验证**：完整测试、lint、MCP smoke 全部通过；主包与 Lite 的 ZIP 资产基于各自发布白名单打包。

---

## [2.2] - 2026-11-08

### 关联图层接进意图表 + 文档话术中性化

- **新增**：SKILL / README 意图表接入 `recall --with-context` 与 `graph`，并新增「什么时候该用图」一节（问关系用图，问内容用 recall / search）。
- **文档**：首屏补关联图能力与版本徽章；意图表列头从「用户怎么说」改为纯意图，不再规定开口话术；来源标注中性化（结论保留、来源去掉）。
- **测试**：Lite 冷启动模块数只统计项目目录（去 IDE shim 干扰，基线 17 不动）；体积基线容差改百分比（1%，且 ≥2 kB）。
- **升级动作**：无（产品代码零改动，仅版本抄本到 2.2）。**破坏性**：无。

> 完整施工记录（file:line、用例计数、逐日明细）见 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md) 的 `[2.2]` 一节。

---

## [2.0.1-hotfix1] - 2026-11-08

### 2.0 review 修复 + 对外展示层

- **新增**：主包 `--version` 补对外展示版（`DISPLAY_VERSION`：稳定版两位、预发布 / hotfix 显示完整串），`--json` 加 `display` 字段，与 Lite 同形。
- **修复**：版本抄本锁正则兼容 prerelease 后缀；Lite 版本线独立推进并加自己的抄本锁。
- **维护**：tag 去 `v` 前缀（直接用版本号），CI 闸门认 `['[0-9]*', 'v*']`。
- **升级动作**：无。**破坏性**：无。

> 完整施工记录（file:line、用例计数、逐日明细）见 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md) 的 `[2.0.1-hotfix1]` 一节。

---

## [2.0.0] - 2026-11-08

### ContextPocket 2.0：节点式关联图 + Lite 独立轻量包

- **新增**：`lib/links.js` 确定性派生关联图（modifies / mentions / references / decided-in / supersedes / last-changed 六类边，可溯源）；`recall --with-context` 入向上下文；`graph` 命令 + `assets/graph.jsonl` 缓存（可删派生索引，读取自愈、逐字节重建）。
- **Lite 独立包**（`lite/`）：8 命令 / 8 工具、5 核心文件，搜索现场扫、图运行时派生，零缓存。
- **修复**：主包空 requirements 解析补 `implausible` 数组，避免 verify TypeError。
- **升级动作**：无（数据格式不变，v1 口袋零改动可读；graph 缓存是可选派生物）。**破坏性**：无（交互层新增，命令名 / 格式兼容）。
- 本节含 2.0 路线图与 Phase 0 / Phase 1 的完整施工记录，详见归档。

> 完整施工记录（file:line、用例计数、逐日明细）见 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md) 的 `[2.0.0]` 一节。

---

## [1.6.1] - 2026-11-08

### tag 归位 + CI 给发版 tag 上门禁

- **维护**：force-move `v1.5.1` tag 到含修复的提交（外部动作，需维护者授权；已 clone 旧 tag 者需 `git fetch --tags --force`）。
- **CI**：`on.push` 增加 `tags: ['v*']`，每个发版 tag 用自己的代码再跑四道门禁；CONTRIBUTING 改为「推 tag → 等绿 → 建 Release」。
- **升级动作**：无（产品代码零改动）。**破坏性**：无。

> 完整施工记录（file:line、用例计数、逐日明细）见 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md) 的 `[1.6.1]` 一节。

---

## [1.6.0] - 2026-11-08

### npm 首发离线部分就位（包本身仍未发布）

- **新增**：`package.json` 补 repository / homepage / bugs；CONTRIBUTING 补 npm publish SOP（adduser + 2FA → 占名自查 → pack 复核 → publish → 验收）。
- **文档**：README「尚未发布」改成可自查说明（Release / clone 是唯一渠道、`npm view` 404 正常、首发后要替换哪段）。
- **回归锁**：包元数据 / 白名单锁 + 「发布流程必须含 npm publish」「README 必须保留未发布哨兵」锁（真发布那天会红，提醒同步文档）。
- **升级动作**：无。**破坏性**：无。**注**：本版发 GitHub tag / Release，`npm publish` 未执行。

> 完整施工记录（file:line、用例计数、逐日明细）见 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md) 的 `[1.6.0]` 一节。

---

## [1.5.3] - 2026-11-08

### 版本号六处抄本全部锁住

- **回归锁**：`every copy of the skill version` 用例补 docs 三处锚点（COMPATIBILITY / FAQ / MIGRATION），每处用「换成 9.9.9」反证真会报红。
- **文档**：CONTRIBUTING 改「真值 1 处 + 抄本 6 处」；tag 步骤从 annotated 改 lightweight（与历史 tag 一致）。
- **升级动作**：无（产品代码零改动）。**破坏性**：无。

> 完整施工记录（file:line、用例计数、逐日明细）见 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md) 的 `[1.5.3]` 一节。

---

## [1.5.2] - 2026-11-08

### CI 加固：code-map rename 用例不再赌时间精度

- **修复**：`rename 按 size+mtime 配对` 用例把两个文件的体积与 mtime 显式错开，避免 Linux 同毫秒写入撞键（1.5.0 / 1.5.1 两次 CI 挂在此，本地 Windows 一直绿）。产品代码与「歧义不配对」保护分支未动。
- **升级动作**：无。**破坏性**：无。

> 完整施工记录（file:line、用例计数、逐日明细）见 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md) 的 `[1.5.2]` 一节。

---

## [1.5.1] - 2026-11-07

### recall 时间窗口：没有关键词也能按坐标翻历史

- **新增**：`recall` 窗口模式（不给 T 号、给 `--since / --until / --from / --to`），按 T 号升序列时间线，与 `search` 共用同一份窗口判据；含归档轮次。给 T 号时行为不变。
- **契约**：T 号与窗口互斥，明确报错不静默丢旗标；MCP `tId` 不再 required，新增窗口参数。
- **升级动作**：无（数据格式 / 模板 / 索引 / 迁移未动，老口袋零成本）。**破坏性**：无。

> 完整施工记录（file:line、用例计数、逐日明细）见 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md) 的 `[1.5.1]` 一节。

---

## [1.5.0] - 2026-11-07

### code-map update 智能增强

- **新增**：`--diff`（git-status 风格 A/M/R/D 清单，dry run）、`--auto-suggest`（从 log Action 给无描述文件建议一句话）、`--apply`（采纳建议）、`--interactive`（逐条补全）。改名继承描述（git mv 语义）。
- **缓存**：新增 per-pocket `assets/code-map-cache.json`（v1，记 size + mtime）；首扫 / 坏缓存自动回退旧比对，绝不拦更新。
- **升级动作**：无（数据格式仍 v2，code-map.md 结构不变，老口袋零迁移）。**破坏性**：无。

> 完整施工记录（file:line、用例计数、逐日明细）见 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md) 的 `[1.5.0]` 一节。

---

## [1.4.1] - 2026-11-07

### 1.4.0 的教训落成回归锁

- **回归锁**：新增 textOption 值选项锁（对称 intOption），扫所有 textOption 读取键断言旗标真吃到值——再忘登记 VALUE_OPTIONS 当场红。
- **清理**：删 1.4.0 调试残留 console.error，换前置断言。
- **升级动作**：无（纯测试改动，零运行时变更）。**破坏性**：无。

> 完整施工记录（file:line、用例计数、逐日明细）见 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md) 的 `[1.4.1]` 一节。

---

## [1.4.0] - 2026-11-07

### 时间窗口搜索

- **新增**：`search` 的 `--since / --until`（T 号窗口）与 `--from / --to`（自然日窗口），四种可混用，闭区间；索引 / 扫描双路径共用 `filterByTime`。
- **索引**：INDEX_VERSION 5 → 6，老缓存自动作废重建（无感）。
- **升级动作**：无（数据格式仍 v2，老口袋直接用）。**破坏性**：无。

> 完整施工记录（file:line、用例计数、逐日明细）见 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md) 的 `[1.4.0]` 一节。

---

## [1.3.1] - 2026-11-07

### 查询侧更正闭环 + verify 降噪提速 + CI 门禁

- **新增**：`recall` 带回 `corrections`；`search` 搜得到 `T<n>-fix` 更正块（双路径同命中）；`check-conflicts` 不再拿被更正的原话报冲突。
- **优化**：verify 去重复解析（`mergeLogs` 合并层）；漂移检查对「创建后被删 / 改名」降噪。
- **CI**：新增 `.github/workflows/ci.yml`，push main / PR 跑四道门禁。
- **升级动作**：无（格式仍 v2；索引升 v5，老缓存自动重建）。**破坏性**：无。

> 完整施工记录（file:line、用例计数、逐日明细）见 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md) 的 `[1.3.1]` 一节。

---

## [1.3.0] - 2026-11-07

### verify 语义层 + 帮助文本单源 + 活测进门禁

- **新增**：verify 三类跨轮矛盾检测（Action ↔ code-map 漂移、重复创建声明、决策 vs 更正），均 WARNING 起步不拦提交；parser 认识 `T<n>-fix` 更正块（修串扰）。
- **重构**：帮助文本收进 `lib/help.js` 单源（CLI / MCP 纯搬运，逐字节一致），`tests/help.js` 7 条锁。
- **CI**：`npm run smoke-live` 六项活测固化为发版第四道闸。
- **升级动作**：无（格式仍 v2）。**破坏性**：无。

> 完整施工记录（file:line、用例计数、逐日明细）见 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md) 的 `[1.3.0]` 一节。

---

## [1.2.2] - 2026-11-02

### 三个「承诺了没做到」缺陷修复 + 内部收敛

- **修复**：P1 bootstrap 红线落到不存在的 T0（改归到下一轮 T）；P2 code-map 漂移检查读不了中文文件名（换正则）；P3 `state update` 零参被拒（帮助说能用，现支持 header-only）。
- **重构**：T 号计算收敛 `nextT()`；code-map 解析器统一并修嵌套路径误报；state update 守卫下沉 `lib/fields.js`。
- **升级动作**：无（格式仍 v2）。**破坏性**：无。

> 完整施工记录（file:line、用例计数、逐日明细）见 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md) 的 `[1.2.2]` 一节。

---

## [1.2.1] - 2026-10-10

修复了一些已知问题

---

## [1.2.0] - 2026-10-07

### --when 整天区间数据损坏修复 + 静默失败补齐

- **修复（P1）**：整天区间 `--when` 曾落盘 `undefined → undefined`；写入侧补全不推算，读取侧对历史坏行报 ERROR（附删行 + amend 命令）；用户原话里的 undefined 一词不误报。
- **新增**：`log append` 缺必填节写后告警 + `--json` 的 `missingSections`；`distill --json` 报真正生效的 `recentKeep` 窗口。
- **文档**：四处「文档 / 代码不一致」对齐。
- **升级动作**：无（格式仍 v2；历史坏行会被 verify 照出，按提示删行重记）。**破坏性**：无。

> 完整施工记录（file:line、用例计数、逐日明细）见 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md) 的 `[1.2.0]` 一节。

---

## [1.1.0] - 2026-10-07

### 版本单一来源 + 数据格式 v2 + 多 Agent 并发安全

- **新增**：CLI `--version`（版本号唯一来源 `package.json`，两入口同源）；verify 附件存在性检查（第 15 项）；`repair` 收号 + `--author` 分来源 + 写时冲突闸；`bootstrap --no-hub`。
- **数据格式 v1 → v2**：每轮加时间行；老 v1 口袋仍可读。
- **修复**：多处「文档承诺、代码未兑现」的一致性缺陷（附件断链、中文文件名漂移、零参 state update 等）。
- **升级动作**：老口袋跑 `context-pocket migrate --to latest`（verify 报 format-upgrade WARNING，不拦提交）。**破坏性**：无（命令名 / 数据兼容，v1 仍可读）。

> 完整施工记录（file:line、用例计数、逐日明细）见 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md) 的 `[1.1.0]` 一节。

---

## [1.0.0] - 日期未留档

### 初始版本（历史宣称清单）

- 首版对外特性清单：T-block 轮次记录、R-id 需求追踪、ADR 决策记录、项目类型自动检测、Lite 模式、🔒 绝对保留区、冲突 / 漂移检查、append-only 修正。
- **诚实注**：确切发布日未留档（不编日期）；清单中几条与代码实际不符，以 1.1.0 为准——布局是 10 核心 + 2 按需（非 12）、归档从不自动、斜杠命令层已在 1.1.0 移除、verify 现 15 项（非 6）。
- 完整原始清单逐字保存在归档。

> 完整施工记录（file:line、用例计数、逐日明细）见 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md) 的 `[1.0.0]` 一节。

---

## 🛣️ Roadmap

早期（1.1.0 时代）的三档功能清单已全部发布，原始清单逐字保存在 [`docs/dev-notes/changelog-archive.md`](docs/dev-notes/changelog-archive.md)。
当前路线图见 [`docs/ROADMAP-2.0.md`](docs/ROADMAP-2.0.md)（2.0 关联图 / 多跳 / 时间有效性及后续方向）。
长期未做的一条：MCP resources / prompts，留给后续版本。

---

## 版本说明

### 语义化版本

- **Major (X.0.0)**：破坏性变更（模板格式、文件名、命令名变更）
- **Minor (x.X.0)**：新增功能 / 新增命令（向下兼容）
- **Patch (x.x.X)**：Bug 修复 / 文档修正
- 版本号只写一处：`package.json` 的 `version`。CLI 与 MCP 都经 `lib/version.js` 读它，
  不要再往入口里抄第二个字面量（`FALLBACK_VERSION` 是唯一那个必须同步的兜底值，用例盯着它）。

### 数据格式版本

`ContextPocket/readme.md` 头部的 `format: v<N>` 是 **数据格式版本**，与 skill 版本（`package.json`）独立。
当前代码原生理解 `v2`（`lib/migrate.js:25` 的 `CURRENT_VERSION`），新建的 pocket 由 `templates/readme.md:1`
写成 `format: v2`。已经存在的 `format: v1` 目录**照旧可读**，只是每轮没有时间行；要补上就跑
`context-pocket migrate --to latest`（`verify` 会报一条 `format-upgrade` WARNING 提醒，从不拦提交）。
即使 skill 升到 2.0，旧项目的 `format: v1` 仍应可读；未来再有不兼容的格式升级，同样走"登记一跳迁移"
这条路，而不是让旧目录变成砖。

版本号本身（skill / CLI / MCP 那一处版本号字符串）只写在 `package.json`，两个入口都经 `lib/version.js` 读：
CLI `context-pocket --version`、MCP `initialize` 回包的 `serverInfo.version`。目录式安装（只拷 `bin/` 与 `lib/`）
拿不到 package.json 时才用 `FALLBACK_VERSION` 兜底，该常量与 package.json 同值由 `tests/unit.js` 断言——
不然升级版本号漏改一处，两个入口就会报两个号。

---

## 贡献者致谢

见 [README.md](README.md) 和 GitHub Contributors 页面。

