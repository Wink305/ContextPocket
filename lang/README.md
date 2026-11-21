# ContextPocket Yuan（渊）

> 专业攻坚版，预览中。当前提供 workspace / merge / capture / repo map / context / recap / audit / decay / forget / consolidate 十个命令，尚未定版。

## 当前可用（3.0 preview）

```bash
context-pocket-yuan workspace init --name payments
context-pocket-yuan workspace add api ./services/api
context-pocket-yuan workspace add web ./apps/web
context-pocket-yuan workspace status
context-pocket-yuan workspace search "token refresh" --type T --pocket api
context-pocket-yuan workspace index --rebuild
context-pocket-yuan workspace recall api:T12
context-pocket-yuan workspace verify --deep
context-pocket-yuan workspace repair
context-pocket-yuan merge web --into api          # 默认 dry-run
context-pocket-yuan merge web --into api --apply  # 真正合并
context-pocket-yuan capture pr.md --pocket api    # 默认只出计划
context-pocket-yuan capture pr.md --pocket api --apply
context-pocket-yuan map update
context-pocket-yuan map verify
context-pocket-yuan context build --max-tokens 6000 --query "token refresh"
context-pocket-yuan context explain --edition-mode focus --query "token refresh"
context-pocket-yuan workspace search "token refresh" --edition-mode audit
context-pocket-yuan recap --since 10 --until 30 --max-tokens 2000
context-pocket-yuan audit --since 10 --until 30      # 健康 / 活动 / 待办
context-pocket-yuan decay --max-age-days 180        # 冷轮次与归档建议
context-pocket-yuan forget --before T10            # 默认只出计划
context-pocket-yuan forget --keep-last 50 --apply  # 真正归档
context-pocket-yuan consolidate                    # 只报告重复
context-pocket-yuan consolidate --apply            # 只删完全重复的偏好行
```

- `workspace`：`contextpocket.workspace.json` 管多个口袋；跨口袋 id 必须写成 `api:T12`。`verify --deep` 检查清单/跨口袋引用/repo map 漂移/未处理 merge 复核；`repair` 默认只出计划，`--apply` 只重建 repo map。
- `workspace search`：默认走工作区本地 BM25 索引（`.contextpocket/search-index.json`），可用 `--pocket` / `--type` 过滤，`--no-index` 强制现场扫描；索引缺失或源文件签名变化时自动增量重建。
- `workspace index [--rebuild]`：显式构建/刷新索引；索引是派生缓存，删掉可随时重建。
- 版本内模式：`--edition-mode focus|audit|migrate` 只提供默认值预设 —— focus 1.5k 预算 / 无 repo map / 检索 5 条；audit 12k + repo map + 20 条；migrate 50k + repo map + 不截断。显式 `--max-tokens` / `--no-repo-map` / `--limit` 永远优先。
- `merge`：按工作区口袋名把 source 合并进 target。轮次重编号、重复轮次/ADR/需求跳过，冲突写进 `merge-<date>.md`；默认 dry-run，`--apply` 才写。源口袋只读；报告会列出目标中真实存在、但 code-map 描述缺失或不同的文件建议（仍人工确认）。
- `capture`：把本地保存的 PR / CI 摘要写成标准 T-block。只摘标题、最多 5 条列表要点和第一个链接，不整段抄正文；写入前扫描凭据，error 级密钥直接拒绝。默认只出计划，`--apply` 才写。
- `map`：JS / JSX / TS / TSX / Python 的文件级 + 顶层符号扫描，缓存 `.contextpocket/repo-map.json`。
- `context`：红线 / 待确认 / 下一步 → 事实 → 检索与 repo map，按 token 预算裁剪并写明裁了什么。`context explain` 额外给出各层 token、来源数量与 2k / 6k / 12k 预算模拟；build 与 explain 共用同一份裁剪逻辑。
- `recap`：只读周期回顾，按 T 区间或日期窗口汇总轮次与当前事实；预算不够先丢最旧轮次。
- `audit`：只读工作区审计。Health（verify --deep、repo map 漂移、索引新鲜度、待复核 merge）+ Activity（窗口内轮次 / 新 ADR / 关闭需求）+ Open（未关闭需求、❓、冲突、复核）；不写任何文件。
- `decay`：只读保留策略报告。按 `--max-age-days` 与 `--keep-last` 找出最旧的连续冷轮次前缀，给出可直接执行的 `forget` 命令；同时标记关联轮次已变冷的未关闭需求、❓ 与 ADR。没有 WHEN 的轮次只报 undated，不按文件 mtime 猜年龄。
- `forget`：把最旧的一批轮次从 `log.md` 搬进 `log-archive.md`（`--before Tn` / `--before-date` / `--keep-last`，三选一）。默认只出计划，`--apply` 才写；只切最旧前缀，归档后 recall / search / recap 仍读得到。
- `consolidate`：按标题找重复 ADR（决策不同会标成冲突）、按文本找重复需求、按 key 找重复偏好。默认只报告；`--apply` 只删除完全重复的偏好行并重算 `index.md` 计数，带编号的 ADR / 需求永远人工合并。
- MCP 入口：`context-pocket-yuan-mcp`，工具为 `context_pocket_workspace` / `context_pocket_merge` / `context_pocket_capture` / `context_pocket_map` / `context_pocket_context` / `context_pocket_recap` / `context_pocket_audit` / `context_pocket_decay` / `context_pocket_forget` / `context_pocket_consolidate`。

## 定位

面向复杂仓库与长期攻坚：多个口袋组成一个工作区，围绕代码结构、上下文预算和深度审计组织记忆。

## 规划能力（阶段 1 / 阶段 2）

- workspace manifest：一个项目内多个口袋（如前端、服务端、基础设施）的统一入口
- repo map：按代码结构生成可检索的仓库地图，与 T-block 的文件变更互相印证
- 上下文预算：复用 quan 的 `handoff --max-tokens`，按预算裁剪交接内容
- 本地检索：BM25 倒排 + 字段权重 + 短语加成 + 时间平局规则，跨口袋统一排序；索引按源文件签名增量刷新。
- 深度 verify / repair / merge 复核：跨口袋引用、编号冲突与合并结果审计
- workspace 审计视图：健康、活动窗口与未决事项一页汇总（已预览）
- 记忆衰减：冷轮次前缀、关联冷需求 / ❓ / ADR 与 forget 建议（已预览）
- consolidate / recap：长周期记忆的合并与回顾（均已预览）
- CI / PR 摘要捕获：从本地摘要文件生成 T-block，写入前做凭据扫描（已预览）

## 与其它版本的关系

- 数据格式仍为 v2，口袋目录仍为 `ContextPocket/`；yuan 产出的口袋 quan / xi 可以直接读。
- 包名与命令名预留为 `context-pocket-yuan` / `context-pocket-yuan-mcp`，发布前不会注册到 npm。
- 通用能力沿用家族同源核心（`shared/` + `scripts/sync-core.js`），不复制一套语义不同的读写实现。

## 状态

| 项目 | 值 |
|------|----|
| 版本线 | 3.0 家族 |
| 展示版本 | `3.0-yuan`（预览） |
| 可安装 | 是（`npm link` 后使用 `context-pocket-yuan`；尚未发布到 npm） |
| 跟踪计划 | [.trae/documents/contextpocket-3.0-four-editions.md](../.trae/documents/contextpocket-3.0-four-editions.md) |
