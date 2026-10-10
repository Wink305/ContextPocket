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

1. **安装** — 在[快速开始](#1-安装)里三选一：装成全局命令、免安装直接 `node` 调用、或复制到 Agent 的 skill 目录
2. **激活** — 自动完成，不用输入任何命令（见下方[⚡ 快速响应](#-快速响应)）
3. **正常工作** — Agent 自动记录；换 Agent / 换模型后也会自动接上

---

## 🚀 快速开始

### 1. 安装

三种运行模式，自动检测，无需额外配置。

| 模式 | 依赖要求 | 可靠性 | 适合场景 |
|------|---------|--------|----------|
| **MCP 模式** | 支持 MCP 的 Agent（Trae、Claude Desktop 等） | ⭐⭐⭐⭐⭐ 10/10 | 体验最好 |
| **CLI 模式** | Node.js 14+（零额外依赖） | ⭐⭐⭐⭐ 9.5/10 | 绝大多数开发者 |
| **纯 Skill 模式** | 无，只需要文件夹 | ⭐⭐⭐⭐ 8/10 | 兼容兜底 |

先把代码拉到本地 —— 方式 (b) 也可以直接指向任意装有这些文件的目录：

```bash
git clone https://github.com/Wink305/ContextPocket.git
cd ContextPocket
```

然后从下面三种安装方式里**选一种**。

#### (a) 装成真正的命令 —— 让 `context-pocket` 进入 PATH

只有这个方式能让本 README 里到处出现的 `context-pocket <cmd>` 真的可用。

**从本地仓库安装 —— 现在就能用**（仓库里已经有 `package.json`，`npm link` 会把 CLI 全局注册到你当前这个目录）：

```bash
# macOS / Linux / Windows（PowerShell 或 cmd）— 在克隆下来的仓库目录里执行
npm link
```

或者改用「从本地目录全局安装」：

```bash
npm install -g .
```

**从 registry 安装 —— 发布之后**。`npm install -g context-pocket` 是最终的形态，但这个包**目前还没有发布到 npm registry**；在发布之前请使用上面的本地安装方式（可用 `npm view context-pocket` 自查是否已发布）。

`package.json` 里声明了两个 bin，link 之后两个命令都会装上：

| 命令 | 入口文件 | 是什么 |
|------|---------|--------|
| `context-pocket` | `bin/context-pocket.js` | CLI 本体 |
| `context-pocket-mcp` | `mcp-server.js` | MCP stdio 服务端 |

验证一下：

```bash
context-pocket help
```

Windows 说明：`npm link` 会自动生成 `context-pocket.cmd` / `context-pocket-mcp.cmd` 垫片，所以在 PowerShell 和 cmd 里命令写法完全一致。卸载用 `npm uninstall -g context-pocket`。

#### (b) 完全不安装 —— 用 `node` 直接跑脚本

什么都不注册到全局；只要机器上有 Node.js 14+、文件在磁盘上就能用。把下面的路径换成你实际放的位置：

```bash
# POSIX（bash / zsh）
node /path/to/ContextPocket/bin/context-pocket.js status --dir /path/to/your/project
```

```powershell
# Windows / PowerShell
node C:\Users\<你>\ContextPocket\bin\context-pocket.js status --dir C:\path\to\your\project
```

本 README 和 [docs/FAQ.md](docs/FAQ.md) 里每一条 `context-pocket <cmd>`，都可以把前缀换成 `node <路径>/bin/context-pocket.js` 来执行。

#### (c) 复制到 skill 目录 —— 连 Node.js 都不需要

如果你的 Agent 从某个目录加载 skill（MiniMax Code、Claude Code、Cursor、Continue 等），把这个文件夹复制进去就够了：Agent 会读 SKILL 文档并替你调用同样的子命令，上面的「纯 Skill 模式」即使在没装 Node.js 的机器上也能工作。

POSIX（bash / zsh）：

```bash
# MiniMax Code / Claude Code / 类似工具的 skills 目录
cp -r . ~/.minimax/skills/context-pocket/

# Cursor / Continue 等 IDE 插件目录
cp -r . ~/.cursor/skills/context-pocket/
```

Windows / PowerShell：

```powershell
# MiniMax Code / Claude Code / 类似工具的 skills 目录
Copy-Item -Recurse -Force . "$env:USERPROFILE\.minimax\skills\context-pocket"

# Cursor / Continue 等 IDE 插件目录
Copy-Item -Recurse -Force . "$env:USERPROFILE\.cursor\skills\context-pocket"
```

Windows / cmd.exe：

```bat
xcopy . "%USERPROFILE%\.cursor\skills\context-pocket\" /E /I /Y
```

> ⚠️ 只做方式 (c) **不会**把 `context-pocket` 加进 PATH。想自己敲 CLI 的话，请再配合方式 (a) 或 (b)。

**MCP 模式配置**：在你的 MCP 配置文件里添加（三种安装方式都适用 —— `args` 指向 `mcp-server.js` 的绝对路径）：

```json
{
  "mcpServers": {
    "context-pocket": {
      "command": "node",
      "args": ["/absolute/path/to/ContextPocket/mcp-server.js"]
    }
  }
}
```

Windows 下请用正斜杠，或者把 JSON 字符串里的反斜杠转义掉：

```json
{
  "mcpServers": {
    "context-pocket": {
      "command": "node",
      "args": ["C:\\Users\\<你>\\ContextPocket\\mcp-server.js"]
    }
  }
}
```

完成方式 (a) 之后，也可以直接用装好的 bin：`"command": "context-pocket-mcp"`，`"args": []`。

完整支持的 Agent 列表见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

### 2. 激活

激活是**自动的**，不需要输入任何命令。项目里还没有 `ContextPocket/` 时，Agent 会在第一轮实质对话时主动提出初始化；已经有了就读 `index.md` + `state.md` 继续记录。

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

换 Agent 或换模型时，让新会话读一下记录：

```
读 ContextPocket/index.md
```

新 Agent 会自动接上记录——5 秒内进入状态。

---

## ⚡ 快速响应

**没有斜杠命令要背。** 直接用大白话说你要什么，Agent 判断意图、去调对应的 `context-pocket` 子命令（或 MCP 工具），然后一行回复。完整的「意图 → 动作」映射见 [SKILL.md](SKILL.md)。

| 你说（随便怎么说都行） | Agent 执行 | Agent 回复 |
|------|------|------|
| 第一次进这个项目 · "开始记一下" · "给我建个记录" · "接手这个项目" | `bootstrap`（幂等） | `✅ ContextPocket ready, auto-recording on` |
| "现在什么情况" · "进度到哪了" · "什么状态" | `status` | 一行摘要 |
| "这条记成红线" · "绝不能改 X" · "这个必须保留" | `absolute add` | 写入 absolute.md，永不压缩 |
| "交接一下" · "我要换模型了" · "把这个交给别人" | `handoff` | 生成 handoff.md |
| "查一下有没有漏" · "提交前检查一下" · "健康吗" | `verify` | 通过；有问题则每条给出可执行的修复命令 |
| "补一下 T7" · "刚才漏了用户那句话" | `log amend` | T7 补齐 |
| "那轮是昨天下午做的" · "从 9 点做到 11 点" | `log append --when` / `log amend <Tn> --when` | 这一轮的时间行，回话时念成 `⏱ <日期> 09:00 → <日期> 11:30`；只知道是哪天的就写成 `(day)`，用户怎么说的就怎么存 |
| "这文件谁改的" · "为什么长这样" | `why <path>` | 命中的轮次，按证据强弱标注：`[changed]`（这轮的 Action 小节里有它）/ `[mentioned only]`（只在 Uncertain、Attachments、Conflicts 里被谈到过，不等于改过）；改过的排在前面 |
| "上次那个 bug 怎么修的" · "搜一下 X" | `search <关键词>` | 命中的 T-block |
| "T7 当时说了什么" · "回看一下那轮" | `recall T<n>` | 完整 T-block |
| "T5 到 T9 变了啥" | `diff Ta Tb` | 差异 |
| "有什么待确认的" · "有没有我不确定的" | 直接读 `❓` 行（无工具） | 列出清单，然后问"逐条确认吗？" |
| "有没有前后矛盾" | `check-conflicts` | 按严重度分级的结果 |
| "git 有没有漏记的" | `sync`（加 `--auto` 才写入） | 补记了几轮 |
| "这玩意儿怎么用" | 内联回答——**绝不**回"见 README.md" | 内联答案 |

> 💡 用大白话比记命令名更顺；如果你想要零歧义，直接把子命令名说出来也行（`context-pocket verify`）。

---

## 💻 CLI 命令（需要 Node.js）

所有命令在 Node.js 14+ 环境下可通过 CLI 调用。用过安装方式 **(a)** 就直接写 `context-pocket …`；否则请加 `node <路径>/ContextPocket/bin/context-pocket.js` 前缀 —— 即安装方式 **(b)**。通过 `--dir <项目根目录>` 指定目标项目。

| 命令 | 作用 |
|------|------|
| `context-pocket bootstrap --dir <root>` | 自动检测项目类型，扫描目录树，复制模板，预填代码地图和状态；默认会在 `~/.contextpocket/hub.json` 里注册本项目，加 `--no-hub`（MCP `noHub: true`）就只建 pocket、不碰 hub |
| `context-pocket verify --dir <root>` | 15 项体检：文件完整性、编号连续、引用、索引一致性、🔒 区、`log.md` 行数 vs `archive_at`、pocket 里的密钥 / PII 形状（带厂商前缀的密钥报 ERROR，也就是会拦住 pre-commit；身份证号、卡号、手机号这类只报 WARNING，永不拦提交）、**附件是否真的在磁盘上**（`### Attachments` 声明了却找不到 = ERROR，磁盘上没有那条记录；模板占位、URL、绝对路径、已经标了 `[missing: …]` 的那一条都不算），外加一条“格式版本落后”的 WARNING（`lib/validator.js:74`，只提醒、不拦提交） |
| `context-pocket verify --drift --dir <root>` | 增加两项扫目录的漂移检查：认知漂移（最近 T-block 提到的路径 vs 工作树）+ 代码比记录新（上次记录之后又被改的文件，不依赖 git）。可加 `--drift-last-n <N>` 调节回看窗口 |
| `context-pocket status --dir <root>` | 一行摘要（T 范围、需求数、ADR 数、❓ 数、归档状态） |
| `context-pocket recall <T-id> --dir <root>` | 查看某一轮的完整详情 |
| `context-pocket diff <Ta> <Tb> --dir <root>` | 对比两轮：需求变化、ADR 新增、文件变化 |
| `context-pocket search <关键词> --dir <root> [--limit N] [--offset N] [--no-index]` | 在全量历史上做关键词搜索：T-block（gist、标签、每一个小节，含已归档轮次）、ADR、需求与偏好。自动走 `assets/search-index.json` 索引，加 `--no-index` 直接扫 Markdown —— 两条路径的匹配与排序完全相同，所以 `--limit`/`--offset` 翻的是同一份结果（`--limit 0` 为全部）。匹配规则：拉丁词按分隔符拆开，中文按**相邻两字组合**建索引，且查询词必须**全部**命中。所以长中文串里的短语能搜到（`时间分页` 能找到「给搜索加时间分页」），换个顺序就不行（`分页时间` 搜不到）；单独一个汉字只能命中那个字独立出现的地方 |
| `context-pocket why <文件路径> --dir <root>` | 反向检索：哪些 T-block 提到过这个文件，并按证据强弱分开 —— `[changed]`（该轮 Action 小节里有这个路径）与 `[mentioned only]`（只在 Uncertain / Attachments / Conflicts / Pitfalls 里出现）。改过它的那几轮排前面，所以 `--limit` 截掉的是弱证据，不会把真实改动挤掉（借鉴 ThoughtDAG） |
| `context-pocket check-conflicts --dir <root>` | 6 维冲突扫描，三级严重度（critical / warning / info） |
| `context-pocket log append --dir <root> --gist "..." --tags "..." [--when "..."] [--author "..."]` | 追加一轮 T-block 到 log.md（务必带 `--user "<用户原话>"`，否则 verify 报错并被 hook 拦下提交）。`--when` 可省略：默认盖成“你记录它的那一刻”，只有当这一轮实际发生在别的时间才用它覆盖。`--author "<谁在记>"` 把写入者写进这一块的 `### Author` 小节——多个 Agent 共用一份 pocket 时该带上；不传就没有这一小节，工具绝不会替你猜一个名字。每一次追加还会拿这一轮去比对 pocket 里已经写着的东西，把**新撞上的**那些以 `[auto]` 前缀写进这一块的 `### Conflicts` 小节（`--no-conflict-check` 可以跳过，跳过也会明说一句）。比对只做通报，永远不拦这次记录 |
| `context-pocket log amend <Tn> --dir <root> --user "..." [--when "..."] [--author "..."]` | 补齐**已写入** T-block 中缺失的小节；绝不覆盖已有内容——`--when` 可以补一条缺失的时间行、或把只知道天的精确到时刻，但会拒绝改写一个已经记下过的时间点；`--author` 只补缺失的 `### Author` 小节，不覆盖块上已有的署名 |
| `context-pocket absolute add --dir <root> --text "..." [--gist "..."]` | 追加一条🔒绝对保留到 absolute.md（原样保存，永不压缩） |
| `context-pocket req add --dir <root> --text "..."` | 新增需求（自动分配下一个 R-id） |
| `context-pocket decision add --dir <root> --title "..."` | 新增架构决策 ADR |
| `context-pocket handoff --dir <root>` | 生成交接摘要 handoff.md |
| `context-pocket state update --dir <root> --summary "..."` | 更新当前状态 |
| `context-pocket preferences update --dir <root> --key "..." --value "..."` | 更新偏好 |
| `context-pocket code-map update --dir <root>` | 重扫项目目录，更新代码地图 |
| `context-pocket archive --dir <root> [--keep-last N] [--dry-run]` | 归档旧轮次（必须有人触发，永不自动发生），含归档前/后验证 + 失败回滚。`--keep-last` 缺省取 `config.md` 的 `recent_keep`（30） |
| `context-pocket migrate --dir <root> [--to v<N>\|latest] [--dry-run] [--list]` | 按登记表里的版本链做格式迁移，一条命令能走完 `v1 → v2 → v3`（`--to` 接受 `v2` / `2` / `latest`）。先备份、每跳之前体检，任何一跳失败或跳完体检不过就整体恢复备份。登记表里现有两跳：`v1 → v1`（noop 自检）和 **`v1 → v2`**——后者是真的改内容：`log.md` / `log-archive.md` 里每个 T-block 都按它上方那条 `--- SESSION: <日期> ---` 补一行 `--- WHEN: <date> (day) ---`，上方没有日期的孤块原样不动，已经有时间行的块直接跳过，所以重跑第二遍什么都不改。停在 v1 的 pocket 只会在 `verify` 里多一条 `format-upgrade` WARNING，提醒你升级——是 warning，hook 不会因此拦提交 |
| `context-pocket repair --dir <root> [--dry-run] [--apply-refs] [--author "..."]` | 把两个 Agent 写出同一个轮次号之后的 T 编号收回来（写入锁只在单机内有效，见 FAQ「多人协作会冲突吗？」）。撞号的那一块**以及它之后的每一块**整体后移一格，让编号继续随文件顺序递增——`log.md` 是只追加的。正文一个字都不改：所有还写着旧编号的行会被**列出来**（那个号在历史上同时指过两块，只有读的人知道每一处指的是哪一块），加了 `--apply-refs` 才真的替换，而且是同时替换，所以 `T3→T4` 与 `T4→T5` 这种级联不会把同一处引用挪两次。而且替换只认**独立的 `T<n>`**——`GPT4` / `RTX4090` / `UTF8` 是含了这个形状的词，不是编号；附件文件名（`T04-diagram.png`、`assets/T04-diagram.png`）连 `--apply-refs` 也不会改，因为改名是两半（先 `mv` 文件、再改文本），只做第二半就是断链，还会丢掉零填充，所以它们单独列在 `fileNames` 里并附上现成的 `mv` 命令。派生值自己跟上（state/requirements/decisions/preferences/code-map/handoff 头行的 `· T<n>`、以及整份重算的 `index.md`）；`log-archive.md` 只报不改（它自己声明只读）。改号这件事本身会写成一个 `[auto]` T-block，而改完之后体检更差就整份回滚（含 `index.md`） |
| `context-pocket sync --dir <root> [--auto] [--dry-run] [--last-n <N>] [--quiet]` | Git 漏记兜底：检测 staged 变更中未被最近 T-block 记录的文件（hook 用 `--auto` 自动补录）。覆盖只认强证据——路径要出现在某轮的 **Action** 小节里；只在 Uncertain / Attachments / Conflicts 里被点名的文件仍算漏记，但报告会写明它在哪一轮哪个小节被谈到过，好让你用 `log amend` 补那一轮，而不是又生成一个 `[auto]` 块 |
| `context-pocket install-hook --dir <root>` | 安装 Git pre-commit 钩子（v3：无 pocket 就跳过 → 自动补录漏记 → 健康检查） |
| `context-pocket uninstall-hook --dir <root>` | 移除我们的钩子，保留其他 hook 内容 |
| `context-pocket index --dir <root> [--rebuild]` | 构建 / 刷新检索索引（`assets/search-index.json`）。Markdown 文件始终是真相源，索引是派生缓存 |
| `context-pocket distill --dir <root> [--dry-run]` | 蒸馏旧轮次：生成 `digest-<date>.md` 报告，列出值得回写到活文档的决策 / 坑点 / 偏好（借鉴 Basic Memory） |
| `context-pocket import --dir <root> --file <session.jsonl> [--source auto\|claude-code\|codex]` | 导入历史会话为 `[imported]` T-block，让中途启用的项目不丢历史 |
| `context-pocket hub [list\|pref\|remove] --dir <root>` | 用户级 hub：列出已注册项目 / 读写全局偏好 / 注销当前项目 |
| `context-pocket help [--json]` | 显示全部命令。加 `--json` 时同一张表以一行 JSON 返回，Agent 不必解析带颜色的文本就能发现命令全集 |

> 💡 在 MCP 模式下，每个 CLI 命令都有对应的 MCP 工具（如 `context_pocket_bootstrap`）。
>
> 💡 所有命令都接受 `--json`：stdout 变成恰好一行可解析的 JSON（`{"ok":true,…}`，出错则是 `{"ok":false,"error":"…"}` 且退出码非 0）——agent 与 hook 那一侧就该读这个。
>
> 💡 T 号在两边只有一个名字：MCP `tId` ⇄ CLI `--t-id`（`diff` 是 `tA`/`tB` ⇄ `--t-a`/`--t-b`，MCP `filePath` ⇄ CLI `--file-path`）。规范写法是位置参数（`context-pocket recall 3`），`--t`、`--id`、`--file`、`-f` 作为同义别名继续可用——这样"猜错拼写"不会再被回一句"你没传"。
>
> 💡 只写 flag 不给值 = **没传**。`context-pocket state update --summary --json` 现在什么都不写、退出码 1，而不是往 `state.md` 里存一个字面量 `true` —— 这条判据原本只管 `--gist`，现在由两个入口共用（`lib/fields.js` 的 `textOption`）。
>
> 💡 `--no-index` 在缓存的两端都出现，两端都动不到数据：`search` 上是"这一次不信缓存"，`log append` / `log amend` 上是"这次写完不刷缓存"。Markdown 永远是真相源，所以下一轮 search 会发现源文件变了、自己重建，命中的轮次一条不少（连着 append 几十轮再归档一轮也不会漏）。但它省多少要看规模：30 轮的项目里每轮约 15 ms，800 轮时才是 0.18 秒；而一次空转的 CLI 调用本身要 112 ms（Node 启动占大头）——所以真正划算的是常驻的 MCP server 和长循环，一次一条的 CLI 用法不必为它改习惯。
>
> 💡 `context-pocket --version`（`-v`、`context-pocket version` 三种写法同解）直接把 `package.json` 里的版本号打出来——不需要项目里有 `ContextPocket/`，也不写任何东西。MCP 客户端在 `initialize` 回包的 `serverInfo.version` 里看到的是同一个数字，两个入口都经 `lib/version.js` 读它，所以版本号只有 `package.json` 一处需要改。

---

## 📋 适用场景

| 场景 | 痛点 | ContextPocket 怎么解决 |
|------|------|------------------------|
| 切换 Agent 平台 | 新 Agent 一无所知 | 读 `ContextPocket/` 即接续 |
| 切换模型版本 | 对话窗口消失 | 同上，数据是模型无关的 |
| 长会话 token 爆掉 | 历史被压缩丢失 | 关键内容已落到磁盘 |
| 多人协作同一项目 | 各 Agent 状态不一致 | 共享同一个 `ContextPocket/`：同一台机器上的并发写入由写入锁排队，跨机器合并后撞到的 T 号用 `repair` 收回来，`log append --author` 写下每一轮是谁记的 |
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
    ├── handoff.md         # 交接摘要（交接时生成）
    ├── config.md          # 可选：自定义配置
    ├── pocket-snapshot-*.md  # 快照文件（最多保留 3 份）
    └── assets/
        ├── search-index.json   # 检索索引（自动生成、可删除重建）
        └── archive/            # 归档附件（archive 时把旧附件搬到这里）
```

### T 编号格式

T-block 的标准形状。所有 `<…>` 都是占位符——工具不会替你编内容。标了「无则省略」的小节
只在真有内容时才写；`verify` 会把缺 `### User` / `### Action` 的块报成 ERROR，其余小节算可选项。

```markdown
## T<n> · <一句话概述> · [tag1] [tag2]
--- WHEN: <YYYY-MM-DD HH:mm> ---

### Author
- <这一轮是谁记的>                    （无署名则省略）

### User
- <用户请求，含全部条件>

### Action
- <操作类型> <文件路径> — <改了什么>

### Decisions & Constraints
- <为什么这么做>                     （非平凡的决策同时登记到 decisions.md）

### Uncertain
- ❓ <推断、尚未确认>
```

完整字段说明（含本例省略掉的小节）见 [SKILL-reference.md](SKILL-reference.md)。

标题下面那行 `--- WHEN: … ---`（格式 v2）就是这一轮实际发生的时间。`log append` 默认写你记录它的那一刻；用户说了别的时间才用 `--when`——一段区间写 `--when "09:00 → 11:30"`，只知道哪天写 `--when "<YYYY-MM-DD>"`（存成 `(day)`，绝不编一个零点出来），要原样留下用户说的就写 `--when "<用户原话>"`，用户怎么说的就怎么存。`recall` 会把它念出来；还停在 v1 的文件夹里根本没有这一行，跑一次 `migrate --to latest` 才有——在 v1 里传 `--when`，块照记（`log.md` 永远是 P0），但工具会说明时间为什么没落盘（`--json` 里是 `whenSkipped`），不会把它悄悄吞掉。

`### Author` 只在有人被告知这一轮是谁记的时候才出现（`log append --author`）。它和其它小节一样是**小节**，不是结构性行，所以不涉及格式版本：v1 的 pocket 里同样可以合法地有一条 `### Author`，而没有它也不算缺——工具不会替你补一个没被给过的名字。

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

首次激活时会询问项目类型（或自动检测），不同类型预填不同字段：

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
- mode: full                  # full = 10 个核心文件（另有 2 个按需创建）；lite = 只建核心 5 个
- archive_at: 800             # log.md 达到多少行时 status/verify 提示"该归档了"（归档本身永远不会自动发生）
- recent_keep: 30             # 归档时保留最近多少个完整 T 块（单次可用 --keep-last 覆盖）
- language: zh                # 记录语言（zh / en / follow user）
- quiet: true                 # true = 每轮最多一行确认
- secret_scan: true           # verify 是否扫描 pocket 里的密钥 / PII 形状（sk-ant-…、AKIA…、私钥块、JWT、
                              # 身份证号、卡号、`password: xxxx`）。带厂商前缀的那批报 ERROR——也就是会拦住
                              # pre-commit；PII 与手写赋值只报 WARNING，绝不拦提交。确实要在记录里保留这些串
                              # （例如在写密钥轮换手册）才改成 false
- gitignore: true             # 初始化时采用的取值（`bootstrap --gitignore false` 会记成 false 并不把
                              # ContextPocket/ 写进 .gitignore）。事后改这一行不会重写 .gitignore——请直接改 .gitignore
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
- **不想进注册表**：`bootstrap --no-hub`（MCP `noHub: true`）只建 pocket，`CONTEXTPOCKET_HOME` 下一个字节都不写。适合一次性目录、脚本试跑、CI 里跑一遍——hub 里就只留你真正在用的项目。pocket 本身完整可用，只是 `hub list` 看不到它。之后想补登记，跑同一条命令去掉 `--no-hub` 即可（bootstrap 幂等，不会动已有记录）

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

完美兼容。首次激活（`bootstrap`）会扫描已有项目，自动建立代码地图，并从 T1 开始记录。之前的对话不会"补录"（Agent 也没记忆了），但代码状态会接续。

**Q: 中途启用，之前用 Claude Code / Codex 留下的对话能找回吗？**

可以。把 `~/.claude/projects/<项目>/<session>.jsonl`（或 `~/.codex/sessions/<id>.jsonl`）找出来，让 Agent 导入——它会执行：

```bash
context-pocket import --file ~/.claude/projects/<项目>/<session>.jsonl --dir <root>
```

会从当前最新 T 继续编号，统一打 `[imported]` 标签写入 `log.md`。自动跳过工具调用噪音。源类型会自动嗅探，也可以用 `--source claude-code` 或 `--source codex` 强制指定。`--limit N` 控制最多导几轮（默认 100），`--truncate N` 控制每条字段截断长度（默认 400）。

**Q: 多人协作会冲突吗？**

分两种情况，答案不一样：

- **同一台机器上多个 Agent**：同时写是安全的。每次写入都先取锁，再去读最新 T 号并追加（`lib/io.js` 的 `withPocketLock`），所以同机的 Agent 会排队、各拿到自己的号，不会重复。锁文件在 `os.tmpdir()` 里、按 pocket 路径命名，它的作用范围就是一台机器。
- **多台机器共享同一份 `ContextPocket/`（进 git）**：仍然按**串行交接**来用——一个 Agent 做完 → 提交 → 下一个先 `git pull`。两个克隆同时写时，各自从自己那份算 `latestT + 1`，就会都写出比如 `T9`；合并之后 `log.md` 里就有两个 `## T9`。`verify` 会把这件事报成 error 并直接给出命令，`context-pocket repair --dry-run` → `context-pocket repair` 把撞号那块（及其之后的块）整体后移回合法序列、列出还写着旧编号的正文、并把这次改号写成一个 `[auto]` T-block。那些引用**不会**被自动改写，除非你加 `--apply-refs`：一句写着 `T9` 的话可能指两块中的任何一块，只有读的人知道是哪一块。另有两类东西**永远不改**：`GPT4`、`RTX4090`、`UTF8` 这种只是含了 `T<数字>` 形状的词，以及 `assets/T04-diagram.png` 这种附件文件名——改名要先 `mv` 文件再改文本，工具不替你动文件，所以它只把准确的 `mv` 命令列出来，你执行完再跑一次 `verify` 确认链接没断。

两种情况下都建议给轮次署名：`log append --author agent-A` 会把写入者写进那块的 `### Author` 小节。另外每次追加已经拿这一轮去比对 pocket 里已有的记录，所以第二个 Agent 和第一个 Agent 的意见分歧会带着 `[auto]` 前缀落在它那轮的 `### Conflicts` 里——分歧进了历史，而不是悄悄盖掉对方。

**Q: token 紧张时怎么办？**

按 P0→P6 优先级降级：`log.md` 永远写，`index.md` 最后。详情见 SKILL.md "Per-turn rules"。

更多问题看 [docs/FAQ.md](docs/FAQ.md)。

---

## 🧩 贡献

欢迎 PR！请看 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 本地开发

```bash
git clone https://github.com/Wink305/ContextPocket.git
cd context-pocket
npm link                 # 把当前这份代码变成 `context-pocket` 命令
# 编辑 templates/ 或 SKILL.md
# 提交 PR 时附上你用过的项目类型 + 大小，便于回归测试
```

npm 脚本（全部零依赖）：

| 脚本 | 实际执行 | 说明 |
|------|---------|------|
| `npm run lint` | 对仓库里每个 `.js` 文件跑 `node --check` | 会遍历 `bin/`、`lib/`、`scripts/` 和根目录；不需要测试框架，也不依赖 glob 库 |
| `npm run smoke` | `node mcp-smoke.js` | 通过 stdio 驱动 MCP 服务端。不传参数时，它会在系统临时目录里现造一个一次性 pocket、把 `CONTEXTPOCKET_HOME` 隔离到同一目录，退出时删除，因此可以独立运行。要指定目标项目就写 `npm run smoke -- /path/to/project`（此时请另设 `CONTEXTPOCKET_HOME=<hub 目录>`，否则 hub 写入会落到你真实的 `~/.contextpocket`） |
| `npm test` | `node tests/run.js` | 需要 `tests/` 下的测试运行器存在 |

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