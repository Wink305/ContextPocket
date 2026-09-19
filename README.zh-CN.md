# ContextPocket

> **[English](README.md)** · [文档目录](docs/) · [更新日志](CHANGELOG.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Skill Format: v1](https://img.shields.io/badge/format-v1-blue.svg)](SKILL.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> **SKILL 文档拆成 3 份**：[SKILL.md](SKILL.md)（日常必读主体） · [SKILL-advanced.md](SKILL-advanced.md)（模板 / 归档 / 边界情况） · [SKILL-reference.md](SKILL-reference.md)（Layout + 各文件模板 + log.md T-block 完整规范）。

📌 **使用场景**

- 切换 Agent / 换模型后，新会话从零开始。
- 长会话 token 爆了，历史被压缩丢失。
- 接手别人的 AI 项目，不知道前面做了什么。

✨ **效果**

- 自动把每轮开发对话记录到项目的 `ContextPocket/` 文件夹。
- 下次任何 Agent 读一遍，5 秒续上进度。
- 记录内容：需求、代码变更、决策、踩坑、偏好。

🚀 **方法**

1. **安装** — 把文件夹放到 Agent 的 skill 目录
2. **激活** — 在项目根输入 `/openpocket`
3. **正常工作** — Agent 自动记录，切换时再 `/openpocket` 续上

---

## 🚀 快速开始

### 1. 安装

三种运行模式，自动检测，无需额外配置。

| 模式 | 依赖要求 | 可靠性 | 适合场景 |
|------|---------|--------|----------|
| **MCP 模式** | 支持 MCP 的 Agent（Trae、Claude Desktop 等） | ⭐⭐⭐⭐⭐ 10/10 | 体验最好 |
| **CLI 模式** | Node.js 14+（零额外依赖） | ⭐⭐⭐⭐ 9.5/10 | 绝大多数开发者 |
| **纯 Skill 模式** | 无，只需要文件夹 | ⭐⭐⭐⭐ 8/10 | 兼容兜底 |

把这个文件夹放到你的 Agent 能加载 skill 的目录。先克隆再操作：

```bash
git clone https://github.com/Wink305/ContextPocket.git
cd ContextPocket
```

然后选一种方式安装：

```bash
# MiniMax Code / Claude Code / 类似工具的 skills 目录
cp -r . ~/.minimax/skills/context-pocket/

# 或者 Cursor / Continue 等 IDE 插件目录
cp -r . ~/.cursor/skills/context-pocket/
```

**MCP 模式配置**：在你的 MCP 配置文件里添加：

```json
{
  "mcpServers": {
    "context-pocket": {
      "command": "node",
      "args": ["path/to/context-pocket/mcp-server.js"]
    }
  }
}
```

完整支持的 Agent 列表见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

### 2. 激活

在任何项目根目录下，跟 Agent 说：

```
/openpocket
```

Agent 会自动：
- 在项目根创建 `ContextPocket/` 文件夹
- 从 CLI/MCP 模式运行 `bootstrap`：自动检测项目类型，扫描目录树，复制所有模板，预填 `code-map.md` 和 `state.md`
- 启动自动记录

### 3. 正常工作

接下来每次你和 Agent 对话，Agent 会**自动**追加一个 `T<n>` 块到 `log.md`，记录：
- 你说了什么（User）
- Agent 做了什么（Action，具体到文件路径）
- 改了哪些代码 / 做了哪些决定

你不需要做任何额外操作。

### 4. 切换/交接

换 Agent 或换模型时，在新会话里说：

```
/openpocket
```

或更直接：

```
读 ContextPocket/index.md
```

新 Agent 5 秒内进入状态。

---

## 📚 核心命令一览

| 命令 | 作用 |
|------|------|
| `/openpocket` | **激活**——开启自动记录，创建/恢复 `ContextPocket/` |
| `/statuspocket` | 一行状态摘要：当前 T 编号、需求数、❓项数 |
| `/putintopocket` | 把上一轮对话**原样**存入🔒绝对保留区 |
| `/recall T<n>` | 查看某一轮的完整记录 |
| `/diff T<a> T<b>` | 对比两轮之间变了什么 |
| `/searchpocket <词>` | 在所有上下文里搜索关键词 |
| `/questions` | 汇总所有待确认项 ❓ |
| `/check-conflicts` | 全面扫描所有上下文的潜在冲突（6 个维度，按严重程度分级） |
| `/handoff` | 生成单文件交接摘要 `handoff.md` |
| `/verify` | 交接前体检：文件齐不齐、引用有无死链 |
| `/sync` | Git 漏记兜底：检测 staged 变更中未被最近 T-block 记录的文件，可自动补录 `[auto]` T-block |
| `/sync --auto` | Agent 模式下直接补录（hook 调用时自动追加 `--auto`）|
| `/digest` | 蒸馏：扫描归档与旧轮次，提取仍有效的决策 / 坑点 / 偏好到 `digest-<date>.md` 报告 |
| `/import <jsonl>` | 导入历史会话（claude-code / codex / auto）到 log.md，标 `[imported]` |
| `/exportpocket` | 导出完整快照文件，可发给同事 |
| `/resetpocket` | 归档旧数据，重建空上下文 |
| `/help` | 查看帮助（默认简版，`/help all` 看完整菜单）|

> 💡 第一个项目你只需要记住 `/openpocket` 和 `/help`，其余的需要时再查。

想查某个命令的详细用法，输入 `/help <命令名>`，Agent 会内联解释。

---

## 💻 CLI 命令（需要 Node.js）

所有命令在 Node.js 14+ 环境下可通过 CLI 调用。通过 `--dir <项目根目录>` 指定目标项目。

| 命令 | 作用 |
|------|------|
| `context-pocket bootstrap --dir <root>` | 自动检测项目类型，扫描目录树，复制模板，预填代码地图和状态 |
| `context-pocket verify --dir <root>` | 全面体检：文件完整性、引用、索引一致性、🔒 区 |
| `context-pocket verify --drift --dir <root>` | 增加认知漂移检查（log.md vs working tree，借鉴 AOCI）。可加 `--drift-last-n <N>` 调节回看窗口 |
| `context-pocket status --dir <root>` | 一行摘要（T 范围、需求数、ADR 数、❓ 数、归档状态） |
| `context-pocket recall <T-id> --dir <root>` | 查看某一轮的完整详情 |
| `context-pocket diff <Ta> <Tb> --dir <root>` | 对比两轮：需求变化、ADR 新增、文件变化 |
| `context-pocket search <关键词> --dir <root>` | 全文搜索所有 T-block（含 gist、标签、笔记）。自动走 `assets/search-index.json` 索引，加 `--no-index` 回退全量扫描 |
| `context-pocket why <文件路径> --dir <root>` | 反向检索：哪些 T-block 提到过这个文件？（借鉴 ThoughtDAG） |
| `context-pocket check-conflicts --dir <root>` | 6 维冲突扫描，三级严重度（critical / warning / info） |
| `context-pocket log append --dir <root> --gist "..." --tags "..."` | 追加一輪 T-block 到 log.md |
| `context-pocket req add --dir <root> --text "..."` | 新增需求（自动分配下一个 R-id） |
| `context-pocket decision add --dir <root> --title "..."` | 新增架构决策 ADR |
| `context-pocket handoff --dir <root>` | 生成交接摘要 handoff.md |
| `context-pocket state update --dir <root> --summary "..."` | 更新当前状态 |
| `context-pocket preferences update --dir <root> --key "..." --value "..."` | 更新偏好 |
| `context-pocket code-map update --dir <root>` | 重扫项目目录，更新代码地图 |
| `context-pocket archive --dir <root> [--keep-last N] [--dry-run]` | 归档旧轮次，含归档前/后验证 + 失败回滚 |
| `context-pocket migrate --dir <root> [--to v<N>] [--dry-run] [--list]` | 格式迁移，含备份 + 回滚 |
| `context-pocket sync --dir <root> [--auto] [--dry-run] [--last-n <N>] [--quiet]` | Git 漏记兜底：检测 staged 变更中未被最近 T-block 记录的文件（hook 用 `--auto` 自动补录） |
| `context-pocket install-hook --dir <root>` | 安装 Git pre-commit 钩子（v2：自动补录漏记 → 健康检查，两步） |
| `context-pocket uninstall-hook --dir <root>` | 移除我们的钩子，保留其他 hook 内容 |
| `context-pocket index --dir <root> [--rebuild]` | 构建 / 刷新检索索引（`assets/search-index.json`）。Markdown 文件始终是真相源，索引是派生缓存 |
| `context-pocket distill --dir <root> [--dry-run]` | 蒸馏旧轮次：生成 `digest-<date>.md` 报告，列出值得回写到活文档的决策 / 坑点 / 偏好（借鉴 Basic Memory） |
| `context-pocket import --dir <root> --file <session.jsonl> [--source auto\|claude-code\|codex]` | 导入历史会话为 `[imported]` T-block，让中途启用的项目不丢历史 |
| `context-pocket hub [list\|pref\|remove] --dir <root>` | 用户级 hub：列出已注册项目 / 读写全局偏好 / 注销当前项目 |
| `context-pocket help` | 显示所有命令 |

> 💡 在 MCP 模式下，每个 CLI 命令都有对应的 MCP 工具（如 `context_pocket_bootstrap`）。

---

## 📋 适用场景

| 场景 | 痛点 | ContextPocket 怎么解决 |
|------|------|------------------------|
| 切换 Agent 平台 | 新 Agent 一无所知 | 读 `ContextPocket/` 即接续 |
| 切换模型版本 | 对话窗口消失 | 同上，数据是模型无关的 |
| 长会话 token 爆掉 | 历史被压缩丢失 | 关键内容已落到磁盘 |
| 多人协作同一项目 | 各 Agent 状态不一致 | 共享同一个 `ContextPocket/` |
| 接手他人/AI 的项目 | 不知道前面做了什么 | 读 `handoff.md` 5 分钟上手 |

---

## 📁 文件结构

```
project-root/
└── ContextPocket/
    ├── readme.md          # 项目名片 + 格式版本
    ├── index.md           # 轻量索引 (~20 行)
    ├── state.md           # 当前状态 + 下一步 + 运行命令 + 坑点
    ├── requirements.md    # 需求清单（R 编号，带 impl 引用）
    ├── preferences.md     # 开发偏好
    ├── decisions.md       # 架构决策 ADR
    ├── code-map.md        # 详细代码/模块地图
    ├── log.md             # 对话时间线（每轮一个 T 块）
    ├── log-archive.md     # 归档区（log.md > archive_at 行时创建）
    ├── absolute.md        # 🔒 永不压缩的绝对保留区
    ├── handoff.md         # 交接摘要（/handoff 时生成）
    ├── config.md          # 可选：自定义配置
    ├── pocket-snapshot-*.md  # 快照文件（最多保留 3 份）
    └── assets/
        ├── search-index.json   # 检索索引（自动生成、可删除重建）
        └── archive/            # 归档附件（archive 时把旧附件搬到这里）
```

### T 编号示例

```markdown
## T5 · 用户确认了数据库选型 · [需求变更] [架构决策]

### User
- PostgreSQL 还是 MongoDB? 我倾向 PG

### Action
- 修改 decisions.md — 新增 ADR-3，记录 PG 选型理由

### Decisions & Constraints
- PostgreSQL over MongoDB: 用户偏好关系型 + 团队熟悉度
  → 详见 ADR-3

### Uncertain
- ❓ 是否需要全文搜索？如果需要可能后期加 ES
```

---

## 🎯 设计原则

| 原则 | 含义 |
|------|------|
| **Completeness > Brevity** | 宁可多记不要漏记——漏掉一轮就是断了的交接链 |
| **永远 P0 记录 log.md** | 即使 token 不够，对话时间线也不能停 |
| **T 编号永久递增** | T1、T2、T3……绝不重置，便于追溯 |
| **🔒 强需求必须确认** | 用户说"必须"时，Agent 会主动问"要不要标🔒" |
| **冲突可见不静默覆盖** | 发现矛盾时同时保留新旧，标 superseded |
| **Agent-agnostic** | 所有文件是纯文本 Markdown，任何 Agent 都能读 |

---

## 🗂 项目类型模板

`/openpocket` 时会询问项目类型（或自动检测），不同类型预填不同字段：

| 类型 | 关注点 |
|------|--------|
| **frontend** | bundler、framework、状态管理、设计 tokens、构建配置 |
| **backend** | API 风格、鉴权方案、DB + 迁移目录、缓存、队列 |
| **fullstack** | 上面两者 + API 边界、共享类型位置、proxy 配置 |
| **data** | 数据源、pipeline 步骤、调度、notebook 环境、输出存储 |
| **mobile** | 平台、最小 SDK、build target、商店/CDN、deep links |

---

## 🔧 高级配置（可选）

创建 `ContextPocket/config.md` 自定义行为：

```markdown
# Config
- project_type: fullstack
- mode: full                  # full = 12 文件；lite = 只建核心 5 个
- archive_at: 800             # log.md 超过多少行触发归档
- recent_keep: 30             # 归档时保留最近多少个完整 T 块
- language: zh                # 记录语言（zh / en / follow user）
- quiet: true                 # true = 每轮最多一行确认
- tags_default: [需求变更, 代码逻辑, 架构决策, Bug, 偏好, 依赖, 测试, UI, API, 部署, 文档, 坑点, 冲突, correction]
```

**Lite 模式**：适合脚本/小项目，只建 5 个核心文件，其余用到才建。

---

## 🛡 隐私与安全

- `ContextPocket/` 是**纯文本 Markdown**，没有可执行代码
- 默认在 `.gitignore` 里**自动忽略**（项目本地数据，按需手动 push）
- 不上传、不联网——所有内容留在你的项目目录
- `absolute.md`（🔒区）是本机加密存储的选项的替代——靠**纪律**而非技术保证不被压缩

---

## 🌐 用户级 Hub（跨项目注册表）

每个项目都有自己的 `ContextPocket/`，但你可能想在多机之间共享一份「我都在哪些项目里用过 ContextPocket」+ 一份跨项目生效的全局偏好。

- **存储位置**：`~/.contextpocket/hub.json`（一份小 JSON，按项目路径索引）
- **内容**：注册过的项目（路径 → 名称 / 类型 / 最新 T / 最近活跃时间）+ 用户级全局偏好
- **设计原则**：hub 只是注册表，**项目数据永远在各项目的 `ContextPocket/` 里**；hub 故障（磁盘满、权限不够）不会影响正常记录
- **跨设备共享两条路径**：
  1. **环境变量**：`export CONTEXTPOCKET_HOME=/path/to/synced/folder`（指向网盘 / Dropbox / iCloud / git bare repo），所有机器共用同一份 `hub.json`
  2. **Git 进仓**：在 `bootstrap` 时加 `--gitignore: false`（或 MCP `gitignore: false`），把整份 `ContextPocket/` 进 git，连项目里的偏好一起同步
- **命令**：`context-pocket hub list`（看注册项目）· `context-pocket hub pref --key <k> --value <v>`（写全局偏好）· `context-pocket hub remove`（注销当前项目）

---

## 🆚 与同类工具的对比

| 工具 | 特点 | ContextPocket 优势 |
|------|------|-------------------|
| Agent 内置 memory | 跨模型失效 | ✅ 模型无关 |
| 手动写笔记 | 容易遗漏 | ✅ 自动捕获 |
| Git commit message | 只记代码 | ✅ 记意图+决策+踩坑 |
| Obsidian/Notion | 外部工具不同步 | ✅ 跟随项目走 |
| 自定义脚本 | 维护成本高 | ✅ 开箱即用 |

---

## ❓ FAQ

**Q: 必须用 MiniMax Code 吗？**

不需要。任何支持 skill 加载的 Agent 都行（Claude Code / Cursor / Continue 等）。所有文件是纯文本 Markdown，自己用编辑器读也能读懂。具体支持的列表见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

**Q: 项目已经进行中，中途启用会怎样？**

完美兼容。`/openpocket` 会扫描已有项目，自动建立代码地图，并从 T1 开始记录。之前的对话不会"补录"（Agent 也没记忆了），但代码状态会接续。

**Q: 中途启用，之前用 Claude Code / Codex 留下的对话能找回吗？**

可以。把 `~/.claude/projects/<项目>/<session>.jsonl`（或 `~/.codex/sessions/<id>.jsonl`）找出来，执行：

```
/import ~/.claude/projects/<项目>/<session>.jsonl
```

会从当前最新 T 继续编号，统一打 `[imported]` 标签写入 `log.md`。自动跳过工具调用噪音。源类型会自动嗅探，也可以用 `--source claude-code` 或 `--source codex` 强制指定。

**Q: 多人协作会冲突吗？**

设计为**串行交接**模式：一个 Agent 工作 → 保存 → 交接 → 下一个读。两个 Agent 不要同时写。

**Q: token 紧张时怎么办？**

按 P0→P6 优先级降级：`log.md` 永远写，`index.md` 最后。详情见 SKILL.md "Per-turn rules"。

**Q: 可以不用 / 命令吗？**

可以，但会少很多自动化。直接说"读 ContextPocket/" 也能让 Agent 加载。但 / 开头的命令会触发完整的工作流。

更多问题看 [docs/FAQ.md](docs/FAQ.md)。

---

## 🧩 贡献

欢迎 PR！请看 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 本地开发

```bash
git clone https://github.com/Wink305/ContextPocket.git
cd context-pocket
# 编辑 templates/ 或 SKILL.md
# 提交 PR 时附上你用过的项目类型 + 大小，便于回归测试
```

### 添加新模板

在 `templates/` 加一个 `.md` 文件，确保：
1. 占位符用 `<...>` 包裹，容易识别
2. 在 [SKILL-advanced.md](SKILL-advanced.md) 的 "Bootstrapping from templates" 表里加一行
3. 至少在一个项目类型里预填

---

## 📄 许可证

[MIT](LICENSE) © 2024 ContextPocket Contributors

---

## 🙏 致谢

- 受 [Conventional Comments](https://conventionalcomments.org/) 启发设计了 T-block 格式
- 灵感来源于多个 Agent 内置 memory 系统的痛点反思
- 感谢所有贡献者与早期使用者

---

⭐ 如果这个项目帮到了你，欢迎 Star 支持！