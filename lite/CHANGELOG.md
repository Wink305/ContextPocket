# ContextPocket Lite — Changelog

Lite has its own version line. The full package stays on its own releases; a Lite pocket is a valid full-package pocket at any time.

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

## [2.2] - 2026-11-08

首个稳定版 Lite：8 条命令 / 8 个 MCP 工具，5 个核心 Markdown 文件，运行时派生关联图（无缓存），与主包同一份 Node schema v2 和格式层。
