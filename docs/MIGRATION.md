# 版本迁移指南

本文档说明 ContextPocket 的版本体系、数据格式兼容性，以及版本间迁移的方法与步骤。

---

## 版本说明

ContextPocket 存在两套独立的版本号，各司其职：

| 版本类型 | 位置 | 示例 | 说明 |
|---------|------|------|------|
| **Skill 版本** | 真值只有 `package.json` 的 `version`；另外三处是它的抄本——`SKILL.md` frontmatter 的 `version:`、`lib/version.js` 的 `FALLBACK_VERSION`（拿不到 package.json 时的兜底）、`CHANGELOG.md` 的 `## [<版本>] - <日期>` 节标题 | `1.2.1` | 遵循 [语义化版本](https://semver.org/lang/zh-CN/)，代表 skill 功能的迭代。静态文件自己算不出版本号，所以四处同值由 `tests/unit.js` 逐处比对：漂了就红 |
| **数据格式版本** | `ContextPocket/readme.md` 中的 `format:` 字段 | `v2` | 代表 `ContextPocket/` 目录内数据文件的结构版本 |

### 兼容性原则

> **新 skill 能读旧数据，旧 skill 可能不识别新数据。**

- **向前兼容（forward compatible）**：高版本 skill 可以读取低版本格式的数据（当前的 skill 1.2.x 就能同时读 `format: v1` 和 `format: v2` 的 pocket），读取时自动忽略不识别的字段。
- **不向后兼容**：低版本 skill 读取高版本格式的数据时（如 skill 1.0 遇到 `format: v2`），可能无法正确解析新增字段，应提示用户升级 skill 或进行迁移。
- v1 → v2 是**只做加法**的一跳：新增的 `--- WHEN: … ---` 结构行落在 `## T<n>` 标题的下一行，而 v1 的解析器把标题与第一个 `###` 之间的行整段忽略，所以旧代码读新文件不会丢东西（`tests/unit.js` 用同一份 `parseLogText` 逐字段比过带行与不带行的解析结果）。

---

## 当前格式版本

| 项目 | 值 |
|------|----|
| 当前数据格式 | **v2** |
| 对应 skill 版本 | **1.x.x** |
| 状态 | 稳定 / 当前 |

v1 是 ContextPocket 的首个正式数据格式，包含 10 个核心文件（`lib/constants.js` 的 `CORE_FILES`）+ 2 个按需文件（`log-archive.md`、`handoff.md`，用到才创建），以及 T-block / R-id / ADR 等基础结构。lite 模式下核心文件只有 5 个（`LITE_CORE_FILES`），缺的文件由写入方在第一次需要时补齐。

**v2 只比 v1 多一样东西**：每个 T-block 的标题下面多一条时间结构行，记下"这一轮是什么时候的事"。文件数量、小节名称、R-id / ADR 编号规则全部没动，所以 v1 的 pocket 依然是完全健康的，升级是可选的（见下面「v1 → v2 迁移」）。

---

## 迁移策略

### 自动检测

数据格式版本存在 `ContextPocket/readme.md` 的标题行里（新建的是 `# ContextPocket · format: v2`），由 `lib/migrate.js` 的 `detectFormatVersion(pocketDir)` 读取（正则 `/format:\s*(v\d+)/i`，`lib/migrate.js:134`）。新建项目的这一行来自 `templates/readme.md:1`，它是"新 pocket 出生时是什么格式"的唯一真相源。**已经存在的 v1 pocket 不会被任何写动作偷偷抬到 v2** —— 版本戳只由 `migrate` 盖。

**检测发生在 `migrate`，不在 `bootstrap`**：`context-pocket bootstrap --dir <root>` 只做幂等保护——已有 `ContextPocket/` 时什么都不写、退 0 并报出该路径（库层 `lib/bootstrap.js` 仍然是遇到已存在目录直接抛错、绝不覆盖），它不会去比对格式版本。要看当前项目的格式与可用迁移，用：

```bash
context-pocket migrate --dir <project-root> --list
```

`--list` 固定输出四行——`Current version` / `Target version` / `Latest registered` / `Status`，再补一段 `Registered steps:`（登记表里全部一跳，`bin/context-pocket.js:1647` 的那个循环）。只有当确实存在跨版本路径且当前不是最新时，才会追加 `Migration path:` 步骤列表。`--json` 时这些字段原样进 JSON（`currentVersion` / `targetVersion` / `latestVersion` / `available` / `path` / `isLatest`）；目标版本写错或路径不可达时 `ok:false` + 带 `error` 文本，退 1。MCP 侧是同名参数 `context_pocket_migrate` 的 `list: true`，文本内容与 CLI 一致。

**登记表里现在有两跳**：`v1 → v1` 是同版本自检（退 0、什么都不改，用来验证机制本身），`v1 → v2` 是**真会改写内容的一跳**——给 log.md 与 log-archive.md 里每个 T-block 补上 `--- WHEN: <日期> (day) ---`。所以 v1 的 pocket 直接 `--to v2` 就能升上去，`--to latest` 会走同一条路；而 `--to v3` 仍然报 `No migration path from v2 to v3` 并列出登记表现存全部跳，退 1——不会写入半套格式。

除了主动跑 `migrate --list`，v1 的 pocket 每次 `verify` 都会看到一条 WARNING（category `format-upgrade`）告诉你有这一跳可走；它是 warning 而不是 error，所以 pre-commit hook 绝不因为"没升级"拦提交，`status` 与写入路径也一切照旧。

示例提示（当未来的 skill 读到比自己更新的格式时）：
```
⚠️ ContextPocket 数据格式为 v2，但当前 skill 版本仅支持 v1。
建议升级 skill 到 2.x，或执行 context-pocket migrate --dir <project-root> --to v1 进行降级迁移。
```

### 迁移命令

#### `context-pocket migrate`（已实现）

CLI 迁移命令。真正干活的是登记表 `MIGRATIONS`（`lib/migrate.js:35`），一条记录 = 一跳 `from → to`；下面的执行语义由框架提供，与具体是哪一跳无关：

- `--to` 支持 `v2`、`2`、`V2`、`latest` / `newest`；**省略或写 `latest` 都取登记表里可达的最高版本**，不是写死的 `v1`
- 一跳一跳的路径由 BFS 现算（`findStepPath`），所以 `v1 → v2 → v3` 这种链**一条命令就能走完**，`--to v2` 只走前半程
- 执行前把整个 `ContextPocket/` 备份到 `ContextPocket.backup-<timestamp>/`
- **迁移前先看体检**：当前 pocket 的 `verify` 有 error 就直接拒绝对外写入、退回到"什么都没改"，备份目录随之删除
- 每一跳之前再 `verify` 一次；这一跳成功后由框架统一把 `format:` 戳抬到 `to`（迁移函数自己不需要写版本号）
- 任何一跳抛错、或**跳完之后 `verify` 出 error**（哪怕迁移函数一声不吭地把数据写坏了），整个目录恢复备份 —— 历史文件要么全升要么全不动
- 回滚成功后删掉那份备份（它此时就是当前内容的副本，留着只会让人误以为迁移过）；**只有成功走完才保留备份**，路径打在 `Backup:` 一行 / `--json` 的 `backupPath` 字段里
- `--dry-run` 打印完整计划（含每一跳），不写文件、不留备份

```bash
# 查看当前版本、登记表里都有哪些跳（v1 的 pocket 会给出 "Status: upgrade available" 和一段 Migration path）
context-pocket migrate --dir <project-root> --list

# 同版本自检（任何 pocket 上都退 0 并打印 "Migration skipped: Already at <当前版本>"，什么都不改）
context-pocket migrate --dir <project-root> --to v1 --dry-run

# 看升级计划：只打印每一跳，不写文件、不留备份
context-pocket migrate --dir <project-root> --to v2 --dry-run

# 真的升级（把每个 T-block 的时间行补出来）
context-pocket migrate --dir <project-root> --to v2

# 再跑一次是空跑：Already at v2，一个字节都不动
context-pocket migrate --dir <project-root> --to v2

# 升到登记表里的最新版本（多跳会自动串起来，全成或全滚）
context-pocket migrate --dir <project-root> --to latest

# 目标不可达时退 1，并把登记表现存的全部一跳列给你看：
#   ❌ Error: No migration path from v1 to v3. Registered step(s): v1 → v1: ... | v1 → v2: ...
context-pocket migrate --dir <project-root> --to v3
```

In MCP mode, use `context_pocket_migrate` tool.

### 手动迁移

如果自动迁移不可用或需要更精细的控制，可以按以下步骤手动迁移：

1. **备份**：复制整个 `ContextPocket/` 目录到 `ContextPocket.backup/`
   ```bash
   cp -r ContextPocket/ ContextPocket.backup/
   ```
2. **导出快照**：让 Agent 写一份完整快照文件(`pocket-snapshot-*.md`)，作为额外备份
3. **重置**：说「重新开始」——Agent 会先跟你确认，再执行 `archive --keep-last N` 归档并重建空的格式版本
4. **恢复**：从备份快照中逐条提取关键信息（decisions、requirements、preferences 等），写入新格式的对应文件

手动迁移适用于跨大版本升级、数据损坏修复，或需要在迁移过程中清理历史数据的场景。

---

## v1 → v2：每个 T-block 的时间行

> 这一跳是**真会改写内容的一跳**，`lib/migrate.js` 的 `migrateV1ToV2(pocketDir)`（登记表第 2 条，`lib/migrate.js:35` 起）。机制一侧由 `tests/migrate.js` 的 16 例覆盖（多跳、逐跳抬版本戳、抛错回滚、静默写坏数据也被事后体检抓出来并回滚、脏 pocket 拒绝开跑、目标不可达时列出登记表），内容一侧的另一半在下面「迁移做了什么」。

### 变更内容

v2 只在每个 T-block 的 `## T<n> · …` 标题**下一行**多一条结构行，其余（文件清单、小节名、R-id / ADR 编号规则）一字未改：

```markdown
## T<n> · <一句话概述> · [tag]
--- WHEN: <时间，见下表> ---

### User
- <用户原话>
```

四个形状（`lib/when.js` 负责解析与格式化，`lib/parser.js` 把它读成 `block.when`）：

| kind | 落盘的样子 | 谁写的 |
|------|-----------|--------|
| `instant` | `--- WHEN: <日期> <时刻> ---` | `log append` 不带 `--when` 时的默认值：写下它的这一刻 |
| `range` | `--- WHEN: <日期> <时刻> → <日期> <时刻> ---` | `--when "09:00 → 11:30"` 这类显式区间；端点只报到"日"时那一端就落日期（`<日期> → <日期>`），不会有别的形状 |
| `day` | `--- WHEN: <日期> (day) ---` | **v1 迁移补出来的就是这一种**；只知道天就只写天 |
| `text` | `--- WHEN: stated: <用户原话> ---` | 用户原话，逐字照抄，工具不做任何换算 |

读写入口：CLI `log append --when` / `log amend <T> --when` / `recall`（人读的是 `⏱ <日期> <时刻> → <时刻>` 这样的一句话，`--json` 里的 `when` 是文件里逐字那一行）；MCP 是 `context_pocket_log_append` / `context_pocket_log_amend` 的同名参数与 `context_pocket_recall` 的 `When:` 一行。两个入口的时间句子都出自 `lib/when.js` 的 `describeWhenLine`，不会各说一套。

### 迁移做了什么

`migrateV1ToV2` 只碰 `log.md` 与 `log-archive.md`（`WHEN_TARGET_FILES`），对每个 `## T<n>` 块：

1. **日期来自它自己上方最近的那条 `--- SESSION: <YYYY-MM-DD> ---`**，写成 `<日期> (day)`。一块跨天历史不会被统一盖成一个日期。
2. 上方找不到 SESSION 的孤块**什么都不写**（`stats.noDate` 计数）。v1 的文件里没有别处能证明这一刻是什么时候，用文件的 mtime 冒充"记录时间"、或者编一个日期，都是往历史里塞假信息。
3. 已经有时间行的块跳过（`stats.already`）。所以这一跳**幂等**：重跑一遍，文件一个字节都不变。
4. 标题行、SESSION 行、小节内容原样保留 —— 只有"插入一行"这个动作。测试把两份文件各自去掉时间行之后逐行 `deepStrictEqual`，这是"宽化不替换"的机械证据。
5. 它不写版本戳。`format: v2` 由框架在整跳成功之后统一盖（`setFormatVersion`），迁移函数只管内容。

三条诚实约束同时写在 `lib/when.js` 与写入层里，`log append` / `log amend` 也遵守：

- **宽化不替换**：迁移只在标题下加一行，绝不改写 SESSION 行或标题里的日期。
- **绝不编造**：源里只有日期就只给日期；`amend --when` 碰到一个**已经记下时刻**的块会拒绝覆盖（"不覆盖历史；要更正就新起一条 T\<n\>-fix"），只允许把粗粒度的 `(day)` 换成更准的值。
- **不做算术**：`→` 右边只继承左边的日期。`09:00 → 11:30` 可以，`23:30 → 00:20` 也照原样记，但工具**不会**推断"那是第二天"——跨天区间请写完整日期。

### 向后兼容说明

- **v1 的代码读 v2 的文件不丢东西**：解析器在 `## T<n>` 标题与第一个 `###` 之间只认结构行，其余行会被忽略，所以旧版本读到的 gist 与各个小节和新版本逐字相同（`tests/unit.js` 用同一个 `parseLogText` 对比带行/不带行的解析结果来钉住这点）。
- **v2 的代码读 v1 的文件**：`block.when` 为 `null`，`recall` 就少一行 `When:`，不会假装知道时间；写入层在 v1 的 pocket 里**永不**写时间行（`formatSupportsWhen` 说了算），免得内容超出它自己声明的版本。但"不写"不等于"不说"：调用方在 v1 里传了 `--when`，块照常追加（`log.md` 是 P0，不能因为版本没到就漏记一轮），同时把时间没落盘的原因讲回来 —— 人类输出多一行 `⚠️ pocket 还是 v1 格式：先 context-pocket migrate --to latest 才记时间`，`--json` 里是 `whenSkipped` 字段，MCP 文本同一句话（`tests/cli.js` 与 `tests/mcp.js` 各钉一条）。
- **归档安全**：`archive` 是按行范围把整块搬进 `log-archive.md` 的，时间行紧跟标题，所以它一定跟着自己的块走（`tests/pocket.js` 有一条专门查这个）。
- **精度不会倒退**：迁移补出来的历史只有"天"，之后新记录的轮次仍然精确到分钟。想知道某块是升级前还是升级后记的，看 `(day)` 就够了。
- 反过来（v2 降回 v1）登记表里没有这一跳，也不会加：时间行是加法产物，留着它对 v1 读者无害。

---

## 回滚方案

### 自动回滚（已实现）

`context-pocket migrate` 本身就会回滚，正常情况下不需要手工干预。触发条件与行为：

| 情况 | 行为 |
|------|------|
| 迁移前 `verify` 就有 error | 拒绝开始，一个字节都不改，刚建的备份目录立即删掉 |
| 某跳开始前 `verify` 已经不干净 | 停止并回滚整个 `ContextPocket/`（不是只撤这一跳） |
| 某一跳抛异常 | 报错里带 `Migration step failed (v2 → v3: <name>): <原因>`，整个目录回到本次运行开始前的状态，版本戳也回到 `v1` |
| 某一跳没报错但把数据写坏了 | 迁移后的 `verify` 报 error，同样整体回滚（`Post-migration verify failed (N error(s)). Rolled back to v1.`） |
| 全部跳完且体检通过 | 保留 `ContextPocket.backup-<timestamp>/` 供对比，确认无误后自行删除 |

回滚成功后那份备份就被删掉了（此时它就是当前内容的副本，留着只会让人以为迁移过）。**唯一会留下备份没恢复的情况是"恢复动作本身失败"**（比如磁盘写不进去），这时备份目录一定还在，按下面手动处理。

### 迁移失败后的手动恢复

只有在自动回滚也报错、且 `ContextPocket.backup-<timestamp>/` 仍然存在时才需要：

1. 停止操作，不要继续写入 `ContextPocket/`
2. 把当前的 `ContextPocket/` 改名保留现场（别直接删，里面的半截状态是排查线索）
   ```bash
   mv ContextPocket/ ContextPocket.broken/
   ```
3. 将备份目录重命名回 `ContextPocket/`
   ```bash
   mv ContextPocket.backup-<timestamp>/ ContextPocket/
   ```
4. 执行 `context-pocket verify` 确认回滚后数据健康
5. 把 `migrate` 的报错原文（含是哪一跳）连同 `ContextPocket.broken/` 反馈到 issue

### 迁移前检查清单

执行任何迁移操作前，**必须**完成以下两项：

- ✅ `context-pocket verify` — 确认当前 ContextPocket 状态健康（无 broken refs、文件齐全）。`migrate` 自己也会先跑一次体检并在不健康时拒绝开始，但那只会告诉你"改完再试"，先手工确认能少跑一趟
- ✅ 导出完整快照作为离线备份（让 Agent 直接写一份快照文件）——命令内的备份在项目目录里，同盘损坏时它救不了你

---

## 相关链接

- [CHANGELOG.md](../CHANGELOG.md) — Skill 版本变更记录
- [CONTRIBUTING.md](../CONTRIBUTING.md) — 如何新增一个迁移步骤（登记表写法）
- [SKILL.md](../SKILL.md) — Skill 规范与格式定义
- [FAQ.md](FAQ.md) — 常见问题
