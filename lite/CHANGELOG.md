# ContextPocket Lite — Changelog

Lite has its own version line. The full package stays on its own releases; a Lite pocket is a valid full-package pocket at any time.

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
