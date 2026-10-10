# 常见问题 (FAQ)

> 常见问题由 Agent 直接按 [SKILL.md](../SKILL.md) 的「快速响应」表内联回答——你用大白话问就行，不需要记命令。本文档收录更深入的、一次会话内不太会问到的边缘问题。

***

## 数据 / 存储

### Q: ContextPocket/ 会同步到 Git 吗？

**A**: 默认不。初始化（`bootstrap`）会在项目根的 `.gitignore` 添加 `ContextPocket/`，作为本地数据。

决定这件事的是 `bootstrap --gitignore false`（或 MCP `context_pocket_bootstrap({ gitignore: false })`）；`config.md` 里的 `- gitignore:` 那一行只是**把初始化时实际采用的取值记下来**，事后编辑它不会重写 `.gitignore`。

如果你**想**提交它（比如团队共享一个 Agent 的工作记录）：

```bash
# 在项目根 .gitignore 删掉 ContextPocket/ 行
git add ContextPocket/
git commit -m "chore: track ContextPocket/ for team sharing"
```

> ⚠️ **注意**：共享的是**数据**，不是并发权。同一台机器上多个 Agent 同时写由写入锁排队（`lib/io.js` 的 `withPocketLock`，锁文件在 `os.tmpdir()`，作用范围就是一台机器）；跨机器同时写会各自算出同一个 T 号，合并后撞号——所以跨机器仍然按"串行交接"用：写完提交，别人先 `git pull`。真撞上了用 `context-pocket repair` 收回来（见「协作 / 团队」）。

### Q: 🔒 区能加密吗？

**A**: 不能。ContextPocket 是纯文本，设计上不加密。如果你的项目包含密码 / API key 等敏感信息，**不要放进 ContextPocket**——它和项目代码在一起，任何读项目的人都能读。

敏感信息应该：

- 用 `.env` + `.gitignore` 管理（标准做法）

- 或用专门的密钥管理工具（1Password / Vault 等）

### Q: 数据格式会变吗？

**A**: 会变，而且已经变过一次。`ContextPocket/readme.md` 第一行的 `format: vN` 标识数据格式版本（`lib/migrate.js` 的 `detectFormatVersion`，`lib/migrate.js:134`）；**当前是 `format: v2`**——新建的 pocket 由 `templates/readme.md:1` 一出生就带 v2，存量 v1 目录仍然是合法的，跑不跑升级由你决定。

v1 → v2 只多了一样东西：每个 T-block 标题下面那条 `--- WHEN: <时间> ---` 时间行。升上去要做的只有一件事：

```bash
context-pocket migrate --dir <project-root> --to v2 --dry-run   # 先看会改什么
context-pocket migrate --dir <project-root> --to v2             # 真写：先备份、逐跳体检、失败自动回滚
```

停在 v1 的目录只会在 `verify` 里多一条 `format-upgrade` **WARNING**（提醒有升级可用），不会拦提交，也不会有任何写动作偷偷把版本号抬上去。

有几点需要说清楚，免得被误解成承诺：

1. **数据格式版本 ≠ skill 版本**。v2 是随 skill 1.1.0 发布的，skill 的主版本号没有动，`SKILL.md` 自己 frontmatter 里的 `format: v1` 也不是数据格式（那是这份文档的排版版本）。只有当新格式**破坏**了旧 skill 的读取能力时，才需要抬 skill 主版本号——纯增字段不需要，因为多余的行会被旧解析器当成标题后的散行丢掉。
2. **提供自动迁移工具**：见上面 `migrate`，登记表 `MIGRATIONS`（`lib/migrate.js:35`）里一跳一跳走，BFS 现算路径，所以 `v1 → v2 → v3` 一条命令就能串完。
3. **在 CHANGELOG 详细说明**：见 [CHANGELOG.md](../CHANGELOG.md) 与 [MIGRATION.md](./MIGRATION.md)。

向后兼容性原则：**新 skill 能读旧数据，旧 skill 可能不识别新数据**。当前这一跳属于前者——v2 相对 v1 只多一行结构行，v1 的读取路径（`lib/parser.js` 的 `parseLogText`）遇到它不会多出任何行为，这一点由测试直接钉住（同一份内容加不加时间行，解析结果必须相等）。

### Q: 怎么确认我装的 context-pocket 是哪个版本？版本号写在哪里？

**A**: `context-pocket --version`（`-v` 和 `context-pocket version` 是同一种意思的三种写法）。它只读包自己的 `package.json`，不要求当前目录有 `ContextPocket/`，也不写任何东西——在空目录里问照样答，跑完目录还是空的。要机器读就加 `--json`，一行：`{"ok":true,"name":"context-pocket","version":"1.2.1","source":"package.json","node":"<你的 Node 版本>"}`。

MCP 那一侧不必另问：`initialize` 回包里的 `serverInfo.version` 就是同一个数字。两个入口都经 `lib/version.js` 的 `pkgVersion()` 读 `package.json`，所以**要改的版本号只有 `package.json` 这一处**，其余三处都是它的静态抄本，由 `tests/unit.js` 逐处比对：拿不到 `package.json` 时的兜底值 `FALLBACK_VERSION`（目录式安装——把 `bin/` 与 `lib/` 拷进 skills 目录、没带 package.json——才会走到它）、`SKILL.md` frontmatter 的 `version:`、以及 `CHANGELOG.md` 里 `## [<版本>] - <日期>` 那节定版标题。抄本自己算不出版本号，漏改任何一处也不会在任何入口报错，只会让不同地方各说一个号——所以报警器只能长在测试里。上面 `--json` 里的 `source` 字段会老实说明这次是从哪一处拿到的号。

顺带分清三个都叫"版本"的东西，它们都不是包版本：`ContextPocket/readme.md` 的 `format: vN` 是**数据格式版本**（见上一问），`SKILL.md` frontmatter 的 `format: v1` 是**这份文档自己的排版版本**，README 顶上那枚 `format-v1` 徽章指的也是它。

### Q: 能导出到其他格式（JSON / SQLite）吗？

**A**: 当前不支持。ContextPocket 是 Markdown-first，换成 JSON 会失去：

- 人类可读性

- git diff 友好

- 与其他工具的兼容性

如果你的项目需要结构化查询，建议把 ContextPocket 作为**输入**，自己写脚本解析。

### Q: 怎么在多台机器之间共享 ContextPocket 数据？

**A**: 有两条路径，二选一即可：

**1) 同步用户级 hub + 项目级 ContextPocket（推荐）**

```bash
# 所有机器上都设
export CONTEXTPOCKET_HOME=/path/to/synced/folder   # 指向网盘/Dropbox/iCloud/git bare repo
```

`~/.contextpocket/hub.json`（hub 注册表 + 全局偏好）会跟着这个文件夹走。新机器登录后，`context-pocket hub list` 就能看到已注册项目。

**2) 把整份 `ContextPocket/` 进 git（项目级同步）**

```bash
context-pocket bootstrap --gitignore: false --dir <root>
```

或 MCP 模式下 `context_pocket_bootstrap({ gitignore: false })`。`ContextPocket/` 不再被 `.gitignore` 忽略，整份目录（包括项目级偏好）跟着 git 走。

> ⚠️ 两条路径都要明白锁的边界：`withPocketLock` 的锁文件写在 `os.tmpdir()` 里、按 pocket 路径命名，所以它**只在一台机器内**给写入排队。跨机器共享时请串行交接（谁做完谁提交，下一个先 `git pull`）；真的两个克隆同时写了，合并后会撞到同一个 T 号，用 `context-pocket repair` 收回来。Hub 是**注册表**，项目数据永远在各项目的 `ContextPocket/` 里；hub 故障（磁盘满、权限不够）不会影响正常记录。

### Q: `assets/search-index.json` 是什么？能删吗？

**A**: 这是**派生缓存**，不是真相源。索引覆盖 `log.md` / `log-archive.md` / `decisions.md` / `requirements.md` / `preferences.md`（`lib/indexer.js` 的 `SOURCE_FILES`）。每次写入后刷新时先比对这几个文件的 mtime + size 签名（`sourceSignature`）：签名没变就整轮跳过；变了也只对**内容变了的那几篇**重新分词，其余条目按 hash 复用。实测 800 轮、每轮 7 个小节的项目：首次整库重建约 0.14 秒，无变化的刷新约 0.07 秒，追加一轮后的刷新约 0.18 秒且只重分词 1 篇（另外 800 篇按 hash 复用）。删除它完全安全——下次 `search` 会自动重建。如果索引损坏或格式过时（`INDEX_VERSION` 对不上），搜索也是**当场重建再走索引**：实测三种情况（文件缺失、内容是坏 JSON、把 `version` 改成对不上的值）里 `search --json` 的 `viaIndex` 都是 `true`。只有连重建都做不成（只读盘、`assets/search-index.json` 这个位置被别的东西占了）才透明回退到全量扫描，那时 `viaIndex` 才是 `false`——实测这样一次搜索的命中数与顺序和索引路径完全一样，索引任何问题都不会阻断搜索，也不会改变结果。

> 剩下的一次性开销来自"整个索引是一个 JSON 文件"：每次读它都要 `JSON.parse` 整份（上面那个 800 轮的项目，v2 二字组分词下 1003 KiB；把分词退回"整串中文当一个词元"的旧写法、同一批语料重测是 628 KiB —— 二字组换来的命中率是要花这 60% 体积买的，见下一问）。所以 `lib/indexer.js` 里加了一层**进程内缓存**（`indexMemo`）：按 `pocketDir` 记住上一次的解析结果 + 当时的源文件签名，签名一致就直接复用，不再读盘。这对常驻的 MCP server 才有意义——实测同一份 800 轮、查同一个中文短语 20 次：每次都从盘上读是 38 ms/次，命中缓存是 11 ms/次（约 3.5 倍）。一次性 CLI 调用（`context-pocket search …`）本来就只搜一次，走不到这层缓存，行为与数字不变。
>
> 数字怎么来的：`bootstrap` 一个临时项目，用 `log append` 灌 800 轮（每轮 7 个小节、含中文短语），删掉索引后 `buildIndex({rebuild:true})` 计时，再跑无变化刷新、追加一轮后的刷新，最后各查 20 次取平均。换机器、换语料都会变，它说明的是量级与"缓存这条路值得走"，不是 SLA。
>
> 为什么它不会读到旧数据：缓存的键就是那 5 个源文件的 mtime+size 签名，**内容一变签名就变**，下一次搜索立即作废缓存并重建（`tests/pocket.js` 里"刚写入的一轮马上能搜到"和"缓存命中时索引文件被删也不会去读盘、不会顺手重建"两条断言就是锁这个的）。缓存最多保留 8 个项目，按插入顺序淘汰；淘汰只是退回"读盘"这条路，不影响正确性。签名一致而只有 `search-index.json` 被别的进程重写过时，复用的那份内容同样是从同一批源文件派生出来的，结果等价。

```bash
# 手动强制重建
context-pocket index --rebuild --dir <root>

# 临时跳过索引走全量扫描（调试时有用）
context-pocket search <keyword> --no-index --dir <root>

# 写入侧也有 --no-index，含义是缓存的另一头：这一次写完不刷索引
context-pocket log append --gist "批量灌历史" --user "…" --no-index --dir <root>
```

> ⚠️ `--no-index` 这个名字出现在两类命令上，读法不同但都动不到数据：在 `search` 上是"这一次查询不信缓存，直接扫 Markdown"；在 `log append` / `log amend` 上是"这次写入完不刷新缓存"。后者省掉的是每轮一次的分词与写盘，代价只有"下一次 search 自己发现源文件签名变了、现场重建"——实测这样灌进去的一轮照样搜得到，且 `assets/search-index.json` 在搜索后回到磁盘上。（注意 `import` 没有这个开关，也不需要：它是一批写完再刷一次，不是每轮刷一次。）Markdown 永远是真相源，所以两种读法给出的命中集合与顺序都完全一致。

> 📏 **省下来的到底是多少，要看规模**（本机 Node v24.18.0 实测，临时项目，每轮只给 gist/user/action 的最短写法）：30 轮的项目里一次 `log append` 端到端 **162 ms**，加 `--no-index` 是 **147 ms**，差值约 **15 ms/轮**；而一次空转的 CLI 调用（`status --json`）本身就要 **112 ms**，大头是 Node 进程启动。所以结论分两面：**常驻的 MCP server、以及连着灌几十轮的脚本**里那 15 ms/轮是净收益，值得加；**一次一条的 CLI 用法**里它会被进程启动税盖住（只占 9%），不值得为它改变写法习惯。上面说的"追加一轮后的刷新约 0.18 秒"是 **800 轮**规模下的数字，不是随手可用的常数——同一个动作在 30 轮时只有 15 ms。

### Q: 中文关键词怎么匹配的？为什么换个顺序就搜不到？

**A**: 索引和全量扫描共用同一个分词函数（`lib/indexer.js` 的 `tokenize`），所以 `--no-index` 与走索引两条路径给出一模一样的命中和顺序。规则三条：

1. **拉丁/数字按分隔符拆词**：`parser.js` → `parser` + `js`，`keep-alive` → `keep` + `alive`。中英混排的 `索引v2` 会拆出 `v2`（所以查 `v2` 命中），但整串 `索引v2` 本身不是词元（查它不命中）。
2. **中文按相邻二字组成词**：「给搜索加时间分页」入库的是 `给搜 / 搜索 / 索加 / 加时 / 时间 / 间分 / 分页`，整串不入库。查询同样被切成二字组，并且**每个词都必须命中**。
3. 于是：长串里的短语能搜到（`时间分页` 命中上面那句），换了顺序就搜不到（`分页时间` 需要 `页时` 这个词元，文档里没有）；实测这两条分别是 1 命中 / 0 命中。

还有一条要知道的取舍：**单独一个汉字**只在那个字独立成段时命中。实测语料里 `库` 命中的是「单独一个汉字 库」那一轮，而不是写着「索引库要重建」的那一轮——那个 `库` 在 run 中间，只贡献了 `索引`、`引库`、`库要` 这些二字组。倒排里再补一层单字词元能让它命中，但同一份 800 轮语料的实测体积会从 628 KiB 涨上去（二字组本身已经是这个代价），postings 也会成倍变长，所以没有做。**要精确就用两字以上的短语，或者直接把关键词写进 `--tags`。**

### Q: 中途启用，之前用 Claude Code / Codex 留下的对话能找回吗？

**A**: 能。把当时的会话 JSONL 找出来：

- Claude Code：`~/.claude/projects/<project-slug>/<session-uuid>.jsonl`
- Codex：`~/.codex/sessions/<id>.jsonl`

然后：

```bash
# 1) 先 dry-run 看导入计划
context-pocket import --file <session.jsonl> --dry-run --dir <root>

# 2) 确认无误后真正导入
context-pocket import --file <session.jsonl> --dir <root>
```

T 编号从当前最新继续，每个导入的 T-block 都打 `[imported]` 标签。工具调用噪音（tool_use / tool_result / 命令标记 / 系统注入）自动跳过。源类型默认嗅探，可用 `--source claude-code` 或 `--source codex` 强制指定。轮次与长度也能调：`--limit N`（默认 100，最多导几轮）、`--truncate N`（默认 400，每条原话/摘要截断到几个字，`--dry-run` 的 preview gist 另有 60 字上限）。导入后建议问一次「查一下有没有漏」（`context-pocket verify`），看有没有 import-shaped 漏填项。

***

## 工作流 / 习惯

### Q: 应该多久跑一次健康检查（`context-pocket verify`）？

**A**: 经验法则：

- 小型项目（< 50 轮）：不需要。注意 `bootstrap` **不做体检**——它只按模板建目录，`ContextPocket/` 已存在时是无害 no-op（退 0，一个字节都不改）；漂移检查在 `verify` 里，且两项都要显式加 `--drift` 才跑（认知漂移 + "代码比记录新"）

- 中型项目（50-200 轮）：每次交接（handoff）前

- 大型项目（> 200 轮）：每 50 轮查一次，或每周一次

- 交接前：必跑

### Q: `context-pocket sync` 和直接 bootstrap 区别？

**A**:

- `bootstrap`（`context-pocket bootstrap`）— 初始化：按模板建 10 个核心文件（lite 模式 5 个）、扫目录预填 code-map、登记 hub（加 `--no-hub`，MCP 写 `noHub: true`，就只建 pocket，`CONTEXTPOCKET_HOME` 下一个字节都不写；之后去掉这个开关重跑一次即可补登记）。**不做体检**，`ContextPocket/` 已存在时是无害的 no-op（退 0，一个字节都不改）

- `context-pocket verify` — 体检，默认 15 项：文件完整性（含 🔒 区 `absolute.md` 在不在）、编号连续性（T/R/ADR）、引用完整性、index 一致性、T-block 小节格式（缺 `### User` / `### Action` 是 ERROR；`log append` 当场就把缺的那一节说出来并给出 `log amend` 命令，不再让你只看到"追加成功"；还有一种 ERROR 专门照 1.1.0 写坏的时间行 `--- WHEN: undefined → undefined ---`，判据是"这一行没有 `stated: ` 前缀，工具不可能这样写原话"，所以用户逐字说过 "undefined" 不会被误拦在提交门外）、code-map 漂移、handoff 过期、标题行 T 一致、畸形编号、log 体积 vs `archive_at`、pocket 里的密钥 / PII 形状、**附件声明对不对得上磁盘**（`### Attachments` 写了 `assets/T04-x.png` 而文件不在 = ERROR，`log.md` 与 `log-archive.md` 都扫；模板占位 `<...>`、URL、绝对路径、含 `..` 的、以及已经按规范标了 `[missing: T<n> <file>]` 的那一条都不算，宁可不报也不误报。修法是补回文件，或按 `[missing: …]` 把这一条标注成缺失，然后重跑 `context-pocket verify`）、**格式版本是否落后**（`lib/validator.js:74`；登记表里真有可走的一跳才报，而且是 WARNING，所以它既不刷屏也不拦提交）。加 `--drift` 才跑另两项扫目录的检查：认知漂移（最近 T-block 提到的路径 vs 工作树）与"代码比记录新"（mtime 晚于上次记录的文件，**不需要 git**）

- `context-pocket sync` — 补档，只关心"最近几轮是否漏记"。判定"记过没有"只认**强证据**：路径出现在最近某轮的 `### Action` 小节里

### Q: 我在 `### Uncertain` 里写了"要不要一起改 `lib/store.js`"，`sync` 为什么还说这个文件漏记？

**A**: 因为那句话不声明 `lib/store.js` 被改过。工具把证据分两级（`lib/parser.js` 的 `weakMentions()`）：Action 小节里的路径 = 强证据，算覆盖；其它小节（Uncertain / Attachments / Conflicts / Pitfalls / Decisions…）里的路径 = 弱证据，**不算覆盖**，但也不会被扔掉——

- `sync` 会把它单独列出来，写成 `← only mentioned in T7/Uncertain, never in Action`，并建议改用 `context-pocket log amend T7 --action "…"` 把那一轮补全，而不是新起一个 `[auto]` 块（后者只会留下一条免责声明）；
- `--auto` 真的补录时，`[auto]` 块的 Action 行里也带着"（此前只出现在 T7 的 Uncertain，未记入 Action）"，核对的人一眼看得懂；
- `why` 对同一件事给两种答案：`evidence: "changed"` 与 `evidence: "mentioned"`，改过的那几轮排在前面。

取舍说明：反过来做（把弱证据也算覆盖）会静默放过真实漏记；只认严格 `<操作> <文件> — <描述>` 格式则会让自然语言的 Action（`新增 src/a.ts 和 src/b.ts`）被误判，于是每次提交多出一个冗余 `[auto]` 块。分级是这两者之间唯一不撒谎的位置：**谈过 ≠ 改过**，但"谈过"值得告诉你去哪儿补。

如果怀疑漏记，说「git 有没有漏记的」（`context-pocket sync`）。如果只是新会话接入，说「开始记一下」即可（bootstrap 是幂等的）。

### Q: 怎么让 Agent 主动问🔒？

**A**: 默认行为已经开启——只要你说"必须""一定""不许"等强需求词，Agent 会问。

如果你不想被问，说"不需要标🔒"，Agent 会记住（`preferences.md`）。

如果你希望 Agent **不主动问但默认标记**，编辑 `ContextPocket/config.md`：

```markdown
- auto_lock_strong_requirements: true  # (未来版本支持，当前需手动)
```

***

## 协作 / 团队

### Q: 团队里每人跑自己的 Agent，ContextPocket 会冲突吗？

**A**: ContextPocket 是项目级（不是用户级）。同一项目只能有**一份** ContextPocket/。

先分清楚两种"同时"：

- **同一台机器上几个 Agent 同时在写**：安全。每次写入先取锁再读 `latestT`、再追加（`lib/io.js` 的 `withPocketLock`，锁按 pocket 路径放在 `os.tmpdir()`），所以它们会排队，各自拿到不同的 T 号。
- **几台机器各自有一份克隆，同时在写**：锁看不见别的机器，两边都算出 `latestT + 1`，合并后 `log.md` 里就会有两个 `## T9`。所以跨机器请按**串行交接**用：一个 Agent 做完 → 提交 → 下一个先 `git pull`。

真撞上了不用手改 markdown：`verify` 会把 `Duplicate T-id: T9` 报成 error 并给出命令，`context-pocket repair --dry-run` 看方案、去掉 `--dry-run` 执行。它把撞号那块**连同它之后的每一块**整体后移（`log.md` 只追加，编号必须继续随文件顺序递增），派生值（各文件头行的 `· T<n>`、`index.md`）跟着对齐，`log-archive.md` 只报不改，改动本身写成一个 `[auto]` T-block；改完体检更差就整份回滚。

**正文里写着旧编号的地方默认只列出来、不改**——一句 `T9` 可能指两块中的任何一块，只有读的人知道是哪一块；确认之后再加 `--apply-refs` 一次性替换。

替换只认**独立的 `T<数字>`**，而且有两类东西它永不改写：
- **词**：`GPT4`、`RTX4090`、`UTF8` 里含着 `T4`/`T2` 的形状，但不是编号，`--apply-refs` 也不会把它们改成别的型号名字。
- **附件文件名**：`T04-diagram.png`、`assets/T04-diagram.png` 是文件名不是引用。改名是两步——先 `mv` 文件、再改文本——repair 不替你动磁盘上的文件，所以也绝不只改文本那一半：那只会造出一条断链，还顺手丢掉零填充（`T04`→`T4`）。它们单独列在输出的 `📎 Attachment file names…` / `--json` 的 `fileNames[]` 里，每条给一句现成的 `mv "旧名" "新名"`，你执行完再跑一次 `context-pocket verify` 确认链接没断。

团队协作模式：

1. 每人用自己的 Agent，写之前 `git pull`、写完立刻提交（推荐）
2. 共用一台机器时可以并行写，锁会排队；给每轮署名（`log append --author agent-A`）就知道那段历史是谁记的
3. 或各自让 Agent 写一份快照文件（`pocket-snapshot-*.md`）导出，合并时人工合并

### Q: 能分项目 + 分人记录吗？

**A**: 当前 ContextPocket 是项目级。可以这样做：

- 每个项目独立 ContextPocket/（默认行为）

- 个人偏好可以放到 `preferences.md`（所有人共享，需要协商）

未来可能加 `ContextPocket/users/<name>.md` 做用户级记录，但当前不支持。

### Q: 接手别人项目，多久能上手？

**A**: 如果 ContextPocket/ 维护良好：

1. 读 `readme.md` — 项目名片（1 分钟）
2. 读 `handoff.md`（如果有）— 阶段交接（3 分钟）
3. 接手——Agent 读 `index.md` + `state.md`（pocket 已存在，`bootstrap` 只会确认它在），必要时跑一次 `verify`（2 分钟）

总计 5-10 分钟可以进入实际工作。

***

## 隐私 / 安全

### Q: 用户把 API key 贴进对话让我排查报错，这条记录会怎么样？

**A**: 会被 `verify` 拦下来。pocket 是明文 Markdown，每一轮新会话都会被重新读进来，工具输出又会被抄进下一条 T-block——所以一句"报错原文"里的 `sk-ant-…` 会沿着历史一路复制下去。`lib/secrets.js` 认 17 类厂商凭证形状（Anthropic / OpenAI / Stripe / AWS / GitHub / GitLab / Google / Slack / npm / Twilio / SendGrid / OAuth / JWT / 私钥块）：

- 命中即 `verify` 报 **ERROR**，位置精确到 `log.md:11`，`archive` 与 `migrate` 当场拒绝执行，装了 pre-commit hook 的话 `git commit` 退 1
- 告警里只有掩码（`sk-ant…(30 chars)`），扫描告警本身绝不回显完整密钥——这条是硬约束，因为输出会进下一条记录。**注意边界**：`verify --json` 除了告警还会回吐 `data`（这个 pocket 的逐字解析内容，`status` / `recall` / `search` 也一样，它们的存在意义就是把记录原文还给调用方），所以**整串密钥会出现在那一行 JSON 里**——值已经在你的 `log.md` 里了，工具不会替你打码。别把 `verify --json` 的原文转存进下一条记录或共享日志；要清掉值，用它给的 `fix`（改那一行，或 `log amend <Tn>`）。
- 正确做法：记下那句话、略掉值本身（`报错原文：401 using <Anthropic key，已略> 调用失败`）

身份证号、卡号、手机号、`password: xxxx` 这类属于 **WARNING**：照样报出来，但**永远不拦提交**——把客户手机号记进历史是正常业务，拦下来只会让人绕过工具。卡号还要过 Luhn 校验，时间戳和订单号不会被误报。

想在 pocket 里合法保存这些串（例如这个仓库本身就是密钥轮换手册）：`config.md` 写 `- secret_scan: false`，整块检查关闭，一条都不报。

### Q: 那 `absolute add` 的🔒原话呢？工具会替我把密钥打码吗？

**A**: 不会，而且这是刻意的。🔒 区的定义就是"逐字保存的用户原话"，静默改写等于撒谎。`redactText()` 存在（把命中换成 `[REDACTED:Anthropic API key]`），但只有调用方显式要求时才用；`log append` / `absolute add` 都不自动调它。要挡在写入之前，靠的是上面那条：Agent 读 SKILL.md 的 MUST-rule，自己决定不把这个值记进去，而不是让工具偷偷改你的历史。

***

## 性能 / 资源

### Q: ContextPocket 会让项目变慢吗？

**A**: 几乎不会。ContextPocket/ 是静态 Markdown 文件，不参与构建。最大开销是 Agent 每次启动时读这几个文件（总共 < 50KB）。

### Q: 项目很大（几万行代码），ContextPocket 还能用吗？

**A**: 可以，但建议：

- 用 `code-map.md` 只记**目录层级和关键模块**，不展开到每个文件

- 把详细文档链接进 attachments 而不是全文复制

- 定期归档：`log.md` 行数到了 `config.md` 的 `archive_at`（默认 800）时，`status` 与 `verify` 会明确报"archive is due"。**归档不会自动发生**——搬动历史必须有人触发（`context-pocket archive`）

### Q: token 消耗如何？

**A**: 每轮 Agent 加载 ContextPocket 大约消耗：

- 首次激活（bootstrap）：\~2-3k tokens（读 10 个核心文件 + on-demand 按需加载）

- 后续每轮：\~200-500 tokens（只读增量）

- 回看 / 对比 / 搜索（recall / diff / search）：按需

比"每次让用户复述项目状态"省 10x+ tokens。

***

## 边界 / 哲学

### Q: ContextPocket 是"长期记忆"吗？

**A**: 是的，但有限制：

- ✅ 跨 Agent / 跨模型

- ✅ 跨会话 / 跨天 / 跨月

- ❌ 跨项目（项目隔离）

- ❌ 跨用户（团队共享时需要协商）

### Q: 和 LangChain / LlamaIndex 的 memory 区别？

**A**: ContextPocket 不是框架的 memory，它是**项目文件的元数据层**。

- LangChain memory — 在框架运行时维护，程序退出就丢

- LlamaIndex — 索引文档做 RAG，用于检索

- ContextPocket — 给下一个 Agent 看的"项目档案"，强调**意图和决策**，不只是内容

### Q: 我只说自然语言，Agent 能听懂吗？

**A**: 能——而且这是唯一的用法。ContextPocket 没有斜杠命令，Agent 按 [SKILL.md](../SKILL.md) 的「快速响应」表把大白话映射到具体子命令：

- "开始记一下" → `context-pocket bootstrap`

- "上一轮进绝对保留" → `context-pocket absolute add`

- "状态怎么样" → `context-pocket status`

- "T5 那轮说了啥" → `context-pocket recall T5`

想要零歧义就把子命令名直接说出来，Agent 会照着执行。

### Q: ContextPocket 会取代 commit message 吗？

**A**: **不取代，互补**。

- commit message：代码层面，精确到 hash，可重放

- ContextPocket T-block：意图层面，记录"为什么"和决策

最佳实践：commit message 写"做了什么"，ContextPocket 写"为什么这么做"和"考虑过的其他方案"。

***

## 故障 / 错误

### Q: 激活（bootstrap）后没有任何反应？

**A**: 排查顺序：

1. 检查 Agent 是否真的加载了本 skill（看它怎么回应"读 SKILL.md"）
2. 检查工作目录是否在项目根（不是子目录）
3. 检查 ContextPocket/ 是否已存在（已存在时 `bootstrap` 是无害 no-op：退 0 并告诉你路径，接着改读 `index.md` + `state.md` 就能继续）
4. 问「现在什么情况」（`context-pocket status`）看是否识别

### Q: log.md 里出现重复内容？

**A**: 通常是 Agent 在 token 紧张时重写而不是 append；也可能是两个克隆各写了一轮同一个 T 号（跨机器并行，见「协作 / 团队」）。先看 `context-pocket verify` 怎么说：

- 报 `Duplicate T-id: T9`（error）→ 是撞号。用 `context-pocket repair --dry-run` 看方案，再 `context-pocket repair` 执行；它把撞号那块及其后的块整体后移，正文一个字不动，还会列出哪些地方仍写着旧号（确认后用 `--apply-refs` 改写；`GPT4` 这类词和 `assets/T04-x.png` 这类文件名不在替换范围内，文件名那条给你现成的 `mv` 命令）。**不要手改 markdown**，那是唯一别的工具查不出来的改法。
- 内容重复但 T 号不撞（同一个 Agent 把一轮写了两遍、块号分别是 T9 和 T10）→ repair 不管这件事，因为"哪一份是该留的"是判断而不是算法：保留信息更全的那一块，另一块用 `context-pocket log amend` 把缺的小节补进去，或直接删掉多余那块再 `verify` 确认序列仍然合法。

无论哪种，之后都问一句「查一下有没有漏」（`context-pocket verify`）确认恢复干净。下次：在 Agent 回复前如果提示"output truncated"或类似信号，主动要求"先 append log.md 再继续"。

### Q: 我想完全重置 ContextPocket/，但保留配置？

**A**:

```bash
# 1. 备份配置
cp ContextPocket/config.md /tmp/cp-config-backup.md

# 2. 跟 Agent 说"重新开始"——它会先跟你确认，再 archive --keep-last N 并重建

# 3. 恢复配置
cp /tmp/cp-config-backup.md ContextPocket/config.md
```

或用 Agent：说"重置 ContextPocket 但保留 config.md"。

### Q: CLI 命令怎么用？需要安装什么？

**A**: 需要 Node.js 14+，无需额外依赖（`package.json` 的 `engines.node` 就是 `>=14`）。

```bash
# 方式一：不装直接用
node path/to/context-pocket/bin/context-pocket.js <command> --dir <project-root>

# 方式二：本地仓库注册成全局命令（README 的"From a clone"）
cd path/to/context-pocket && npm link    # 得到 context-pocket / context-pocket-mcp
```

常用命令：
- `log append` / `log amend <Tn>` — 记一轮 / 补写已写入块里缺的小节。追加时工具会自动做一遍冲突比对，把这一轮**新撞上**的既有条目带 `[auto]` 前缀写进那块的 Conflicts 小节（`--no-conflict-check` 可跳过，跳过也会明说）；多个 Agent 共用一份 pocket 时用 `--author "<谁在记>"` 署名；`--no-index` 让这一次写入跳过索引刷新（连着灌几十轮时用，下一轮 search 会自己重建，命中一条不少——注意这里它的意思是"不刷缓存"，和 `search --no-index` 的"不信缓存"是缓存的两头）
- `absolute add` — 记一条 🔒 绝对保留（`--t-id <n>` 指定它诞生于哪一轮，默认最新一轮）
- `bootstrap` — 一键初始化项目 ContextPocket（已存在则无害 no-op）
- `verify` — 全面体检（`--drift` 再加两项扫目录的：认知漂移、代码比记录新）
- `status` — 一行状态摘要
- `sync` — 找 git 里漏记的轮次
- `recall <T-id>` — 查看某轮详情（归档过的轮次也能查到）。T 号也可以写成选项：`--t-id 3`，历史别名 `--t 3` / `--id 3` 同样认（MCP 侧对应 `tId`）。只写 flag 不给值仍然算没传，那时报 "T-id is required" 是实话
- `diff <Ta> <Tb>` — 对比两轮变化（也可以写 `--t-a <a> --t-b <b>`，与 MCP 的 `tA`/`tB` 同名）
- `search <keyword> [--limit <N>] [--offset <N>] [--no-index]` — 全文搜索
- `why <file-path>` — 反查"这个文件是哪轮动的、为什么"。路径也可以写成选项：`--file-path src/a.js`（对齐 MCP 的 `filePath`），历史别名 `--file` / `-f` 同样认；只写 flag 不给值仍算没传。每条命中带证据等级：`evidence: "changed"` 表示这个路径在那一轮的 Action 小节里（真的改过），`"mentioned"` 表示只在别的小节里被谈到过（待确认、附件、冲突点名）。改过的排在前面，所以 `--limit` 截断时先掉的是"只提到过"的那些
- `check-conflicts` — 6 维冲突扫描
- `req add --text "…"` / `decision add --title "…"` — 记需求 / 记架构决策
- `state update --summary "…" --next-step "…"` — 更新当前状态
- `preferences update --key … --value …` — 更新项目偏好（`prefs update` 是别名）
- `code-map update` — 重新扫描目录、刷新代码地图（`codemap update` 是别名）
- `handoff` — 生成交接摘要
- `archive [--keep-last N] [--dry-run]` — 归档旧轮次（含失败自动回滚；必须有人触发，永不自动发生）
- `index [--rebuild]` — 查看/重建搜索索引
- `distill [--dry-run] [--recent-keep N]` — 从归档与旧轮次里提炼摘要报告
- `import --file <session.jsonl>` — 导入历史会话
- `hub list|pref|remove` — 已注册项目列表 / 全局偏好 / 移除注册（项目在 `bootstrap` 时自动登记，`bootstrap --no-hub` 跳过这一步）
- `migrate` — 格式迁移（含备份 + 回滚）
- `repair [--dry-run] [--apply-refs] [--author "…"]` — 把跨机器并行写出来的撞号 T 编号收回来：撞号那块及其后的块整体后移，派生值跟着对齐，正文旧引用默认只列不改（`--apply-refs` 才改写），改完体检更差整份回滚
- `install-hook` / `uninstall-hook` — 安装/移除 Git pre-commit 钩子

上面这份表由 `context-pocket help --json` 生成（同一张数据源），命令总数与 MCP 工具数都是 27，
`tests/cli.js` 与 `tests/mcp.js` 会同时核对"帮助 ↔ README 表 ↔ MCP 工具名"三处，任何一处漏项测试就红。

每个命令（含 `help` 本身）都接受 `--json`：stdout 只有一行 JSON，出错时 `{"ok":false,"error":"…"}` 且退出码非 0。

### Q: 如何安装 Git pre-commit hook？

**A**: 在项目根执行：

```bash
node path/to/context-pocket/bin/context-pocket.js install-hook --dir <project-root>
```

这会向 `.git/hooks/pre-commit` 追加一段带管理标记的脚本（`lib/hooks.js` 生成，嵌入 CLI 的绝对路径），每次 commit 前跑三步：

1. 从仓库根向上找 `ContextPocket/`。找不到就打印提示并 `exit 0` —— 先装 hook、后 `bootstrap` 是正常顺序，绝不能因此把每一次提交都锁死（那种情况下唯一的出路只有 `--no-verify`）
2. `context-pocket sync --auto` —— git 兜底：把最近几轮漏记的 staged 文件补成 `[auto]` T-block
3. `context-pocket verify --quiet` —— 体检：**只有 error 阻止提交，warning 放行**（所以"archive is due"这类 warning 不会挡住你 commit）

hook 缺失 `node` 或找不到 CLI 时同样打印提示并 `exit 0`（不锁死仓库）。这三条兜底路径和"该拦的要拦住"都由 `tests/hooks.js` 看着：既有对生成脚本的逐行内容断言，也有真 `git init` + 真提交的端到端用例（本机没有 git/sh 时该组自动跳过）。

装过旧版（两步、没有第 0 步）hook 的项目，**再跑一次 `install-hook` 就原地升级**：脚本靠成对的管理标记切分，只替换自己那一段，不会叠加两份，也不会碰你手写的其它检查。如需移除：

```bash
node path/to/context-pocket/bin/context-pocket.js uninstall-hook --dir <project-root>
```

### Q: 数据迁移怎么处理？

**A**: 使用 `context-pocket migrate` 命令。执行逻辑已经实现并有测试覆盖（`tests/migrate.js` 16 例）：先备份整个 `ContextPocket/` 到 `ContextPocket.backup-TIMESTAMP/`，每跳之前体检，任何一跳抛错**或跳完之后体检报 error**（哪怕迁移函数自己一声不吭地把数据写坏了）都整体回滚，回滚成功后删掉那份备份；只有全部走通才留备份给用户对比。迁移前体检就不干净会直接拒绝开始，一个字节都不改。

**登记表里现在有两跳**（`MIGRATIONS`，`lib/migrate.js:35`）：

- `v1 → v1` —— 同版本自检，退 0、什么都不改，存在的意义就是把机制本身跑一遍。
- `v1 → v2` —— **真会改写内容**的一跳（`migrateV1ToV2`）：扫 `log.md` 与 `log-archive.md`，给每个 T-block 按**它自己上方最近的那条 `--- SESSION: <日期> ---`** 补一行 `--- WHEN: <日期> (day) ---`。上方找不到日期的孤块什么都不写（不拿文件 mtime 冒充、不编日期），已经有时间行的块直接跳过，所以重跑第二遍一个字节都不变。版本戳不由这一跳写，由框架在跳完之后统一抬（`setFormatVersion`，`lib/migrate.js:444`）。

v1 项目因此不是"只能等 v2 发布"，而是现在就能升：`--to v2` 与 `--to latest` 走的是同一条路，`--to latest` 会自动把 `v1 → v2 → v3` 串成一条链一次走完（`--to` 接受 `v2` / `2` / `V2` / `latest` / `newest`；`--to v2` 只走半程）。再往后登记一跳时，按 [CONTRIBUTING.md](../CONTRIBUTING.md)「如何新增一个迁移步骤」加一条 `run()` 即可。

```bash
# 查看当前版本 + 登记表里都有哪些跳
context-pocket migrate --dir <project-root> --list

# 预览这一跳会改哪些块（一个字节都不写）
context-pocket migrate --dir <project-root> --to v2 --dry-run

# 真执行：先备份，逐跳体检，失败整体回滚
context-pocket migrate --dir <project-root> --to latest
```

目标版本超出登记表时仍然退 1，并把现存的跳全列出来，例如 `--to v3`：

```
❌ Error: No migration path from v2 to v3. Registered step(s): v1 → v1: ... | v1 → v2: ...
```

不健康的 v1 目录也不受影响：verify 会多一条 `format-upgrade` **WARNING** 告诉你"有升级可用"，但 pocket 本身合法，WARNING 不拦提交；任何写动作（`log append` / `archive` / `import`）都不会偷偷把版本号抬上去。v1 的 pocket 里 `--when` 不会落盘（不能往 v1 里塞 v2 才有的字段），但块照记、`log.md` 永远是 P0，并且 CLI 与 MCP 都会明说一句"pocket 还是 v1 格式：先 context-pocket migrate --to latest 才记时间"（`--json` 里是 `whenSkipped` 字段），不会把你给的时间悄悄吞掉。

升级前仍然建议手工做两件事：先 `context-pocket verify` 确认健康（否则 `migrate` 会拒绝对外写入，只会告诉你"改完再试"），再让 Agent 导出一份完整快照 —— 命令内的备份就在项目目录里，同盘损坏时它救不了你。

### Q: archive 会丢数据吗？

**A**: 不会。真实流程（`lib/writer.js` 的 `archiveLog`）是：

1. 先跑 `verify`，**有 error 就直接拒绝归档**（不把坏状态搬进归档）
2. 按整块切割：把旧的 T-block **原文**追加到 `log-archive.md`，并把它上方的 `--- SESSION: <日期> ---` 分隔线一起带走；`log.md` 里剩下的块若前面没有分隔线，会补一条同日的，否则这些轮次的日期就查不到了
3. 更新 `index.md` 的 T 范围，并静默刷新搜索索引（`afterWrite`）
4. 再跑一次 `verify`，**失败自动回滚** `log.md` / `log-archive.md` / `index.md`

保留数取 `config.md` 的 `recent_keep`（默认 30），`--keep-last <N>` 可临时覆盖；`--dry-run` 先看计划。归档只是"搬家"，不是压缩——`recall` / `diff` / `search` / `why` 都同时读 `log.md` 与 `log-archive.md`，结果里会标 `archived: true`。

***

## 还有问题？

- [GitHub Issues](/issues)

- [GitHub Discussions](/discussions)

- 或直接问 Agent「ContextPocket 常见故障排查」，它会内联回答

最后更新：2026

