# ContextPocket · LOG ARCHIVE

> Archived T-blocks. Read-only reference. Do not modify.

<!--
  这份头与 `context-pocket archive` 首次创建文件时写入的内容一致（lib/writer.js 的 archiveLog），
  所以"用工具归档"和"Agent 手工建文件"两条路径得到同一个布局。

  归档 = 整块搬家，不是压缩：被归档的 T-block 原文照搬到这里，10 个小节一条不少，
  `--- SESSION: <YYYY-MM-DD> ---` 分隔线跟着它下面那批块一起搬。
  旧版本这里写着"oldest blocks live here as 3-4 line summaries"，那是假的——
  照着它把块缩写成 3-4 行会永久丢失历史内容。

  标题下面那行 `--- WHEN: … ---`（format v2）是这一轮的时间，**跟着块一起搬**，
  不要在这里手改它：`archive` 搬的是原文，`log append` / `log amend` 才是写它的地方。
  v1 升上来的块只有 `(day)` 精度，那是迁移能从 SESSION 行里读出的全部，不是遗漏。

  这个文件只追加、永不回写；`recall` / `diff` / `search` / `why` 会同时读
  log.md 与 log-archive.md，归档过的轮次会标成 archived: true。
-->

## T1 · <gist> · [tags]
--- WHEN: <YYYY-MM-DD HH:mm> ---

### User
- <原文照搬，不要缩写>

### Action
- <原文照搬>
