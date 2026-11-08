# ContextPocket 2.0 / 2.0 Lite 路线图

> 状态：草案 v1 · 2026-11-08 · 基线版本 1.6.1（`e0c2a74`）
> 本文是规划，不是承诺。每个阶段都有退出 gate：不值就停，不把复杂度硬堆上去。
> 一个版本只解决一个问题（沿用 1.5.1 / 1.5.2 / 1.5.3 的做法）。

---

## 0. 一句话

ContextPocket 2.0 用节点式上下文把轮次、文件与决策连起来；2.0 Lite 建立在这套设计与共用的 **Node schema v2** 上，面向小型项目和日常对话记忆，把读取/写入路径做得更轻、更直接。Lite 保留确定性的单跳关联但不建图缓存；完整 2.0 面向更大的口袋，提供图索引、多跳与时间有效性。图用来**扩展**检索，不替换现有的分词倒排。

---

## 1. 基线：1.6.1 的家底（实测数字）

| 项 | 现状 | 出处 |
|---|---|---|
| 代码量 | 17,995 行 JS；23 个 `lib/` 模块；`bin` 2,605 行、`mcp-server` 2,457 行 | `wc -l` |
| 命令面 | 27 个 CLI 子命令 = 27 个 MCP 工具，**对称是硬约束** | `lib/help.js` / `mcp-server.js` |
| 数据文件 | 10 个核心 + 2 个按需 Markdown；`--mode lite` 只建 5 个（`LITE_CORE_FILES`） | `lib/constants.js` / `lib/bootstrap.js:236` |
| 检索 | 分词 AND 倒排 + 子串校验；`why <file>` 单跳反查 | `lib/indexer.js:634` / `lib/query.js:470` |
| 已有语义层 | conflicts 六维规则、verify drift（`code-newer-than-log`）、corrections 闭环、时间窗口 | `lib/query.js` / `lib/validator.js` |
| 门禁 | 292 用例 / 9 套件；lint 38 个 js；smoke；smoke-live；CI 对 main 与 `v*` tag 都跑 | `tests/` / `.github/workflows/ci.yml` |
| 工程约束 | 6 处版本号抄本全部上锁；`migrate` / `repair` 已有；npm 包 59 文件 | `tests/unit.js` / `package.json` |
| 设计原则 | Completeness > Brevity、T 号永久递增、纯文本 Markdown、Agent-agnostic、零依赖 | `README.zh-CN.md:360` |

**最关键的发现**：`--mode lite` 已经存在，但它只裁文件数量，不裁命令面、不裁能力、没有独立入口，也没有独立数据格式。所以「2.0 Lite 更轻」不是从零造一个新产品，而是把已有的 lite 数据面**升格**。

**第二关键的发现**：T-block 之间没有任何边。`recall T7` 只吐 T7 自己的正文，`why src/a.ts` 只能答「哪几轮提过这个文件」。节点化要补的就是这一维。

---

## 2. 要解决的问题，以及明确不做的事

解决的问题：

- **P1 孤立节点**：一轮记录拿不到「谁引用过我、我受哪条 ADR 约束、我改的文件后来又被谁动过」。这是「节点关联上下文」真正值钱的地方，不是画一张好看的图。
- **P2 Lite 不真轻**：lite 目前只是少建 5 个文件，装到用户机器上仍是同一份 17,995 行代码和同 27 个命令。
- **P3 多跳问题答不了**：「这个决策后来影响了哪些文件」「改动这条链路的有哪些轮」需要跨 T 号 / 文件 / ADR 的连通性。

明确不做（守住 1.x 的资产）：

- 不引入图数据库、向量库、常驻服务或 npm 运行时依赖。
- 不把每轮写入变成 LLM 抽取；默认零模型调用、离线可跑。
- 不替换 `search` 的分词 AND 语义；图只负责召回后的邻接扩展与排序。
- 不做图形化 UI；输出保持纯文本 Markdown + JSON。
- 不破坏 v1 口袋：老版本必须仍能读 v2 写出来的文件。

---

## 3. 核心设计：Node schema v2

### 3.1 节点类型与 ID

| 类型 | ID 形式 | 来源 | Phase 0 |
|---|---|---|---|
| 轮次 | `T<n>` | `log.md` / `log-archive.md` 的 T-block | 是 |
| 文件 | `file:<path>` | Action 的 `files`、code-map 的树 | 是 |
| 决策 | `adr:ADR-<n>` | `decisions.md` 的 `## ADR-n · title · T<n>` | 是 |
| 需求 | `req:R<n>` | `requirements.md` | Phase 1 |
| 标签 | `tag:<name>` | T-block 的 `[tags]` | Phase 1 |

ID 用「类型前缀 + 原样标识」，保证纯文本可读、grep 得到、不引入新编号体系。T 号继续沿用「永久递增、绝不重置」。

### 3.2 边类型、方向与证据等级

| 边 | 方向 | 派生来源 | 证据 | 可溯源到 |
|---|---|---|---|---|
| `modifies` | T → file | `parseLogAll().blocks[].actions[].files` | 强 | log.md 的 Action 行 |
| `mentions` | T → file | `blocks[].mentions`（`weakMentions`） | 弱 | 非 Action 小节 |
| `references` | T → T | `blocks[].corrects`（`Corrects T<n>`）、`fixBlocks.targetId` | 强 | log.md 的更正行 |
| `decided-in` | ADR → T | `parseDecisions().adrs[].createdAt` | 强 | decisions.md 标题 |
| `supersedes` | ADR → ADR | `adrs[].supersedes` | 强 | decisions.md 字段 |
| `last-changed` | file → T | code-map 树里的 `T<n>:` 行 | 强 | code-map.md |
| `co-occurs` | T ↔ T | 同一文件被多轮改动 | 弱（推导） | 由 `modifies` 派生 |

**强/弱分层直接照搬 `lib/parser.js` 现成的设计**：`actions.files` 是「这轮动过」，`weakMentions` 是「这轮谈到过」。混在一起会让 `why` 把「待确认里提了一句」答成「这轮改了」，也会让 verify 看到幻影覆盖。弱边必须带 `evidence: 'weak'` 标记，默认不进上下文摘要。

### 3.3 存储：图是派生品，不是真值

真值永远在 `log.md` / `code-map.md` / `decisions.md` 里。图必须满足：

- **可重建**：删掉索引缓存，从三份 Markdown 现场重算，结果逐字一致。
- **可 diff**：纯文本、逐行一条记录、能进 git。
- **可人工修**：人改的是源 Markdown，不是缓存。

Phase 0 **完全不落盘**（纯运行时派生，零迁移风险）。Phase 1 再决定缓存载体，候选：

| 方案 | 优点 | 缺点 | 倾向 |
|---|---|---|---|
| `graph.jsonl`（一行一边） | 可 diff、易解析、MCP 官方 Memory server 同款 | 引入第二种数据格式 | 推荐，但定位成**可删的索引缓存** |
| `links.md`（Markdown 表） | 与「全是纯文本 Markdown」一致 | 大口袋下人读不动、解析更脆 | 备选 |
| 不落盘，每次现算 | 最简、零一致性问题 | 大口袋每次 recall 都要全量扫 | Phase 0 用它；Phase 3 再评估 |

### 3.4 确定性派生规则（逐条，禁止靠模型猜）

1. 每个 T-block 建一个 `T<n>` 节点；归档块同样建，带 `archived: true`。
2. 每轮 Action 的每个 `files` 路径建 `file:<path>` 节点 + 一条 `modifies` 边。
3. 非 Action 小节里出现的路径建 `mentions` 弱边，不参与默认上下文。
4. `Corrects T<n>` 与 `## T<n>-fix` 建 `references` 边，指向被更正轮。
5. 每个 ADR 建 `adr:ADR-n` 节点，按标题里的 `T<n>` 建 `decided-in` 边。
6. `Supersedes: ADR-x` 建 `supersedes` 边。
7. code-map 树里 `T<n>:` 行按最近的文件节点建 `last-changed` 边。
8. 每条边必带 `source` 与产出它的 T 号；**无来源的边一律不建**。

### 3.5 时间有效性（2.0，Phase 3）

借 Graphiti/Zep 的 bi-temporal 思路，但用 T 号当天然时间轴，不引入时间戳数据库：

- `recordedAt = T<n>`：事实在哪一轮被记下。
- `validFrom / validTo`：由 `corrections` 的 superseded 链、`Supersedes`、`log amend` 推导。
- 「T7 当时我以为 X」类问题答的是 recordedAt，不是当前值；现有 `superseded` 语义已经把新旧并存，正好接上。

### 3.6 可溯源性

每条边输出时都带 `source` 与 `tId`。做不到溯源的边（例如纯语义相似）在 2.0 与 Lite 里都不进入图。

---

## 4. 检索契约

```
query → 倒排召回（现有 search，语义不变）
      → 图邻接扩展（Lite 1 跳 / 2.0 默认 2 跳，上限 3）
      → 输出：命中节点 + 入向上下文 + 每条边的来源
      → 排序：文本得分优先，图距离只做次级权重
```

**硬性回归锁**：同一组简单关键词查询，在「开图 / 关图」两种模式下的命中集合与顺序必须一致。图不能把简单查询变差——这是 2025 年 GraphRAG 系统评估反复出现的翻车点。

入向上下文的最小定义（Phase 0 先实现前四项）：

1. 谁引用了我（`references` 反向 + corrections）
2. 我改过的文件后来又被哪些轮改过（`modifies` 同文件、T 号更大）
3. 我关联到哪些 ADR（`decided-in` 反向）
4. 我碰过哪些文件、它们在 code-map 里的最后改动轮
5. 弱证据提及（默认折叠，需 `--include-weak`）

### 命令 / 工具面（CLI 与 MCP 必须同步）

| 能力 | CLI | MCP | 阶段 |
|---|---|---|---|
| 单轮带上下文 | `recall T<n> --with-context` | `context_pocket_recall` + `withContext` | Phase 0 |
| 查看派生图 | `graph [--type <type>] [--json]` | `context_pocket_graph` | Phase 1 |
| 文件多跳反查 | `why <file> --expand <n>` | `context_pocket_why` + `expand` | Phase 3 |
| 搜索邻接扩展 | `search <kw> --expand <n>` | `context_pocket_search` + `expand` | Phase 3 |
| 重建索引缓存 | `graph rebuild` / `graph verify` | 同 | Phase 1 |

---

## 5. 两版分化矩阵

| 维度 | 2.0 Lite | 2.0 |
|---|---|---|
| 数据文件 | 5 个（现有 `LITE_CORE_FILES`） | 10 + 2（现有全集） |
| 命令 / 工具 | 最小面：bootstrap / status / log append / recall / search / why / verify / graph | 现有 27 + 新增 |
| 图能力 | 运行时派生、单跳邻接、不建索引 | 图索引、多跳、时间有效性 |
| LLM | 完全不用 | 不提供 LLM 路径 |
| 运行时依赖 | 0 | 0（两者都保持） |
| 目标场景 | 小项目、纯 skill 模式、无 Node.js 的复制式安装 | 长周期、多人、跨模型、大口袋 |
| 数据格式 | **Node schema v2（共用）** | **Node schema v2（共用）** |

**共用 schema 是硬要求**。两版若各用一份格式，用户/Agent 在两版间迁移就要转换，生态立刻裂成两半；Lite 是构建在 2.0 节点式上下文之上的「同一格式、更少能力」，不是「另一种格式」。

「更轻」必须可量化，Phase 2 的验收口径：核心文件数、CLI 命令数、MCP 工具数、包内文件数、冷启动到 `status` 的耗时、包体积——六项都要比完整包小，且写进回归锁。冷启动同时锁模块加载数（稳定代理）并以同机 best-of-5 墙钟实测作断言。

| 指标 | 2.0 Lite | 完整包 | 回归锁 |
|---|---:|---:|---|
| 核心文件 | 5 | 10 | 常量数组绝对值 + Lite < full |
| CLI 命令 | 8 | 28 | `help --json` 现场数 + 绝对值 |
| MCP 工具 | 8 | 28 | stdio `tools/list` 现场数 + 绝对值 |
| 包内文件 | 27 | 61 | `npm pack --dry-run` 解析文件数 |
| 冷启动模块数 / `status` best-of-5 | 17 / 97.0 ms | 25 / 114.3 ms | 模块数绝对值 + 墙钟耗时实测比较 |
| npm 包体积 | 96.7 kB | 约 398.4 kB | dry-run 输出绝对值锁；npm 只显示一位小数，容差 0.1 kB |

---

## 6. 数据格式与迁移

- v1 → v2 是**增量**：既有 Markdown 结构一字不改，只新增可派生的图索引层。
- v2 读 v1：没有图缓存时现场派生，行为与 v1 一致。
- v1 读 v2：忽略新增的 `graph.jsonl`，不报错（现有 reader 本来就读白名单内的文件）。
- `migrate` 扩展一条 graph 缓存重建；`repair` 增加「缓存与源不一致」的自愈。
- `docs/MIGRATION.md` 已有 v1 章节，接着写 v2；版本号六处抄本与回归锁照旧。

---

## 7. 分阶段里程碑与退出 gate

| 阶段 | 内容 | 退出 gate（不达标就停） |
|---|---|---|
| **Phase 0** | 只读原型：`lib/links.js` 确定性派生 + `recall --with-context`（CLI/MCP 同步） | 零写盘；现有 292 用例全绿 + 新增用例；简单查询不退化；人工在真实口袋上确认「入向上下文」有用 |
| **Phase 1** | Node schema v2 定稿、graph 缓存、migrate/repair、MIGRATION v2 章节 | 删掉缓存能逐字重建；v1 口袋零改动可读；跨平台 CI 绿 |
| **Phase 2** | 2.0 Lite 独立轻量包：面向小项目与日常对话记忆，简化读写路径 | §5 六项量化指标全部下降；与完整 2.0 共用 schema 有回归锁 |
| **Phase 3** | 完整 2.0 的图索引、多跳与时间有效性 | 多跳问题有可复现用例；延迟预算内；不引入 LLM 路径 |
| **Phase 4** | 生态：npm 首发收尾、示例口袋、文档双语 | `npm view context-pocket` 不再是 404 |

Phase 0 是**验证价值**的阶段：如果入向上下文在实际使用里没人看，后面全部不做。

---

## 8. 版本计划

沿用「一个问题一个版本」：

- `1.6.2`（或 1.7.0）：Phase 0 只读原型（不改数据格式，可保持 minor/patch 讨论）
- `1.7.x`：Phase 1 schema + 缓存
- `2.0-lite`：Phase 2 独立轻量包；`2.0`：Phase 3 完整节点式上下文能力（同源 schema，见 §12）

**已拍板（2026-11-08）**：对外版本号统一两位（`2.0`、`2.1`、`2.0-lite`），不再写 `2.0.0`。
npm 的 `package.json` / dist-tag 仍必须是三位 semver（`2.0.0`，npm 不接受两位版本串），
两位只用于 tag（`v2.0`）、CHANGELOG 标题、README 与帮助文本；六处版本号抄本锁相应
把「对外两位、包内三位」一起钉死。发版仍走 `.trae/skills/context-pocket-release/SKILL.md`：
抄本 → CHANGELOG 切节 → 四道门禁 → tag → 等 tag CI 绿 → Release。

---

## 9. 测试策略

- 帮助文本单源（`tests/help.js`）继续钉死 CLI / MCP / initialize 三个入口。
- 新增每条派生规则配「反证」用例：把源文本里那一行改掉，边必须消失——防止正则写成永远通过的摆设（1.5.3 的做法）。
- 跨平台：所有涉及 mtime / 路径 / 换行的用例显式错开输入（1.5.2 的教训）。
- 四道门禁 + `npm pack --dry-run` 每次定版必跑；CI 现在对 `v*` tag 也会跑。
- 性能预算：图派生在大口袋（>800 行 log）下不得让 `recall` 变慢一个数量级。
- 「简单查询不退化」锁：开图/关图两种模式的命中集合与顺序一致。

---

## 10. 风险与反面证据

- **图不总比倒排好**：2025 年有系统评估发现 GraphRAG 在很多真实任务上不如普通 RAG，优势集中在多跳 / 时序 / 关系查询，平均延迟约 2.4 倍，早期索引成本极高（LazyGraphRAG 才降到 0.1%）。所以是 hybrid，不是 replace。
- **弱边污染**：`weakMentions` 的分层必须照搬，否则「待确认里提了一句」会被当成「这轮改了」。
- **LLM 成本**：每个 episode 多次 LLM 调用是 Graphiti/Cognee 的常态，会直接毁掉零依赖与离线可跑；已拍板 2.0 与 Lite 都不带 LLM 路径。
- **复杂度反噬**：17,995 行已经不小。Lite 若只是「再加一层抽象」而不是真减文件、真减命令，就是失败。
- **schema 分裂**：两版格式不一致是最容易发生的架构事故。
- **既有尾巴**：npm 包仍未发布（`npm adduser` + 2FA 必须维护者本人）；`v1.5.1` tag 已 force-move 到 `97d2b91`，已 clone 旧 tag 的人需 `git fetch --tags --force`；CI 有 Node 20 / Ubuntu 26 两条无害 warning。

---

## 11. 参考项目对照

| 项目 | 抄什么 | 不抄什么 |
|---|---|---|
| MCP 官方 Knowledge Graph Memory（`@modelcontextprotocol/server-memory`） | 三原语 entities/relations/observations、单个本地 JSONL、无服务无账号；与本仓库「零依赖、纯文本、可 diff」同哲学，最贴的参照 | 边全靠模型自觉写、无确定性派生、无时间维度 |
| Obsidian / Roam / Logseq | 反向链接 = 入向上下文自动可用；Roam/Logseq 的块级引用对应 T-block | 手工 `[[链接]]`，漏写就断链；自动记录场景不可靠 |
| Graphiti / Zep（时态知识图） | bi-temporal：事实「何时成立」与「何时被记录」分开，边带失效区间；对应 T 号时间线与 `superseded` | Neo4j/FalkorDB + 每 episode 多次 LLM |
| LightRAG | 轻量图 + 增量更新（改一处只更新局部），正是 Lite 的样子 | 它是 RAG 框架，没有 agent memory 写入面 |
| Microsoft GraphRAG | 社区摘要能答「这项目整体在往哪走」这类全局问题 | 批处理静态语料、索引成本高 |
| Cognee | 从代码建符号/依赖图，`code-map.md` 有现成升级路径 | 图 + 向量 + 关系三套存储、多模型依赖 |

---

## 12. 待决问题（需要拍板）

1. **~~Lite 的形态~~ 已拍板（2026-11-08）：独立包**。Lite 以独立 npm 包（候选名
   `context-pocket-lite`）发行，建立在 ContextPocket 2.0 节点式上下文设计之上，
   与完整 2.0 共用 Node schema v2；Lite 面向小型项目与日常对话记忆，优先减少读写路径与维护负担。
   代码先放**同一仓库的独立目录**（如 `lite/` 自带 `package.json`），不发 monorepo 工具、
   不拆仓库：schema 一致性靠同仓测试互查（Lite 的用例直接读 2.0 仓库的口袋样本），
   「schema 分裂」这个最大架构风险用同仓锁住；将来若体积或发布流程冲突再拆仓库，
   拆的时候 schema 版本号必须双向断言。
2. **~~图缓存载体~~ 已拍板（2026-11-08）：`graph.jsonl`****（一行一边，定位成可删的索引缓存）**。
   真值永远在源 Markdown；删缓存后 `graph rebuild` 必须逐字重建。
3. **~~版本号关系~~ 已拍板（2026-11-08）**：Lite 独立版本线（`2.0-lite`、`2.1-lite`…），
   与 2.0 主线各自递增，不共用 major 通道；对外展示统一两位，见 §8。
4. **~~LLM 增强~~ 已拍板（2026-11-08）：不做**。2.0 不带任何 LLM 路径，
   不设 `graph enrich` 命令——零模型调用、离线可跑是 Lite「更便宜」与 2.0 零依赖的共同底线；
   语义相似类边彻底不进图。将来真有需求再单独立项评审。
5. **~~breaking change 容忍度~~ 已拍板（2026-11-08）：v1 口袋必须零改动可读**（维持本文设计）。
6. **~~Phase 0 的观测方式~~ 已拍板（2026-11-08）：加 `graph --json`**，
   它同时是 Phase 1 `graph` 命令的输出底座，人工验边与程序断言共用一份结构。

六个问题全部拍板完毕，Phase 1 进入实现。

---

## 13. 落地进度

### Phase 0（已完成，未提交）

- 本文：`docs/ROADMAP-2.0.md`（新增，进 `docs/` 白名单，不触发版本号变更）。
- 只读原型：`lib/links.js`、`lib/query.js`（导出 `extractFilesFromBlock`）、`bin/context-pocket.js`、`mcp-server.js`、`lib/help.js`、`tests/harness.js`、三处测试、`CHANGELOG.md [Unreleased]`。
- 验证结果：`npm test` 302/0（新增 10 条）、`lint` 39 个 js、`smoke` ALL PASS、`smoke-live` 6/6、`npm pack --dry-run` 61 文件。§1 表里的 292 / 38 / 59 是**基线 1.6.1** 的数字，Phase 0 后已变为 302 / 39 / 61。
- **不发版、不提交、不写 npm**。Phase 0 是验证价值的实验，等人工确认有用再定版本号。

### Phase 1（已完成，未提交）

- §12 六个待决问题全部拍板（见该节），本文 §8 / §12 已回填。
- `lib/links.js` 缓存层：`assets/graph.jsonl`（`schema: "graph/1"`，一行一条记录，
  meta 第一行带四源 sha1 签名）、`writeGraphCache` / `graphCacheStatus` /
  `verifyGraphCache`（逐字节比对，抓签名未动的篡改）/ `readGraph`（读取时自愈）。
- CLI `graph` / `graph rebuild` / `graph verify` + MCP `context_pocket_graph`
  （`action: view/rebuild/verify`），命令面 27 → 28，CLI/MCP 对称依旧；
  `recall --with-context` 仍走运行时派生，与缓存解耦。
- `migrate` / `repair` 收尾重写已存在的缓存（`graphCacheRebuilt`），没建过的不新建。
- `docs/MIGRATION.md` v2 派生层章节；`SKILL.md` / `COMPATIBILITY.md` / 中英 README 同步 28。
- 验证结果：`npm test` **318/0**（新增 16 条：删缓存逐字重建、v1 零改动可读、
  篡改检测、自愈路径、migrate/repair 两分支）、`lint` 39、`smoke` ALL PASS、
  `smoke-live` 6/6、`npm pack --dry-run` 61 文件。
- 依旧**不发版、不提交、不写 npm**。

### Phase 2（实现完成；全量门禁通过；待用户确认；未提交、未发布）

- `lite/` 是基于 2.0 节点式上下文/schema 的独立轻量包，适用于小型项目和日常对话记忆；
  以 5 个核心文件、8 条 CLI 命令 / 8 个 MCP 工具、现场扫描及运行时图派生，降低启动和维护负担。
- Lite 测试：9 条行为测试、1 条六项量化指标回归锁、4 条 schema/读写互认测试；
  主包 `tests/lite.js` wrapper 将 Lite 套件纳入 `npm test`。
- 六项指标实测（Lite / 主包）：核心文件 **5 / 10**；CLI 命令 **8 / 28**；
  MCP 工具 **8 / 28**；包内文件 **27 / 61**；启动模块数 **17 / 25**，status best-of-5
  实测 **97.0 / 114.3 ms**（一次本机样本；指标测试会在每次运行时重新实测并比较）；
  npm 包体积 **96.7 / 398.4 kB**。Lite 的 `npm pack --dry-run` 保持 27 files，
  主包保持 61 files；HANDOFF 中 Phase 1 主包实测为 395.4 kB（较早的 381.9 kB 基线，
  因 Phase 1 的 `docs/ROADMAP-2.0.md` 与扩充后的 `docs/MIGRATION.md` 纳入 `docs/` 白名单）。
  本轮 README 与路线图/Unreleased 变更记录补入 2.0 Lite 定位、并更新完整包版本抄本后，
  当前工作树主包复测约 398.4 kB
  （测试对 npm 输出的一位小数显示值留 0.1 kB 容差）。
- 行为/兼容锁覆盖五文件 bootstrap、追加与时间结构、recall 窗口/上下文、扫描分页、why 证据层级、
  verify 密钥扫描与 T 号连续性、graph 零写盘、CLI/MCP 对称、parser/links/search schema 一致及双向写入互认。
- **不提交、不发布、不写 npm registry**；变更保留工作树，等待用户确认后再提交。

### 下一步

- Phase 0 的价值确认（真实口袋上人工用 `recall --with-context` / `graph`）。
- Phase 2：2.0 Lite 独立发行（§5 六项量化指标全部下降才准出）。
