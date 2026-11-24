# ContextPocket 3.0 · xi / quan / yuan / hai 四版能力矩阵与规划

> 定位：一套口袋协议，四个独立版本，覆盖从单项目到组织级协作的全场景 AI 记忆问题。
> 四个版本是独立包、独立命令面、独立版本线；每个版本内部再设计自己的模式。
> 数据格式保持 v2 兼容：升级版本不等于改口袋格式。

---

## 1. 命名与交付物

| 项目 | 约定 |
|---|---|
| 产品名 | ContextPocket 3.0 |
| 版本名 | xi / quan / yuan / hai（对外对内统一） |
| npm 包 | `context-pocket-xi` · `context-pocket-quan` · `context-pocket-yuan` · `context-pocket-hai` |
| CLI | `context-pocket-xi` · `context-pocket-quan` · `context-pocket-yuan` · `context-pocket-hai` |
| MCP server | `context-pocket-xi` · `context-pocket-quan` · `context-pocket-yuan` · `context-pocket-hai` |
| tag | `ContextPocket-3.0-xi` · `ContextPocket-3.0-quan` · `ContextPocket-3.0-yuan`（预览资产为 `-yuan-preview`） · `ContextPocket-3.0-hai` |
| Release 标题 | `ContextPocket 3.0 xi` · `ContextPocket 3.0 quan` · … |
| 压缩包 | `ContextPocket-3.0-xi.zip` · `ContextPocket-3.0-quan.zip` · `ContextPocket-3.0-yuan.zip` · `ContextPocket-3.0-hai.zip` |
| 展示版本 | `3.0-xi` / `3.0-quan` / `3.0-yuan` / `3.0-hai` |

**旧包名兼容（已确认）**：`context-pocket` 与 `context-pocket-lite` 保留一个周期做兼容别名，分别转发到 quan / xi。

- 兼容窗口：3.0.x 与 3.1.x；3.2 起停止发布旧名。
- 旧包不新增功能，只做入口转发与迁移提示；`--version` 报新包名与目标版本。
- 旧 CLI / MCP 二进制名保留，stderr 提示一次弃用信息，不改变 stdout / `--json` 机器格式。
- README / FAQ / MIGRATION 增加“旧名 → 新名”对照页。

---

## 2. 四版定位

| 版本 | 一句话定位 | 记忆半径 | 主用户 | 当前基线 |
|---|---|---|---|---|
| **xi 溪** | 轻量版：一个项目、一个 Agent，开箱即记 | 单项目、短周期 | 小项目、脚本、快速试用 | 现 Lite 2.13（11 命令 / 11 工具） |
| **quan 泉** | 通用版：个人跨会话、跨 Agent 的默认记忆 | 个人、多项目 | 独立开发者、长期项目 | 现完整包 2.13（29 / 29） |
| **yuan 渊** | 专业攻坚版：大仓库、长周期、上下文预算 | 单人多模块 / monorepo | 技术负责人、攻坚型项目 | 新建 |
| **hai 海** | 协作强化版：多人多机多 Agent 的共享记忆 | 团队 / 组织 | 团队、平台组、企业 | 新建 |

---

## 3. 四版能力矩阵

> 命令数与工具数是目标值，定版时以 `help --json` 与 MCP `tools/list` 实际计数为准。

| 维度 | xi 溪 | quan 泉 | yuan 渊 | hai 海 |
|---|---|---|---|---|
| **部署形态** | 本地 CLI + MCP | 本地 CLI + MCP | 本地 CLI + MCP + workspace 索引 | 本地 + 共享 hub / 自托管服务 |
| **存储** | 5 个核心 Markdown 文件 | 10 个核心文件 + assets + 可选缓存 | 多口袋 workspace + 可选向量/图索引 | 共享 hub + 每项目口袋 + 审计日志 |
| **记忆范围** | 项目内轮次与偏好 | 跨会话、跨 Agent、跨项目检索 | 跨模块、长周期、代码结构上下文 | 跨人、跨机、跨 Agent、跨团队 |
| **捕获方式** | Agent 手动/自动记录 | 全量轮次 + handoff + import | + CI/PR 摘要、仓库地图、批量导入 | + 会议/PR/IM 连接器、审批后入库 |
| **检索** | 全文扫描 | 全文 + 多跳图 + 相关度排名 | + 仓库地图、混合检索、上下文预算 | + 联邦检索、命名空间、ACL |
| **上下文组装** | `handoff` / `recall` | `handoff` + `--rank` + 跨项目结果 | `context build --max-tokens` + repo map | 角色化团队简报 + 来源与权限过滤 |
| **写入治理** | secrets 扫描 + verify | 冲突门 + verify + merge 回滚 | 深度 verify / repair / merge 复核 | 多写者队列 + 评审 + 审批 + 审计 |
| **跨口袋** | 无 | `hub search` + `merge --from` | 多口袋合并编排 + 冲突处理 | 自动同步 + 冲突队列 + 团队合并 |
| **协作** | 无 | 个人多 Agent | 个人 + 结对/评审只读视图 | 角色、评审、审批、团队 handoff |
| **安全治理** | 本地、零网络 | 隔离运行 + 秘密扫描 | 策略化脱敏、保留期、深度审计 | RBAC/SSO、保留期、来源链、审计导出 |
| **扩展接口** | CLI / MCP | CLI / MCP / import | + workspace manifest / context API | + 服务 API / Webhook / GitHub·GitLab·IM |
| **命令 / 工具目标** | 11 / 11 | 29 / 29 | ~38 / 38 | ~45 / 45 + 服务 API |
| **版本内模式** | `brief` / `full` | `solo` / `agent` / `brief` / `full` | `focus` / `audit` / `migrate` | `team` / `review` / `private` |
| **明确不做** | 缓存、团队、服务端 | 团队权限、服务端 | 实时多人写入 | 通用数据湖、模型托管 |

---

## 4. 各版 MVP 与后续

### xi 溪（3.0 MVP：只改名，不加功能）

- 保留 11 命令 / 11 工具、5 文件、零缓存零依赖
- 包名、CLI、MCP、tag、zip 全部切到 xi
- 内部模式：`brief` / `full`（沿用现有输出分级）
- 后续：一键接入向导、与 quan 的显式升级命令

### quan 泉（3.0 MVP：补齐 merge 闭环）

- 保留 29 命令 / 29 工具、完整图上下文、`--rank`、isolation、handoff
- 新增 `hub merge <项目名>`：按 `hub list` 注册名选源，省去手敲路径
- 新增 `merge report [--json]` 与 `merge report --apply <id>`：复核 state / code-map / 冲突项
- 新增 `handoff --max-tokens <n>`：先给通用版的上下文预算能力
- 内部模式：`solo`（人驱动）/ `agent`（MCP 驱动），输出仍支持 `brief` / `full` / `--json`

### yuan 渊（3.0 MVP：专业攻坚）

- **workspace 多口袋**：一个 manifest 管多个子项目口袋，跨口袋 recall / search / merge
- **repo map + 上下文预算**：文件/符号地图按图相关度排序，装入固定 token 预算
- **深度诊断**：`verify --deep`、`repair --plan`、`merge report --apply`
- **记忆生命周期**：`consolidate`（合并重复）、`forget`（按保留期/来源删除）、`recap`（长周期回顾）
- **可选增强检索**：本地索引 + 语义/关键词混合；默认仍可纯扫描
- 内部模式：`focus`（最少上下文）/ `audit`（全证据链）/ `migrate`（大版本迁移）
- 明确不做：实时多人写入、云端托管

### hai 海（3.0 MVP：协作闭环）

- **共享 hub**：团队命名空间（org / team / repo / user / agent），先支持 git / 对象存储同步
- **多写者协调**：写锁、冲突队列、合并评审；`merge report --apply` 团队版
- **治理**：RBAC、来源链、审计日志、保留期、导出/删除
- **团队 handoff**：按角色生成简报，带来源与可见范围
- **连接器**：GitHub / GitLab / CI / 飞书 / Slack（先只做捕获，不做双向同步）
- 内部模式：`team`（共享）/ `review`（审批）/ `private`（本地草稿）
- 明确不做：通用知识库、模型托管、完整数据湖

---

## 5. 参考项目与可借鉴点

| 项目 | 已验证的做法 | 对应版本 |
|---|---|---|
| [Basic Memory](https://www.basicmemory.com/playbooks/coding-memory) | 纯 Markdown + 图 + MCP；按需检索，不把全部记忆塞进上下文；CI 在 PR/部署后自动写入“改了什么、为什么” | xi / quan / hai |
| [Claude Code memory](https://docs.anthropic.com/en/docs/claude-code/memory) | 小份始终加载的 `CLAUDE.md` + 按需读取的详细记忆；压缩后从磁盘重读 | xi / quan |
| [Aider repo map](https://aider.chat/docs/repomap.html) | 全仓符号地图 + 图排序 + 固定 token 预算（默认 1k），按聊天状态动态扩缩 | yuan |
| [Mem0](https://mem0.ai/library/agent-memory/memory-hierarchy-in-ai-systems-from-sensory-to-semantic) | session / user / agent 分层；add / search 作为一等操作；自动抽取事实与偏好 | quan / yuan / hai |
| [Letta / MemGPT](https://docs.letta.com/guides/agents/architectures/memgpt) | 两层记忆（常驻小块 + 外部存储）；Agent 自编辑记忆；工具化管理 | yuan |
| [Zep / Graphiti](https://help.getzep.com/graph-overview) | 时序知识图；事实、关系、来源随时间的有效区间；来源 episode 可追溯 | yuan / hai |
| [Cognee](https://www.cognee.ai/inside-cognee-1-0) | `remember / recall / improve / forget` 四动词；图 + 向量 + 关系三存储；巩固与遗忘 | yuan / hai |
| [Agent Memory Maturity Model](https://www.mintive.com/blog/agent-memory-maturity-model) | 从会话内到组织级五阶段；来源、访问范围、保留期、审计等治理支柱 | hai |
| [LangSmith Fleet](https://blog.langchain.com/introducing-langsmith-fleet/) | Agent 行为与工具调用的完整审计轨迹 | hai |

**差异化主张**：以上项目大多是数据库/服务优先；ContextPocket 坚持 **Markdown 是真相、口袋可带走、无厂商锁定**。xi/quan 保持本地零依赖；yuan 才引入可选索引；hai 才引入共享服务，但仍保证可导出回 Markdown。

---

## 6. 代码组织

四个独立版本，不复制四份实现：

```text
/                     # quan（现根包，先保持原位）
lite/                 # xi（3.0 暂不物理改名）
lang/                 # 新建：workspace / repo-map / context / lifecycle
hai/                  # 新建
shared/               # 纯逻辑，逐字同源
  parser / io / fields / secrets / isolate / edition
  links-core / render / budget / when
scripts/sync-core.js  # shared -> 各版 lib/，带哈希清单与漂移检查
```

- 每个版本独立拥有：`package.json`、`bin/`、MCP 入口、命令面、help、templates、README、SKILL、tests、metrics
- `shared/` 只放跨版本必须逐字一致的**纯逻辑**；缓存、索引、merge、hub、命令壳留在各版
- `sync-core.js` 负责同源复制与 diff 检查，CI 的 `node scripts/sync-core.js` 是家族门禁
- 模式是各版内部实现，不跨版本暴露为统一开关

### shared v2（yuan 启动前置，已完成）

- 把 `links.js` 拆成纯派生 `links-core` 与 quan 的缓存外壳；xi 继续只用纯派生。
- 把 handoff 的 token 估算与裁剪抽成 `shared/budget`，yuan 的 `context build` 直接复用。
- 把“这轮动过哪些文件”抽成 `shared/files`，主包 query 与 xi core 共用。
- 能共享的输出渲染暂留在各版 formatter；它们与版本颜色/文案耦合，等 yuan 需要时再抽。
- 共享清单从 7 个文件扩到 25 个，`sync-core` 支持 `targetsByFile`：`core` / `constants` / `when` / `version` / `budget` / `links-core` / `indexer` / `query` / `validator` / `migrate` / `writer` / merge 闭包等按需进 quan + yuan，其余双份或三份。
- `tests/shared.js` 逐字比对，并新增“纯层不得依赖缓存/命令模块”的锁。

> **3.0 落地状态**：`lite/` 目录暂不物理改名，包名 / 命令 / 文档已切到 xi；`xi/` 目录迁移推迟到后续，避免 CI 与路径的大规模迁移风险。`shared/` 当前收录 25 个逐字同源文件（`budget`、`constants`、`core`、`edition`、`fields`、`files`、`handoff-path`、`indexer`、`io`、`isolate`、`lifecycle`、`links-core`、`links`、`merge-review`、`merge`、`migrate`、`parser`、`query`、`repair`、`secrets`、`userhub`、`validator`、`version`、`when`、`writer`），由 `tests/shared.js` 锁定；`lang/` 已从预览转正（10 命令 / 10 工具，`edition.json` status=stable，API 冻结），`hai/` 仍为 private 骨架。quan 收尾已落地：`hub merge`、`merge report --apply`、`handoff --max-tokens`、`--edition-mode solo|agent`；CI 已加 `sync-core` 门禁并覆盖 Node 18 / 20 / 22。yuan 的 shared v2 前置已完成；发版自动化见 `scripts/release.js`。

---

## 7. 版本、发布与迁移

- **家族版本**：3.0；四版同日发，之后可独立 patch
- **tag**：`ContextPocket-3.0-xi`、`ContextPocket-3.0-quan`、`ContextPocket-3.0-yuan`（历史预览 tag 为 `ContextPocket-3.0-yuan-preview`）
- **zip**：`ContextPocket-3.0-xi.zip`、`ContextPocket-3.0-quan.zip`、`ContextPocket-3.0-yuan.zip`；由 `scripts/release.js` 统一生成（`npm pack` → 解包 → zip → notes → `gh release`）
- **npm**：四个独立包名；旧包名在 3.0 / 3.1 保留兼容别名，3.2 移除
- **数据格式**：仍为 v2；merge / hub 数据与 2.13 兼容
- **迁移**：
  - `context-pocket` → `context-pocket-quan`
  - `context-pocket-lite` → `context-pocket-xi`
  - 口袋目录不改名、不搬迁；只换可执行入口
  - 旧名转发包不复制代码，依赖对应新包并复用其 bin / MCP 入口
  - 提供 `migrate --edition <name>` 与文档对照表
- **待定**：patch 版展示规则（如 `3.0.1-xi` 是否完整显示 patch 位）

---

## 8. 路线图（按阶段，不排日期）

### 阶段 0 · 家族地基（含 quan 收尾）
- 四个包名 / CLI / tag / zip 规范落地；旧名转发包上线
- `shared/` 抽取 + `sync-core` + 四版一致性测试
- xi / quan 3.0 只做改名与迁移，不加新功能
- quan 顺手收尾：`hub merge <项目名>`、`merge report [--apply]`、`handoff --max-tokens`
- 能力矩阵、版本选择器、迁移文档

### 阶段 1 · yuan MVP（优先）

**前置**：shared v2 抽取（links-core / budget / render / when），完成后才起 yuan 命令层。

- **1A workspace**：`contextpocket.workspace.json` + 多口袋 resolve；跨口袋 search / recall / merge；限定 id `pocket:Tn`。
- **1B repo map + 预算**：JS/TS/Python 正则扫描，文件级 + 顶层符号；`context build --max-tokens` 复用 shared/budget。
- **1C 深度诊断**：`verify --deep`、`repair --plan`、`merge report --apply` 的 workspace 编排。
- **1D 生命周期**：`consolidate` / `forget` / `recap`，默认 dry-run。
- **检索**：MVP 现场扫描 + repo map；阶段 2 已加工作区本地 BM25 索引（`.contextpocket/search-index.json`），按源文件签名增量刷新，`--no-index` 仍可回退现场扫描。

验收：3 个口袋组成的工作区可检索、回看、合并；`context build` 在 2k / 6k / 12k 预算下输出稳定可解释；所有新增能力不改变 pocket 格式 v2。

> **3.0 stable 已落地**：`workspace`（init/add/remove/list/status/search/index/recall/verify/repair）、`merge`（按口袋名，默认 dry-run）、`capture`（本地摘要 / `gh pr view` / `gh run view` → T-block，写前凭据扫描）、`map`（update/view/verify，增量扫描）、`context build/explain`（事实标注 pocket 来源）、`recap`、`audit`、`decay`（冷轮次前缀；`--apply` 归档同一份候选）、`forget`、`consolidate`（口袋内 + 跨口袋重复）与对应 MCP 十个工具；`focus` / `audit` / `migrate` 已落成 context / search / recap 的默认预设。阶段 2 的索引、审计、衰减与 PR/CI 捕获均已完成。

### 阶段 2 · yuan 专业增强
- 已完成：本地 BM25 索引、workspace 审计、decay、CI/PR 摘要捕获

### 阶段 2.5 · 质量与性能（P3，已完成）
- quan `search --rank bm25`：默认字段权重顺序不变，BM25 只重排命中。
- `merge report --apply` 补目标 code-map 的 missing 描述；different 仍人工。
- MCP 常驻进程 `parseAll` 签名缓存（默认关闭，仅 MCP 启用）。
- `scripts/bench-workspace.js`：10 口袋 × 1000 轮的 search / context / audit 延迟。
- 内核收敛：`shared/rank.js` 统一 quan / yuan 的 BM25 公式与词频统计；`shared/mcp-runtime.js` 统一 JSON-RPC 传输层，xi 不接入。
- 格式决策：时间戳时区不进入 format v3，跨时区合并成为真实痛点前不改格式。

### 阶段 2.6 · 工作区时间图（阶段 A，已完成）
- 显式 `pocket:Tn` → `x-ref` 强边；裸 T / 同 tag / 同文件 / 时间接近不猜。
- `context build/explain --expand 1|2` 在 Related 增加 Graph 段；`--as-of <日期|pocket:Tn>` 按 WHEN 日期切片，默认 `expand=0` 输出不变。
- 派生缓存 `.contextpocket/workspace-graph.json`，按口袋签名增量重建；`status` / `audit` 只读检查图健康，不主动建图。
- `shared/graph-core.js`（零依赖纯函数）；xi 不接入；不新增命令，yuan 仍 10 命令 / 10 工具。

### 阶段 2.7 · 工作区时间图派生边（阶段 B，已完成）
- `--graph-edges duplicate|shared-file|tag|near|all` 显式开启；`--graph-near-days` 默认 7。
- 派生边全部 weak：相同 ADR / 需求 / 偏好、同路径、同标签、共享 tag/文件且时间接近的轮次。
- 偏好节点 + `updated-in` 锚定；缓存 version 2，签名加入 `preferences.md`。
- 有界：每 key 最多 5 口袋、near 两级上限、派生边总数 2000；Graph 段输出 Derived 汇总与示例。
- 仍未做：有界 PPR、`workspace graph` 子命令。

### 阶段 3 · hai MVP
- 共享 hub（git / 对象存储优先）
- 多写者冲突队列 + 评审/审批
- RBAC、来源链、审计日志、保留期
- 团队 handoff + CI/IM 连接器

### 阶段 4 · 生态
- 自托管服务与云端托管
- 连接器市场 / 模板市场
- 组织级分析（记忆覆盖率、上下文节省、冲突解决时长）

---

## 9. 成功指标

| 维度 | 指标 |
|---|---|
| 采用 | 安装到首个 T-block 的完成率；7 日留存；版本选择页转化 |
| 记忆质量 | 跨会话 recall 命中率；handoff 后无需重复解释的比例；verify 错误率 |
| 上下文效率 | 相同任务下节省的 token；`context build` 预算命中率 |
| 合并 | merge 成功率；冲突数量与解决时长；回滚率 |
| 协作（hai） | 周活团队数；评审通过率；审计导出使用率 |
| 可移植 | 导出回 Markdown 的成功率；跨版本读取成功率 |

---

## 10. 风险与非目标

**风险**
1. 四版碎片化 → `shared/` + 四版一致性锁 + 能力清单（capability manifest）
2. 功能蔓延 → 每版写清“明确不做”；跨版能力先过矩阵
3. hai 的安全承诺过重 → 没有 RBAC/审计/保留期就不发布 hai 稳定版
4. Markdown 规模上限 → yuan 才引入可选索引；hai 用服务层分片
5. 改名迁移流失 → 旧包名兼容别名 + 一页迁移指南

**非目标**
- 不做通用向量数据库/模型托管
- 不要求用户放弃 Markdown 作为真相
- 不把四个版本做成同一包里的模式开关

---

## 11. 已定与待定

**已定**
1. 旧包名保留一个周期：3.0 / 3.1 兼容，3.2 移除。
2. `yuan` 优先于 `hai`；`yuan` MVP 在家族地基与 quan 收尾之后开始。
3. **yuan 启动前先做 shared v2**：先把纯逻辑抽进 `shared/`，再让 yuan 只写增量层，不复制 quan 核心。
4. **workspace manifest**：`contextpocket.workspace.json` 放在工作区根，可提交到 git；只存相对路径与策略，不存项目内容。
5. **repo map MVP**：JS / TS / Python 正则扫描，文件级 + 顶层符号；零依赖、可跳过 vendor/大文件。
6. **yuan MVP 检索**：现场扫描 + repo map；本地 BM25/混合检索留到阶段 2，接口预留。

**待定**
1. patch 版本的展示规则：`3.0-xi` 是否显示 `3.0.1-xi`？

---

## 12. yuan MVP 实施蓝图（已定）

### 12.1 分层

```text
shared/                  纯逻辑：parser / io / fields / secrets / isolate / edition
                         links-core / render / budget / when
quan/lib/               缓存、索引、merge、hub、命令壳
lang/lib/
  workspace/             manifest 解析、口袋解析、限定 id
  repomap/               语言识别、文件/符号扫描、缓存
  context/               选材、排序、预算分配、渲染
  lifecycle/             consolidate / forget / recap
  cli/ + mcp/            命令与工具壳（能力声明进 edition.json）
```

原则：yuan 不复制 quan 的索引/merge/hub；跨版能力先落到 shared，再由各版包一层。

### 12.2 workspace manifest

`contextpocket.workspace.json` 放工作区根，可提交；只存结构，不存内容：

```json
{
  "version": 1,
  "name": "payments",
  "pockets": [
    { "name": "api", "path": "./services/api/ContextPocket" },
    { "name": "web", "path": "./apps/web/ContextPocket" }
  ],
  "context": { "defaultMaxTokens": 6000, "includeRepoMap": true },
  "repoMap": { "languages": ["js", "ts", "py"], "maxFiles": 500 },
  "index": { "mode": "scan" }
}
```

规则：

- `path` 用正斜杠相对路径，解析时统一 normalize；缺失口袋只报错不猜测。
- 跨口袋 T 号必须限定：`api:T12`；裸 `T12` 只在单口袋命令里有效。
- workspace 缓存放 `.contextpocket/`（repo map、索引），默认 gitignore；清单本身可提交。
- `version` 不兼容时拒绝写入，迁移由后续 `workspace migrate` 处理。

### 12.3 repo map

- 首版支持 JS / TS / Python；按扩展名与忽略规则筛选（node_modules、vendor、dist、minified、超大文件）。
- 文件级记录：路径、语言、大小、mtime、顶层符号（function/class/export/def）。
- 缓存键：`path + size + mtime`，`map verify` 报告漂移，`map update` 重建。
- 不做完整 AST；解析失败退化为文件级条目并在输出里注明。
- 不写进 pocket Markdown，也不改变 T-block 格式。

### 12.4 context build

1. 固定层：STOP CONDITION、🔒 红线、❓ 待确认、next steps。
2. 事实层：state、当前 ADR、open requirements、最近 N 轮。
3. 相关层：workspace search 命中 + repo map 中与命中文件/符号相关的条目。
4. 排序：显式提及 > 图邻近 > 时间新近；同分按口袋名与 T 号稳定排序。
5. 预算：按层分配，先裁相关层，再裁事实层，固定层永不裁；每次裁剪写明“裁了什么、去哪看”。
6. 输出：带来源（`pocket:Tn` / 文件路径 / ADR id）；`--json` 返回同样的结构，不返回未裁剪的隐藏内容。

### 12.5 命令面（目标 ~35-38）

- `workspace init/add/remove/list/status/search/index/recall/verify/repair`
- `merge`（工作区口袋之间）
- `capture`（本地 PR / CI 摘要）
- `map update/view/verify`
- `context build/explain`
- `audit`（workspace 健康 / 活动 / 未决事项）
- `consolidate` / `decay` / `forget` / `recap`
- `verify --deep`、`repair` 作为选项，不新增命令
- 最终数量以 `help --json` 为准，并同步 `lang/edition.json`

### 12.6 验收与测试

- 三口袋工作区 fixture：跨口袋 search / recall / merge / context build。
- 预算快照：2k / 6k / 12k 三档，断言固定层完整、截断说明存在、无未标注来源。
- repo map：JS/TS/Python 样本、忽略目录、mtime 漂移、损坏缓存回退。
- 兼容：quan / xi 直接读写 yuan workspace 里的任意 pocket；yuan 不修改 pocket 格式。
- 家族锁：shared 逐字一致、edition.json 与 help 数量一致、CI 全绿。

### 12.7 明确不做（MVP）

- 不引入 tree-sitter、向量库或嵌入模型。
- 不做云端同步、实时多人写入。
- 不自动修改历史轮次；`forget` 只走归档 + 显式 apply。
- 不把 workspace 配置写进 pocket Markdown。

---

## Sources

- [Basic Memory · Persistent memory for coding](https://www.basicmemory.com/playbooks/coding-memory)
- [Claude Code · How Claude remembers your project](https://docs.anthropic.com/en/docs/claude-code/memory)
- [Aider · Repository map](https://aider.chat/docs/repomap.html)
- [Mem0 · Memory Hierarchy in AI Systems](https://mem0.ai/library/agent-memory/memory-hierarchy-in-ai-systems-from-sensory-to-semantic)
- [Letta · Agent memory & architecture](https://docs.letta.com/guides/agents/architectures/memgpt)
- [Zep · Context Graph overview](https://help.getzep.com/graph-overview)
- [Cognee · Inside cognee 1.0](https://www.cognee.ai/inside-cognee-1-0)
- [Mintive · The Agent Memory Maturity Model (2026)](https://www.mintive.com/blog/agent-memory-maturity-model)
- [LangSmith Fleet](https://blog.langchain.com/introducing-langsmith-fleet/)
