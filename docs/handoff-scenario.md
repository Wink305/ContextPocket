# 跨对话 / 跨 Agent 记忆：一次可复现的接手剧本

> **这不是 benchmark。** 本文不定义指标、不设对照组、不产分数，也不评测任何模型。
> 它只做一件事：把「一段上下文在换会话、换 Agent 之后还在」用一组可复制的命令从头跑一遍，
> 让任何第三方都能照着重现。
>
> 产品定位：**辅助上下文记忆 + 跨对话、跨 Agent 记忆**。交接是这份记忆的一种用法，不是另一款产品。

## 准备

```bash
mkdir cp-scenario && cd cp-scenario
context-pocket bootstrap
context-pocket status --json
```

预期：`ok: true`、核心文件齐全、`latestT: 0`。任何命令的完整参数用 `context-pocket-quan <命令> --help` 查，下文只写本剧用得到的部分。

---

## 第一幕 · A 用 Claude Code 写下上下文

目的：让记忆先真实存在，而不是靠描述。

```bash
context-pocket log append --gist "选纯 Markdown 做本地存储" \
  --author "claude-code" \
  --user "把项目记忆存在本地，不要上云" \
  --action "新增 src/store.ts" \
  --decisions "不引入数据库与向量库" \
  --tags "arch,storage"

context-pocket req add "支持跨 Agent 接手" --tags "handoff" --uncertain

context-pocket decision add --title "本地优先" --context "隐私要求" \
  --options "SQLite / 纯 Markdown" --decision "SQLite" --consequences "多一个依赖" \
  --supersedes "none"

context-pocket log append --gist "实现 T-block 追加" \
  --author "claude-code" --user "继续" --action "修改 src/writer.ts" \
  --decisions "T 编号只增不减" --tags "core"
```

预期：每条 `log append` 回一行 `✅ ... T<n>`，编号从 T1 连续递增；`--author` 落进块的 `### Author` 小节（多 Agent 共用一份口袋时唯一的署名来源）；带 `--uncertain` 的需求在 `requirements.md` 里带 ❓ 标记。

**为什么证明记忆存在**：内容全部落在项目本地纯文本里，不依赖 A 的会话或模型内存。关掉 Claude Code，文件还在。

---

## 第二幕 · B 用 Codex 接手 + 并发撞号

目的：证明「换 Agent」和「两个人同时写」都不会把历史弄丢。

**先读，不要先动手**：

```bash
context-pocket handoff
context-pocket handoff --read
```

预期：`--read` 输出 `## 0 · Start here` 全文，含 STOP CONDITION、项目身份、State、🔒 红线、❓ 待确认、Next，末尾另列 ❓ 清单。`--read` 不写任何文件；若之后又追加了一轮导致 handoff 过期，它会**拒绝**输出 0 段并提示 `STALE (generated at T<x>, log at T<y>)`、退出码非 0 —— 这是「不拿旧记忆冒充现状」的闸门。强行看加 `--force`，看全文加 `--full`，机器读加 `--json`。

**并发写**：A、B 各自在本地算 `latest + 1`，都写下 `## T4`（真实项目里由合并产生）。

```bash
context-pocket verify            # 报 duplicate T-id 的 ERROR
context-pocket repair --dry-run  # 先看会怎么改
context-pocket repair            # 撞号块及其后所有块整体后移，正文逐字不动
context-pocket verify            # 恢复干净
```

预期：`repair` 输出被后移的编号、以及仍引用旧号的位置清单（默认**不改引用**，因为 `T4` 曾指两个块，只有读者知道每处指向谁），并在口袋里追加一条修复记录；每个被改文件都先备份，修复后 `verify` 不比修复前差才算成功，否则整体回滚。

**为什么证明跨 Agent 记忆没丢**：冲突被摆到台面上而不是静默覆盖；两个 Agent 写的内容**都**留在历史里，移动的只是编号。

---

## 第三幕 · 用历史切片判断「当时算不算数」

目的：证明记忆不是一坨最新摘要，而是可回溯的时间线。

```bash
context-pocket decision add --title "改用纯 Markdown + 关联图" \
  --context "零依赖优先" --options "SQLite / Markdown" --decision "Markdown" \
  --consequences "去掉数据库" --supersedes "ADR-1"

context-pocket search "存储" --expand 2 --as-of T1
context-pocket search "存储" --expand 2
context-pocket diff T1 T3
context-pocket why src/store.ts
```

预期：`--as-of T1` 只给 T1 时有效的图事实（后面的 `supersedes` 尚未发生）；不带 `--as-of` 时旧 ADR 已被剪枝；`diff` 列出两轮之间的需求 / ADR / 文件变化；`why` 反查出改过 `src/store.ts` 的轮次。四条都只读。

**为什么证明跨 Agent 记忆没丢**：B 不需要问 A「当时怎么定的」，按 T 编号就能把那一刻的事实切出来；`handoff.md` 的 Key Decisions 也只列当前有效 ADR。

---

## 第四幕 · C 用 Cursor 复查 + 导入外部历史 + 再交接

```bash
context-pocket import --file ~/.codex/sessions/<session>.jsonl --source codex
context-pocket handoff
context-pocket handoff --read --full
```

预期：`import` 把外部会话作为 `[imported]` T-block 续在当前最新 T 之后；`handoff` 重新生成三段式摘要，`--read --full` 打出整份（含节点链、当前有效 ADR、限额 Code Map、指针）。节点链每步带 `[T<n>]` 来源，可 `context-pocket recall T<n>` 溯源。

**为什么证明记忆没丢**：C 既读到 A、B 的原文，也读到导入的第三方历史；交接视图是**派生**的，真值始终在那几份 Markdown 里 —— 换任何能读文件的 Agent 都成立。

---

## 一条命令从头跑到尾

上面四幕就是可复制的顺序命令列表，不需要额外脚本。仓库里另有一条端到端回归把关键链路（记录 → 生成 → `--read` → 新轮次触发 STALE 拦截 → 强制读取）自动化：

```bash
node tests/run.js pocket
```

对应 `tests/pocket.js` 的 `cross-agent handoff scenario` 用例；两包视图一致性由 `lite/tests/compat.js` 的 `handoff.md is byte-identical across both packages` 锁住。格式本身另有一份独立校验：`node scripts/verify-format.js`（见 `docs/format-spec.md`）。

> 复现边界：这里验证的是「链路跑得通、历史不丢、冲突可见」，
> 不含任何准确率、耗时或 token 指标 —— 那属于另一套独立设计，不在本文范围。
