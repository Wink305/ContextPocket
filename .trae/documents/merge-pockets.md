# 跨机器 / 多 Agent 合并口袋（merge）

## Context

同一项目在两台机器、两个 clone 或两个 Agent 上各自记录时，会得到两份 `ContextPocket/`：
T 号重复、ADR/需求编号重复、偏好可能冲突。现有 `repair` 只能修**同一个 log.md 内部**的撞号，
`import` 只能导入会话 JSONL，都无法把另一份口袋的历史与长期文档并进来。

本轮新增单向 `merge`：把源口袋的轮次、ADR、需求、🔒 红线、非冲突偏好并入当前口袋；
state.md / code-map.md / 冲突偏好不自动覆盖，写入 merge 报告，交给人/Agent 复核。
源口袋只读，目标写入持锁、可回滚，合并后 verify 不得变差。

已确认的决策：

- 新命令 `context-pocket merge --from <pocketDir> [--dry-run] [--include-archive] [--json]`
- 新 MCP 工具 `context_pocket_merge`（`from` / `dryRun` / `includeArchive`）
- 合并范围：`log.md` 轮次 + `decisions.md` ADR + `requirements.md` R + `absolute.md` 🔒 + `preferences.md` 非冲突项
- state.md、code-map.md、冲突偏好、冲突需求 → 只写报告，不静默覆盖
- `log-archive.md` 默认跳过；`--include-archive` 才把源归档轮次重编号后并入目标 live log.md
- 命令面 / 工具面 28 → 29；Lite 不变（11 / 11）

## 现状与可复用原语

- [repair.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/repair.js)
  - `HEADING_RE`、`remapTRefs()`、`findTRefs()`、`findFileTokens()`：T 引用边界安全改写
  - 文件级快照 + `verify()` 变差回滚 + `refreshGraphCacheIfExists()` 的既有模式
  - `lockedWrite()` 包装写入口的做法
- [parser.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/parser.js)
  - `parseLogText` / `parseLog` / `parseLogAll`、`parseDecisions`、`parseRequirements`、`parsePreferences`、`parseAbsolute`
  - 轮次结构：`## T<n> · gist · [tags]`、`## T<n>-fix`、`--- WHEN ---`、`### 小节`
- [writer.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/writer.js)
  - `appendLogBlock`（T 分配、SESSION、index 头）、`generateHandoff`
  - ADR / 需求 / absolute / preferences 的规范行格式
  - `updateIndexHeader` 及未导出的 `updateIndexReqCount` / `updateIndexAdrCount` / `updateIndexAbsoluteCount` / `updateIndexPrefCount`
- [importer.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/importer.js)：逐轮写入、T 号接续的参考实现
- [io.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/io.js)：`lockedWrite`、`writeAtomic`、`readTextOr`
- [validator.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/validator.js)：`verify()`、`attachmentRefs()`（附件引用解析）
- [migrate.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/migrate.js)：`detectFormatVersion()`
- [isolate.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/isolate.js)：源项目隔离检测

## 行为规格

### 1. 源与目标校验（全部在读取源内容之前）

1. `--from` 可指项目根（含 `ContextPocket/`）或直接指 `ContextPocket/`；解析为真实路径。
2. 源必须 `isPocketDir()`；源与目标 realpath 不能相同。
3. 源项目隔离检测命中（env / `.contextpocket-isolate` / `ContextPocket.isolated`）→ 拒绝，不读内容。
4. `detectFormatVersion(source)` 不得高于目标；源更高 → 拒绝并提示先在目标上 `migrate --to latest`。
5. 源 `verify()` 必须 **0 error**（warning 允许）；否则拒绝并回传错误清单。
6. 源 `log.md` / `log-archive.md` 存在重复或畸形 T 号 → 拒绝，提示先对源跑 `repair`。
7. 目标自身存在重复 T 号 → 同样拒绝，提示先在目标上跑 `context-pocket repair`（合并不能建立在已知撞号上）。

### 2. 轮次合并（不重建格式）

- 按行切块：`## T<n> ·` 与 `## T<n>-fix ·` 为块头，切到下一个块头/EOF；
  `--- WHEN ---`、`### 小节`、续行、空行全部逐字保留；**不用 `appendLogBlock` 重建内容块**。
- 源 SESSION 行不复制。目标最后 SESSION 日期 ≠ 今天时，在追加块前加一行 `--- SESSION: <今天> ---`；
  今天仍是同一 SESSION 则不再加（verify 要求同日不重复）。
- 源 v1 且目标 v2、块缺 `--- WHEN ---` 时，用源 SESSION 日期补一行 `--- WHEN: <date> (day) ---`，保留天级时间。
- 每个复制块在标题标签位追加 `[merged]`（不新增 `·` 段；无标签则加 ` · [merged]`）。
- T 号映射：
  1. 目标 `parseLogAll`（live + archive）按内容指纹建索引；
  2. 源块按 raw 顺序，用 `gist + tags（去掉 merged）+ WHEN + sections` 的 sha1 匹配目标同内容块；
     命中 → 复用目标 T 号，不重复追加；
  3. 未命中 → 分配 `目标 latestT + 1 ...` 连续新号；
  4. 重复内容按出现次序（第 k 次匹配第 k 个目标块）处理，避免相同轮次互相吞并。
- **内容指纹必须对编号改写免疫**：计算前把文本里的独立 `T<n>` / `ADR-<n>` / `R<n>` 归一成占位符，
  并排除 `Attachments` 小节里的文件名 token（附件会在复制时改名）。否则第一次合并把 `T1` 改成 `T21`、
  把 `T03-x.png` 改成 `T23-x.png` 之后，第二次合并会因内容不同而重复追加同一轮。
- 这样天然支持增量合并：同一源再合一次只追加新增轮次；源被 renumber 也不靠高水位，而靠内容匹配。
- `T<n>-fix` 不占号；其 `targetId` 必须落在 tMap 中，否则拒绝并报告。
- 引用改写只作用于**复制块文本**：T 用 `repair.remapTRefs`；ADR-`n` / R`n` 用边界安全的正则同时替换，避免级联。
- 未映射引用：
  - 若该 T 存在于源 `log-archive.md` 且未加 `--include-archive` → 拒绝并提示加旗标；
  - 若源里根本不存在 → 拒绝并提示先修源（不让合并文本悬空或错指目标同号块）。
- `--include-archive`：源归档块与 live 块按 T 号升序一起规划，统一重编号后追加到目标 **live** `log.md`（会变得可搜索）。

### 3. 长期文档

> 所有"是否已存在"的判定都先做与轮次相同的编号归一（`T<n>` / `ADR-<n>` / `R<n>` → 占位符），
> 再比较文本；否则第一次合并改过编号后，第二次会把同一条 ADR/需求/红线/偏好当成新的。

- **ADR**：目标 `max(ADR)+1` 起分配新号；匹配键为 `title + context + options + decision + consequences` 归一化。
  - 命中 → 源 ADR id 映射到目标 ADR id，不重复；
  - 新增 → 按 `addDecision` 的行格式追加，`createdAt` T 经 tMap（无映射则用 merge 记录 T），`Supersedes` 经 ADR 映射；
  - 同标题不同内容 → 作为新 ADR 追加，并在报告标 "same title, different content"。
- **需求**：按 `text` 归一化匹配；同文同状态 → 复用 R 号；新增 → 目标 `max(R)+1` 起，按 `## Open/Done/Cancelled` 分组插入，保持 `- [ ] R<n> text [tags] (opened T<n>) · impl: ...` 格式，T 号经 tMap。
  - 同文不同状态 → 保留目标，映射 R 号，报告冲突。
- **🔒 红线**：按正文归一化去重；新增条目按 `## 🔒 T<anchor> · gist` + blockquote 正文追加，anchor 经 tMap，无映射则指向 merge 记录 T。
- **偏好**：key 大小写不敏感（沿用 `updatePreferences` 语义）；同值跳过；异值保留目标并报告冲突。复制行里的 T 引用经 tMap。
- **requirements.md** 首行 `next_id: R<m>` 更新到新最大值；所有派生头行（state / requirements / decisions / preferences / code-map）T 号对齐到合并后的 latestT。
- **index.md**：更新 log 范围、ADR / 需求 / 🔒 / 偏好计数。
- **handoff.md**：合并结束后重新生成（best-effort，失败只告警）。
- **state.md / code-map.md**：不合并内容；源 state 的 summary / next steps / pitfalls 与 code-map 提示写入 merge 报告。

### 4. 附件

- 从源块 `### Attachments` 用 `validator.attachmentRefs()` 取引用；只为**新增/复制**的块处理。
- 在源侧按 verify 同款规则解析（pocket 相对 / 项目根相对 / assets 裸文件名）。
- 文件名含 `T<旧号>` 的，改成 `T<新号>`（保持原零填充宽度），复制到目标对应相对路径，并同步替换块文本里的精确 token。
- 不含 T 号的引用：原相对路径复制；目标已存在同内容 → 跳过；不同内容 → 保留目标、报告冲突（文本仍指向存在的文件，verify 不新增错误）。
- pocket 外无法安全复制的路径只报告，不猜。
- 合并前源 verify 已保证这些文件在源侧存在；目标侧复制失败会触发回滚。

### 5. 合并记录与报告

- 有新内容时追加一条 `[merge]` 记录 T-block（走 `appendLogBlock`，`conflictCheck:false`）：
  - gist：`merge: <source 名称>`
  - Action：源路径、源 latestT、新增轮次区间、ADR/需求/红线/偏好计数、`--include-archive` 状态
  - Uncertain：冲突偏好、冲突需求、未合并的 state/code-map 提示
- 报告写到 `ContextPocket/merge-<date>.md`（同日重复运行则追加一节）：
  - 源/目标路径、格式版本
  - 轮次：新增 / 已存在 / fix 块 / 归档跳过数
  - 长期文档：新增 / 复用 / 冲突明细
  - 源 state 摘要、源 code-map 提示
  - 附件复制/冲突/无法复制清单
  - T / ADR / R 映射表
- 全部内容都在目标里已存在（新增轮次=0、文档新增=0、无冲突）→ `alreadyMerged:true`，不写报告、不加记录。

### 6. 原子性与回滚

- `mergePocket` 用 `lockedWrite` 持有目标锁。
- 写前快照：`log.md`、`decisions.md`、`requirements.md`、`absolute.md`、`preferences.md`、
  `index.md`、`state.md`、`code-map.md`、`handoff.md`，以及本次将创建/覆盖的附件与报告路径。
- 写序：log 合并块（单次 `writeAtomic`）→ merge 记录（raw `appendLogBlock`）→ 四类长期文档 →
  派生头行 → index 计数 → 复制附件 → 写报告。
- 任何异常或 `verify().errorCount` 增加、或出现重复 T 号 → 恢复全部快照、删除新建附件与报告、
  `refreshGraphCacheIfExists()`，返回 `{success:false, rolledBack:true}`。
- 成功后同样刷新 graph 缓存，并调用 `afterWrite(pocketDir, { latestT, gist, index:true })`。

## 代码改动

### 新增 `lib/merge.js`

建议拆分：

- `resolveSource(from)` / `preflightSource(sourcePocket, targetPocket)`
- `sliceLogBlocks(lines)`：raw 块切分（T / fix / 原始行号 / session）
- `planTurns(targetParsedAll, sourceBlocks, includeArchive)`
  → `{ tMap, units, duplicateTurns, skippedArchive, newLatest }`
- `planDecisions()` / `planRequirements()` / `planAbsolute()` / `planPreferences()`
  → `{ adrMap, rMap, newEntries, conflicts }`
- `remapCopiedBlock(raw, maps, opts)`：标题号、T/ADR/R 引用、`[merged]`、v1 WHEN
- `copyAttachments()`：解析、复制、文本 token 替换、冲突清单
- `composeReport()` / `appendMergeRecord()`
- `mergePocket(targetPocket, opts)` 导出为 `lockedWrite(...)`

### `lib/writer.js`

- 新增仅供内部调用的非锁版本导出（避免 merge 持锁时嵌套 `lockedWrite` 死锁）：
  `internal: { appendLogBlock, updateIndexHeader, generateHandoff }`
- 导出四个 index 计数函数：`updateIndexReqCount`、`updateIndexAdrCount`、
  `updateIndexAbsoluteCount`、`updateIndexPrefCount`
- 不改现有导出行为。

### `bin/context-pocket.js`

- `BOOL_OPTIONS` 加 `include-archive`（`from` 和 `dry-run` 已在表内）
- 新增 `cmdMerge(options)`：`ensurePocket`、调 `mergePocket`、人类/`--json` 输出、失败退出 1
- `main()` 加 `merge` 分发与 `--help` 分支
- 顶部 usage 注释补一行

### `mcp-server.js`

- `TOOLS` 新增 `context_pocket_merge`：
  `from`（string，必填）、`dryRun`（boolean）、`includeArchive`（boolean）
- `handleToolsCall` 分发 `toolMerge(args)`
- `toolMerge` 输出 Markdown 摘要（计数、映射范围、报告路径、冲突）

### `lib/help.js`

- `HELP_GROUPS` 的 Long-term memory commands 加
  `['merge', 'Merge another pocket: turns + ADRs + requirements + red lines + prefs (--from)']`
- `COMMAND_HELP.merge` 详细帮助（源/目标、dry-run、archive、报告、回滚）
- `TOOL_DESCRIPTIONS.context_pocket_merge`

### 文档

- README 中英命令表加 `merge`；Hub 章节后新增短节 "Merging two machines / agents"：
  单向、源只读、state/code-map 报告、`--include-archive`
- `docs/FAQ.md`：命令清单加 merge，命令总数 27 → 29（顺手修正过期数字）；补一条
  "两台机器各有一个 ContextPocket 怎么合？"
- `docs/COMPATIBILITY.md`：28 → 29
- `SKILL.md`：工具列表 28 → 29、Quick responses 加"合并另一台机器/Agent 的口袋"
- `CHANGELOG.md` `[Unreleased]`：能力、边界、测试口径；**不升版本**

## 测试

测试加到 `tests/repair.js`（多 Agent 编号/合并同一域），不新增测试文件。

1. 基础合并：源 2 轮 → 目标 1 轮；新号接续、`[merged]`、源文件零变化、verify 通过、报告存在
2. 引用改写：源块引用 `T1` / `ADR-1` / `R1` → 合并后指向新号或已存在的目标条目
3. fix 块：`## T2-fix` → `## T3-fix`，`Corrects T2` 同步改写
4. 增量 + 幂等：再合一次 0 新增；源新增一轮后再合只追加那一轮，旧轮不重复
5. dry-run：所有目标文件 hash 不变、无报告
6. 长期文档：ADR / 需求 / 红线新增；重复项复用；同文不同状态 → 冲突记录；
   偏好同值跳过、异值保留目标并报告
7. state / code-map：目标内容不变，报告包含源内容
8. 归档：默认跳过并在报告计数；`--include-archive` 后归档轮次进入 live log 且重编号
9. 拒绝路径：源隔离、源 verify 有 error、源重复/畸形 T 号、`--from` 缺失/不存在、源与目标同路径
10. 未映射引用：源归档被引用但未加 `--include-archive` → 拒绝
11. 附件：T 编号文件复制 + 文本改名；同名同内容跳过；同名异内容报告
12. MCP：工具存在、`from` 缺失 → `isError`、dryRun 返回摘要
13. 计数：`tests/cli.js` 命令数 28 → 29；`lite/tests/metrics.js`
    CLI 28→29、MCP 28→29、包内文件 68→69

回滚不做平台相关的权限注入；改为单元覆盖快照恢复函数，并靠 verify 闸门 + dry-run 防回归。

## 验证

1. 静态：`git diff --check`、`node --check lib/merge.js bin/context-pocket.js mcp-server.js`
2. 门禁（工作区未受信任，由用户执行）：
   `npm run lint` · `npm test` · `npm run smoke` · `npm run smoke-live` · `node scripts/verify-format.js`
3. 体积基线：`npm pack --dry-run` 读主包实际 kB；若超出 1% 容差，把
   `lite/tests/metrics.js` 主包 size 基线追平（文件数同步 69）
4. 手动：
   ```bash
   context-pocket merge --from /path/other/ContextPocket --dry-run
   context-pocket merge --from /path/other/ContextPocket
   context-pocket verify
   context-pocket recall <新号>
   ```
   再跑一次应报 `already merged`；`--include-archive` 单独验证一次。

## 明确不做

- 不做双向同步 / 自动定期合并
- 不自动合并 state.md、code-map.md
- 不自动解决冲突偏好/需求，只报告
- 不改 Lite（仍 11 命令 / 11 工具）
- 不升版本、不发版
