# Changelog

All notable changes to ContextPocket will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

> 开发中版本，预计发布为 1.1.0。

### Added

**🔍 Path A：借鉴参考项目的新增机制**

- **`why` 反向检索** — `context-pocket why <file-path> [--limit <N>]`
  - 借鉴 [ThoughtDAG](https://github.com/chenxiachan/thoughtdag) 的 `why_file` / `why_check` 思路
  - 给定文件路径，返回提到该文件的所有 T-block，按时间倒序
  - 检索范围：Action / Changes / Pitfalls / Notes / Commits / User section
  - 路径分隔符自动兼容（Windows `\` ↔ Unix `/`）
  - 新 MCP 工具 `context_pocket_why`（参数：filePath / limit）
  - 新增文件：`lib/query.js` 新增 `why()` 函数

- **`verify --drift` cognition refresh 轻量版** — `context-pocket verify --drift [--drift-last-n <N>]`
  - 借鉴 [AOCI-CODE](https://github.com/aoci-spec/aoci-code) 的 cognition refresh 概念
  - 对比「最近 N 个 T-block 引用的文件」vs「working tree 中实际存在的代码文件」
  - 检测两类 drift：
    - **Unrecorded (WARNING)**：working tree 中有但 T-block 没提到的代码文件
    - **Phantom (INFO)**：T-block 提到了但 working tree 找不到的文件
  - 默认关闭（路径扫描开销大），需显式 `--drift` 启用
  - `--drift-last-n <N>` 调节回看的 T-block 数（默认 5）
  - MCP 工具 `context_pocket_verify` 新增 `drift` / `lastN` 参数
  - `lib/validator.js` 新增 `checkLogCognitionDrift()` 函数

**📦 Path B：借鉴 Basic Memory 的新增机制（2026-09-19）**

- **检索索引层** — `context-pocket index [--rebuild]` / `context_pocket_search [--no-index]`
  - 借鉴 [Basic Memory](https://github.com/basicmachines-co/basic-memory) 的「Markdown 为唯一真相源 + 派生索引缓存」架构
  - Markdown 文件始终先写；索引只是 `ContextPocket/assets/search-index.json` 里一份可随时重建的派生缓存
  - 索引范围：log.md + log-archive.md 的所有 T-block、decisions.md 的 ADR、requirements.md 的需求、preferences.md 的偏好行
  - 分词：拉丁词按非字母数字切分；CJK 文本取二字组（bigram），中英混合查询均可命中；查询用 AND 语义 + 子串校验去噪
  - 懒刷新：search 前对比源文件 mtime+size 签名自动增量重建；索引损坏 / 缺失自动回退到全量扫描
  - 新 MCP 工具 `context_pocket_index`（参数：rebuild）
  - 新增文件：`lib/indexer.js`（buildIndex / searchWithIndex）

- **用户级 Hub** — `context-pocket hub [list|pref|remove]`
  - 借鉴 Basic Memory 的「跟着人走」用户级知识库定位
  - 存储位置：`~/.contextpocket/hub.json`（可用 `CONTEXTPOCKET_HOME` 环境变量重定向到网盘 / dotfiles 仓库，实现多机共享）
  - 内容：注册过的项目（路径 → 名称 / 类型 / 最新 T / 最近活跃时间）+ 用户级全局偏好（跨项目生效，项目 preferences.md 缺失时兜底）
  - 设计原则：hub 只是注册表，项目数据永远在各项目的 `ContextPocket/` 里；所有写入都是 best-effort，hub 故障绝不影响正常记录
  - 触发点：`bootstrap` 自动 `registerProject`；`log append` 自动 `touchProject` 更新最新 T
  - 新 MCP 工具 `context_pocket_hub`（action: list / pref / remove）
  - 新增文件：`lib/userhub.js`（getHubDir / getHubFile / readHub / writeHub / registerProject / touchProject / removeProject / listProjects / setGlobalPref / getGlobalPref）

- **旧信息蒸馏** — `context-pocket distill [--dry-run]`
  - 借鉴 Basic Memory 的「活文档」思路：归档不等于埋葬
  - 扫描 log-archive.md + log.md 旧轮次，把仍然有价值的决策 / 坑点 / 偏好 / 待确认项 提取成 `ContextPocket/digest-<date>.md` 报告
  - 由 Agent 或用户逐条判断后合回 `decisions.md` / `state.md` / `preferences.md` 这些活文档
  - 报告只读不改活文档 —— 合并动作由 Agent 完成（需人工判断是否仍然有效），合并完可删
  - 新 MCP 工具 `context_pocket_distill`（参数：dryRun）
  - 新增文件：`lib/distill.js`（distill）

- **历史会话导入** — `context-pocket import --file <session.jsonl> [--source auto|claude-code|codex] [--limit N] [--truncate N] [--dry-run]`
  - 让「中途启用」的项目不丢历史
  - 把各家 Agent 留在本地磁盘的会话记录（JSONL）解析成 T-block 批量补录进 log.md，T 编号从当前最新继续，统一打 `[imported]` 标签
  - 支持 `claude-code`（`~/.claude/projects/<project>/<session>.jsonl`）、`codex`（`~/.codex/sessions/`）、`auto`（嗅探兜底，识别任何 `{message:{role,content}}` / `{role,content}` 形状的 JSONL）
  - 自动跳过工具调用噪音（tool_use / tool_result）、命令标记、系统注入文本
  - 新 MCP 工具 `context_pocket_import`（参数：file / source / limit / truncate / dryRun）
  - 新增文件：`lib/importer.js`（importSession）

### Changed

**🪶 文档精简（2026-09-19）**

- **`SKILL.md` 拆分为 3 文件**（51.7 KB → 18.8 KB 主文件，−64%）
  - [`SKILL.md`](SKILL.md) — 日常必读主体：YAML + Usage boundary + Execution modes + Commands + Per-turn rules + Pre-reply safety hook + Corrections + Cross-agent handoff（18.8 KB / 203 行）
  - [`SKILL-advanced.md`](SKILL-advanced.md) — 按需加载：Bootstrapping from templates + Project type templates + Archiving + Edge cases（含 Version migration）（6.8 KB / 79 行）
  - [`SKILL-reference.md`](SKILL-reference.md) — 纯参考：完整 Layout + 每个文件的模板注释 + log.md T-block 完整规范 + filled example + config.md 字段表（13.4 KB / 265 行）
  - 顶部加交叉链接 + 入口说明
- **`templates/help/` 目录移除**（11 文件 / 14.9 KB → 0）
  - 之前用于存放 `/help` 命令的分类回复模板，但**所有代码均不引用**（`bin/context-pocket.js` / `lib/*.js` / `mcp-server.js` 都没有 `readFileSafe('help/...')` 调用）
  - SKILL.md 中 `/help` 段改为"Agent 内联生成，引用本文件 Commands 区与 `docs/FAQ.md`"
  - CHANGELOG 历史记录保留（自然注脚）
- **README 中英版**顶部加一行提示三件套；CONTRIBUTING 的"在 SKILL.md 加 Bootstrapping 表一行"改为指向 `SKILL-advanced.md`

**🛣️ Roadmap 全部完成**

- **`bootstrap` 命令** — `context-pocket bootstrap` 一键初始化项目 ContextPocket
  - 自动检测项目类型（frontend / backend / fullstack / data / mobile）
  - 扫描项目目录树，预填 code-map.md 和 state.md
  - 复制所有模板到 ContextPocket/，更新 index.md、readme.md、config.md
  - 支持 `--project-type` / `--mode` / `--language` 参数
  - 新文件 `lib/bootstrap.js`（detectProjectType / scanProjectTree / bootstrap / prefillTemplate / updateConfigValues / updateGitignore）

- **查询命令** — `context-pocket recall` / `diff` / `search` / `check-conflicts`
  - `recall <T-id>` — 查看指定 T-block 完整详情
  - `diff <Ta> <Tb>` — 对比两轮的需求 / ADR / 文件变化
  - `search <keyword>` — 全文搜索所有 T-block（含 gist、tags、notes）
  - `check-conflicts` — 6 维冲突扫描（技术栈 / 需求 / ADR / 风格 / 部署 / 🔒），三级严重度（critical / warning / info）
  - 新文件 `lib/query.js`

- **归档命令** — `context-pocket archive [--keep-last <N>] [--dry-run]`
  - 归档前 verify → 归档 → 归档后 verify → 失败自动回滚
  - 旧 T-block 移到 log-archive.md（压缩为 3-4 行摘要）
  - 附件移到 assets/archive/，更新所有路径引用
  - writer.js 新增 archiveLog()

- **状态写入命令** — `context-pocket state update` / `preferences update` / `code-map update`
  - `state update --summary "..." [--next-step "..."] [--pitfall "..."]` — 更新 state.md
  - `preferences update --key "..." --value "..."` — 更新 preferences.md
  - `code-map update` — 重扫项目目录，保留已有描述，新文件标记 TODO
  - writer.js 新增 updateState() / updatePreferences() / updateCodeMap()

- **迁移工具** — `context-pocket migrate [--to <version>] [--dry-run] [--list]`
  - 格式版本自动检测（readme.md `format: v<N>`）
  - 迁移前自动备份（ContextPocket.backup-TIMESTAMP）
  - 迁移后 verify，失败自动回滚
  - 当前 v1 noop 迁移（格式校验）
  - 新文件 `lib/migrate.js`

- **Git pre-commit hook v2** — `context-pocket install-hook` / `uninstall-hook`
  - **v2 两步行为**（升级自 v1 的单步 verify）：
    1. `context-pocket sync --auto` — git 漏记兜底：自动检测 staged 变更中未被最近 T-block 记录的文件，自动补录一个 `[auto]` T-block（解决 Agent 漏记的核心问题）
    2. `context-pocket verify --quiet` — 健康检查：有 error 阻止提交，warning 放行
  - `install-hook` 自动升级：已安装 v1 hook 时再次运行自动替换为 v2，无需手动卸载
  - Hook 安装时注入 CLI 绝对路径（正斜杠格式），不依赖 node_modules / npx
  - Hook 内 git 出错 / node 找不到 / CLI 不存在时均跳过（不阻断提交）
  - 成对 MARKER 管理 hook 区块，精确安装/升级/卸载
  - 新文件 `lib/sync.js`（detectUnrecorded / buildCatchupBlock / sync）
  - `lib/hooks.js` 升级为 v2

- **`sync` 命令** — `context-pocket sync [--auto] [--dry-run] [--last-n <N>] [--quiet]`
  - **检测原理**：对比「git staged 变更」与「最近 N 个 T-block 的 Action 文件路径」，找出漏记项
  - 默认 report-only（不写入），`--auto` 时自动补录 `[auto]` T-block
  - `--dry-run` 显示补录计划而不写入；`--quiet` 单行输出（hook 使用）
  - 覆盖判定：同一文件在最近 N 个 T-block 中出现过则跳过（幂等）
  - 忽略 `ContextPocket/` 自身；非 git / 无 log.md / git 出错时安全降级（skip 不报错）
  - CLI exit code：0 = 成功（含 clean/auto-fill/skipped），1 = 检测到 error 需要手动处理
  - MCP 新增 `context_pocket_sync` 工具（参数：auto / dryRun / lastN）

- **MCP Server 全量工具** — mcp-server.js 新增 11 个工具
  - `context_pocket_bootstrap` / `context_pocket_recall` / `context_pocket_diff` / `context_pocket_search`
  - `context_pocket_check_conflicts` / `context_pocket_state_update` / `context_pocket_preferences_update` / `context_pocket_code_map_update`
  - `context_pocket_archive` / `context_pocket_migrate` / `context_pocket_install_hook` / `context_pocket_uninstall_hook`

- **CLI 路由完善** — bin/context-pocket.js 现有 17 个命令全部完成路由

**三形态架构（MCP + CLI + 纯 Skill）**
- **纯 Skill 模式可靠性提升 6/10 → 8/10**
  - SKILL.md 新增「Pre-reply safety hook」强化版：每轮开始前**强制 T 编号一致性检测**（读 log.md 最新 T → 对比对话窗口内容 → 漏记则拒绝继续并补档）
  - 所有关键规则改为 **MUST 强制措辞**，P0 规则（`log.md` 必须追加）标注为 non-negotiable
  - Mode 3 描述明确说明：Pre-reply safety hook 中的 MUST-rules 是**不可绕过的强制规则**
  - Lite mode 描述强化：即使 Lite mode 也必须遵守所有 per-turn MUST-rules

- **CLI 工具** `bin/context-pocket.js`（零依赖 Node.js 脚本，6 个命令）
  - `verify` — 健康检查（10 项校验：文件存在性 / T-id 连续性 / R-id 连续性 / ADR 连续性 / index 一致性 / T-block 格式 / 引用完整性 / code-map 漂移 / handoff 过期 / 标题一致性）
  - `status` — 一行状态摘要（当前 T 编号 / 开放需求数 / 待确认数 / 绝对保留数）
  - `log append` — 追加 T-block 轮次记录（自动分配 T-id / 自动更新 index / session 分组）
  - `req add` — 新增需求（自动分配 R-id / 安全编号校验 / 防止重复）
  - `decision add` — 新增架构决策（自动分配 ADR 编号 / 安全校验）
  - `handoff` — 生成单文件交接摘要 handoff.md
- **MCP Server** `mcp-server.js`（零依赖，stdio 传输协议）
  - 6 个 MCP 工具：`context_pocket_status` / `context_pocket_verify` / `context_pocket_log_append` / `context_pocket_req_add` / `context_pocket_decision_add` / `context_pocket_handoff`
  - 支持 MCP 的 Agent（Trae / Claude Desktop 等）可直接调用，结构化参数零格式错误
- **核心逻辑层** `lib/`（6 个模块，CLI 和 MCP 共享同一套逻辑）
  - `constants.js` — 常量定义（文件名、优先级、标签等）
  - `core.js` — 路径解析 / 配置读取 / 工具函数
  - `parser.js` — Markdown 结构化解析（log / requirements / decisions / index / state / preferences / absolute）
  - `validator.js` — 校验器（10 类检查项，按严重程度分级）
  - `writer.js` — 写入器（安全编号生成 / 自动同步 index / 防重复）
  - `formatter.js` — CLI 输出格式化（彩色 / 分组 / 严重度标识）

**Skill 升级**

- SKILL.md 新增「Execution modes」章节：三模式自动降级链路（MCP → CLI → 纯 skill），Agent 启动时自动检测最优模式
- `/openpocket` 新增模式检测逻辑：优先用 MCP，其次 CLI，最后 fallback 到纯 skill 手写
- Per-turn 写入流程改为模式化：有 CLI/MCP 就调工具，没有就手写
- 新增 `/check-conflicts` 命令：全面扫描 ContextPocket 中的潜在冲突（6 项扫描范围，按严重程度分级输出）

**文档完善**

- `docs/MIGRATION.md` — 版本迁移指南（迁移策略 / 自动检测 / 手动迁移步骤 / 回滚方案）
- `docs/FAQ.md` — 常见问题详细解答（数据存储 / 工作流 / 协作 / 性能 / 边界 / 故障 6 大类）
- `docs/COMPATIBILITY.md` — Agent 兼容性列表 + 最小子集降级方案
- `CONTRIBUTING.md` — 贡献指南（Bug 报告 / 功能建议 / PR 流程 / 开发约定）
- README.md 新增三模式安装说明 + MCP 配置示例
- README.md 新增 Quick Start 快速上手指南
- README.zh-CN.md — 完整中文文档

**模板优化**

- `templates/on-demand/` — 按需创建模板目录（log-archive.md / handoff.md），bootstrap 时不复制
- `templates/help/` — 11 个 /help 分类回复模板，从 SKILL.md 拆分出来
- `templates/code-map.md` — 从单文件占位扩充为完整骨架模板（Structure / Key Relationships / Recently Changed 三节）
- `templates/config.md` — 新增标签双语说明注释

### Changed

- SKILL.md 精简：/help 章节从 ~430 行减至 ~50 行，详细回复模板移至 `templates/help/`
- SKILL.md 结构优化：头部新增 YAML frontmatter（name / description / version / format / tags）
- SKILL.md ADR 模板：新增 `Supersedes:` 字段，与 templates/decisions.md 对齐
- SKILL.md 冲突检测：从模糊描述改为 7 项 checklist（技术栈 / 需求 / ADR / 风格 / 部署 / 🔒 / API）
- SKILL.md 归档机制：增加归档前验证、归档后验证、失败回滚机制
- SKILL.md 标签说明：明确标签语言跟随 `language` 配置（zh / en 两套默认标签）
- SKILL.md Edge cases：新增版本迁移说明（格式版本检测 + /migrate-pocket 预留）
- `/help` 命令大幅强化：采用多级菜单导航（8 个分类 + 多种查询方式）
  - `/help` 主菜单（8 个分类入口，数字 / 分类名导航）
  - `/help all` 完整命令列表（扁平视图）
  - `/help <数字/分类名>` 进入对应分类详情
  - `/help <命令名>` 单命令详细说明
  - 智能识别（自然语言匹配，如"怎么用" / "出问题了" 等）
- README.md 排版优化：顶部更紧凑，开头直接说明使用场景 / 效果 / 方法
- CHANGELOG.md 结构调整：更清晰的版本分层 + Roadmap 章节

### Fixed

- ADR 模板不一致：SKILL.md 正文 ADR 模板缺少 Supersedes 字段，现已补充
- `status` 命令偏差：T-block 含 `[auto]` 标记时 action gist 格式与普通 T-block 不同，now correctly extracts gist from `· [` separator
- `index.md` 计数不一致：bootstrap 后 `templates/preferences.md` 包含 6 条示例内容未被清理，导致 verify 告警；已替换为注释说明占位
- `verify` bootstrap 误报：bootstrap 后 `index.md` 预填 `T0 (empty)` 且 `log.md` 为空是正确状态，`lib/validator.js` 新增 bootstrap 空白状态容错（index=T0 & log.latestT=0 时不报警）
- `lib/bootstrap.js`：index.md T-range 预填改为 `T0 (empty — bootstrap state)`，与容错逻辑对齐
- README 示例与规则不一致：T-block 示例的 Action 动词改为中文操作类型，与 language 配置对齐
- log-archive 模板与"按需创建"矛盾：模板移至 on-demand 目录，bootstrap 不复制
- README FAQ 折叠面板渲染问题：HTML 标签在部分渲染器不生效，改为纯 Markdown Q&A 格式
- README 底部 Star 提示 HTML 标签渲染问题：改为纯 Markdown 文本
- **`lib/hooks.js` exit code bug**：hook 脚本末尾无条件 `exit 0` 丢弃了 verify 失败时的 `$VERIFY_RC=1`，导致所有 commit 均被放行；已修复为 `exit $VERIFY_RC`，确保 verify error 时正确阻止提交

---

## [1.0.0] - TBD

### 核心特性

- **12 文件完整布局**：readme / index / state / requirements / preferences / decisions / code-map / log / log-archive / absolute / handoff / config
- **12 个对应模板**：`templates/` 目录下每个文件都有规范模板
- **T-block 轮次记录**：每轮对话一个 T-block，包含 Summary / Tags / Action / Changes / Decisions / Pitfalls / Questions 等结构化字段
- **R-id 需求追踪**：每条需求有唯一编号，状态管理（open / done / superseded），支持优先级和分类
- **ADR 架构决策记录**：Architecture Decision Records，记录每个重要技术决策的上下文、选择、后果
- **P0–P6 优先级降级**：token 紧张时按优先级跳过非核心文件，log.md 永远不跳

### 命令系统

- **激活 / 状态**：`/openpocket`（激活 + 漂移检查）、`/statuspocket`（一行状态）、`/putintopocket`（标记本轮重要内容）
- **查询检索**：`/recall`（查看某轮）、`/diff`（对比两轮）、`/searchpocket`（关键词搜索）
- **待办管理**：`/questions`（待确认项汇总）、`/sync`（补档漏记轮次）
- **交接协作**：`/handoff`（生成交接摘要）、`/verify`（6 项健康检查）、`/exportpocket`（快照导出）
- **维护**：`/resetpocket`（归档重建）、`/help`（帮助系统）

### 智能化特性

- **项目类型自动检测**：frontend / backend / fullstack / data / mobile 五种类型，自动预填 code-map 和 state 扩展字段
- **Lite 模式**：mode: lite 只建 5 个核心文件，适合小项目
- **自动归档**：log.md 超过 archive_at 行自动触发归档，旧轮次压缩移到 log-archive.md
- **🔒 绝对保留区**：absolute.md 永不压缩归档，存放最重要的约束和红线
- **强需求检测**：自动识别"必须 / 绝不 / MUST / NEVER"等强语气，提示标记为绝对保留
- **冲突检测**：写入前检测方向性矛盾，冲突时标记 superseded 由用户裁决
- **漂移检查**：code-map vs 实际目录树对比，检测新增 / 删除 / 移动的文件
- **Pre-reply 安全钩子**：回复前三问自检，防漏记
- **append-only 修正**：历史 T 块有错不篡改，追加 T<n>-fix 修正块

### 安全与可靠性

- **永不静默覆盖**：检测到冲突时保留旧信息并标记，由用户裁决
- **快照导出**：/exportpocket 导出单文件快照，保留最新 3 份
- **/verify 体检**：6 项健康检查（文件存在 / 编号连续 / 引用有效 / 漂移 / 过期 / 计数一致）
- **串行交接约定**：明确同一项目只能一个 Agent 写，避免并发冲突

---

## 🛣️ Roadmap

> 以下功能已在 Unreleased 中全部完成，待发布 1.1.0。

### 优先级 🔥 高（已 ✅）

- [x] **`bootstrap` 命令** — CLI 一键创建 ContextPocket，自动检测项目类型、预填 code-map 和 state
- [x] **查询命令** — recall / diff / search / check-conflicts
- [x] **`check-conflicts` 命令** — CLI 版冲突扫描，6 项扫描范围，三级严重度

### 优先级 ⭐ 中（已 ✅）

- [x] **归档功能** — `context-pocket archive`，归档前/后验证 + 自动回滚
- [x] **更多写入命令** — state update / preferences update / code-map update

### 优先级 🟢 低（已 ✅）

- [x] **迁移工具** — `context-pocket migrate`，格式检测 + 备份 + 回滚
- [x] **Git pre-commit hook** — `install-hook` / `uninstall-hook`
- [ ] **MCP 增强** — 资源（resources）和提示（prompts），后续版本

---

## 版本说明

### 语义化版本

- **Major (X.0.0)**：破坏性变更（模板格式、文件名、命令名变更）
- **Minor (0.X.0)**：新增功能 / 新增命令（向下兼容）
- **Patch (0.0.X)**：Bug 修复 / 文档修正

### 数据格式版本

`ContextPocket/readme.md` 里的 `format: v1` 是 **数据格式版本**，与 skill 版本独立。即使 skill 升级到 2.0，旧项目里 `format: v1` 的 ContextPocket/ 仍应可读。如果未来格式升级不兼容，会同时升 v1→v2 并提供迁移工具。

---

## 贡献者致谢

见 [README.md](README.md) 和 GitHub Contributors 页面。
