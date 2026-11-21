# 可用性优化第一轮（头脑风暴 + 可执行批次）

> 来源：`ContextPocket/handoff.md` 的结论——2.12 / 2.12-lite 已发版，工作树干净，
> 下一步是「可用性打磨 + 真实口袋 dogfooding」，外部评审 usability ~C+ 是最弱轴。
> 本文先把可优化点摊开（脑暴池），再收敛成本轮可落地的 6 组改动。
> 不新增命令、不改数据格式（仍 v2）、不升版本号、不发版。

## 1. 摘要

本轮只做「第一次用的人能不能自己走通」这一件事：

1. 空口袋 `status` 给出下一步，而不是只显示 `T0`。
2. `context-pocket help <command>` 可用，主帮助页补三条最常见流程。
3. 命令拼错时给出 `Did you mean ...`。
4. 输出被管道接走 / `NO_COLOR` 时自动关色，不再往日志和 `less` 里灌 ANSI。
5. `bootstrap` 的 Next steps 从「手改 readme.md」改成「先记第一轮」，并说明 readme.md 是唯一可手改的身份卡。
6. README 双语「切换/交接」步骤改为 `handoff --read`，与 2.10 起的真实入口一致。

两包（主包 / Lite）同步，行为保持逐字同源；命令面与 MCP 工具面不变。

## 2. 现状分析（代码走查结论）

| # | 摩擦点 | 证据 |
|---|---|---|
| F1 | 新口袋 `status` 只显示 `Latest: T0`，没有任何「下一步做什么」 | [formatter.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/formatter.js#L154-L201) |
| F2 | `help <command>` 不生效：`context-pocket help recall` 只打印主帮助页；Lite 虽然已有 `printCommandHelp()`，但 `help` 分支同样忽略位置参数 | [bin/context-pocket.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/bin/context-pocket.js#L301-L338)、[context-pocket-lite.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lite/bin/context-pocket-lite.js#L1188-L1196) |
| F3 | 拼错命令只提示「Run help」，不猜用户想敲什么 | [bin/context-pocket.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/bin/context-pocket.js#L2875-L2879)、[context-pocket-lite.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lite/bin/context-pocket-lite.js#L1268-L1274) |
| F4 | `colorize()` 永远输出 ANSI；全仓库没有 `NO_COLOR` / `isTTY` 判断 | [formatter.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/formatter.js#L11-L28)、Lite 同名文件 |
| F5 | `bootstrap` 的 Next steps 第 1 条是「Edit ContextPocket/readme.md」，与「不要手改 Markdown」的总体口径冲突，也没告诉用户第一轮记录怎么来 | [bin/context-pocket.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/bin/context-pocket.js#L494-L499)、[mcp-server.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/mcp-server.js#L1254-L1257)、Lite 两处同名文案 |
| F6 | README 双语第 4 步仍写「读 ContextPocket/index.md」，而 2.10 起读侧入口是 `handoff --read` | [README.md](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/README.md#L225-L233)、[README.zh-CN.md](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/README.zh-CN.md#L225-L233) |

## 3. 脑暴候选池

| 候选 | 价值 | 风险/成本 | 本轮 |
|---|---|---|---|
| 空口袋 status 引导 | 首次成功路径直接变短 | 低；改 formatter + 2 条测试 | 做 |
| `help <command>` + 常见流程 | 28 个命令有入口，不用整页翻 | 低；纯渲染，无命令面变化 | 做 |
| 未知命令 did-you-mean | 拼错一次就能自查 | 低；本地编辑距离，无依赖 | 做 |
| 非 TTY / `NO_COLOR` 关色 | 管道、CI、日志立刻干净 | 低；只影响人类渲染，`--json` 与 MCP 不动 | 做 |
| bootstrap Next steps 纠偏 | 消除「手改 Markdown」口径冲突，给出第一轮动作 | 低；4 个入口同步文案 | 做 |
| README 交接步骤对齐 `handoff --read` | 文档与真实入口一致 | 低；纯文档 | 做 |
| README 顶部加「60 秒路径」 | 首屏更短 | 中；与现有 Quick Start 重复，先等真实 dogfood 反馈 | 暂缓 |
| MCP 工具描述瘦身 | 每次 `tools/list` 省 token | 中；收益需实测，且描述是单源契约 | 暂缓 |
| `--json` 错误加 `code` 字段 | Agent 可按代码分支 | 中；属于机器契约变更，单独版本做 | 暂缓 |
| 新增 `doctor` / `setup` 命令 | 自检更直观 | 高；handoff 明确「不是加命令」 | 不做 |
| CLI 文案本地化（zh） | 中文用户更顺 | 高；`language` 目前只影响模板与标签 | 不做 |

## 4. 具体改动

### 4.1 空口袋 `status` 引导（F1）

**文件**
- [lib/formatter.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/formatter.js#L154-L201) `formatStatus`
- [lite/lib/formatter.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lite/lib/formatter.js#L154-L201)（保持与主包逐字同源）

**做法**
在 `nextSteps` 过滤之后、`Next Steps:` 输出之前插入：

```js
const empty = log.blocks.length === 0 && !index.hasArchive;
if (empty) {
  lines.push('');
  lines.push(`  ${colorize('🚀 Empty pocket — no turns recorded yet.', 'bold')}`);
  lines.push('     The first "log append" becomes T1; a configured agent records automatically.');
}
```

条件带 `!index.hasArchive`：只有归档、`log.md` 为空的旧口袋不能被说成「从未记录」。
文案不带 `context-pocket` 前缀，主包与 Lite 才能共用同一段文本。

**测试**
- `tests/cli.js` 新增：新 pocket `status` 含 `Empty pocket` 与 `log append`；追加一轮后该提示消失。
- `lite/tests/core.js` 新增同形用例（用 `makeLitePocket` 的空白口袋）。

### 4.2 `help <command>` 与主帮助页常见流程（F2）

**文件**
- [bin/context-pocket.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/bin/context-pocket.js#L301-L338) `cmdHelp` 与 [分发处](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/bin/context-pocket.js#L2570-L2574)
- [lib/help.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/help.js)（只读复用 `COMMAND_HELP` / `commandHelp`）
- [lite/bin/context-pocket-lite.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lite/bin/context-pocket-lite.js#L1188-L1196)（复用已有 `printCommandHelp`）

**做法（主包）**
- 签名改为 `cmdHelp(options, positionals)`；分发处传 `args.positional`。
- 有位置参数时：`key = positionals.join(' ')`，用 `commandHelp(key)` 取文本；
  - 命中：`--json` 输出 `{ok:true, command:key, text}`，否则 `console.log(text)`；
  - 未命中：退出 1；若 `key === 'log'`，额外提示 `help log append` / `help log amend`。
- 主帮助页在最后的「Run ... --help」之前加：

```
  Common flows:
    context-pocket status
    context-pocket log append --gist "..." --user "..." --action "..."
    context-pocket handoff --read
```

**做法（Lite）**
- `command === 'help'` 且 `positional.length > 0` 时调用 `printCommandHelp(positional.join(' '), options)`。
- 主帮助页同样加三条，二进制名换成 `context-pocket-lite`。

**测试**
- `tests/help.js` 新增：对每个 `COMMAND_HELP` 条目，`runHelp(['help', ...entry.argv])` 输出 === `entry.text`；`help log append` 同样成立。
- `lite/tests/core.js` 在现有 help 契约用例里加 `help status` 断言。

### 4.3 未知命令 did-you-mean（F3）

**文件**
- [bin/context-pocket.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/bin/context-pocket.js#L2875-L2879)
- [lite/bin/context-pocket-lite.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lite/bin/context-pocket-lite.js#L1268-L1274)

**做法**
- 两个入口各加一个本地 `editDistance()` + `suggestCommand(word)`（不引依赖）：
  - 候选 = `Object.keys(COMMAND_HELP)` 及每条的首个单词；
  - 仅对长度 ≥3 的输入给建议，距离阈值：长度 ≤4 用 1，否则用 2；
  - `log <未知子命令>` 单独在 `log append` / `log amend` 里比对。
- 人类输出加一行：`     Did you mean "recall"?`；`--json` 的 `error` 字符串同样带上建议。
- 没有足够接近的候选时保持原文案。

**测试**
- `tests/cli.js` 新增：`recll` / `statsu` 退出 1 且输出含 `Did you mean "recall"` / `"status"`；`--json` 的 `error` 含建议。
- `lite/tests/core.js` 把现有 `unknown-command` 用例扩一条 `statsu` 断言。

### 4.4 非 TTY / `NO_COLOR` 自动关色（F4）

**文件**
- [lib/formatter.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/formatter.js#L11-L28)
- [lite/lib/formatter.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lite/lib/formatter.js#L11-L28)

**做法**
模块加载时计算一次：

```js
function detectColor() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== '0';
  return !!(process.stdout && process.stdout.isTTY) || !!(process.stderr && process.stderr.isTTY);
}
const COLOR_ENABLED = detectColor();
```

`colorize()` 在 `!COLOR_ENABLED` 时直接返回原文。`--json` 走 `emitJson` 不经 `colorize`；
MCP 不引用 formatter，因此两者行为不变。

**测试**
- `tests/cli.js` 新增：管道运行 `status` 不含 `\x1b[`；带 `FORCE_COLOR=1` 时含 `\x1b[`。
- `lite/tests/core.js` 加一条 Lite 版本的同形断言（可用 `spawnSync` 传 env）。

### 4.5 `bootstrap` Next steps 纠偏（F5）

**文件（4 个入口，文案同义、命令名按包替换）**
- [bin/context-pocket.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/bin/context-pocket.js#L494-L499)
- [mcp-server.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/mcp-server.js#L1254-L1257)
- [lite/bin/context-pocket-lite.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lite/bin/context-pocket-lite.js#L344-L348)
- [lite/mcp-server-lite.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lite/mcp-server-lite.js#L572-L575)

**新文案（主包 CLI）**

```
  Next steps:
    1. Record the first turn — a configured agent does this automatically, or:
       context-pocket log append --gist "one line" --user "what you asked" --action "what changed"
    2. Fill in ContextPocket/readme.md — the project identity card (safe to edit by hand)
    3. Run "context-pocket status"; "install-hook" adds pre-commit checks
```

- Main MCP：把命令换成 `context_pocket_log_append` / `context_pocket_status` / `context_pocket_install_hook`。
- Lite CLI / MCP：第 3 步改为 `verify`（Lite 无 `install-hook`）。
- 「safe to edit by hand」明确只针对 readme.md，消除与 `log.md` 不可手改规则的口径冲突。

**测试**
- 不新增断言文件；在 `tests/cli.js` 的 bootstrap 用例里补一条「输出含 `log append` 且不再以 `Edit ... readme.md` 开头」的断言即可。

### 4.6 README 交接步骤对齐（F6）

**文件**
- [README.md](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/README.md#L225-L233)
- [README.zh-CN.md](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/README.zh-CN.md#L225-L233)

**做法**
第 4 步改为 `context-pocket handoff --read` 为首选，并说明：
- 只打印 `0 · Start here`；落后于最新 T 时拒绝输出，`--force` 才放行；
- 没有 CLI 时，新 Agent 读 `ContextPocket/handoff.md`，再读 `index.md`。

中英各写一段，保持现有版式，不重写整节。

### 4.7 CHANGELOG

- 主 [CHANGELOG.md](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/CHANGELOG.md#L10) 在 `## [Unreleased]` 下加 4–6 条本轮改动。
- Lite [CHANGELOG.md](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lite/CHANGELOG.md) 顶部加 `## [Unreleased]`，列对应条目。
- 只记录，不升版本号。

## 5. 假设与决策

1. CLI 人类文案继续使用英文（与现有输出一致），不引入本地化。
2. 两包 `formatter.js` 的 `formatStatus` / `colorize` 必须保持逐字同源；Lite 只在命令名前缀上不同。
3. 不新增文件；避免 `lite/tests/metrics.js` 的文件数基线（30 / 68）变化。文本增量远小于 1% 体积容差；若超差，按既有做法追平 `metrics.js` 基线。
4. 命令面、MCP 工具面、数据格式均不变，属于纯可用性补丁。
5. 改动留在工作树；commit / push / tag / Release 均需另行授权，本轮不做。
6. 工作区当前未被信任，测试门禁命令由用户执行或显式授权后执行；本轮实现阶段只做文件编辑与静态核对。

## 6. 验证

实现完成后按以下顺序核对：

1. **静态**：改动文件 `git diff` 自查；确认 4 个 bootstrap 文案入口、2 个 formatter、2 个 help 分发都已同步。
2. **门禁（需用户执行）**：
   - `npm run lint`
   - `npm test`（主包全量，内含 Lite 子套件）
   - `npm run smoke`
   - `npm run smoke-live`
   - `node scripts/verify-format.js`
3. **手动场景**（临时目录）：
   - `context-pocket bootstrap` → 首条 Next step 是记录第一轮；
   - `context-pocket status` → 显示 Empty pocket 与 `log append`；
   - `context-pocket help recall` / `help log append` → 直接出该命令帮助；
   - `context-pocket recll` → `Did you mean "recall"?`；
   - `context-pocket status | cat` → 无 ANSI；`FORCE_COLOR=1 context-pocket status | cat` → 有 ANSI；
   - 双语 README 第 4 步可照着 `handoff --read` 走通。

## 7. 明确不做

- 不新增 `doctor` / `setup` / `resume` 等命令。
- 不改 T-block 格式、图缓存、搜索索引。
- 不做 README 大改或首屏重写。
- 不发布、不升版本、不写 npm。
