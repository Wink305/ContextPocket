# ContextPocket

> **给 AI 编码 Agent 的项目级持久记忆。** ContextPocket 把一次开发里“明天仍然有用”的部分，以纯 Markdown 写回你的仓库；下一次会话、换一个模型，或换一个 Agent，都能从同一条时间线继续。

**[English](README.md)** · [文档](docs/) · [更新日志](CHANGELOG.md) · [安全](SECURITY.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version: 3.2 family](https://img.shields.io/badge/version-3.2%20family-blueviolet.svg)](CHANGELOG.md)
[![Pocket format: v2](https://img.shields.io/badge/format-v2-blue.svg)](docs/format-spec.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

---

## 它解决什么问题

AI 编码会话越来越长，记忆却仍然很短：

- **换 Agent / 换模型**：新会话不知道上一个会话做过什么。
- **会话顶到上下文上限**：早先的决定、约束和坑点被压缩掉。
- **接手别人的 AI 项目**：很难判断哪些已经做过、为什么这样做。
- **问“这个文件为什么是这样”**：答案埋在别人的聊天记录里。

内置记忆通常按厂商隔离、不可读、存在服务端。ContextPocket 反过来：**项目自己拥有记忆，纯文本，和代码放在一起。**

## ContextPocket 做什么

- 把每一轮开发记成一个 `T<n>` 块：你要求了什么、Agent 做了什么、改了哪些文件、决定了什么、还有什么没确认。
- 把“时间线”和“仍然成立的事实”分开：当前状态、需求、ADR、偏好、🔒 红线。
- 为下一次会话或另一个 Agent 生成 **handoff**。
- 连接轮次 ↔ 文件 ↔ 决定，可以问“这一轮前后发生了什么”“哪些决定碰过这个文件”。
- 不依赖工具也能读：全部是 Markdown，编号稳定，历史只追加不覆盖。

```text
一次 Agent 轮次
   │
   ├── ContextPocket/log.md             T12 · 发生了什么（只追加）
   ├── ContextPocket/state.md           现在什么是真的
   ├── ContextPocket/requirements.md    还有什么没做完
   ├── ContextPocket/decisions.md       为什么是这样
   ├── ContextPocket/absolute.md        🔒 绝不能丢的红线
   └── ContextPocket/handoff.md         下一次会话从这里开始
```

没有服务端，没有数据库，没有厂商锁定。

---

## 选择版本

3.2 是四个独立包组成的家族。它们共用同一个 `ContextPocket/` 目录和 **v2 数据格式**，换版本不需要迁移口袋。

| 版本 | 包名 / 命令 | 定位 | 适合 | 体量 |
|---|---|---|---|---|
| **xi 溪** | `context-pocket-xi` | 轻量：一个项目、一个 Agent，开箱即记 | 小项目、脚本、快速试用 | 5 个核心文件 · 11 命令 / 工具 |
| **quan 泉** | `context-pocket-quan` | 通用：跨会话、跨 Agent 的默认个人记忆 | 独立开发者、长期项目 | 10 个核心文件 · 29 命令 / 工具 |
| **yuan 渊** | `context-pocket-yuan` | 攻坚：多口袋工作区与长周期审计 | 复杂仓库、长期攻坚 | 稳定 · 10 命令 / 工具 · workspace / repo map / 检索索引 |
| **hai 海** | — | 协作：共享记忆、评审与审计 | 团队、多写入者 | 规划中 |

**默认从 `quan` 开始，除非：**

- 只想要一个零缓存的小日志 → **xi**；
- 同时维护多个仓库、需要生命周期工具 → **yuan**；
- 需要团队评审和共享写入 → 等 **hai**。

**旧名已在 3.2 移除**：`context-pocket` / `context-pocket-mcp` 不再存在，请改用 `context-pocket-quan` / `context-pocket-quan-mcp`；轻量版旧名 `context-pocket-lite` / `context-pocket-lite-mcp` 同样移除，请改用 `context-pocket-xi` / `context-pocket-xi-mcp`。

### 下载

`main` 是 3.2 家族线。每个归档都带自己的 `package.json`、README 和 LICENSE；**不经过 npm registry**，从 GitHub Release 归档或 git clone 安装。

| 版本 | 展示版本 | Release / 归档 |
|---|---|---|
| **quan 泉** | `3.2-quan` | [ContextPocket-3.2-Quan](https://github.com/Wink305/ContextPocket/releases/tag/ContextPocket-3.2-Quan) · `ContextPocket-3.2-Quan.zip` |
| **xi 溪** | `3.2-xi` | [ContextPocket-3.2-Xi](https://github.com/Wink305/ContextPocket/releases/tag/ContextPocket-3.2-Xi) · `ContextPocket-3.2-Xi.zip` |
| **yuan 渊** | `3.2-yuan` | [ContextPocket-3.2-Yuan](https://github.com/Wink305/ContextPocket/releases/tag/ContextPocket-3.2-Yuan) · `ContextPocket-3.2-Yuan.zip` |
| **hai 海** | 规划中 | — |

上一个稳定版：[`2.13`](https://github.com/Wink305/ContextPocket/releases/tag/2.13) · [`2.13-lite`](https://github.com/Wink305/ContextPocket/releases/tag/2.13-lite)。

---

## 快速开始

### 1. 获取代码

```bash
git clone https://github.com/Wink305/ContextPocket.git
cd ContextPocket
```

或下载所选版本的归档并解压。

### 2. 安装一个入口

**CLI（开发者推荐）** —— 在克隆/解压目录内：

```bash
npm link
context-pocket-quan help
```

`npm link` 会注册正式命令和旧名别名。这个包**一次都没有发布到 npm registry**；`npm install -g context-pocket-quan` 现在还不可用，请使用 clone 或 Release 归档。

**不安装** —— 直接调用脚本：

```bash
node /path/to/ContextPocket/bin/context-pocket.js status --dir /path/to/your/project
```

**只放 Skill 目录**：

```bash
cp -r . ~/.cursor/skills/context-pocket-quan/
```

**MCP** —— 指向 stdio server：

```json
{
  "mcpServers": {
    "context-pocket-quan": {
      "command": "node",
      "args": ["/absolute/path/to/ContextPocket/mcp-server.js"]
    }
  }
}
```

如果已经 `npm link`，也可以写 `"command": "context-pocket-quan-mcp"`、`"args": []`。

### 3. 激活

项目里没有 `ContextPocket/` 时，配置好的 Agent 会在第一次实质开发时询问并初始化；也可以直接跑：

```bash
context-pocket-quan bootstrap --dir /path/to/your/project
```

`bootstrap` 会自动识别项目类型、扫描目录、复制模板，并预填 `code-map.md` / `state.md`。它是幂等的，重复执行只会重新注册，不会碰历史。

### 4. 正常工作

Agent 会自动记录每一轮，不需要斜杠命令，也不需要额外步骤。

换 Agent 或模型时，让新会话读：

```text
ContextPocket/index.md
```

或重新生成 handoff：

```bash
context-pocket-quan handoff --dir .
```

---

## 一个典型的工作日

| 你想…… | Agent 运行 | 你得到 |
|---|---|---|
| 在新项目开始 | `bootstrap` | 口袋就绪，自动记录开启 |
| 看现在到哪了 | `status` | T 范围、未关需求、ADR、❓、归档状态 |
| 换一个 Agent 继续 | `handoff` | 含红线、待确认、下一步的 `handoff.md` |
| 找之前的一轮 | `search <关键词>` | 匹配的 T 块 / ADR / 需求 / 偏好 |
| 查谁改过这个文件 | `why <路径>` | 先列“改过”的轮次，再列“只提到”的轮次 |
| 看一轮 **及其上下文** | `recall T<n> --with-context` | 这一轮、引用它的地方、同文件后续变化 |
| 检查口袋健康 | `verify` | 15 项检查；凭据形状阻断提交，PII 只警告 |
| 补一个缺失小节 | `log amend <Tn>` | 只补缺失内容，绝不覆盖已有内容 |
| 标记绝不能丢的规则 | `absolute add` | 一条永不被压缩的 🔒 |
| 合并另一台机器的口袋 | `merge --from <路径> --dry-run` | 先看可复核的合并报告，再决定是否写 |

完整的意图 → 命令映射见 [SKILL.md](SKILL.md)。

---

## 四个版本

### xi 溪 —— 先记录，保持小

- 5 个核心 Markdown 文件，11 条命令 / MCP 工具。
- 搜索始终扫描 Markdown；图和索引只在读取时派生，没有缓存要维护。
- 适合希望口袋极小、只需要可靠时间线的小项目。

更多：[lite/README.md](lite/README.md)。

### quan 泉 —— 默认的个人记忆

- 10 个核心文件，29 条命令 / MCP 工具。
- 有来源的多跳图：`search <kw> --expand 2`、`why <file> --expand 2`、`--as-of <T>` 历史切片。
- 记忆沉淀：`distill --knowledge` 从显式 Pitfalls / Uncertain / Decisions 与 tag / file 锚点生成 K 候选；`--apply` 写成 `knowledge.md`（默认 draft），`--activate` 才升 active。`search --type K` 可检索，`graph` 里是 `k:K1` 与 `derived-from` 边。
- 搜索索引、图缓存（`graph/4`）、handoff 预算、merge 复核、hub 注册、隔离模式、Git 安全网。
- `--edition-mode solo|agent` 只改变交互方式，不改变数据。

更多：[SKILL.md](SKILL.md) · [SKILL-advanced.md](SKILL-advanced.md) · [SKILL-reference.md](SKILL-reference.md)。

### yuan 渊 —— 长周期工作区（稳定）

- 用 `contextpocket.workspace.json` 注册多个口袋，跨口袋 id 必须限定（`api:T12`）。
- `workspace status` 直接给出索引、repo map 与工作区图的健康摘要，不用先跑 `audit`。
- `map` 扫描 JS/JSX/TS/TSX/Python 生成 repo map；未变化文件按 size + mtime 复用旧符号，`map verify` 只比 metadata。
- `context build` / `explain` 按预算组装红线、事实与相关材料；每条事实标注来源（`api:T5`、`api:R3`、`[api] src/login.js`）。
- `context build --expand 1|2` 沿显式 `pocket:Tn` 引用增加跨口袋图邻居（`Path: api:T5 → x-ref → web:T9`）；`--as-of <日期|pocket:Tn>` 按 WHEN 日期切片。派生图缓存在 `.contextpocket/workspace-graph.json`，只重建变化的口袋。
- `--graph-edges duplicate|shared-file|tag|near|all` 显式开启派生跨口袋边（相同 ADR/需求/偏好、同路径、同标签或时间接近的轮次）；全部 weak、有界、默认关闭。
- 记忆沉淀：`workspace knowledge build|apply|list|view|verify` 把跨口袋证据写成 `knowledge/K-*.md`；默认只出提案、写入默认 draft，duplicate / conflict 留人工。`context build` 的 Related 会带 active K（`--no-knowledge` 关闭），`workspace status` / `audit` 报告 K 健康。
- 生命周期：`recap`、`audit`、`decay`（`--apply` 归档报告出的前缀）、`forget`、`consolidate`（口袋内 + 跨口袋）、`merge`、`capture`（本地文件或本机 `gh pr view` / `gh run view`）。
- `--edition-mode focus|audit|migrate` 提供预算预设，显式参数优先。
- API 已冻结：10 命令 / 10 MCP 工具，`edition.json` 转 stable。仍未发布 npm，用 Release 归档或 git clone。

更多：[lang/README.md](lang/README.md) · [lang/SKILL.md](lang/SKILL.md)。

### hai 海 —— 团队共享记忆（规划中）

仓库目前只有私有骨架，还没有可安装命令。目标是在同一套 v2 格式上做共享写入、评审与审计。

---

## 核心工作流

### Handoff

`handoff` 生成三层恢复卡：

- **0 · Start here** —— 红线、待确认、下一步，永不裁剪。
- **1 · On demand** —— 决定、坑点、未关需求。
- **2 · Pointers** —— 去哪里读更多。

`handoff --max-tokens <N>` 只裁可选部分，并在文件里写明裁掉了什么。

### 校验、漂移与修复

```bash
context-pocket-quan verify            # 文件、编号、引用、索引、🔒、凭据、附件
context-pocket-quan verify --drift    # 追加认知漂移 / 代码比最后一次记录更新
context-pocket-quan repair --dry-run  # 先看编号冲突，再决定是否重排
```

`verify` 不猜。凭据形状是 error，会阻断提交钩子；个人数据只是 warning。`repair` 重排冲突的 T 编号，列出仍写着旧编号的正文，只有 `--apply-refs` 才会真正替换引用。

### 搜索与关系

```bash
context-pocket-quan search token --expand 2 --as-of T40
context-pocket-quan search token --rank bm25
context-pocket-quan why src/auth.js --expand 2
context-pocket-quan recall T12 --with-context
context-pocket-quan graph --type file
```

- `search` / `recall` 共用时间窗：`--since` / `--until` / `--from` / `--to`。
- `search --rank bm25` 是可选排序：命中集合不变，只把顺序换成 BM25 打分；默认字段权重顺序逐字不变。
- `why` 区分 **改过** 和 **只提到**，`--limit` 会先丢弱证据。
- 图上下文有来源、可重建；Markdown 始终是唯一真相。

### 合并两台机器 / 两个 Agent

```bash
context-pocket-quan merge --from /path/to/other/ContextPocket --dry-run
context-pocket-quan merge --from /path/to/other/ContextPocket
```

单向合并，源口袋只读。轮次重新编号；ADR、需求、🔒 红线与非冲突偏好会合入。`state.md`、`code-map.md` 与冲突写入 `merge-<date>.md`；code-map 建议会列出目标中真实存在但描述不同的文件。`merge report --apply <id>` 重放安全项：需求状态、偏好、源 state 独有行，以及**目标缺失**的 code-map 描述（文件已在目标树里、但没有真实描述）；已有不同描述仍留人工复核。

### 长周期治理（yuan）

```bash
context-pocket-yuan workspace init
context-pocket-yuan workspace add api ../api
context-pocket-yuan context build --query "token refresh"
context-pocket-yuan context build --query "token refresh" --expand 1 --as-of 2026-11-02
context-pocket-yuan context build --query "token refresh" --expand 2 --graph-edges all
context-pocket-yuan recap --since T40
context-pocket-yuan audit
context-pocket-yuan decay --max-age-days 180
context-pocket-yuan forget --before T20 --apply
```

`forget` 只归档最旧的一段；必须 `--apply` 才写。归档后的轮次仍可 search / recall。`decay` 只读，并打印它建议的 `forget` 命令。

### 隔离运行

三个开关，最后一个最强：

| 开关 | 用法 |
|---|---|
| 环境变量 | `CONTEXTPOCKET_ISOLATED=1 context-pocket-quan ...` |
| 标记文件 | 在项目根创建 `.contextpocket-isolate` |
| 物理隔离 | 把 `ContextPocket/` 移出项目 |

隔离期间，所有 CLI 命令和 MCP 工具在打开任何口袋文件前就被拒绝；`status` 只报告隔离状态。

---

## 口袋里有什么

```text
project-root/
└── ContextPocket/
    ├── readme.md          项目身份 + 格式版本
    ├── index.md           轻量索引
    ├── state.md           当前状态、下一步、坑点
    ├── requirements.md    需求 R 编号与实现引用
    ├── preferences.md     开发偏好
    ├── decisions.md       ADR
    ├── code-map.md        模块 / 文件地图
    ├── log.md             只追加的 T 块时间线
    ├── log-archive.md     已归档轮次
    ├── absolute.md        🔒 永不被压缩的红线
    ├── handoff.md         生成的恢复卡
    ├── config.md          可选配置
    └── assets/            搜索索引、图缓存、归档附件
```

最小的 T 块：

```markdown
## T12 · Refresh token rotation · [api] [security]
--- WHEN: 2026-11-22 10:30 ---

### User
- 每次使用都轮换 refresh token。

### Action
- src/auth/refresh.js —— 签发新 token 并吊销旧 token。
- tests/auth/refresh.test.js —— 覆盖复用检测。

### Decisions & Constraints
- 安全评审要求必须检测复用。
```

`### User` 和 `### Action` 是必需小节；其他小节有内容才写。`--- WHEN: … ---` 记录这一轮发生的时间；只给日期就保留 `(day)`，用户原话原样保留。

完整格式：[docs/format-spec.md](docs/format-spec.md)。

---

## 隐私与安全

- 口袋是 **纯文本 Markdown**：没有可执行代码，不联网，不上传。
- `ContextPocket/` 在 bootstrap 时默认加入 `.gitignore`（可用 `--gitignore false` 关闭）。
- `verify` 扫描凭据与 PII 形状；厂商密钥会阻断提交钩子。
- 🔒 `absolute.md` 靠纪律而不是加密来防止压缩；它挡不住刻意读取文件系统的人。
- 隔离模式让实验和 CI 不会污染真实历史。

详见 [SECURITY.md](SECURITY.md)。

---

## 兼容与迁移

| 从 | 到 | 做法 |
|---|---|---|
| `2.13` | `3.2-quan` | 数据格式不变，换命令名即可。 |
| `2.13-lite` | `3.2-xi` | 轻量模型不变，换命令名即可。 |
| `context-pocket` | `context-pocket-quan` | 旧名别名已在 3.2 移除，改用 quan 命令名。 |
| `context-pocket-lite` | `context-pocket-xi` | 旧名别名已在 3.2 移除，改用 xi 命令名。 |
| v1 口袋 | v2 口袋 | 运行 `migrate --to latest`；迁移前 `verify` 会给 warning。 |

四个版本都读写 v2 格式；换版本不需要复制、转换或锁定口袋。

更多：[docs/MIGRATION.md](docs/MIGRATION.md) · [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) · [docs/FAQ.md](docs/FAQ.md)。

---

## 命令索引

`quan` 共 29 条 CLI 命令；每条都有对应的 MCP 工具，且都支持 `--json`。下面是完整索引，每条都可以加 `--help` 查看参数和示例。

```bash
context-pocket-quan bootstrap --help
context-pocket-quan install-hook --help
context-pocket-quan uninstall-hook --help
context-pocket-quan verify --help
context-pocket-quan sync --help
context-pocket-quan status --help
context-pocket-quan recall --help
context-pocket-quan diff --help
context-pocket-quan search --help
context-pocket-quan why --help
context-pocket-quan graph --help
context-pocket-quan check-conflicts --help
context-pocket-quan log append --help
context-pocket-quan log amend --help
context-pocket-quan absolute add --help
context-pocket-quan req add --help
context-pocket-quan decision add --help
context-pocket-quan state update --help
context-pocket-quan preferences update --help
context-pocket-quan code-map update --help
context-pocket-quan handoff --help
context-pocket-quan index --help
context-pocket-quan distill --help
context-pocket-quan import --help
context-pocket-quan merge --help
context-pocket-quan hub --help
context-pocket-quan archive --help
context-pocket-quan repair --help
context-pocket-quan migrate --help
```

`xi` 以 `context-pocket-xi` 提供其中 11 条（不含索引 / 图缓存）；`yuan` 以 `context-pocket-yuan` 提供自己的 10 条。

---

## 参与贡献

欢迎 PR。发布清单与本地开发见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```bash
npm run lint       # 语法检查所有 JS
npm test           # 全量测试
npm run smoke      # MCP stdio 冒烟
npm run smoke-live # 真实 CLI 端到端冒烟
npm run bench      # 10 口袋 × 1000 轮：search / context / audit 延迟
```

四个版本共用 `shared/` 下逐字同源的核心；`node scripts/sync-core.js` 是漂移门禁。

## License

[MIT](LICENSE) © 2024 ContextPocket Contributors

## 致谢

- T 块格式受 [Conventional Comments](https://conventionalcomments.org/) 启发
- 源于各类 Agent 内置记忆系统的真实痛点
- 感谢每一位贡献者和早期用户

---

⭐ 如果 ContextPocket 帮你把项目记忆留住了，欢迎点一个 Star。
