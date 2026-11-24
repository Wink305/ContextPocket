# ContextPocket Yuan（渊）

> 专业攻坚版，稳定。当前提供 workspace / merge / capture / repo map / context / recap / audit / decay / forget / consolidate 十个命令，API 已冻结。Agent 可执行说明见 [SKILL.md](SKILL.md)。

## 当前可用（3.1 stable）

```bash
context-pocket-yuan workspace init --name payments
context-pocket-yuan workspace add api ./services/api
context-pocket-yuan workspace add web ./apps/web
context-pocket-yuan workspace status                 # 口袋 + 索引 / repo map / 图 健康
context-pocket-yuan workspace search "token refresh" --type T --pocket api
context-pocket-yuan workspace index --rebuild
context-pocket-yuan workspace recall api:T12
context-pocket-yuan workspace verify --deep
context-pocket-yuan workspace repair
context-pocket-yuan merge web --into api          # 默认 dry-run
context-pocket-yuan merge web --into api --apply  # 真正合并
context-pocket-yuan capture pr.md --pocket api    # 默认只出计划
context-pocket-yuan capture --pr 42 --pocket api  # 本机 gh pr view
context-pocket-yuan capture --run 123456 --pocket api --repo acme/app
context-pocket-yuan map update                    # 复用 size + mtime 未变的符号
context-pocket-yuan map verify                    # 只比 metadata
context-pocket-yuan context build --max-tokens 6000 --query "token refresh"
context-pocket-yuan context build --query "token refresh" --expand 1 --as-of 2026-11-02
context-pocket-yuan context build --query "token refresh" --expand 2 --graph-edges all
context-pocket-yuan context explain --edition-mode focus --query "token refresh"
context-pocket-yuan workspace search "token refresh" --edition-mode audit
context-pocket-yuan recap --since 10 --until 30 --max-tokens 2000
context-pocket-yuan audit --since 10 --until 30      # 健康 / 活动 / 待办
context-pocket-yuan decay --max-age-days 180        # 冷轮次与归档建议
context-pocket-yuan decay --max-age-days 180 --apply  # 归档同一份前缀候选
context-pocket-yuan forget --before T10            # 默认只出计划
context-pocket-yuan forget --keep-last 50 --apply  # 真正归档
context-pocket-yuan consolidate                    # 口袋内 + 跨口袋重复
context-pocket-yuan consolidate --apply            # 只删口袋内完全重复的偏好行
```

- `workspace`：`contextpocket.workspace.json` 管多个口袋；跨口袋 id 必须写成 `api:T12`。`status` 直接给出索引 present/fresh、repo map 文件数与工作区图节点 / 跨口袋边数，不用先跑 `audit`；`verify --deep` 检查清单/跨口袋引用/repo map 漂移/未处理 merge 复核；`repair` 默认只出计划，`--apply` 只重建 repo map。
- `workspace search`：默认走工作区本地 BM25 索引（`.contextpocket/search-index.json`），可用 `--pocket` / `--type` 过滤，`--no-index` 强制现场扫描；索引缺失或源文件签名变化时自动增量重建。
- `workspace index [--rebuild]`：显式构建/刷新索引；索引是派生缓存，删掉可随时重建。
- 工作区时间图：跨口袋显式引用 `web:T1` 会变成一条 `x-ref` 边，缓存在 `.contextpocket/workspace-graph.json`。只有 `context build/explain --expand 1|2` 会构建或刷新它；按口袋签名增量重建，`--as-of` 用 WHEN 日期做时间切片（也接受 `pocket:Tn`）。`status` / `audit` 只读检查新鲜度，不主动建图。
- 派生跨口袋边：`--graph-edges duplicate|shared-file|tag|near|all` 显式开启。`duplicate` 连接相同 ADR 标题 / 需求文本 / 偏好 key+value；`shared-file` 连接同名相对路径；`tag` 连接同名标签；`near` 连接共享 tag / 文件且 WHEN 相差不超过 `--graph-near-days`（默认 7）的轮次。全部是 weak 边、默认关闭，同一 key 最多取 5 个口袋，派生边总数上限 2000；Graph 段会给出 `Derived: N edge(s)` 汇总与最多 8 条示例。
- 版本内模式：`--edition-mode focus|audit|migrate` 只提供默认值预设 —— focus 1.5k 预算 / 无 repo map / 检索 5 条；audit 12k + repo map + 20 条；migrate 50k + repo map + 不截断。显式 `--max-tokens` / `--no-repo-map` / `--limit` 永远优先。
- `merge`：按工作区口袋名把 source 合并进 target。轮次重编号、重复轮次/ADR/需求跳过，冲突写进 `merge-<date>.md`；默认 dry-run，`--apply` 才写。源口袋只读；报告会列出目标中真实存在、但 code-map 描述缺失或不同的文件建议（仍人工确认）。
- `capture`：把 PR / CI 摘要写成标准 T-block。三种本地来源：摘要文件、`--pr <number|url>`（本机 `gh pr view`）、`--run <id>`（本机 `gh run view` + 失败日志）。只摘标题、最多 5 条列表要点和第一个链接，不整段抄正文 / 日志；写入前扫描凭据，error 级密钥直接拒绝。默认只出计划，`--apply` 才写。
- `map`：JS / JSX / TS / TSX / Python 的文件级 + 顶层符号扫描，缓存 `.contextpocket/repo-map.json`。`map update` 按 path + size + mtime 复用未变化文件的旧符号；`map verify` 只比 metadata，不读文件正文。
- `context`：红线 / 待确认 / 下一步 → 事实 → 检索与 repo map，按 token 预算裁剪并写明裁了什么。每条事实标注来源（`api:T5` / `api:R3` / `api:ADR-2`），repo map 行形如 `[api] services/api/src/login.js`。`--expand 1|2` 在 Related 里增加跨口袋图邻居（带 `Path: api:T1 → x-ref → web:T1`），`--graph-edges` 追加派生边，`--as-of` 只保留该日期已知的节点；三者都要求显式开启，默认输出逐字不变。`context explain` 额外给出各层 token、来源数量与 2k / 6k / 12k 预算模拟；build 与 explain 共用同一份裁剪逻辑。
- `recap`：只读周期回顾，按 T 区间或日期窗口汇总轮次与当前事实；预算不够先丢最旧轮次。
- `audit`：只读工作区审计。Health（verify --deep、repo map 漂移、索引 / 图新鲜度、待复核 merge）+ Activity（窗口内轮次 / 新 ADR / 关闭需求）+ Open（未关闭需求、❓、冲突、复核）；不写任何文件，也不构建图缓存。
- `decay`：默认只读保留策略报告。按 `--max-age-days` 与 `--keep-last` 找出最旧的连续冷轮次前缀，给出可直接执行的 `forget` 命令；`--apply` 归档同一份前缀候选（复用 `archiveLog`，不是另一套选区）。同时标记关联轮次已变冷的未关闭需求、❓ 与 ADR。没有 WHEN 的轮次只报 undated，不按文件 mtime 猜年龄。
- `forget`：把最旧的一批轮次从 `log.md` 搬进 `log-archive.md`（`--before Tn` / `--before-date` / `--keep-last`，三选一）。默认只出计划，`--apply` 才写；只切最旧前缀，归档后 recall / search / recap 仍读得到。
- `consolidate`：口袋内按标题找重复 ADR（决策不同会标成冲突）、按文本找重复需求、按 key 找重复偏好；同时报告跨口袋重复（同一 ADR 标题 / 需求文本 / 偏好 key 出现在两个或以上口袋）。`--apply` 只删除**单个口袋内**完全重复的偏好行并重算 `index.md` 计数；跨口袋发现与带编号的 ADR / 需求永远人工合并。
- MCP 入口：`context-pocket-yuan-mcp`，工具为 `context_pocket_workspace` / `context_pocket_merge` / `context_pocket_capture` / `context_pocket_map` / `context_pocket_context` / `context_pocket_recap` / `context_pocket_audit` / `context_pocket_decay` / `context_pocket_forget` / `context_pocket_consolidate`。

## 定位

面向复杂仓库与长期攻坚：多个口袋组成一个工作区，围绕代码结构、上下文预算和深度审计组织记忆。

## 能力（阶段 1 / 阶段 2 已完成）

- workspace manifest：一个项目内多个口袋（如前端、服务端、基础设施）的统一入口
- repo map：按代码结构生成可检索的仓库地图，与 T-block 的文件变更互相印证；增量更新 + metadata-only 漂移检查
- 上下文预算：复用 quan 的 `handoff --max-tokens`，按预算裁剪交接内容，并标注每条事实的口袋来源
- 本地检索：BM25 倒排 + 字段权重 + 短语加成 + 时间平局规则，跨口袋统一排序；索引按源文件签名增量刷新。
- 深度 verify / repair / merge 复核：跨口袋引用、编号冲突与合并结果审计
- 工作区时间图：显式 `pocket:Tn` 引用变成可遍历的 `x-ref` 边，按 WHEN 日期切片，按口袋增量重建；默认不建图
- 跨口袋派生边：duplicate / shared-file / same-tag / temporal-near，`--graph-edges` 显式开启、全部 weak、有界去重
- workspace 审计视图：健康、活动窗口与未决事项一页汇总
- 记忆衰减：冷轮次前缀、关联冷需求 / ❓ / ADR 与 forget 建议；`--apply` 直接归档同一份前缀
- consolidate / recap：口袋内 + 跨口袋重复检测，长周期记忆回顾
- CI / PR 摘要捕获：本地摘要文件或本机 `gh pr view` / `gh run view`，写入前做凭据扫描

## 与其它版本的关系

- 数据格式仍为 v2，口袋目录仍为 `ContextPocket/`；yuan 产出的口袋 quan / xi 可以直接读。
- 包名与命令名为 `context-pocket-yuan` / `context-pocket-yuan-mcp`；尚未注册到 npm，安装走 Release 归档或 git clone。
- 通用能力沿用家族同源核心（`shared/` + `scripts/sync-core.js`），不复制一套语义不同的读写实现。

## 状态

| 项目 | 值 |
|------|----|
| 版本线 | 3.1 家族 |
| 展示版本 | `3.1-yuan`（stable） |
| API | 10 命令 / 10 MCP 工具，`edition.json` 已冻结 |
| 可安装 | 是（`npm link` 后使用 `context-pocket-yuan`；尚未发布到 npm） |
| 跟踪计划 | [.trae/documents/contextpocket-3.0-four-editions.md](../.trae/documents/contextpocket-3.0-four-editions.md) |
