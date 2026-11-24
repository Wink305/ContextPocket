# ContextPocket Hai（海）

> 协作强化版，规划中。当前仓库只有骨架，**没有可安装的命令**。

## 定位

面向团队与多写者：把口袋从个人记忆扩展为可共享、可评审、可审计的协作记忆。

## 规划能力（阶段 3）

- 共享 hub：以 git / 对象存储为先的团队记忆仓库
- 多写者冲突队列：并发写入不静默覆盖，冲突进入评审流程
- 评审 / 审批：关键决策与红线的变更需要人工确认
- RBAC、来源链、审计日志、保留期
- 团队 handoff 与 CI / IM 连接器

## 与其它版本的关系

- 数据格式仍为 v2，口袋目录仍为 `ContextPocket/`；hai 产出的口袋 quan / xi / yuan 可以直接读。
- 包名与命令名预留为 `context-pocket-hai` / `context-pocket-hai-mcp`，发布前不会注册到 npm。
- 通用能力沿用家族同源核心（`shared/` + `scripts/sync-core.js`）。

## 状态

| 项目 | 值 |
|------|----|
| 版本线 | 3.1 家族 |
| 展示版本 | `3.1-hai`（发布后） |
| 可安装 | 否 |
| 跟踪计划 | [.trae/documents/contextpocket-3.0-four-editions.md](../.trae/documents/contextpocket-3.0-four-editions.md) |
