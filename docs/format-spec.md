# T-block 开放格式规范 · format v2

> **状态：描述性规范（第一版）。** 它把 ContextPocket 2.x 已在使用的口袋格式写清楚，
> 不引入新字段、不改数据格式、不新增依赖。目的是让第三方能独立读写同一份口袋，
> 而不是宣布一个需要别人来申请的标准。
>
> 参考实现：`lib/parser.js`（主包）与 `lite/lib/parser.js`（Lite，两包逐字同源）。
> 一致性校验：`node scripts/verify-format.js [--dir <pocketDir>]`。

## 0. 三个「版本」互不相干

| 名字 | 在哪 | 例 | 含义 |
|---|---|---|---|
| 包版本 | `package.json` 的 `version` | `2.12` | CLI / MCP 软件版本 |
| 数据格式版本 | 口袋 `readme.md` 的 `format:` | `v2` | 本规范描述的格式 |
| SKILL 排版版本 | `SKILL.md` frontmatter 的 `format:` | `v1` | 那份文档的排版约定 |

三者独立演进；抬包版本不等于抬数据格式版本。

## 1. 载体

口袋是项目本地 `ContextPocket/` 下的**纯 UTF-8 Markdown**，无数据库、无二进制索引。
`log.md` 是事件日志；`log-archive.md` 是同格式的只读归档；
`requirements.md` / `decisions.md` / `preferences.md` / `absolute.md` / `state.md` / `code-map.md`
是派生视图与人工约束；`handoff.md` 是可随时重生成的接手卡片，**不是真值**。
删掉任何派生视图都可从 Markdown 源重建。

## 2. T 编号（硬规则）

1. 从 `T1` 开始，正整数，**永久递增**；不重用、不留空洞补号。
2. 块**只追加**：新块只能追加到 `log.md` 末尾，已有块正文逐字不改。
3. 冲突**可见、不静默覆盖**：两个 Agent 各自算出同一个 `T<n>` 并合并后，文件里会有两个同名块；
   `verify` 报 ERROR，`repair` 把撞号块及其后所有块整体后移一位，**只改标题编号**，
   并把仍引用旧号的位置列出来交给读者判断（默认不自动改写引用，因为旧号曾指两个块）。
   修复前逐文件备份，修复后 `verify` 不比修复前差才提交，否则整体回滚。
4. 更正走 `## T<n>-fix · <gist> · [correction]`：编号指向被更正的轮次，
   **不参与发号与连续性检查**；旧轮次保留为历史，更正本身也是历史。

## 3. 词法

```
SESSION 行   ^--- SESSION: (\d{4}-\d{2}-\d{2}) ---$
T-block 标题 ^##\s+T(\d+)\s*·\s*<one-line gist>(?:\s*·\s*<tags>)?\s*$
WHEN 行      ^--- WHEN: <payload> ---$        （紧跟标题下一行，format v2 可选）
fix 标题     ^##\s+T(\d+)-fix\s*·\s*<gist>(?:\s*·\s*<tags>)?\s*$
小节标题     ^### (Author|User|Action|Commits|Decisions & Constraints|Pitfalls|Preferences|Conflicts|Attachments|Uncertain)$
```

- 分隔符是中间点 `·`（U+00B7），不是冒号或竖线。
- 标签用方括号、空格分隔（`[arch] [storage]`）；`<...>` 形态的占位值不得成为真实节点。
- WHEN 的 payload 有五种形状：`<日期> <时刻>`、`<日期> <时刻> → <日期> <时刻>`、
  `<日期> → <日期>`、`<日期> (day)`、`stated: <用户原话>`。最后一种逐字保留，绝不换算成日期；
  `log amend <T> --when` 只肯把粗粒度换成细粒度，不覆盖已记下的时刻。
- `### Author` 只在 `log append --author` 给了名字时出现；工具不得凭空发明署名。
- `### Uncertain` 里的 ❓ 条目是「待用户确认」，接手方必须先确认再动手。

## 4. Session 重建

SESSION 行只在**日期变化时**插入，同一天只写一条。每个 T-block / fix 块的 session
等于它前面**最近一条** SESSION 行的日期。`log-archive.md` 的 SESSION 行随它下面那批块
一起搬走，并保证 `log.md` 幸存块前面仍有一条同日分隔线。找不到前置 SESSION 行时
session 为 `null`，**不得猜测**。精确 T-id 快路径正是靠这条规则从最近前置 SESSION 行
重建 session，才不用逐文件全量解析。

## 5. 关联图与来源

图在读取时从 Markdown 现场派生（`lib/links.js`；Lite 零缓存，完整包可选 `assets/graph.jsonl`
缓存，缓存过期 / 损坏自动重建，Markdown 始终是唯一真值）。

- 节点：turn / file / decision / requirement / tag / correction。
- 边：`modifies` / `mentions` / `references` / `decided-in` / `supersedes` / `last-changed` /
  `tagged` / `opened-in` / `completed-in` / `implements`。
- **每条边必须带** `source`（来源文件名）、`tId`（来源 T 编号）、`evidence`（强 / 弱）。
  弱证据 `mentions` 只是「提到过」，不算改动，也不能作为交接依据。
- `supersedes` 把旧记录的 `validTo` 关闭在替代发生的 T 上；旧节点**保留为历史**，
  但 `activeAt(record, asOf)` 会排除它，因此 `--as-of <T>` 能切出「当时有效的事实」。
- 边过滤幽灵节点（指向不存在的 T 号），输出按 `(type, from, to)` 稳定排序，保证可复现。

## 6. 派生视图的约束

`handoff.md` 头部必须保留 `# Handoff · T<n> · <date>`（stale 检查靠它）与
`> generated-at: T<n>`。读侧在 `generated-at` 落后于 `log.md` 最新 T 时，
必须拒绝交出「可据此开工」的段落，除非调用方显式 `--force`。
每节有硬上限，截断必须如实写出省略了多少、去哪里看，不得静默丢弃。

## 7. 兼容性

新实现能读旧数据（v1 没有 WHEN 行，旧解析器忽略标题与第一个 `###` 之间的行）；
旧实现可能不识别新字段，但多余的行会被当作散行丢掉，**不会破坏已有块**。
引入破坏性字段必须抬 `format` 版本并提供 `migrate` 路径。

## 8. 一致性校验

`scripts/verify-format.js` 只用 Node 内置模块，对任意口袋逐条校验第 2、3、4 节：

```bash
node scripts/verify-format.js                    # 跑仓库自带金样本
node scripts/verify-format.js --dir <pocketDir> # 校验任意口袋
```

任一规则失败即打印 FAIL 并以非 0 退出。第三方实现可拿同一份金样本
（`tests/fixtures/format-conformance/log.md` 与 `expected.json`）对齐解析结果。
校验器刻意**不 require 项目自身的 parser**，这样它才是独立的格式一致性检查，
而不是「用实现验证实现」。
