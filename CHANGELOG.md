# Changelog

All notable changes to ContextPocket will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

_本节暂无条目。1.2.1 之后的改动写在这里。_

---

## [1.2.1] - 2026-10-10

修复了一些已知问题

---

## [1.2.0] - 2026-10-07

> 本版修的是 1.1.0 发布后复现出的一个数据损坏缺陷（P1，见下面第一小节），另外补了两处静默失败
> （缺必填节的 append、`distill --json` 报错窗口）和三处文档与代码的口径对齐。
> **数据格式仍是 v2**，没有新跳：老 pocket 不需要再 `migrate`，只是历史上被写坏的那几行时间现在会被
> `verify` 照出来（一条 ERROR，附删行后重记的命令）。抬到 1.2.0 而不是 1.1.1，是因为这一版除了修复还**新增了**
> 用户能读到的东西：`--json` 的 `missingSections` 字段、`log append` 的写后告警、MCP 回执里的补齐指引，
> 以及一条过去不存在的 verify ERROR 判据。
> 定版当天日期写在标题里；Git tag 与 npm publish 由维护者按 `CONTRIBUTING.md`「发布流程」第 6-8 步补，
> 那两步没做完之前，不要把这一节当成"已经发出去了"。

### 🐛 P1：`--when` 的整天区间把 `undefined` 写进了记录，而且 verify 一声不响（2026-10-07）

- **缺陷本体**：1.1.0 的 `lib/when.js` 里，区间分支两个端点都取 `.stamp`，而只有日期、没有钟点的端点（`precision:'day'`）根本没有 `stamp` 这个键。于是 `context-pocket log append --when "2026-05-01 → 2026-05-03"` 落盘的是 `--- WHEN: undefined → undefined ---`——一行谁都不认得的结构行，永久留在 `log.md` 里。另一半同样坏：`--when "2026-05-01 09:00 → 2026-05-03"`（左端有钟点、右端只有天）写成 `2026-05-01 09:00 → undefined`。
- **为什么没人发现**：`verify` 当时只看这一行**是不是** WHEN 行（`lib/parser.js` 用 `WHEN_LINE_RE` 匹配后交 `parseWhenLine`），不解析行内的值；`undefined → undefined` 反解出来是"用户原话"，于是 recall 从此显示一句用户从没说过的话，格式检查还给这条记录打通过。
- **写入侧修法**：新增 `pointValue(point)`（`lib/when.js:140`）——有钟点取 `日期 钟点`，只有天就落日期，两边都给不出值才退回 `{kind:'text'}`；区间分支改成 `lib/when.js:85-90` 的 `fromValue && toValue` 判据。**补全，不推算**这条约束没动：右端只给钟点仍然继承左端日期。测过 12 种输入形状，全部逐字节往返稳定，落盘行里 `undefined` 出现 0 次（`tests/unit.js` 的往返语料现在每个形状都断言 `!/undefined/`）。
- **读取侧修法（已躺在历史里的坏行）**：`lib/when.js:184`/`:191` 给 `text` kind 补了一个 `unprefixed` 标记，含义是"这一行没有 `stated: ` 前缀，而写入方从不用那种形状写原话（`formatWhen` 一定要加前缀），所以它只能是手改或 1.1.0 的缺陷"。`lib/validator.js:555` 据此报 **ERROR**，修法给的是可跑的命令（先删那一行，再 `log amend <n> --when "…"`，因为 amend 只肯补空行、从不覆盖已记下的时间）。
  - **为什么判据不是"行里有 undefined 就行"**：ERROR 是闸门——它拦住 `archive`、`migrate` 和 pre-commit hook。用户原话里真的可能出现 "undefined" 这个词（那一行有 `stated: ` 前缀），工具不能拿用户逐字说过的话去挡他的提交，所以缺陷判据锁在"无前缀 + undefined"这一种形状上。`tests/pocket.js` 两个方向都钉着：原话行 0 条告警、`undefined → 2026-05-03 11:30` 1 条 ERROR。
- **Tests**：`tests/unit.js` +1 条（整天区间 / 混合区间 / `上午 → 下午` 的退回原话，外加两条 `'2026-05-01 →'`、`'上周三 → 11:30'` 必须落成 `stated:`），另在既有的手改行用例里钉死 `unprefixed` 的有与无；`tests/pocket.js` +1 条（写坏 → 照出来 → 删掉 → amend 补回 → 干净，含原话不误报）；`tests/cli.js` +1 条（`--when` 走真实 CLI：`--json` 的 `when`、文件内容、recall 输出无 `undefined`、重读 kind 是 `range`）。
- **文档**：`templates/log.md:8` 表头注释、`SKILL-reference.md:240` 的形状表、`docs/MIGRATION.md` 的 `range` 行都补了"端点只到天"这一种；`bin/context-pocket.js` 的 `log append --help` 里 `--when` 同样列出该形状。

### 🧾 四个"文档/代码不一致"与两个静默失败（2026-10-07）

按既有工作规则处理：文档承诺了代码没做的 → 改代码；行为是有意的取舍 → 改文档。

- **`log append` 静默写出缺必填节的块**（改代码）：`--user` / `--action` 都没给时，块照样落盘，而 `verify` 判 ERROR，于是 `archive`、`migrate`、pre-commit 一起被拦，用户却只看到"追加成功"。现在 `lib/writer.js:65` 把必填节名单 `REQUIRED_TBLOCK_SECTIONS` 收在一处（与 `AMENDABLE_SECTIONS` 同源排序，判据在 `lib/validator.js`），`:187` 起记下缺了哪几节，`:221` 随返回值交出 `missingSections`；CLI 在 "✅ T\<n\> added" 同一屏补一条 ⚠️ 并打印该跑的 `log amend` 命令（`bin/context-pocket.js:1116-1118`，`:1157` 进 `--json`），MCP 在工具回执里给同一条信息、连 MCP 形态的入参（`mcp-server.js:1593-1594`）。**没有删掉任何写入能力**：块照写，只是不再假装没事。
- **`distill --json` 报的是旗标不是生效窗口**（改代码）：`--recent-keep` 不给时字段是 `null`，而实际用的是 `config.recent_keep`，机器读到的数对不上报告本体。现在两处返回都带 `recentKeep`（`lib/distill.js:124` 的 `nothing` 早退与 `:180` 的主结果），值就是真正生效的那个窗口。`tests/cli.js` 钉住"config=2 时报告 2、旗标 4 覆盖成 4"。
- **CLI 与 MCP 的写后自检默认值不同**（改文档）：CLI 的 `--verify` 是 opt-in，MCP 的 `verify` 默认开——这不是漏，是 800 轮全量扫描的代价只落在常驻进程一侧。已在 `log append --help` 的 `--verify` 条目写明两侧默认值与原因，MCP 侧参数 schema 的 `default: true` 原先就有。
- **"扫描告警绝不回显完整密钥"说得太满**（改文档）：掩码保证覆盖的是**告警本身**（返回值、人类输出、hook 的 stderr，三处各有断言）；`verify --json` 的 `data` 段里逐字带上下文，所以完整值确实会出现在那里。`CHANGELOG.md` 那句已收窄成带出处的说法，`docs/FAQ.md` 把"报告里只有掩码"换成同一条口径，并写明要机器可读又不想带出完整值时该怎么做。

### 定版与门禁

- **四处版本号抄本一起改准**（`CONTRIBUTING.md`「发布流程」第 1-2 步）：`package.json` 的 `version` 是真值，`lib/version.js` 的 `FALLBACK_VERSION`、`SKILL.md` frontmatter 的 `version:`、本文件的 `## [1.2.0] - 2026-10-07` 节标题是抄本，`tests/unit.js` 那条同值用例盯着。顺带把两处会随版本过期的文档说法改准：`docs/COMPATIBILITY.md:97` 的"对应 skill …"、`docs/FAQ.md` 里 `--version --json` 的示例回包。
- **门禁**：`npm run lint` 35 个 .js；`node tests/run.js` 全量 **239 条通过 / 0 失败**（unit 61 / pocket 61 / hooks 16 / importer 17 / migrate 16 / repair 19 / cli 30 / mcp 19，相对 1.1.0 定版时的 233 条多 6 条）；`npm run smoke` ALL PASS。同一套在发布克隆里也跑了一遍，结果一致。
- **活测**（真实 CLI 子进程，临时目录 + 临时 hub，不碰用户的 `~/.contextpocket`）六项：整天区间落 `--- WHEN: 2026-05-01 → 2026-05-03 ---` 且文件里 `undefined` 出现 0 次；植入 1.1.0 坏行后 `verify` 退 1、`archive --dry-run` 退 1 并说明"verify found 1 error(s)"；改成 `stated:` 原话行后 `verify` 退 0；删行后 `log amend 1 --when` 补回、`recall` 显示 `When: 2026-05-01 → 2026-05-03`；缺 `--action` 的追加当场打 ⚠️ 并给出 `log amend 2 --action`，`--json` 的 `missingSections` 是 `["User","Action"]`；`distill --json` 在 `config.md` 写 `recent_keep: 2` 时报 2、带 `--recent-keep 5` 时报 5。
- 本版**没有新增文件**，`lib/` 下的改动都在既有模块里，所以 `npm pack --dry-run` 的 `files` 白名单那一步无事可做（发布前照跑一遍确认）。

---

## [1.1.0] - 2026-10-07

> 下面就是 1.1.0 的全部改动。此前它一直在 `[Unreleased]` 下累积，而 `package.json` 的 `version` 早已写成
> `1.1.0`、MCP `initialize` 回包报的也是 `1.1.0`——包版本先动了，changelog 没跟上，所以这一节把两者对齐
> （日期取本次定版当天 2026-10-07；真实的 tag / npm publish 由维护者按 `CONTRIBUTING.md`「发布流程」补，
> 那一步没做之前不要把这一节当成"已经发出去了"）。
> 数据格式 **v2**（每轮的时间行）随本版发布：停在 `format: v1` 的老 pocket 仍可读，用 `context-pocket migrate` 升级。
>
> 读这一节的方式：下面每个带日期的小节都是当时的施工记录，里面的 `file:line` 指向**那天那一份文件**，
> 后续小节又改动过同一批文件，所以行号会往后漂（例如 `--no-index` 的三个读取点从 `:876`/`:1098`/`:1166`
> 漂到了 `:909`/`:1131`/`:1199`）。活文档（`CONTRIBUTING.md`、`docs/FAQ.md`、README）里被这些改动移动过的行号已按当前代码重测，
> 全部 123 处 `file:line` 引用也扫过一遍（文件存在、行号在范围内，0 处越界）；定位符号最可靠的办法还是 grep 名字。

### 🏷 版本号：一个来源，而且 CLI 终于能答（2026-10-07）

- **缺陷本体**：`package.json` 写着 `1.1.0`，MCP `initialize` 回包也报 `1.1.0`（版本读取原先是 `mcp-server.js` 顶部一个 IIFE，兜底值 `'1.1.0'` 就硬编码在里面），但 CLI **没有任何版本入口**：`context-pocket --version`、`-v`、`context-pocket version` 三种写法都落进 `main()` 的默认分支（`args.command || 'help'`），输出整页 help、退出 0——实测在 1.1.0 定版前跑就是这样。用户问"我装的是哪版"，拿到 60 行帮助加一个假成功；而版本号要改两处的第二处（那个硬编码兜底）漏改时也不报错，只是两个入口各报一个号。
- **修法**：新文件 `lib/version.js` 导出 `pkgVersion(dir)` → `{ version, source }`（读得到 `package.json` 是 `'package.json'`，读不到才是 `'fallback'`）与 `FALLBACK_VERSION`；MCP 那一处 IIFE 换成 `pkgVersion().version`（`mcp-server.js:64`，回包在 `mcp-server.js:178`），CLI 新增 `cmdVersion()`（`bin/context-pocket.js:396`），`main()` 的分发在 `:2050`。从此两个入口读同一处。
- **判据范围**：版本请求排在 help 分支**之前**——只写 `context-pocket --version` 时 command 是空的，排在后面就永远被 help 吃掉。它是全局 flag，不像 `--help` 那样按命令处理：任何命令后面带 `--version` 都按"就是要问号码"处理，因为仓库里没有任何命令把 `-v` / `--version` 用作别的含义（两个键进 `BOOL_OPTIONS`，`bin/context-pocket.js:100`，顺带让 `-v` 不再吞后面的裸词）。
- **不需要 pocket**：`cmdVersion` 只读包自身的 `package.json`，不调 `ensurePocket`、不碰 `~/.contextpocket`，在空目录里也能答；`--json` 回 `{ok:true,name,version,source,node}`。
- **文档**：`bin` 顶部 Usage 清单加一行（`:32`）、全局 Options 表加 `--version`（`:345`）；`README.md` / `README.zh-CN.md` 的全局选项脚注、`docs/FAQ.md` 各补一条；`CONTRIBUTING.md`「发布流程」按真实改动顺序重写（版本号只改 `package.json` + `FALLBACK_VERSION`，再切 changelog 一节，`npm pack --dry-run` 核对 `files` 白名单），并写明 README 现在**没有**版本徽章，只有 License / format / PRs 三枚（`README.md:5-7`），别把 `format-v1` 那枚当包版本；`docs/MIGRATION.md:13` 那张"两套版本号"表里 Skill 版本那一行原先写"位置：`package.json` / `SKILL.md` / `CHANGELOG.md`"（三个地方都是来源，等于承认没有来源），改成"真值只有 package.json，其余三处是静态抄本，同值由用例比对"。
- **Tests**：`tests/unit.js` +2（`pkgVersion()` 读得到 package.json、拿不到时是 `fallback` 而不是崩；另一条把版本号的四份抄本逐个对齐——`SKILL.md` frontmatter 的 `version:`、`FALLBACK_VERSION`、CHANGELOG 的 `## [<版本>] -` 节标题都必须等于 package.json）、`tests/cli.js` +1（三种写法逐字节同解且不含 `Usage:`、`--json` 字段、空目录跑完仍是空的、`log append … --version` 一个字都不写、`help` 里教得到）、`tests/mcp.js` +1（`serverInfo.version` == package.json == CLI `--version --json`）。全量 233 条：unit 60 / pocket 60 / hooks 16 / importer 17 / migrate 16 / repair 19 / cli 27 / mcp 18；`npm run lint` 35 个 .js（新增 `lib/version.js`），`npm run smoke` 通过。
- **顺手清掉两处还活着的旧口径**：`bin/context-pocket.js:904` 与 `mcp-server.js:1343` 的搜索注释仍写着"索引不可用时回退全量扫描"，与 2026-10-06 那一节实测并改过的行为相反（缺/坏/版本对不上都是当场重建后仍走索引）——注释也一起改准；本文件搜索特性那一条（"索引损坏 / 缺失自动回退到全量扫描"）同步改成实测的说法。
- **`README.md:258` 那句 "Every command accepts `--json`" 这一次是真跑过审计了**：28 个入口（27 命令 + `help`）逐个带 `--json` 在一次性临时项目里跑一遍，判据是"stdout 恰好一行、`JSON.parse` 得过、且有布尔 `ok` 字段"，结果 **0 例不合格**。退出码里 `recall` / `diff` 是 1，原因是审计把这两条排在了第一条 append 之前、当时目录里还没有轮次，与 JSON 口径无关（同一个判据由 `tests/cli.js` 的多条用例长期盯着）。

### 🔍 记录与磁盘对不上、以及 bootstrap 那个写到家目录的副作用（2026-10-06）

> 上一轮把 `repair` 做完之后重读了一遍代码，找到的不是"还差什么功能"，而是四处**文档已经承诺、代码没有兑现**的缺陷。这一轮只做这四处的修复，不加功能、不删功能：`T<n>` 引用的词边界与附件文件名（并入上面 10-05 那一节的 `repair` 说明，因为改的是同一处判据）、`verify` 的附件存在性检查、`bootstrap --no-hub`。

#### Added

**`verify` 第 15 项：附件存在性（`checkAttachmentExistence`，`lib/validator.js:1042`；注册在 `lib/validator.js:77`，默认就开，不必加 `--drift`）**

- **这条检查是上一轮的补丁欠下来的**：`repair` 从此不改附件文件名，断链就只能靠体检报出来——而在那之前 `verify` 会对着一条指向不存在文件的 `### Attachments` 说 `All checks passed`。声明和磁盘对不上，是 pocket 里最贵的一种错：`recall` 会把这条念给用户听，用户去点，点不开。
- **`log.md` 与 `log-archive.md` 分开 parse**（`lib/validator.js:1042` 里的 `sources`）：`parseLogAll` 按 id 合并、live 优先，归档里的附件块会被同名的 live 块遮掉，合并着扫就扫不到归档那半。
- **一条声明里到底哪一段是路径**——这是本轮唯一反复改的地方。第一版拿整行去匹配文件名，结果 `- T1 项目结构图: assets/T01-diagram.png` 这种规范写法（`SKILL-reference.md` 的 Attachments 模板）里，标签 `项目结构图.png` 也被当成路径报错了。现在的取法收窄成四种：markdown 链接目标 `!?[...](<target>)`、含 `/` 的裸 token、冒号（`:` / `：`）之后的值、整行就是一个路径。其余一律不取。
- **宁可不报，也不误报**：`isCheckableAttachmentRef`（`lib/validator.js:1001`）把这几类筛掉——模板占位 `<...>`、URL（`http`/`mailto`/`data`/`ftp`、`//` 开头、带 `#` 片段）、绝对路径与 `~`/`C:\`、含 `..` 的、以及第一段看着像主机名的（`githubusercontent/...`）。剩下必须有 `.<2~8 位字母>` 扩展名才算一个文件。已经按 `SKILL-advanced.md:83` 标成 `[missing: T<n> <file>]`（或"缺失/已丢失/已删除"，`ATTACH_MISSING_RE` `lib/validator.js:995`）的那条也跳过：那是**已经如实记录了的事实**，再报一次就是催用户撒谎。
- **解析口径与 `repair` 同源**：候选路径是 `pocketDir/<ref>`、`projectRoot/<ref>`，只有当 ref 本身不以 `assets/` 或 `ContextPocket/` 开头时才再补 `assets/<ref>`、`assets/archive/<ref>`——否则错误信息里会出现 `ContextPocket/assets/assets/T01-diagram.png` 这种没找过的路径。`tried` 走 Set 去重。
- **输出**：0 缺且查过至少一条 → INFO `All N declared attachment path(s) found on disk`；有缺 → 最多 12 条逐块 ERROR（`T<n> (file) declares <ref>, which is not on disk`），每条 `fix` 给出两条出路（把文件放回这里 / 按 `[missing: T<n> <ref>]` 标注缺失）+ 可直接复制的重跑命令 `context-pocket verify --dir "<projectRoot>"`，再加一条汇总 ERROR 指向 `verify --json`。
- **它不会把 `repair` 的回滚判据搅了**：附件文件名不进改写（见 10-05 一节），所以 repair 前后 errorCount 完全一致，"修完体检更差就整份回滚"那条判据不受新检查影响。
- **MCP 与 CLI 口径同步**：`context_pocket_verify` 描述从 13 项改成 15 项并写明跳过规则（`mcp-server.js:247`），CLI `verify --help` 同步（`bin/context-pocket.js`）。顺带修掉一个自己造的事故：往 `--help` 的模板字符串里写 markdown 反引号会把字符串截断，`node --check` 在 `bin/context-pocket.js:1967` 报 "missing ) after argument list"，表现为 6 个套件 24 条用例一起红。
- **冒烟脚本自己就是这条检查抓到的第一个对象**（`mcp-smoke.js:202` 起）：它一直在 append `attachments: 'T1-diagram.png'`——一个从来没有落盘的文件名。而 `check('verify after smoke writes', ...)` 断的是"工具没返回 error"，于是它把 `❌ 1 error found` 原样念出来照样 PASS。现在冒烟先把 `ContextPocket/assets/T01-smoke-diagram.png` 真的写出来，再按模板的 `<label>: <path>` 形式声明它，断言也改成必须看到 `All checks passed`。这条改动的价值不在那条附件，在于**冒烟的收尾判据从"进程还活着"变成"结论是干净的"**。

**`bootstrap --no-hub` / MCP `noHub: true`（`bin/context-pocket.js:372`、`:471`，help 见 `:1976`；`mcp-server.js:1016`、`:1087`，schema 见 `:228`）**

- `bootstrap` 是这条链路上唯一会写到用户家目录的命令：`registerProject`（`lib/userhub.js:126`）按 `path.resolve(root)` 往 `$CONTEXTPOCKET_HOME/hub.json` 加一行。临时目录、脚本试跑、CI 里跑一遍都不该在"我用过哪些项目"的清单里留一条，所以把这个副作用做成可关的开关。`--no-hub` 进 `BOOL_OPTIONS`（`bin/context-pocket.js:99`），保证它不会吞掉后面的裸词。
- **默认行为一字未改**：仍然注册。`hub list` 和 MCP 侧的项目解析都依赖这一行，把默认翻过来是行为变更而不是缺陷修复，不在这一轮范围。
- **两个分支都要顾**：`ContextPocket/` 已存在的幂等分支（`:380`）和新建分支（`:410`）各自有 `if (!noHub)`；`--no-hub --json` 输出 `hub: null` + `hubSkipped: true`，人类输出 `Hub: skipped (--no-hub) — nothing was written to <hubFile>`，并紧跟一句"去掉这个开关重跑一次就能补登记"（bootstrap 幂等，不会动已有记录）。中途在文案里写过 `context-pocket hub add` —— 那个命令不存在（hub 只有 `list|pref|remove`），已换成真的做法。
- 幂等分支里 `--no-hub` **不会注销**已有条目，只是这次不写：去掉开关重跑仍然只是更新登记信息。
- **幂等分支补上一句 hub 的结论**（`bin/context-pocket.js:396`/`:398`，MCP `mcp-server.js:1039`/`:1040`）：文档写的是"去掉 `--no-hub` 再跑一次就补登记"，而已有 `ContextPocket/` 那条分支原本一个字都不提 hub——用户照着文档重跑，屏幕上没有任何证据说明登记成功了。现在这条分支与新建分支同口径打印 `Hub: registered in <file>` / `Hub: skipped (--no-hub) — nothing was written to <file>`；注册失败（hub 不可用）时保持静默，与新建分支同一处理。

#### 🔢 同日补：同一个 T 号只许有一个名字

> 这一条是做性能实测时顺手撞出来的：逐条敲 CLI，`context-pocket recall --t 1` 退 1 并报 `❌ Error: T-id is required`——号明明传了。

- **缺陷本体是"一个概念三个名字"**：`recall` 只认 `--id`（`bin/context-pocket.js:704`）、`log amend` 只认 `--t`（`:1137`）、`absolute add` 只认 `--t-id`（`:1201`）。三个键都在 `VALUE_OPTIONS`（`:87-96`）里，所以猜错的那一种会被 `parseArgs` **正常解析**、再被对应命令静默丢掉，报错于是谎称"你没传"。MCP 侧一直是统一的 `tId`（`mcp-server.js:1211` / `:1606` / `:1665`），漂的只有 CLI 这一边。
- **修法**：`tIdOption()`（`bin/context-pocket.js:264`）成为唯一的取号入口——长写法 `--t-id` 就是 MCP `tId` 的 kebab-case，历史别名 `--t` / `--id` 继续可用；`diff` 走 `tIdPairOption()`（`:269`）认 `--t-a` / `--t-b`（对齐 MCP 的 `tA` / `tB`），这两个键同时补进 `VALUE_OPTIONS`——不补的话未知选项会吃掉后面的裸词，`diff --t-a 1 --json` 那种写法会当场把 `--json` 当成 t-a 的值。
- **边界仍然说实话**：只写 flag 不给值就是没传（`missingValue` 判完返回 undefined），`recall --t` 照旧报 `T-id is required`；`recall --t-id abc` 照旧报 `Invalid T-id: abc`——别名只扩接受面，不放宽校验。
- **报错文案现在教写法**：三条 required 消息都补了 `(or --t-id <n>)` / `(also accepted: --t <n>, --id <n>)`，四条 `--help`（recall / diff / log amend / absolute add）各写明自己的写法。
- **测试**：`tests/cli.js` +1 条（当时全量 220，同日又补了 3 条，见下一节）。断的是等价而不是"能跑"：`recall` 四种写法 stdout 逐字节相同；`diff 1 2` == `diff --t-a 1 --t-b 2`；`log amend --id 3 --pitfalls …` 真把内容写进 T3；`absolute add --t 1 --json` 的 `absolute.tId === 1`（默认会是 latest T=3）且 `absolute.md` 里出现 `## 🔒 T1 ·`；再加两个负例（只写 flag、值为 `abc`）和四条 `--help` 文案断言，防止以后代码修了、帮助没修。
- **写进约定的那一条**：`CONTRIBUTING.md`「命令设计原则」新增"选项名 = MCP 参数名的 kebab-case，一个概念只有一个名字；要加新入参就加新名字，别再给同一个概念加第二个名字"。这次不是修一处写法，是把产生这种漂移的规则堵住。

#### 🧾 同日再补：文件路径同解，以及"裸 flag 不许写下 true"

反向审计（MCP 参数名 → CLI 选项名）又抓到同一族的两个问题，一起收掉。

- **`why` 的文件路径**：MCP 叫 `filePath`（`mcp-server.js:337`），CLI 历史上只认 `--file` / `-f`，写成 `--file-path` 会被解析后丢掉，然后谎报 "file path is required"。现在 `filePathOption()`（`bin/context-pocket.js:275`）三写法同解，`why` 与 `import` 共用；`'file-path'`、`'pitfall'`、`'pitfalls'` 补进 `VALUE_OPTIONS`（文档里早就是正式选项，之前不在已知集合里，`--pitfalls --json` 这种写法会静默丢值）。`import` 的缺值改在 CLI 层报错（`cmdImport`），错误文案教全三种写法，`lib/importer.js:222` 那句库内错误保持原样（它面向 API 调用方）。
- **一次覆盖 22 命令 × 全部带值选项的落盘审计**（脚本只看 markdown 前后差集，不读代码，v1 版因为没给必填项赋值、命令提前退出而漏掉一批，v2 修正）：**11 处会把字面量 `true` 写进记录**——`absolute add --gist` → 块头 `## 🔒 T1 · true`；`req add --status` → 凭空一个 `## true` 分组标题；`decision add` 的 `--context/--options/--decision/--consequences/--supersedes` → `- Context: true` 这类；`state update` 的 `--summary/--next-step/--pitfall/--pitfalls` → `- true`，而且 `--summary` 是整节替换，占位符正文一起没了。`--json` 全都回 `{"ok":true}`。
- **修法是把判据收成一份**：`lib/fields.js` 新增 `textOption(obj, ...keys)`（只收字符串/数字，`true`/`false`/`''`/纯空白/数组一律 `undefined`），CLI 的 `missingValue()` 改成 `textOption(...) === undefined` 的薄壳，`firstStringOption` 删掉、别名直接走 `textOption`；MCP 侧 `toolLogAppend` / `toolAbsoluteAdd` / `toolReqAdd` / `toolDecisionAdd` / `toolStateUpdate` / `toolPreferencesUpdate` / `toolHub(pref)` 同一判据（MCP 的 schema 写的就是 `type: 'string'`，`{ gist: true }` 这种入参本来就该拒）。`turnFields()` 里的 `gist` 也归一了——它是块头，两个入口共用同一份形状定义。`toolReqAdd` 的 `tags`/`impl` 由 `args.tags || []` 改走 `toList()`，数组语义不变但 `true` 不再变成 `['true']`。`hub pref --key k --value`（给了 flag 没给值）明确报错而不是悄悄降级成"读取"。`pickFirst` 在两个入口都不再用于带值选项，import 一并清掉。
- **测试**：`tests/cli.js` +2（文件路径四种写法逐字节同解 + `import` 三种写法同解、`--file-path` 空值仍报 required 且 `log.md` 一字节不动；11 例裸 flag 逐个断"新增行里不许出现 true"，并留一条正向对照——gist 真值为文本 `"true 的字符串值"` 时照旧落盘，判据不误伤）、`tests/unit.js` +1（`textOption` 的八种入参形状 + `turnFields`）。重跑审计：落盘 true 计数 **11 → 0**。
- **写进约定的那一条**：`CONTRIBUTING.md`「命令设计原则」新增"只写 flag 不给值 = 没传，判据只有 `textOption` 一份；用 `pickFirst` 或 `obj.x !== undefined` 读带值选项等于把这个漏洞重开一遍"。
- **同族第三条（再往反方向审计 CLI → MCP 抓出来的）**：
  - `absolute add --t abc` 过去不报错：`intOption('abc')` → undefined → 那条 🔒 悄悄盖到**最新一轮**上，用户指名的号被换掉了。现在走 `toTId()`（与 `recall` 同一判据），非法值报 `Invalid T-id: abc` 并退出 1，`T2` 这种带前缀的写法一并认。
  - MCP `verify` 的回看窗口从前叫 `lastN`，而 `lastN` 在 `context_pocket_sync` 里指的是另一件事——同一个名字在两个工具里是两个窗口。现在 `driftLastN` 与 CLI `--drift-last-n` 同名，旧名 `lastN` 继续认并在 schema 里标了 deprecated；用例两个名字都跑，并断 schema 里两个都在。
  - `migrate --list-only` 是 `--list` 的**未文档化**别名（`bin/context-pocket.js:1588` 一直在认，帮助里没写）。补进 `migrate --help`；README/FAQ 仍只推 `--list` 一种写法——别名只保证不砸已有调用方，不该再向外推销。
  - `VALUE_OPTIONS` 里的 `'from'` 是死键：全仓（代码 / 帮助 / 文档 / 测试）没有任何一处读 `options.from`，`migrate` 的起点版本本来就从 pocket 自己的格式戳算（`result.fromVersion`）。删它不改变任何解析结果（未知选项照样吃后面的裸词），留着只会让人以为 `migrate --from v1` 有用。

#### 🗂 同日再补：`--no-index` 的两端，以及三处写错的"回退全量扫描"

留到最后的那条（"search 索引的默认行为"）这轮做实了，结论跟文档写的相反。

- **写入侧也有 `--no-index`，可只有 `search --help` 教过它**：`log append`（`bin/context-pocket.js:1098`）和 `log amend`（`:1166`）一直在读这个布尔，用它跳过写后的索引刷新（`afterWrite` 的 `opts.index`，`lib/lifecycle.js:38`），而 `--help` / README / FAQ 里它只作为搜索开关出现。后果有两层：想省掉每轮刷新的人找不到入口（测试骨架自己天天在用，见 `tests/cli.js` 里的 append 循环）；读过 `search` 说明的人又会把它理解反——在写入侧它说的是缓存的另一头。
- **先实测它到底安不安全**：`bootstrap` 一个临时项目（`CONTEXTPOCKET_HOME` 指到临时目录），`log append --no-index` 那一轮之后 `ContextPocket/assets/` 是空的（缓存确实没建），紧接一次 `search` 给出 `"viaIndex":true`、命中那条 gist，`search-index.json` 同时回到磁盘上；`log amend --no-index` 同一条路。所以**跳过刷新的代价只有"下一次搜索自己付一次重建"**，记录本身与可搜性都不受影响。`import` 不需要这个开关，也确实没有：`lib/importer.js:283` 是全部写完才 `afterWrite`，本来就只刷一次。
- **顺带撞出三处写错的口径**：`SKILL.md:33`、`docs/FAQ.md:93`、`lib/indexer.js:21` 的头注释都写着"索引缺失 / 损坏 → 回退全量扫描"。实测三种情况——文件删掉、内容写成坏 JSON、把 `INDEX_VERSION` 改成对不上的值——`search --json` 的 `viaIndex` **全是 `true`**：`ensureFreshIndex`（`lib/indexer.js:464`）走的是"当场增量重建、然后仍然用索引"，只有重建本身失败才 `return null` 让调用方回退扫描。这一条也实测了：拿一个目录把 `assets/search-index.json` 那个位置占住，才第一次看到 `viaIndex:false`，而命中数和顺序与索引路径逐条相同。行为是有意的（`ensureFreshIndex` 自己的注释就是这么写的），所以修的是三处口径 + `search --help` 那句 "falls back to a full scan otherwise"，并在测试里把四种情况一次跑完钉住——以后谁再动这条路径，测试会说是代码漂了还是文档漂了。
- **测试**：`tests/cli.js` +2（一条钉"三个帮助都教 `--no-index`"，外加 append / amend 两侧各一轮"跳过刷新 → 缓存不在 → search 自愈并命中，且索引路径与扫描路径同结果"；一条钉"缺失 / 坏 JSON / 版本过时三种都 `viaIndex:true`，只有重建失败才 `false`，且回退那一趟结果与索引路径完全一致"）。
- **写进约定的那一条**：`CONTRIBUTING.md`「命令设计原则」新增"代码读了的开关，每个读它的命令都要在自己的 `--help` 里教；同名不同读法必须显式写清——能自愈的行为差异要写进文档，不能靠用户读源码"。

#### 📡 同日再补：18 个从没在 MCP 线上跑过的工具

回答"这个工具够好用了吗"时实测出来的缺口，本轮补上。

- **缺口本身**：`tests/mcp.js` 真发过 `tools/call` 的只有 9 个工具（`log_append` / `log_amend` / `recall` / `search` / `sync` / `verify` / `migrate` / `repair` / `bootstrap`），其余 **18 个只被"名字对不对得上 CLI 命令"那条 parity 断言核对过**。名字对上不等于参数对上——schema 与 handler 各写一遍参数名的漂法，只有真发一次调用才会露出来，而这正是本轮 T 号 / 文件路径漂移那一族。MCP 是 Agent 的主入口，所以这条缺口的权重比看起来大。
- **先把参数面从线上抓下来**：临时脚本发 `initialize` + `tools/list`，打印 27 个工具的 `req/opt/all`（`Temp/cp-tools.js`），用例照这份线上形状写，而不是照我读代码的记忆写——记忆错过一次：我以为 `context_pocket_import` 的参数该叫 `filePath`，线上它叫 `file`，`filePath` 是 `context_pocket_why` 的。这两个不是同一个概念的漂法（一个收会话文件、一个收被反查的源码路径），所以**没有动代码**，只在用例里把各自的名字钉住；真要统一改名是另一件事，得单独决断。
- **+3 条用例覆盖全部 18 个**（`tests/mcp.js` 14 → 17），新增局部 helper `mcpBatch(projectDir, calls)`：一个服务进程里按 id 连发多个 `tools/call`、等齐回包，比每个工具重开一个进程便宜得多。
  - `every writing tool lands its arguments in the markdown`：`state_update` / `preferences_update` / `decision_add` / `req_add` / `absolute_add` / `hub(pref)`。断的是**盘上的文件**而不是回话文本——`state.md` 三条都在；`preferences.md` 键值都在；`decisions.md` 五个小节逐条；`requirements.md` 里 `## 进行中` 这个分组标题（`status` 是标题不是字段，两边必须同一个形状）；`absolute.md` 出现 `## 🔒 T1 ·`（显式给 `tId: 1`，不给就盖到 latest T 上——同族那一课）；`CONTEXTPOCKET_HOME/hub.json` 里真的多出一条偏好。
  - `maintenance tools do over the wire what they claim — and dry runs touch nothing`：`index{rebuild}` 之后缓存文件必须在；`import{dryRun}` 前后 `log.md` 的轮次数不变、会话正文没混进来；`distill{dryRun}` 不落 `digest-*.md`；`archive{keepLast:1}` 真把 T1、T2 搬进 `log-archive.md`、`log.md` 只剩一轮。**顺序是有意的**：三个 dry-run 的"什么都没改"必须赶在 archive 之前验完，否则看到的已经是归档后的文件，分不清是谁动的——第一次就犯了这个错，断言把归档造成的"只剩一轮"当成了 import 写盘。
  - `reading tools and the hook pair answer over the wire with real content`：`status` / `diff{tA,tB}` / `why{filePath}` / `check_conflicts` / `handoff` / `code_map_update`（断 `code-map.md` 里真出现 `app.js`，也就是确实重扫了目录），再加钩子这一对：另开临时项目 `git init` → `bootstrap{noHub}` → `install_hook` → 断 `.git/hooks/pre-commit` 里有托管标记（`lib/hooks.js:28` 的 `MARKER`）→ `uninstall_hook` → 断标记真被摘掉。这里踩到的边界是 `install-hook` 在没有 `.git` 的项目里退 1 并报 `No .git directory found`（实测），所以它不能借读侧那个非 git 项目跑。
- **过程里我自己错了一次，记在这里**：中途把"归档之后索引取不到号"当成缺陷推进了一轮，依据是一段我并没有真读到的脚本输出（结果被工具拦截，我却按预期当成了事实）。回头查源码 `lib/indexer.js:160` 是 `const key = 'T' + block.id;`——用的就是标题里那个号，我描述的那个"按序号推 id"的函数根本不存在。随后用真归档场景实测（灌 6 轮、归档 4 轮）：索引路径与扫描路径给出**完全相同的序列** `T5,T6,T1,T2,T3,T4`，`total` 都是 6，每条都带 `archived: true`。结论撤回。记下来是因为它和本轮其余改动讲的是同一件事：**断言必须来自真跑过的命令，不能来自我以为的输出**。
- **顺带把上一条 🗂 留下的口径缺口补上**（`--no-index` 到底省多少）：本机实测 30 轮的项目里 `log append` 端到端 **162 ms**、加 `--no-index` 是 **147 ms**（差约 15 ms/轮），而空转一次 CLI 调用就要 **112 ms**——所以划算的场景是常驻 MCP 与长循环，不是一次一条的 CLI。FAQ / 两个 README / `log append --help` 四处都写明了数字与适用面，免得被读成"每轮能省 0.18 秒"（那是 800 轮规模的数字）。

#### Changed

- `lib/validator.js` 顶部 import 补 `parseLogText`（附件检查要把 `log.md` / `log-archive.md` 分别 parse）；`attachmentRefs` / `isCheckableAttachmentRef` / `checkAttachmentExistence` 导出给单元测试（判据本身可测，不必造整个 pocket）。
- 文档口径：`README.md` / `README.zh-CN.md`（CLI 表 `bootstrap` 行加 `--no-hub`，Hub 小节新增"不想进注册表"一条，两张表脚注各加一条"T 号两边同名"）、`docs/FAQ.md`（命令清单三处：`recall` 的写法与"只写 flag 仍算没传"、`diff --t-a/--t-b`、`absolute add --t-id`；外加 bootstrap 说明）、`SKILL-reference.md`（Attachments 两条规则写在模板代码块外面 + 资产文件名永不改写）、`SKILL-advanced.md:83`（`[missing: …]` 与 verify 第 15 项的关系）、`CONTRIBUTING.md`（「命令设计原则」的命名一条）。

#### Tests

- 全量 229 条（**当时**的数字；1.1.0 收尾后是 233 条，见本节顶部 2026-10-07 那一节）：`node tests/run.js` = unit 58 / pocket 60 / hooks 16 / importer 17 / migrate 16 / repair 19 / cli 26 / mcp 17，`npm run lint` 34 个 .js，`npm run smoke` 通过。
- **unit +4**：词边界（`GPT4` / `RTX4090` / `UTF8` / `HTTP2` 不算引用，句末 `见 T9.` 仍算）；文件名 token 带 `mv` 命令列出且 `--apply-refs` 也不改；`attachmentRefs` 只取记录里那条路径——用例里用 `String.raw` 写 `ContextPocket\assets\T07-map.png`，因为反斜杠走 shell heredoc 会被吃掉；`isCheckableAttachmentRef` 把主机名形、绝对、含 `..` 的形状挡在外面。
- **pocket +1**：`verify` 只报那一条缺失附件。用例顺序是有意的——刚 bootstrap 的模板 0 error（占位符不能被误报）→ 造一条指向不存在文件的声明，恰好 1 个 error 且 `fix` 里同时含 `[missing: T1 assets/T01-diagram.png]`、`context-pocket verify`、真实路径 → 把文件补上则 0 error + INFO → 标了 `[missing:]` 则跳过 → 归档文件里那条也扫得到 → markdown 图片 + CDN URL 只报 2 条且不出现 `cdn|example` → `ContextPocket/assets/...` 这种项目根写法能解析成功。
- **repair +1 / cli +1 / mcp +1**：`GPT4` 与附件名在同一条用例里对照（`--apply-refs` 全开也不动）；`bootstrap --no-hub` 前后 `hub.json` 的 key 集合对照，并验默认分支仍登记，外加幂等分支的人类输出两行（`Hub: skipped (--no-hub)` / `Hub: registered in`——只在 `--json` 里能看见等于用户在照着文档操作时看不见）；MCP 侧同规则走 `tools/call`，并对同一个目录再调一次 `context_pocket_bootstrap` 验幂等分支的 `- **Hub:**` 那行。这里踩到一个坑：`mcpCall(projectDir, name, args, waitCount)` 的 `waitCount` 缺省时 `waitFor` 永不 resolve，新用例挂了两次才定位——所有调用都必须显式传等待条数。
- **`mcp-smoke.js` 的收尾断言换掉了**：由"工具没返回 error"改成必须看到 `All checks passed`，并让它声明的附件真的落盘（`mcp-smoke.js:202` 起）。旧断言连着很多次冒烟都在把 `❌ 1 error found` 念出来后判 PASS。


### 🤝 多 Agent 并发：`repair` 收号、`--author` 分来源、写时冲突闸（2026-10-05）

> 先说清边界，因为整个设计都是从这条边界长出来的：写入锁**只在一台机器里有效**。`withPocketLock`（`lib/io.js:348`）把锁文件放在 `os.tmpdir()`，名字是 pocket 路径的哈希，所以同一台机器上多个 Agent 同时写会排队，跨机器的两个克隆彼此看不见对方的锁。而下一号是 `logData.latestT + 1`（`lib/writer.js:126`）——**从自己那份算**。于是两边各写出一个 `T9`，合并后 `log.md` 里就有两个 `## T9`。
>
> 这件事此前是"检测得到、动不了手"的死路：`checkTIdContinuity`（`lib/validator.js:161`）把 `Duplicate T-id: T9` 报成 error，附带的修法只有一句 `'Rename or merge duplicate blocks.'`。对手改 markdown 是 skill 明令禁止的，`git commit --no-verify` 是绕过检查，而 append-only 的历史越写越乱。这一轮把那一句人话变成三个能跑的入口。

#### Added

**`context-pocket repair`（`lib/repair.js:236` 的 `repairLogIds`；CLI `bin/context-pocket.js:1316` 的 `cmdRepair`；MCP `mcp-server.js:1847` 的 `toolRepair`）—— 把撞号收回合法序列，且每一步都可回滚**

- **重排规则是级联，不是只改撞的那一块**：`planIdRenumber`（`lib/repair.js:94`）取 `target = Math.max(id, prev+1)`，撞号那块**及其后的每一块**整体后移。理由是 `log.md` 是只追加的历史，编号必须继续随文件顺序递增；只改前面那块会把它推到后面的块之前。
- **改块头靠行号，不靠"旧号"字符串**（`lib/repair.js:286`）：`planIdRenumber` 记下每一块在哪一行，重写时只换那一行的数字。曾经写过的 `new RegExp('^(##\\s+T)' + from)` 认不出手写补零的 `## T02 ·`（parser 把 `T02` 读成 2，用 `"T2"` 去匹配就找不到行），repair 会安静地什么都没改还退 0 —— 现在这条路径有用例盯着（补零块重排、畸形号 `T99999999999999` 原样不动：畸形号 `toPlausibleId` 判 null，本来就不参与编号）。
- **块头是定义，不是引用**：`## T2 ·` 声明的是"这一块的号是 2"。级联出来的映射表里 key 和 value 是重叠的（`3→4`、`4→5`），如果不跳过块头行，保留原号的那一块会被自己的映射改走（`lib/repair.js:290` 有注释）。正文引用则**一次替换到位**（`remapTRefs`，`lib/repair.js:137`），不做链式二次替换。
- **旧编号引用：默认只列不改，改与不改要显式加 `--apply-refs`**。这是设计决定而不是省事：一句写着 `T9` 的话在撞号历史里同时指过两块，只有读的人知道每一处指的是哪一块。清单里每条带 `{file, line, from, to, text, rewritten}`，扫描范围是 `REFERENCE_FILES`（`lib/repair.js:43`）：`log.md` 正文 + `requirements.md` / `decisions.md` / `absolute.md` / `state.md` / `handoff.md` / `code-map.md` / `preferences.md` / `log-archive.md`。MCP 侧同名参数 `applyRefs`，人类输出里引用超过 20 条截断并注明。
- **「引用」必须是独立的 `T<数字>`：两处误伤都是复现出来的真缺陷**（`T_REF_RE`，`lib/repair.js:119`）。第一版判据是裸的 `/T(\d+)/g`，`--apply-refs` 在一次 800 轮的 pocket 上把 `GPT4` 写成了 `GPT5`（`RTX4090`、`UTF8`、`HTTP2` 同理——它们只是碰巧含了这个形状，不是编号）。现在两边都判边界：前面不能接字母/数字/下划线或 `/`、`\`，后面不能紧跟字母/数字/下划线/`-`，且"点 + 2~4 个字母"按扩展名排除（句末的 `结论见 T3.` 仍然算引用）。
- **附件文件名是第三类，永不改写，连 `--apply-refs` 也不**（`findFileTokens`，`lib/repair.js:176`；`padId` `:122`）。`T04-diagram.png`、`assets/T04-x.png` 这类 token 从前会被引用替换改成 `assets/T4-diagram.png`：文件还在原地，链接断了，零填充也丢了（`SKILL-reference.md`「Asset filenames: T01, T02 … zero-padded」），而 `verify` 那时只会说 `All checks passed`。改名是两半——先 `mv` 文件，再改文本——工具不做第一半就不做第二半，改为在 `fileNames` 里给出完整命令（`{file, line, from, to, name, renamed, command, readOnly}`），CLI 打印 `📎 Attachment file names…`、MCP 同步、记录块的 `### Uncertain` 里也留一份，执行完让用户跑 `context-pocket verify` 确认链接没断。归档来的名字带 `readOnly: true`，与 `log-archive.md` 只读那条一致。
- **派生值自己跟上**：`state.md` / `requirements.md` / `decisions.md` / `preferences.md` / `code-map.md` / `handoff.md` 头行的 `· T<n>` 走 `remapDerivedHeader`（`lib/repair.js:203`，三个分支：映射命中 / 已是最新号 / 数字对不上就不动），`index.md` 整份重算（`updateIndexHeader`）而不是映射——它的每个 T 号都是算出来的。
- **`log-archive.md` 只报不改**：归档文件自己写着 "Read-only reference. Do not modify."。重排后的新号如果与归档里的号同名，`recall`/`search` 会显示 live 那份、把归档那份遮住（`parseLogAll` live 优先），repair 把这件事打印成 `⚠️ T<n> 与 log-archive.md 里的编号同名`（`stillShadowed`）而不是替归档改号。
- **改动本身写成一个 `[auto]` T-block**（`appendRepairRecord`，`lib/repair.js:471`）：`### User` 直说"这不是用户的一轮，是工具改过编号这个事实"，`### Action` 列映射表（超过 12 条折叠成 `… (+n)`）与"有没有动引用"，未改写的引用按文件计数进 `### Uncertain`（同一节还会列出待执行的 `mv` 命令，最多 6 条，见下），`--author` 署名是谁跑的这次 repair。这一块的 `conflictCheck` 显式关掉——工具自己的一次改号动作不是一轮工作，不该拿来和用户记录比冲突。
- **回滚是全量的**：落盘前把每个 touched 文件的内存原文存进 `backups`，`index.md` 虽然不在 touched 里也必须一起存（`lib/repair.js:379`：否则编号回到旧值、索引头却写着新值，repair 自己就成了把 pocket 改坏的那个东西）。判据有两条——重跑 `verify` 的 errorCount 比修之前更多，**或者**块头仍有重复（`hasDuplicateHeading`）——任一命中就整份 restore；写入过程抛错同样 restore，且回滚本身再失败会把两个错误一起抛出。
- **`--dry-run` 一个字节都不写**，返回 `changed: true` + `dryRun: true`，人类输出是 `📋 Repair plan (dry-run)` 加一句 `*(dry-run: no files were modified)*`；没有撞号时退 0 打印 `✅ Nothing to repair`、不写记录块、不消耗 T 号。
- **修完重建索引**：编号变了，旧搜索索引里的 T 号就指错了地方，所以真实改动后走 `afterWrite(pocketDir, { latestT, index: true })`（`bin/context-pocket.js:1342`、MCP 侧同口径）。
- **`--json` 是全集**：`{ok, success, changed, dryRun, renumbered[]（含 from/to/line/heading）, references[], fileNames[], duplicates, latestTBefore, latestTAfter, filesWritten[], recordTId, stillShadowed[], applyRefs, message, verifyBefore, verifyAfter}`；撞号 pocket 本来就不止一条 error（重复 + 由它派生的 index 一致性），所以契约测试断的是 `verifyBefore.errorCount > verifyAfter.errorCount`，不是"恰好一条"。

**`### Author` 小节 + `log append --author` / `log amend <Tn> --author` —— 每一轮是谁记的，写在块里而不是猜在号上**

- 落点是**小节**（`AMENDABLE_SECTIONS` 的第一项，`lib/writer.js:46`），不是结构行：小节顺序由这张表独家决定，append 按它写、amend 按它插，所以加一节不动数据格式版本。`--- BY: ---` 那种结构行是 v2→v3 的议题，这一轮没做（理由见下面「明确没做」）。
- **绝不编造**：不传 `--author` 就没有这一节，工具不会填 `agent`、`unknown` 或文件名之类的假来源。`log amend --author` 与其他 amend 字段同规——只补缺失的小节，从不覆盖已有的署名（`amendLogBlock`，`lib/writer.js:294` 起的那条约束）。
- MCP 的两个参数描述里写明"填你自己的 agent id，不是用户名；不知道就省略"（`mcp-server.js:393` / `:479`）。

**写时冲突闸：`log append` 自动做，不用你记得做**（`lib/writer.js:130-149`、`detectTurnConflicts` `:246`）

- 旧实现只能等 Agent 自己传 `--conflicts`，忘了传，冲突就永远不在历史里——而 `log.md` 是这个工具唯一的真相来源。现在每一轮 append 都先假定这块已写进 `log.md`，问一遍"会新撞上哪些既有记录"（`conflictsIntroducedBy`，`lib/query.js:423`；与 `check-conflicts` 共用同一份六维规则，差别只在数据是内存里合成的那份）。
- **只有 critical / warning 进块**，加 `[auto]` 前缀写进本块的 `### Conflicts`，用户自己传的那几条原样排在前面；info 类提示不写进去，否则 `Conflicts` 节会变成噪音。
- **检查从不阻断记录**：检查器自己抛错时块照写，原因走 `conflictCheckError` 说回去（与 `whenSkipped` 同一口径——用户显式给过的东西不能被悄悄吞掉）。默认开，唯一入口是 `--no-conflict-check`（CLI）/ `conflictCheck: false`（MCP）。
- `--json` 新增四个字段：`autoConflicts`（全部检出）、`conflictsWritten`（进历史那几条的条数）、`conflictCheckSkipped`、`conflictCheckError`。

#### Changed

- **verify 的撞号修法从一句人话变成一条命令**：`lib/validator.js:162` 的 `fix` 现在直接给 `context-pocket repair --dry-run` → 去掉 `--dry-run`，并写明原因（"两台机器各自从自己的克隆算 latestT+1，锁是按机器的"），MCP 侧同时给出 `context_pocket_repair`。以前那句 "Rename or merge duplicate blocks." 对 Agent 是不可执行的。
- **命令/工具总数 26 → 27**。CLI↔MCP 一一对应继续是断言而不是承诺：`tests/cli.js:465` 数 `help --json` 的命令全集（同时核 README 中英两张 CLI 表），`tests/mcp.js` 用同一张表 diff `tools/list` 去掉 `context_pocket_` 前缀后的工具名。
- **文档口径统一为"同机排队、跨机撞号、repair 收回"**：`README.md` / `README.zh-CN.md`（CLI 表新增 repair 行、`log append`/`log amend` 行加 `--author` 与闸的说明、T-block 示例加 `### Author`、多人协作用例行、FAQ "会不会冲突"改成两case 回答）、`docs/FAQ.md`（两处串行警告改写成锁的机器边界 + repair；「协作 / 团队」与「log.md 出现重复内容」两条重写，撞号交给 repair、内容重复留给人的判断；CLI 清单补 `repair` 与 `--author`；工具数改 27）、`docs/COMPATIBILITY.md`（27 个；不兼容表拆成"同机并发=锁排队"与"跨机器=撞号后 repair"两行）、`SKILL.md`（意图表新增撞号一行；每轮第 1 步改写为"写时闸已经替你扫过，什么时候才需要再跑 `check-conflicts`"）、`SKILL-advanced.md`（新增「并发与撞号（多 Agent）」小节 + 边缘情况一条）、`SKILL-reference.md`（T-block 模板加 `### Author`、新增「Author 节规则」与「写时冲突闸」两块）、`CONTRIBUTING.md`（工具数、用例总数、目录树补 `lib/repair.js` 与 `tests/repair.js`）。

#### Tests

- **新增 `tests/repair.js` 套件（18 条，已登记进 `tests/run.js` 的 SUITES）**：级联方案、两台机器各写一轮（`['3→4','4→5']` → 号排到 1..6）、dry-run 全目录快照逐字节不变、干净 pocket no-op、引用"只列不改"与 `--apply-refs` 改写两组对照、级联引用只改一次（`按 T4 定，又被 T5 推翻`）、派生头行与 `index.md` 对齐、归档只读 + `stillShadowed: [4]`、补零块头、畸形号不动、**回滚用例**（往 `require.cache` 里塞一个假 `verify`：修之前 0 个 error、修之后 5 个，断言整个目录回到改前快照，`finally` 里还原缓存——不加"假装体检失败"的生产开关）、6 条 CLI 契约（`--dry-run --json` 字段全表、人类输出、`--author agent-A` 署名、第二次跑 no-op、`verifyBefore > verifyAfter`、"撞号修法指向 repair"）。
- `tests/unit.js` +6 条纯函数用例（`planIdRenumber` 三种输入、`remapTRefs` 单趟替换、`remapDerivedHeader` 三分支、`HEADING_RE` 的"定义 vs 引用"分类）；`tests/cli.js` +1 条（`--author` 入块 + 写时闸把检出的冲突念回屏幕）；`tests/mcp.js` +2 条（闸的 `[auto]` 行进工具文本、`context_pocket_repair` 先给方案再动手——两次调用**必须分开 `waitFor`**，否则 dry-run 的"没写盘"会在第二次调用之后才读，验不出东西）。
- 全量：`npm run lint`（34 个 .js）+ `node tests/run.js` = unit 53 / pocket 59 / hooks 16 / importer 17 / migrate 16 / repair 18 / cli 20 / mcp 12，共 **211 条，全绿**；`npm run smoke` 的覆盖范围没变（`repair` 需要先人为造出撞号目录，不在冒烟里，`CONTRIBUTING.md:41` 已注明这件事）。

#### 顺手修掉的两个真缺陷（都是写回滚用例时暴露的）

- `index.md` 原先不在 `backups` 里：回滚能把编号退回去、退不回索引头，pocket 会留下"号是旧的、索引是新的"这种 verify 都解释不了的状态。
- 块头替换原先用旧号拼正则，遇到手写补零的 `## T02 ·` 直接匹配不到，repair 静默 no-op 还报成功。

#### 明确没做（以及为什么）

- **`--- BY:` 结构行（v2 → v3 一跳）**：`### Author` 小节已经携带了"这一轮谁记的"，而加一条结构行意味着所有存量 pocket 都要迁一遍、`verify` 要开始检查一个刚出生的字段。等有跨小节语义的需求（比如按作者聚合统计）再升版。
- **claim/lease「谁握着笔」这一层**：跨机器的互斥没法靠工具自己建立——锁文件在 `os.tmpdir()`，这是物理边界。要租约就得引入一个各机器都读得到的中心，那会变成 `ContextPocket/` 之外的第二个真相来源，与"数据全在 git 跟踪的 markdown 里"直接冲突。当前的正解是串行交接（谁做完谁提交，下一个先 `git pull`）+ `repair` 兜底 + `--author` 事后分得清来源。

### ⏱ 每轮的时间行：数据格式 v1 → v2 真的升了一版（2026-10-04）

> 动机来自 hindsight 的 temporal-bound 处理：一条记录的时间只能**放宽**、不能替换，也不能靠猜。这一轮把"这一轮是什么时候发生的"变成 pocket 里的一行结构数据，并把它做成一跳真迁移——不是给新 pocket 加字段就完事，而是让存量 v1 目录能一条命令把历史时间补上，且补出来的东西查得回来源。

#### Added

**`--- WHEN: … ---` 结构行（format v2）**

- 位置只在 `## T<n> ·` 标题的**下一行**，由 `lib/when.js` 独家解析与渲染（`parseWhen` / `parseWhenLine` / `whenLine` / `describeWhen` / `describeWhenLine` / `formatSupportsWhen`）。四种形状，精度互不冒充：
  - `--- WHEN: 2026-10-03 14:47 ---` —— `instant`，写入时刻，`log append` 不带 `--when` 时的默认值
  - `--- WHEN: 2026-10-03 09:00 → 2026-10-03 11:30 ---` —— `range`，右端只写钟点时**继承左端的日期**，不做跨天算术
  - `--- WHEN: 2026-10-03 (day) ---` —— `day`，只知道是哪天；`(day)` 就是这条记录的精度声明，绝不补一个 `00:00` 出来
  - `--- WHEN: stated: 上周三下午 ---` —— `text`，用户原话逐字存，不换算（工具不知道"两个小时前"从哪一刻起算）
- 写入侧：`log append --when` / MCP `context_pocket_log_append {when}`；`log amend <Tn> --when` **只放宽不替换**——块里没有这一行就补，现值是 `(day)`（迁移留下的粗粒度）允许换成更准的，现值是当时记下的时刻或区间则拒绝并指你去新起 `T<n>-fix`。
- 读取侧：`recall` 在 session 日期旁边多打一行 `When: …`（`--json` 里是 `t.when` 结构化对象），`search` / `diff` / `why` / `sync` / `distill` / `archive` 全部照常工作，附件与 SESSION 分隔线的规则不变。
- `--json` 里的 `when` 是文件里**逐字那一行**（机器要真相），人类与 Agent 的输出走 `describeWhenLine` 还原成一句话（`⏱ 2026-10-03 09:00 → 2026-10-03 11:30`）；两个入口共用同一个函数，不会各说一套。
- 结构行刻意不过 `sanitizeInline`：那道防护会把本行的 `---` 逃成 `\---`，解析器就认不出来了（`lib/writer.js:96` 附近有注释说明）。

**`v1 → v2` 这一跳（`migrateV1ToV2`，登记表第 2 条，`lib/migrate.js:37`）**

- 扫 `log.md` 与 `log-archive.md`，给每个 T-block 按**它自己上方最近的那条 `--- SESSION: <日期> ---`** 补一行 `--- WHEN: <日期> (day) ---`。归档时那条 SESSION 线跟着它下面那批块一起走，所以归档过的轮次也补得到。
- 上方找不到日期的孤块**什么都不写**，计进 `stats.noDate`：不拿文件 mtime 冒充时间、不编日期。已经有时间行的块跳过，计进 `stats.already`，所以重跑第二遍一个字节都不改（幂等）。
- 版本戳不由这一跳写：`setFormatVersion`（`lib/migrate.js:444`）在每一跳成功后由框架统一盖上。CRLF 的 pocket 迁完仍是 CRLF。
- 三条诚实性规矩各有用例钉住：只放宽不替换（`stats.already` + 第二次跑字节相同）、不无中生有（`noDate` 的孤块标题下留空）、不做算术（`tests/unit.js` 的 range 只继承日期）。
- 新加相邻断言 `lineAfter(content, heading)`：时间行必须落在**它所属那个块**的标题下一行，全文 `includes` 会把"写到隔壁块"也算通过。

**向后兼容**

- v1 的读取器看 v2 的 log 只会"看不见时间"，别的什么都不变：`parseLogText` 丢掉标题与小节标题之间的散行，这一点由 `tests/unit.js` 直接断言（同一份内容加不加时间行，`sections` 必须逐字节相等，`when` 分别是对象与 `null`）。
- `templates/readme.md:1` 抬到 `format: v2` —— 这是新建 pocket 出生格式的唯一真相源；`CURRENT_VERSION` 同步为 `v2`（`lib/migrate.js:25`）。
- 存量 v1 目录**不会被任何写动作偷偷抬版本**：`log append` / `log amend` / `import` 在 v1 里都不写这一行。为了让"没写"不等于"没说"，`log append` 现在会把用户明确给过的 `--when` 的去处讲出来（人类输出多一行 `⚠️ pocket 还是 v1 格式：先 context-pocket migrate --to latest 才记时间`，`--json` 里是 `whenSkipped` 字段，MCP 同一句话），块照记不误——`log.md` 永远是 P0。
- 没登记降级跳：升上去之后，`describeWhen` 与 `whenLine` 都能读旧 pocket，但 v1 的 pocket 不会再长出 v2 字段，`--when` 在那边永远是"说清楚为什么不写"。

**`verify` 第 14 项：`format-upgrade`（`checkFormatUpgrade`，`lib/validator.js:74`）**

- 登记表里真有可走的一跳才对停在旧版本的 pocket 报 **WARNING**，文本给出跳链与 `context-pocket migrate --to v2 --dry-run` 的下一步；升完之后再 verify 就 0 条。
- 选 WARNING 而不是 ERROR 是刻意的：pre-commit 生成的 hook 只在退出码非 0（有 error）时回显，所以这条提示既不刷屏也不拦提交；升级永远是用户的一次显式命令。

**🔎 搜索分词修复：中文短语终于搜得到（`lib/indexer.js`，`INDEX_VERSION` 3 → 4）**

- 旧的 `tokenize` 把整段连续中文当成**一个**词元入索引，于是 `时间分页` 这种查询永远命中不了「给搜索加时间分页」——而倒排索引和实扫两条路径共用这个函数，两边一起漏，测试也一起瞎。现在中文按**相邻两字组合**建索引（外加单字成段），拉丁词仍按分隔符拆。
- 中英混排（`索引v2`）拆出拉丁片段 `v2`，整串不再入索引；`tokenize('parser.js keep-alive')` = `{parser, js, keep, alive}`。顺带删掉一条永远走不到的分支：`/[.\-_]/` 的子切分，因为分隔符在第一轮就已经把它们拆开了。
- `INDEX_VERSION` 抬到 4：词元集合变了，旧 `assets/search-index.json` 必须作废。`loadIndex` 版本不符返回 `null`，`ensureFreshIndex` 现场重建，所以老缓存自愈，索引/实扫两条路径继续给同样的结果（`tests/pocket.js` 有用例：手工把缓存里的 `version` 减一，断言 `loadIndex() === null`、实扫命中数一致、搜完之后缓存重建且 `viaIndex: true`）。
- 已知取舍写进文档而不是偷偷改行为：**单个汉字**的查询只在那个字独立出现时命中（实测：语料里有「索引库要重建」和「单独一个汉字 库」两轮，查 `库` 只命中后者 —— 前者那个 `库` 在 run 中间，只贡献 `索引` / `引库` / `库要`）。倒排里加单字词元会让 postings 再翻一倍，所以不做。换序的短语（`分页时间`）同样搜不到，因为匹配的是相邻二字组合（实测 1 命中 vs 0 命中）。
- 代价被量出来并写进 FAQ：同一批 800 轮语料，索引体积从"整串中文一个词元"的 628 KiB 涨到二字组的 1003 KiB（+60%），进程内缓存的收益从约 9 倍降到 38 ms → 11 ms（约 3.5 倍）；对照数字是把 `lib/indexer.js` 复制一份、把分词退回旧写法在同一语料上重测得到的。FAQ 里原先那组 683 KiB / 25.2 ms / 2.8 ms 因此整体换成重测值，并写明测量步骤（换机器换语料会变，说明的是量级不是 SLA）。

#### Docs

- `docs/MIGRATION.md`：版本表与自动检测一节改写，"v1 → v2（预留）"整节换成已发布的一跳说明（四种形状表、这一跳做了什么 5 条、三条诚实规矩、5 条向后兼容）。
- `docs/FAQ.md`：「数据格式会变吗」重写（v2 已发布，且**数据格式版本 ≠ skill 版本**——v2 随 1.1.0 发布，skill 主版本号没动，`SKILL.md` frontmatter 的 `format: v1` 是这份文档自己的排版版本）；「数据迁移怎么处理」从"只有 v1 → v1、格式还没变过"改成两跳的真实现状；verify 清单一行 13 项 → 14 项；新增「中文关键词怎么匹配的？为什么换个顺序就搜不到」一问（二字组 + 每个词必中 + 单字限制 + 为什么不加单字词元），索引体积/缓存收益那两行换成上面重测的数字并附测量步骤。
- `SKILL.md` 新增一条 MUST-rule：只在用户说了别的时间时才传 `--when`，并写死四不（不猜、不换算、不覆盖历史、不给 v1 塞 v2 字段）。`SKILL-reference.md` 补 Time line 规范与填好的样例；`SKILL-advanced.md` 的版本迁移节改成两跳 + 升级三行命令。
- README 中英两份：T-block 样例加时间行并加一段解释；`--when` 进速查表与 `log append` / `log amend` 两行；`search` 行写明匹配语义（二字组合、全词必中、短语在内可以、换序不行、单字限制）；`migrate` 行与 `verify` 行（13 → 14 项）改成现状。
- `templates/on-demand/log-archive.md` 的归档样例加时间行，`templates/readme.md` 抬 `format: v2`。
- `CONTRIBUTING.md`：登记表样例换成真两跳 + 一条未来的 `v2 → v3`；`run()` 的规矩由四条扩到六条（新字段两侧同时落地、迁移不许无中生有）；"同一笔提交必须一起改的地方"补 `CURRENT_VERSION` 与 `SKILL-reference.md`，模板行号与 `lib/migrate.js` 行号对齐；测试要求新增"相邻断言"和"重跑幂等"两类；项目结构树补 `lib/when.js`；用例总数 143 → 179。

#### Tests

- 套件计数：7 个套件 **179 例**（47 unit + 54 pocket + 16 hooks + 17 importer + 16 migrate + 19 cli + 10 mcp），此前 143。`npm run lint`（32 个 `.js`）、`node tests/run.js`、`npm run smoke` 全绿。
- 新增覆盖：`lib/when.js` 的四种形状与精度、`describeWhenLine` 的行→句子；迁移内容侧（活文件与归档文件的相邻断言、无 SESSION 孤块留空、幂等、CRLF）；写入侧（v1 不写、amend 三态、`--when` 默认落写入时刻）；CLI/MCP 两侧的人类输出与 `--json` 字段；`tokenize` 的两条词元用例与"旧索引缓存被丢弃"的端到端用例；中文短语查询命中；`format-upgrade` WARNING 存在、迁移之后消失。

### 本轮工程收尾（2026-10-03）—— 逐条对着代码修，功能一个没删

> 背景：把"README/SKILL 承诺的能力"与"代码实际做了什么"逐条对表，凡是不一致的地方**优先改代码**（文档说存在的功能就该真的存在），只有确实属于设计取舍的才改文档。以下每一项都有对应测试。
>
> 阅读提示：本节里"26 条 / 26 个工具"是**当时**的计数，那一句在 2026-10-05 加了 `repair` 之后变成 27（见上面那一节的 Changed）。

#### Added

**✅ 可运行的测试基线（`npm test`）**

- 零依赖自研骨架：`tests/run.js`（按文件前缀只跑一个）+ `tests/harness.js`（`test` / `tmpProject` / `makePocket` / `readPocketFile` / `writePocketFile` / `cleanup`）。引入 npm 测试框架会让"clone 下来 node 就能跑"这条承诺失效，所以没用 tape/mocha/jest。
- `tests/harness.js` 把 `CONTEXTPOCKET_HOME` 重定向到临时目录（子进程继承 env，CLI/MCP 的 spawn 一起隔离），测试**不会**再往真实 `~/.contextpocket/hub.json` 里写注册项目。
- 首批 5 个套件共 94 例（本轮结束时 7 个套件 143 例，见下）：`unit.js` 36（`bin` 的 `parseArgs` 与选项登记、`core` 的编号/整数归一、`fields` 的参数形状、`io` 与 `parser` 的纯函数、带行尾注释的 config 取值仍是正确类型、`lib/secrets.js` 的命中/掩码/占位符/Luhn/`redactText`）、`pocket.js` 43（真实 bootstrap 出来的 pocket 上的数据正确性：计数、归档、归档阈值、蒸馏窗口与覆盖判定、注入防护、CRLF、并发锁、增量索引、进程内索引缓存、`--drift` 的漏记检测、覆盖证据分级与真 git 的 sync 端到端、密钥报成 error 且定位到 `log.md` 行号、PII 只出 warning、`secret_scan: false` 整块关闭、新 pocket 首提交前 `errorCount === 0`）、`hooks.js` 16（pre-commit 脚本内容与真 git 端到端，见下）、`importer.js` 14（各家 JSONL 形状、噪音过滤、T 号接续、limit/truncate/dry-run、CLI 侧参数真的生效）、`migrate.js` 11（版本链：多跳一次走完、逐跳抬版本戳、抛错与静默写坏都整体回滚且不留垃圾备份、脏 pocket 拒绝开跑、目标不可达时列出登记表、CLI 的 `--list` / `--to latest` / 坏目标的退出码与 JSON 形状）、`cli.js` 15（`--json` 契约、分页、bootstrap 警告与幂等、`help --json` 与 README 表对表）、`mcp.js` 8（换行分隔 JSON-RPC、端到端 append/amend/search 分页/migrate list、CLI 命令与 MCP 工具名一一对应，并把 `mcp-smoke.js` 整套跑一遍）。
- `package.json` 脚本：`test` / `lint`（对全仓 `.js` 跑 `node --check`）/ `smoke`（真实 stdio 打一遍 MCP server；不传参数时自己在临时目录里造一个一次性 pocket 并隔离 hub，见下）。

**🔌 写入层的原子性与并发锁（`lib/io.js`）**

- `writeAtomic()`（`lib/io.js:178`）：同目录写 `*.tmp` + `fs.renameSync` 替换，进程被杀 / 磁盘满时不会留下半套 markdown。
- `withPocketLock()`（`lib/io.js:348`）：`ContextPocket/*.cp-lock` 自旋锁 + 陈旧锁抢占（按 mtime 判定持有者是否已死），归档 / 追加 / 迁移不再能互相踩。锁与 tmp 文件已加进 `ContextPocket` 的忽略规则，不会污染 git 状态。

**🧩 两个单一真相源**

- `lib/fields.js`：T-block 载荷形状（`turnFields` / `sectionFields` / `toList` / `hasAnySection`）第一次有了唯一定义，CLI 与 MCP 都从它读写，不再各写一份字段清单。
- `lib/lifecycle.js`：`afterWrite(pocketDir, {index, hub})`（`lib/lifecycle.js:28`）统一"写完 markdown 之后必须做的事"（刷新索引、更新 hub）。此前散落在各命令里，导致有的写入路径刷新索引、有的不刷。

**🤖 每个 CLI 命令都支持 `--json`（此前这个承诺只写在文档里，代码中不存在）**

- `bin/context-pocket.js:212` `emitJson()` + `:218` `failJson()`：`--json` 时 stdout **只有一行可 JSON.parse 的内容**，不带 ANSI 颜色与排版；失败也是 `{"ok":false,"error":"…"}` 且退出码非 0（`verify` 有 error / 冲突 critical 仍是 1）。人类模式的信息量一点没减。
- 补漏：`bootstrap` 的 catch 原本只打人读文本，`--json` 消费方会拿到一行 emoji 句子（已修）；`status --json` 现在带 `logLines` / `archiveAt`。

**🧭 `help` 也变成数据（`HELP_GROUPS` 是命令清单的唯一来源）**

- `help` 原先是二十多行 `console.log` 硬排版，`--json` 落到它身上仍然打印带颜色的文本——而"命令有哪些"恰恰是 Agent 最想机器读的一件事。现在命令表抽成 `bin/context-pocket.js:259` 的 `HELP_GROUPS` / `HELP_OPTIONS`，人类帮助与 `help --json`（`{ok,usage,groups[],options[]}`，26 条）都由它渲染，改一处不会只更新一半。列宽常量 `HELP_COL` 导出给测试用。
- 清单里的 `prefs update` 改成规范名 `preferences update`（CLI 两个名字都继续接受，`prefs`/`codemap` 别名一个没删），这样"工具名 = 子命令名加 `context_pocket_` 前缀"这句话对全部 26 项成立。
- 新增 3 处对表测试：`help --json` 的 26 条 ↔ 人类帮助排版 ↔ README 中英的 CLI 表（`tests/cli.js`），以及 MCP `tools/list` 去前缀后 ↔ 同一张表（`tests/mcp.js`）。以前 `docs/COMPATIBILITY.md:44` 的"一一对应"只是文档，现在是断言。

**📏 `archive_at` 与 `recent_keep` 第一次真的被读**

- `verify` 新增第 12 项检查 `checkLogSize()`（`lib/validator.js`）：`log.md` 行数 ≥ `archive_at` 报 WARNING 并给出可执行命令；达到 80% 报 INFO"快到了"；`archive_at` 写成 `800 lines` 这类非数字时**直接报"配置坏了"**，而不是静默永不触发。
- `status`（`lib/formatter.js` 与 MCP `toolStatus`）在超阈值时追加 `· 34/20 lines — archive is due`；`parseLogText` 新增 `lineCount`（按 `wc -l` 口径，末尾换行不多算一行）。
- `archiveLog()`（`lib/writer.js:900`）保留数改为 `intOption(options.keepLast, readConfig(pocketDir).recent_keep)`。此前 CLI（`intOption(..., 20)`）和 MCP 各硬编码一个 20，而 `templates/config.md` / README / SKILL 全都写着"`recent_keep`：归档时保留最近 N 个完整 T 块（默认 30）"——**用户改这个配置从来没有效果**。显式 `--keep-last` 仍优先于配置；`keep-last 0` / 负数现在当场报错（旧实现会在取 `blocksToKeep[0].id` 时抛裸 TypeError）。

**⚠️ bootstrap 把"没做成但不致命"的事说出来**

- `lib/bootstrap.js` 的 `detectProjectType` / `scanProjectTree` / `prefillTemplate` 接收 `notes` 数组并随返回值以 `warnings` 导出；CLI 与 MCP 都打印（`⚠ N warning(s) during initialization`），`bootstrap --json` 里是 `warnings: []`。
- 覆盖三种以前静默的情况：`package.json` 解析失败（项目类型是猜的）、目录扫描被 EACCES/EPERM 跳过（自动生成的结构树不完整）、模板缺失导致某个核心文件根本没建。

#### Changed

**🔌 MCP stdio 分帧改成换行分隔 JSON（协议正确性）**

- 旧实现按 `Content-Length:` 头分帧 —— MCP 的 stdio 传输规范用的是**每行一条 JSON**（newline-delimited JSON-RPC），于是标准客户端发来的 `initialize` 根本读不到，整个 MCP 模式不可用。现在写出与读取都是整行，`npm run smoke` 与 `tests/mcp.js` 锁住这个行为。

**🗂 搜索索引 v3：增量 postings + 两条路径同结果同顺序**

- `INDEX_VERSION = 3`（`lib/indexer.js:40`），旧版本索引自动作废重建（`lib/indexer.js:229` 的版本校验）。
- 存储从"每篇文档存全文"改成 postings（term → {docKey: weight}）+ `docHash`；刷新时按 hash 只重分词**内容变过的那几篇**，其余复用。实测 800 轮：单次追加后的刷新只重分词 1 篇（此前每追加一轮都重算全部 801 篇）。
- 源文件签名没变时 `buildIndex` 直接短路返回 `unchanged: true`（不重序列化、不写文件）；`index` / `index --rebuild` 的输出如实区分 built / refreshed / already up to date，并显示 `Re-tokenized: x of y docs`。
- **索引路径与全量扫描路径共用同一套匹配与排序**（`idShortcutHit` / `sortCandidates` / `shapeHits`），`--no-index` 与带索引返回**完全相同的有序结果**——以前两者会给出不一致的名单。
- `searchAny` 返回 `{results, total, offset, limit, hasMore, viaIndex}`：以前命中超过 50 条会**静默截断**却不告诉调用方还有更多。现在 CLI（`--limit` / `--offset` / `--limit 0` = 全部）与 MCP（`limit` / `offset`，默认 50，`0` 为不限）都报告真实总数并给出下一页参数；越界 offset 是"空页"而不是错误。
- **已知成本如实记录**：800 轮规模下整库重建 ~122ms、无变化刷新 ~65-73ms、追加一轮后的刷新 ~101-104ms；瓶颈不再是分词，而是"整个索引是一个 JSON 文件"带来的 `JSON.parse`（~34ms）+ `JSON.stringify`（~26ms）。没有为此加内存缓存，因为失效风险（读到过期索引）比这几十毫秒更贵。要跨过这条线只能改成 append-only postings 日志，属于格式 v2 的议题。

**🔁 检索/校验的小节清单统一到 `TBLOCK_SECTIONS`**

- `lib/query.js` 的 `SEARCHABLE` 与 `lib/validator.js` 的 `PATH_SECTIONS` 现在直接引用 `lib/constants.js:62` 的 `TBLOCK_SECTIONS`。旧列表里写着 `'Changes'` / `'Notes'` —— **这两个从来不是真实存在的小节名**，一边白做扫描、一边 `Attachments` / `Conflicts` / `Decisions & Constraints` 被静默跳过（`why <文件>` 因此漏检）。现在 T-block 的 9 个小节全部参与 `why` / `search`。

**▶️ `bootstrap` 第二次运行变成无害 no-op**

- CLI 与 MCP 在调用 `bootstrap()` 前先判断 `ContextPocket/` 是否已存在：存在就**什么都不写**、退 0 并报出路径与"read index.md + state.md 继续记"（`bin/context-pocket.js` `cmdBootstrap`、`mcp-server.js` `toolBootstrap`）。
- 旧行为是抛错 + `exit 1`，而激活方式是全自动的（用户说"开始记一下"时项目很可能已有 pocket）——Agent 于是收到"初始化失败"，转而放弃记录或去手改 markdown。`lib/bootstrap.js` 里"拒绝覆盖"的库层保护原样保留，任何直接调库的代码仍然会报错。

**📝 `config.md` 不再记录撒谎的 gitignore**

- `lib/bootstrap.js` 先算 `.gitignore` 的实际处置，再把生效值写进 `config.md`（`updateConfigValues({... gitignore})`）。此前无论 `--gitignore false` 做了什么，`config.md` 里永远写着 `gitignore: true`。
- 同时把文档改准：这一行是**初始化时采用的记录**，事后编辑它不会重写 `.gitignore`（要切换请直接改 `.gitignore`，FAQ 有步骤）。

#### Fixed

**🗂 归档会静默丢掉幸存轮次的日期（数据保真缺陷）**

- `archiveLog()` 原本从 `## T<第一个保留块>` 那一行开切，于是块**上方**的 `--- SESSION: <YYYY-MM-DD> ---` 被一起搬进归档，`log.md` 里剩下的块 `session` 全变 null：`recall` 少一行日期，且索引里每篇文档的 hash 都变、增量刷新退化成全量重分词。
- 修法：切分点向前吸收那条 SESSION 分隔线（归档文件里它继续管它下面那批块），若保留段前面一条都没有则复制最近一条留下（`lib/writer.js` 的 `keepStart` / `carriedSessionLine`）。两个文件本来各自独立解析，所以留一份副本不产生歧义。
- `SESSION_LINE_RE` 提到 `lib/constants.js:92`，parser / writer 共用同一份定义（以前是两处手写的正则，改一处就漂移）。测试：`archiving leaves the SESSION marker in front of the blocks it describes`。

**🧪 `distill` 的覆盖判定跨条目累加，新条目被误判为"已经提炼过"**

- `findCover()` 用**跨条目共享**的 `latinHits` / `dead cjkHits` 累加器，于是第一轮之后所有候选项都被认为已在报告里出现过 —— 蒸馏报告逐渐不再提出任何新内容。改为每条候选项自己的 `latinHit`，并删掉那段永不生效的死代码。

**🔎 归档 ≠ 丢失：`recall` / `diff` / `search` / `why` 都读 `log-archive.md`**

- 查询侧此前只读 `log.md`，于是**归档一执行，老轮次就从 recall / 无索引 search 里消失**，而同一条查询在索引存在时却能命中（索引读两个文件）。统一到 `parseLogAll()`，并在结果里带 `archived: true` + `source`。

**🧱 parser 对畸形输入的健壮性（含一处 ReDoS）**

- 恶意 / 手改的 `## T4000000000` 这类天文数字不再参与编号分配（`plausibleIds` / `MAX_PLAUSIBLE_ID`），`verify` 改为在根因处报"这一行需要修"，而不是一串莫名其妙的缺号警告；`next_id: R99999999999` 同理。
- 收紧可能回溯爆炸的路径匹配；`intOption` 归一 `--limit abc` 之类，NaN 不再渗进截断阈值。
- `index.md` 标题行写坏（`# Index · T99999999999`）时，`checkIndexConsistency` 直接报**根因** ERROR 并给出正确的标题行，而不是同时打印"index 说 T0 / log 说 T3"这种派生噪音把真因盖住。

**🧹 死代码与重复实现清理（不改行为）**

- 删掉 10 处从未被使用的 require 绑定与 `getAssetsDir` / `cjkHits` 等死分支；`getTodayStr` 原先在 `writer.js` / `distill.js` / `bootstrap.js` 各有一份，统一到 `lib/core.js`。
- `lib/fields.js` 接管后，`bin` 与 `mcp-server` 里重复的字段拼装、以及两份会互相漂移的命令/工具清单合并为单一来源（工具数仍是 26 个，一个没删）。

**🚑 `npm run smoke` 一跑就退出码 2，文档却写着"三条都要过"**

- `mcp-smoke.js` 把 `<project-dir>` 当必填参数，缺失就 `usage: … ` + `process.exit(2)`，而 `package.json:34` 的脚本正是无参的 `node mcp-smoke.js` —— 也就是这个冒烟测试作为 npm 脚本**从来没有可用过**，只有 `tests/mcp.js:122` 传了临时目录时才真的跑起来。
- 修法取"补齐能力"而不是"改文档认命"：不传参数时脚本现在在 OS 临时目录里 `mkdtempSync` 一个工作区，`require('./lib/bootstrap').bootstrap()` 现造一个 pocket，并在 `CONTEXTPOCKET_HOME` 未设置时把它指到同一个临时目录（避免污染真实的 `~/.contextpocket/hub.json`），`process.on('exit')` 里整棵删掉。传了参数则行为完全不变，只在 `CONTEXTPOCKET_HOME` 未设时先打印一行"hub 写入会落到你真实目录"的提示。
- `mcp-smoke.js:4-8` 的用法注释、`CONTRIBUTING.md` 本地验证清单、README 中英的脚本表同步改为"可独立运行 / 可指定项目"。测试仍是同一批：`tests/mcp.js` 用显式目录跑（隔离由 harness 负责），`npm run smoke` 现在自证可用。
- 附带踩到的 Windows 坑：一次性目录刚 `child.kill()` 掉就被 `rmSync` 删除会 EPERM/EBUSY（server 进程的 cwd 就在那棵树里），于是一次次运行把临时目录留成一地垃圾。改成"退出前重试删除，3 秒超时才承认失败并打印留在哪"（`mcp-smoke.js` 的 `finish()` / `removeThrowaway()`），`process.on('exit')` 保留为异常路径的兜底。

**🧪 `distill` 第一次有测试，MCP 侧补上它缺的那个参数**

- 蒸馏此前只被 smoke 的 `dryRun` 一例路过。新增 2 例（`tests/pocket.js`）：窗口语义（`recentKeep: 0` 必须真的是 0 而不是"没传"、`4` 只扫 T1-T2、不传时读 `config.md` 的 `recent_keep`、生成报告但**绝不改写** `decisions.md`）与覆盖判定（关键词分散在两条 ADR 上不算"已覆盖"——这是上面 `findCover` 修复的回归锁）。
- `context_pocket_distill` 加 `recentKeep` 参数。CLI 的 `--recent-keep` 早已存在，MCP 侧却连字段都没有，于是 `docs/COMPATIBILITY.md:44` 承诺的"CLI 子命令与 MCP 工具一一对应"在蒸馏这一项上是假的。工具数仍是 26 个。
- 运行时文案里还留着三处斜杠命令（`bin/context-pocket.js:1481`、`:1506`，`mcp-server.js:1880`："just say: /digest"、"after /archive moves old T-blocks out"），与 `SKILL.md:66` 的硬规则"永不告诉用户输入 /xxx"直接冲突——Agent 把工具输出转述给用户就会重新发明命令表。已改为自然语言 + 真实命令名。

**🔒 没有 pocket 的仓库曾被 hook 锁死每一次提交（`lib/hooks.js` v3）**

- `install-hook` 只检查有没有 `.git`，从不检查有没有 `ContextPocket/`（`bin/context-pocket.js:1407`）。而 hook 的第 1 步 `sync --auto` 在没有 pocket 时必然 `exit 1`（`ensurePocket()` 直接退出），于是脚本走进 `❌ ContextPocket sync failed — commit blocked` → `exit 1`：**先装 hook、后 bootstrap 这个完全正常的顺序，会让之后每一次提交都被拦下**，唯一出路只有 `git commit --no-verify`。这与上面第 1 条修掉的"hook 锁死提交"是同一个形状的坑。
- 修法：生成的脚本先做第 0 步——从 `pwd`（git 在工作树根运行 hook）逐级 `dirname` 向上找 `$POCKET_DIR_NAME`，找不到就打印"没有 ContextPocket/，跳过检查 + 怎么 bootstrap / 怎么卸掉"并 `exit 0`。找到后把 `--dir "$PROJECT_DIR"` 显式传给 `sync` 与 `verify`，让两步用同一个解析结果，不再依赖各自的 cwd 猜测。`install-hook` 也在人类输出与 `--json` 里明说当前项目有没有 pocket（新增 `pocket: false`），没 bootstrap 就当场警告。
- `scripts/pre-commit` 参考副本同步到三步逻辑（它此前只找 `<script>/../bin`，被手抄进 `.git/hooks/` 后永远找不到 CLI 而静默跳过全部检查；现在按 `pwd` 逐级试 `../bin`、`../../bin`、`../../../bin`）。MCP 的 `context_pocket_install_hook` 描述与回执、README 中英命令表、`docs/FAQ.md` 的 hook 一节一起改为三步。

**🧪 `tests/hooks.js`：生成脚本第一次有测试**

- 此前 hook 只在真实 git 环境里手工验过退出码。新增 14 例：内容断言（shebang、成对 MARKER 恰好两对、`sync` 必须排在 `verify` 前、两处 `commit blocked`、**最后一行必须是 `exit $VERIFY_RC`**——这是"warning 也曾拦提交"那次的回归锁、CLI 绝对路径为正斜杠且真实存在、node/CLI 缺失两个兜底只能是 `exit 0`）；共存断言（有别人的 hook 时 `appended`，卸载只摘自己那段并保留 `echo foreign-lint`；整份都是我们的就 `deleted`；没有 MARKER 的原样不动）；`findGitDir` 对 worktree `.git` 文件的跟进；非 git 仓库必须抛错。
- 端到端 3 例（真 `git init` + 真提交）：健康 pocket 能提交且暂存文件被补成 `[auto]` T-block；打掉 `log.md` 后提交必须被拦下并打印原因；**没有 pocket 的仓库绝不能被锁死**。本机缺 git/sh 时打印 `(skipped)` 跳过，不当作通过；"必须被拦下"那条同时是另两条的对照开关——它一红就说明 hook 根本没被执行，"放行"的结论不可信。
- 总计 5 个套件 94 例（28+30+14+15+7），`tests/run.js:16` 的 SUITES 加 `hooks.js`。

**💥 `import` 遇到内容为 `null` 的 JSONL 行会抛 TypeError（`lib/importer.js:117`）**

- `detectSource()` 只给 codex 那一支写了 `obj &&` 判空，下一行 `(obj.type === 'user' …)` 直接读属性。而 `parseSession()` 是把每一行 `JSON.parse` 的结果原样塞进数组的，所以会话文件里出现一行合法 JSON `null`（中断写入 / 心跳行都会留下这种行）时，整条 `context-pocket import` 崩在解析阶段，一条历史都导入不进去。
- 修法：循环开头统一 `if (!obj || typeof obj !== 'object') continue;`，两支判定都不再依赖调用方过滤。`extractEvent()` 本来就有同样的判空，所以只有嗅探这一层漏了。

**🔇 `import --truncate 200` 被无声忽略（`bin/context-pocket.js:95`）**

- `--truncate` 登记在 `BOOL_OPTIONS` 里，`VALUE_OPTIONS` 没有它。`parseArgs` 因此把 `--truncate` 置为 `true`、把 `200` 掉进 `positional`；`cmdImport:1575` 的 `intOption(options.truncate, 400)` 见到 `true` 就退回默认值 400。结果：CHANGELOG:270 与 MCP `context_pocket_import` 的 `truncate` 参数（`mcp-server.js:762`，`type:'number'`）都白纸黑字承诺可以调截断长度，CLI 侧却永远是默认值，且不报任何错。
- 修法：`--truncate` 移到 `VALUE_OPTIONS`（`bin` 里唯一的消费者就是 `cmdImport`，没有任何地方把它当开关用，行为只增不改）。
- 顺手把这类错登记做成机器锁：`tests/unit.js` 新增一例，扫源码里所有 `intOption(options.x` / `intOption(args.x` 的选项名，逐个断言 `--x 7` 解析出来的必须是 `'7'` 而不是 `true`。以后再有"数值选项登记成开关"直接红。

**🧪 `tests/importer.js`：导入第一次有 fixture 测试**

- `import` 是"中途启用不丢历史"的唯一入口，此前零测试：各家 JSONL 的形状、噪音过滤、T 号接续、`limit` / `truncate` / `--dry-run` 全靠肉眼看。新增 14 例，用真实 jsonl 文本喂进 `parseSession` / `importSession`，再看 `log.md` 里长出来的 T-block。
- 覆盖面：Claude Code（用户消息是字符串、助手消息是 `{type:'text'|'thinking'|'tool_result'}` 块数组——只有 `text` 能进记录）、Codex（`response_item` + `payload.message`，`input_text`/`output_text`，且 `developer` 角色与 `function_call` 必须丢弃）、泛化 `{role,content}` / `{message:{role,content}}` 的嗅探、显式 `--source` 覆盖时标签原样落到 Action 行；五种噪音（`<command-*>`、`Caveat:`、`[request interrupted`、`<system-reminder>`、空白）都不许开出 T-block；开场助手文本不许挂到下一轮；空白行 / 说明行 / 半截 JSON / `null` / 数组 / 字符串行都不许炸。
- 落盘面：`[imported]` 标签、`### User` 行带 `[YYYY-MM-DD]` 前缀、无回复的轮次显式写"（无助手文本回复记录）"、T 号接着 `latestT` 往后排、导入后 `verify` 的 `errorCount` 必须是 0；`--dry-run` 必须一个字节都不写（`log.md` 与 `index.md` 逐字节比对）；0 轮导入不许碰 `log.md`；`--file` 缺失 / 文件不存在必须报错而不是静默导入 0 条。
- CLI 面 2 例：`import --dry-run --json` 的 `plannedTurns` / `preview[].gist`（60 字上限）/ `--truncate 20` / `--limit 2` 全部按值生效，真导入后 `log.md` 里能看到 `[imported]`；没有 pocket 时 `--json` 必须给出 `{"ok":false,…}` 且退 1（不是给人看的 emoji 文本）。
- 总计 6 个套件 117 例（29+38+14+14+15+7），`tests/run.js:16` 的 SUITES 加 `importer.js`。

**⚡ 常驻 MCP 进程的索引缓存（`lib/indexer.js` 的 `indexMemo`）**

- 每次 `search` 前都要 `ensureFreshIndex` → `loadIndex`，也就是把整份 `assets/search-index.json` 读进来再 `JSON.parse`。CLI 一次一条命令无所谓，MCP server 是常驻进程、同一项目被反复查询，于是这份解析开销每次都要重付。此前 `docs/FAQ.md:84` 明确写着"没有用缓存去换（缓存失效风险大于收益）"。
- 现在按 pocketDir 记住"上次解析结果 + 当时的 `sourceSignature`"，签名一致直接复用；`saveIndex` 顺手更新缓存，所以本进程刚 append 完再搜也不用读盘。容量 8 个项目，按插入顺序淘汰（`MEMO_LIMIT`），另导出 `resetIndexMemo(pocketDir?)`。
- 失效逻辑：键就是那 5 个 `SOURCE_FILES` 的 mtime+size；内容一变签名就变，下一次搜索作废重建。签名一致而只有 json 文件被别的进程重写过时，复用的那份同样是从同一批源文件派生出来的，结果等价——所以"绝不做缓存"的旧理由并不成立，收益是实测的：800 轮（索引 683 KiB）同一关键词查 20 次，**每次读盘 25.2 ms/次 → 命中缓存 2.8 ms/次（约 9 倍）**；一次性 CLI 调用走不到这层，行为与耗时不变。
- 两条机械断言（`tests/pocket.js`，`the index memo…` + `a resident process reuses…`）：① 命中缓存时把索引文件从磁盘删掉，搜索必须照常给出**完全一致**的结果与顺序，且那个文件**不会被顺手重建**——只比字符串永远证明不了"没读盘"；② 索引文件缺失时新写一轮，搜索必须立刻查到它（`r.id === fresh.tId`），之后 `search-index.json` 回到磁盘上。另加一条：两个项目交错搜索时缓存按 pocketDir 分键、绝不串台，超出 8 个后被淘汰的项目重读盘结果不变。

**🕳️ `verify --drift` 补第二项检查：代码比记录新（`lib/validator.js:817` `checkCodeNewerThanLog`）**

- 短板：查"改了没记"此前只有两条路，而两条都有前提。`sync` 要 `git diff --staged`，不是 git 仓库时它直接打印 "not a git repository" 就返回；`checkLogCognitionDrift` 只在**已有 T-block 提到的路径**上找漂移，从没被记过的文件它根本看不见。纯 SVN / 复制进来的项目 / 还没进 git 的新目录，漏记是查不出来的。
- 新增检查用文件 mtime，不依赖 git：拿 `log.md` 的落盘时刻当基线（**不是** T-block 里的 SESSION 日期——那个只有"天"的精度，同一天内改的文件一律比不出来），扫项目根目录带代码后缀的文件（`DRIFT_CODE_EXTS`，`lib/validator.js:761`），列出比基线晚 2 秒以上的（`TOLERANCE_MS`：编辑器格式化、复制收尾这类"同一批写入"不该报警）。
- 两种降噪：① 干净时给 INFO 并带上扫了多少个文件，让"扫过了"本身可见，而不是静默无输出；② 文件数 >20 且九成以上都比记录新时判为 clone / checkout / 分支切换导致的时间戳集体刷新，报 INFO 说明"这不是漏记"——否则这种场景每次都报警，用户学会的第一件事就是忽略这条警告。真正的漏记才是 WARNING，且 fix 里同时给出 append / amend / `sync --auto` 三条出路。
- 永远是 WARNING 不是 ERROR：`verify` 的 error 会退 1，而 pre-commit hook 跑的是不带 `--drift` 的 `verify --quiet`，这道判据因此既不会拦提交，也不会因为"改动不是你做的"卡住工作流。
- 顺手抽出共用的目录遍历 `walkCodeFiles()`（`lib/validator.js:768`，返回 `Map<相对路径小写, mtimeMs>`，忽略规则 `DRIFT_EXCLUDE_DIRS` 含 `ContextPocket`/`.git`/`node_modules`/`dist`/`build` 与各测试临时目录），`checkLogCognitionDrift` 改为复用它的键集合，两处"扫目录"的忽略规则从此只有一份。

**📄 `verify` 的人类输出现在会点名文件，而不只给个数（`lib/formatter.js:141` `pushDetails`）**

- 检查项早就带 `details` 数组（具体是哪几个文件），但只有 `--json` 看得到；人类模式里那句"7 file(s) were modified after the last record"没法回答"是哪 7 个"，用户只能自己去跑 git status。现在 quiet 与详细两种模式都会在该行下面缩进列出 `details`（dim 色、每行一条），最多 8 条由检查侧截断，避免刷屏。

**🔍 覆盖证据分级：谈过 ≠ 改过（`lib/parser.js` `weakMentions()` + `lib/query.js` `why()` + `lib/sync.js`）**

- 问题：一轮里"改了哪些文件"和"提到了哪些文件"以前是同一个集合。`Uncertain` 写"要不要一起改 `lib/store.js`"、`Attachments` 挂一张截图，都会被当成这轮动过那个文件——`why` 于是能把"从没改过它的轮次"答成"是这轮改的"，任何拿"提到过"当已记录判据的检查看到的都是幻影覆盖。
- 现在分两级：**强证据** = `### Action` 小节里的路径（`block.actions[].files`，整行都算，保留原有那条取舍：自然语言的 Action 不该被误判成漏记，否则每次提交多一个 `[auto]` 块）；**弱证据** = 其它八个小节里的路径，解析时落到新的 `block.mentions[]`（`{path, section, text}`，按小节+路径去重）。
- `why`：命中项带 `evidence: 'changed' | 'mentioned'`，改过的整体排在只提到过的前面、组内仍按时间倒序，所以 `--limit` 截断先掉弱证据、绝不会把真实改动挤掉；`references` 里 Action 的引用也排到最前。人类输出每行加 `[changed]` / `[mentioned only]` 标记，头部一行统计"几个改了它、几个只提到它"，若**全部**只有弱证据则额外提示"没有任何一轮记录改过这个文件，这个 why 还没解决"。
- `sync`：覆盖判定仍然只看强证据（行为不变，不会突然开始补一堆 `[auto]` 块），但漏记文件若被弱证据提到，结果里带 `mentionedIn: [{tId, section, text}]`，顶层带 `mentionedOnly` 路径列表；人类输出在该文件后面直接写明 `← only mentioned in T7/Uncertain, never in Action`，并给出 `context-pocket log amend T7 --action "…"` 这条更对的修法；`--auto` 真的补录时，`[auto]` 块的 Action 行里也带着"（此前只出现在 T7 的 Uncertain，未记入 Action）"，事后核对看得出当初缺的是哪一节。
- 取舍：没有把弱证据也算进覆盖——那会让"只在待确认里出现过"的文件永远查不出漏记；也没有要求 Action 必须写成严格 em-dash 格式才算覆盖——那会让自然语言写法每次提交都产生一个冗余 `[auto]` 块。分级是唯一不撒谎的位置，并且弱证据仍然可查、可反查、可指引修复。
- 测试（`tests/pocket.js` 新增 3 例）：强弱证据在解析层各自落在哪（`lib/b.js` 只出现在 Action 描述里仍算强证据，`lib/c.js` 只在 Uncertain 里则进 `mentions` 且不进强证据）；`why` 的分级、排序与 `--limit` 截断方向；`sync` 在**真 git 仓库**里的端到端——`lib/a.js`（Action）被覆盖、`lib/c.js`（只在 Uncertain）仍算漏记且带出处、`lib/d.js` 完全没提过则不带 `mentionedIn`，`--auto` 补出的块里带着那句"此前只出现在…"，补完再查必须干净（幂等）。缺 git 时该例打印跳过说明，不算通过。
- 文档同步：`SKILL.md` 的 Action 格式一节改成"三级说明"（强证据 / 弱证据 / 为什么不能靠别的小节记账），意图路由表的 `why` 一行标出两种证据；README 中英的 `why` 与 `sync` 两行、`docs/FAQ.md` 的命令清单一行，并新增一条 FAQ 问答"我在 Uncertain 里写过它，为什么 sync 还说漏记"（含上面那段取舍）；`--help` 的 `sync` / `why` 说明同步。
- 两个入口都要说同一句话：MCP 的 `context_pocket_why` / `context_pocket_sync` 工具描述写明分级规则，`toolWhy()` 的 Markdown 输出给每条命中加 `**[changed]**` / `**[mentioned only]**`、头部统计"几个改了它、几个只提到它"、全无强证据时追加一条"这个 why 还没解决"，`toolSync()` 的三处文件清单（dry-run / 已补录 / 仅报告）都带上弱证据出处与 `log amend` 建议。实测对着一个真 git 仓库跑 MCP stdio：`why lib/c.js` 返回 T2 `[changed]`（自动补录块，Action 行里带着"此前只出现在 T1 的 Uncertain"）+ T1 `[mentioned only]`，顺序与 CLI 一致。
- 套件计数随之变为 6 个套件 117 例（29+38+14+14+15+7）。

**🧳 版本迁移链真的能串起来：`--to latest`、多跳、逐跳抬版本戳、回滚不再留垃圾备份（`lib/migrate.js`）**

- 短板：`migrate` 会重写整个 `ContextPocket/`，而这层**此前一行测试都没有**，登记表里也只有内置那条 `v1 → v1` 空跑 —— 于是"多跳""失败回滚""`--to latest`"全是文档里承诺、代码里从没跑过的能力。第一条断言就抓出真 bug：`findStepPath` 的 BFS 把跳对象直接接到链尾当 cursor 用，`step.from !== cursor` 拿对象比字符串，**任何两跳以上的路径永远返回"不可达"**；就算 v2 登记进来，用户也只会看到 `No migration path from v1 to v2`。
- 登记表 `MIGRATIONS`（`lib/migrate.js:33`）成为唯一真相源：一条记录一跳 `{from,to,name,run|type}`。新增 `registerMigration(step)`（返回反注册函数，主要给测试拼临时链用）并做入口校验：`run` 不是函数、既没 `run` 又不是内置 `type`、`from`/`to` 不是 `v<数字>` 一律当场抛错 —— 旧写法接受坏记录，只会在几周后执行时以"未知迁移类型"的形式爆。
- `--to` 现在接受 `v2` / `2` / `V2` / `latest` / `newest`（`resolveTarget`），**省略即"登记表里可达的最高版本"**（`latestVersion()`），不再是写死的 `CURRENT_VERSION`；`CURRENT_VERSION` 的角色改成"代码原生理解的版本 + latest 的下界"。路径不可达时的报错把现存跳全列出来并指向 CONTRIBUTING，不再是一句干巴巴的 `No migration path`。
- 版本戳由框架统一盖：每一跳成功后调 `setFormatVersion(pocketDir, step.to)`（`executeStepWithLabel`），迁移函数**不需要也不应该**自己写 `format:` —— 漏写一次就会让下一跳从旧版本重新判断，多写一次则让"这一跳跑了两遍"看不出来。异常统一绑到"是哪一跳炸的"：`Migration step failed (v2 → v3: <name>): <原因>`。
- 回滚语义收紧：① 迁移前体检不干净 → 拒绝开始、刚建的备份目录立即删掉（旧实现会先把备份留在项目根，然后什么都不改地报错，用户看到一个从没迁移过的目录里躺着一个 `ContextPocket.backup-*`）；② 任何一跳抛错、或**跳完之后 `verify` 报 error**（迁移函数静默把数据写坏也不放过）→ 整体恢复，版本戳一起退回；③ **回滚成功后删掉那份备份**（此时它就是当前内容的副本，留着只会让人以为迁移过），只有全程成功才保留 `backupPath` 供对比；④ `rolledBack` 开关保证只恢复一次，避免"事后体检"与外层 catch 双重恢复互相踩。
- `--json` / MCP 不再泄漏内部结构：返回给外部的步骤经 `summarizeStep` 归一为 `{from,to,name,type,hasRun}`，函数对象不会被 `JSON.stringify` 带出去；`hasRun` 让人一眼看出某一跳是真干活还是空跑。
- 两个入口的输出补齐到同一句话：CLI `migrate --list` 固定四行（`Current version` / `Target version` / `Latest registered` / `Status`）+ 恒定列出 `Registered steps:`，`--list --json` 在目标写错时给 `{"ok":false,…}` 并退 1（旧代码无论 `info.error` 都说 `ok:true`，Agent 会以为"有迁移可用"）；dry-run 与完成态都按 `1. v1 → v2: …` 编号枚举每一跳，单跳以上额外标注 `multi-hop, all-or-nothing`。MCP 的 `context_pocket_migrate` 同样加 `to` 参数说明、`list` 分支补 `Latest registered` + `Registered steps:` + 错误时 `isError:true`，完成态也枚举跳序并写明"失败会整体回滚并删除备份"。
- 测试：新增套件 `tests/migrate.js` 11 例（`tests/run.js:17` 的 SUITES 加 `migrate.js`）—— 内置表就是 v1 自检而非自称更新、`registerMigration` 四种非法输入都被拒且**绝不留在表里**、反注册后 `latestVersion()` 必须回到 `v1`（否则假跳污染同进程后续用例）、`resolveTarget` 别名、**两条真跳拼成的链一次走完**（dry-run 一个字节不写且不留备份 → 真跑后 `readme.md` 里两个 marker 各恰好出现一次、版本戳落到 `v3`、升完不被自己的 `verify` 判错）、`--to v2` 只走半程、抛错跳整体回滚（断言第一跳**确实施加过**才谈回滚，readme/log 逐字节回到原样、版本戳回到 v1、体检 0 error、无残留备份）、静默写坏 log.md 被事后体检抓出并回滚、脏 pocket 拒绝开跑且不留备份、不可达目标把 `v7 → v8: unrelated island` 列出来、CLI 侧 `migrate --list --json` / `--to latest` / `--to banana` 的退出码与 JSON 形状。MCP 侧 `tests/mcp.js` 补 1 例：`context_pocket_migrate {list:true}` 的文本要给出版本表与登记跳，`to:'banana'` 必须是 `isError` 而不是把空目标当"没问题"报出来。
- 文档同步：`docs/MIGRATION.md` 的 migrate 一节改为链/别名/全有或全无语义，并新增"自动回滚触发条件表 + 只有自动回滚自己失败时才手动恢复"的步骤（原来写的是"删除有问题的 `ContextPocket/`"，会让人把唯一现场删掉）；`CONTRIBUTING.md` 新增「如何新增一个迁移步骤」（登记表写法、`run()` 四条规矩、**必须同一笔提交一起抬 `templates/readme.md` 的 `format:`**、要补哪三类测试）；`SKILL-advanced.md` 版本迁移一节、README 中英的 migrate 命令行、`docs/FAQ.md` 的"数据迁移怎么处理"（原示例教用户跑今天必然失败的 `--to v2`）一起改写。
- 套件计数：7 个套件 129 例（29+38+14+14+11+15+8）。`npm run lint`、`node tests/run.js`、`npm run smoke` 全绿。（同轮的密钥闸门再把三套抬高，最终 143 例，见下一条。）

**🔐 第 13 项体检：pocket 里不再躺着能直接用的密钥（新文件 `lib/secrets.js`）**

- 短板：`### User` 小节按设计就是**逐字原话**，而排查报错时用户贴进来的原文里最常带的就是 `sk-ant-…` / `ghp_…` / 私钥块。pocket 又是每轮新会话都要读回上下文的明文目录，Agent 还会把工具输出抄进下一条 T-block —— 一次粘贴会长期复利。此前 12 项检查只看结构与编号，**没有任何一项看内容形状**。
- `SECRET_RULES`（`lib/secrets.js:37`）分两档共 21 条：17 条 `error` 全是厂商前缀强特征（Anthropic、OpenAI 的 `sk-` 与 `sk-proj-`、Stripe、AWS `AKIA/ASIA/ABIA/ACCA`、GitHub 六种前缀与 fine-grained、GitLab、Google `AIza`、Slack token 与 webhook、npm、Twilio、SendGrid、Google OAuth、私钥块、JWT）；4 条 `warning` 是人的信息（身份证、SSN、手机号）与手写赋值。卡号走独立候选正则再套 **Luhn 门**，所以"订单号 4111 1111 1111 1112""构建时间戳 1727950000000"不会被打扰。
- 两档的分工是这次唯一的设计决定：**`error` 就是闸门**（`verify` 的 errorCount 涨 → pre-commit 的 `verify --quiet` 退 1、`archive` 与 `migrate` 拒绝执行），只有"泄露即需立刻轮换"的东西配得上；`warning` 永不拦提交，因为把客户手机号记进历史是正常业务，拦下来的结果只会是用户绕开工具。`scanText()` 的每条结果经 `mask()` 只留前 6 位 + 长度（`sk-ant…(30 chars)`），**扫描告警本身**的返回值、人类输出与 hook 的 stderr 都不带完整值 —— 三处各有断言钉着（`tests/unit.js` 扫结果 dump、`tests/pocket.js` 的 `formatVerifyResult` 全文、`tests/hooks.js` 真 git 端到端的拦截输出）。
  - 2026-10-07 定版后的一次真人全流程实测把这句话的边界照出来了：`verify --json` 里**确实**能看到整串密钥。不是掩码坏了——告警那条仍是 `log.md:43 Anthropic API key sk-ant…(57 chars)`；是 `--json` 除了告警还回吐 `data`，而 `data` 是这个 pocket 的逐字解析内容（`status`/`recall`/`search` 同理，它们的存在意义就是把记录原文还给调用方）。这条不是 bug，是 `--json` 的契约本身，所以改的是话术：**"扫描告警永远只有掩码" ≠ "工具的任何输出里都不会有密钥"**。想把密钥从记录里清掉，用它给的 `fix`（改那一行或 `log amend`），别指望任何输出帮你打码。
- `redactText()` 存在但**只有调用方显式要求才用**：`log append` / `absolute add` 都不自动改写文本。🔒 区的定义就是逐字原话，工具偷偷打码等于对历史撒谎；真要留这些串（写密钥轮换手册）就把 `config.md` 的 `- secret_scan: false` 关掉整块检查（`DEFAULT_CONFIG` 与模板同步加上，默认开）。
- 没有新增 CLI 子命令或 MCP 工具：这条挂在 `verify` 里就够，多一个入口就要多养一份 `help --json` ↔ README ↔ 26 工具对表。
- 顺带挖出两个**已经存在很久**的 bug：① `parseConfigValue` 只在"字符串"分支摘行尾注释，而 `templates/config.md` **每一行都带注释**，于是 `- quiet: false   # 说明` 解析成字符串 `'false'`（真值判断为"开着"）、`- archive_at: 800   # 说明` 退化成字符串 —— 用户在 config.md 里改配置从来没有生效。现在由 `stripTrailingComment()`（`lib/core.js:155`）先找"空白 + `#`"的第一个位置，`language: zh#1` 这类值不被截，`- key:   # 只写了注释` 视同没配、默认值继续生效。② `parseIndex` 把出厂标题 `# Index · T0` 判成 malformed header 报 **ERROR**，pre-commit 于是对**新项目的第一个提交**直接退 1 —— 用户还没记下任何东西就被拦下。T0 现在是合法取值（`malformedIndexT` 只在解析不出或超出可信范围时置真），而 `# Index · T99999999999` 依旧报 ERROR，两头各一条用例。
- 测试：`tests/unit.js` +7（带注释的取值仍是布尔/数字、缺文件或半行退回默认值、6 类厂商凭证命中且 5 段良性语料一条不报、掩码里查不到完整密钥、占位符与 `${ENV}` 引用不报而真实口令报 warning、卡号要过 Luhn、`redactText` 逐条换成 `[REDACTED:<label>]`）；`tests/pocket.js` +5（贴进 `### User` 的密钥报成 error 且 `details` 的 `log.md:11` 行号真的指到那一行、报告全文不含密钥、手机号只出 warning 且 `errorCount === 0`、`secret_scan: false` 之后一条不报、全新无记录的 pocket `errorCount === 0`、坏标题依旧是 error）；`tests/hooks.js` +2（**真 git 端到端**：带密钥的提交被 hook 拦下且拦截理由只有掩码、只有手机号的提交照常通过）。
- 文档同步：README 中英的 verify 行 12 → 13 项并写明两档语义，config 示例两处加 `secret_scan`；`SKILL.md` 新增一条 MUST-rule"密钥绝不逐字记录"（并明写它**不适用于** 🔒 区，因为那里就是原话）；`SKILL-reference.md` 的 config 模板；`docs/FAQ.md` 新增「隐私 / 安全」两问（贴进来的 key 会怎么样 / 🔒 会不会替我打码）与 verify 清单一行；`CONTRIBUTING.md` 新增「如何加一条密钥 / PII 检测规则」（四条不变量：severity 决定闸门、结果不得回显、`guard` 词边界何时关、取值字符类不能用 `[^\s…]`），端到端用例说明由三条改五条。
- 套件计数：7 个套件 143 例（36+43+16+14+11+15+8）。`npm run lint`、`node tests/run.js`、`npm run smoke` 全绿。

**🧮 一条从 hindsight 借来的规则：Agent 不许对用户的数字做加减法（`SKILL.md` MUST-rules）**

- hindsight 在它的整合提示里把这条写成硬约束（`hindsight-api-slim/hindsight_api/engine/consolidation/prompts.py:53`，`NO COMPUTATION`）：用户先说"我有 2 只狗"、后说"我有一只叫 Rex 的狗"，**不许**把计数改成 3 —— 你无法知道 Rex 是不是那 2 只之一。它宁可让记忆少合并不合并。
- 这条对 ContextPocket 同样成立，而且更容易踩：`state.md` 的待办数、接口数、"还剩几个 bug"都是 Agent 顺手算出来的，而它每次只看到最近几十轮。算错之后没有任何工具能发现——`verify` 检查编号连续与文件存在，检查不了"3 是不是应该等于 3"。
- 现在写成 MUST-rule：**只写用户说过的数字**，推导出来的量放 `### Uncertain` 并明说是推断。没有配套代码检查（无法从 Markdown 判断一个数是引述还是算出来的），所以它是一条约定而不是闸门 —— 与"归档从不自动发生"同一类。
- 文档同步：`SKILL.md` MUST-rules 新增一条；hindsight 的其余可借机制的取舍记录见本轮的结合点评估（结论摘要在同条目末）。

**📚 文档与代码对表（这次改的全是被代码证伪的句子）**

- 文件数：`full` 模式是 **10 个核心文件 + 2 个按需文件**（`lib/constants.js:11` / `:25`），`lite` 是 5 个（`:33`）。原先 `SKILL-reference.md` / `templates/config.md` / README 中英 / `SKILL-advanced.md` 都写"12 文件布局"。
- 冲突检测：`checkConflicts` 实现的是 **6 个维度**（技术栈 / 需求 / ADR / 风格 / 部署 / 🔒，`lib/query.js:334-356`）。`SKILL-reference.md` 列了 7 条，多出的"API 接口形状"**没有任何自动检测**——现在明写"工具不会替你发现它，别因为 check-conflicts 干净就认为接口没变"。
- 归档：`templates/on-demand/log-archive.md` 原本写着归档块是"3-4 行摘要"，而 `archiveLog` 实际**原文整块搬家**——照着模板做会永久丢历史。模板已重写为与代码一致（含"只追加不回写""`recall` 会标 archived"），并说明它只是纯文本 Agent 的手工参照。
- 代码从不读取 `templates/on-demand/`（`lib/bootstrap.js` 只复制 `templates/` 根层，`lib/writer.js:389` `readFileOrTemplate` 同理），`SKILL-advanced.md` 原先说"归档时从 on-demand 复制模板头"是假的，已改为"工具自己生成，头部与模板一致"。
- 格式版本检测发生在 `migrate`（`detectFormatVersion`），**不在 `bootstrap`**；`MIGRATION.md` / `SKILL-advanced.md` 原先都写 bootstrap 会比对版本并提示迁移。当前迁移表只有 `v1 → v1`，`migrate --to v2` 报 `No migration path from v1 to v2`（链语义与 `--to latest` 见上面「版本迁移链真的能串起来」那条 —— 那一条把这段描述里承诺过的多跳与回滚真正实现了）。
- `bootstrap` **不做任何体检**：`docs/FAQ.md` 原先三处写着"激活时自动漂移检查""已存在则只做漂移检查"，认知漂移其实要 `verify --drift` 才跑。
- `archive_at`：原先写"超过阈值自动触发归档"。现在统一为"阈值只产生提示（`status` / `verify`），搬动历史必须有人触发"，`SKILL.md` 的 MUST-rules 增加一条"永不主动归档"。
- `docs/FAQ.md`：索引"毫秒级重建"改为实测数字；`search` 命令行列出 `--limit/--offset/--no-index`；补上此前完全没提的 `log append` / `log amend` / `absolute add` / `why` / `index` / `distill` / `import` / `hub`；`hub add` 这种不存在的子命令删掉（真实为 `list|pref|remove`）；pre-commit 一节补全两步行为。
- `CONTRIBUTING.md`：项目结构树补 `bin/ lib/ tests/ mcp-server.js package.json scripts/`（原来只有 templates 与 docs），templates 清单改成真实的 10 + `on-demand/` 两个；"本地验证"加入 `npm test` / `npm run lint` / `npm run smoke` 与测试的隔离说明；PR 合并标准加"测试全绿"。
- `docs/COMPATIBILITY.md` 的"最后更新:2024"改为与 skill 1.1.0 对齐；`SKILL.md` 版本号同步为 `1.1.0`。

### Changed

**🚫 移除斜杠命令层，改为意图触发的快速响应（Breaking: 交互层）**

- **ContextPocket 不再有任何斜杠命令**。原先的 16 个（`/openpocket`、`/statuspocket`、`/putintopocket`、`/recall`、`/diff`、`/searchpocket`、`/why`、`/questions`、`/check-conflicts`、`/handoff`、`/verify`、`/sync`、`/digest`、`/import`、`/exportpocket`、`/resetpocket`、`/help`）全部移除。
- **原因**：`/verify`、`/import`、`/diff`、`/search`、`/handoff` 这类短命令名会与 Agent 自带的同名内置命令冲突，用户需要记忆一整张命令表却没有对应收益。Agent 本身就是执行方，让用户去记命令是多余的一层。
- **替代方案**：用户用自然语言表达意图，Agent 自行判断并调用对应能力。`SKILL.md` 新增 **Quick responses** 章节（意图 → 动作 → 一行回应对照表），并加一条硬规则：**永不告诉用户"输入 /xxx"**；用户若习惯性说出斜杠命令，按最近的意图直接执行。
- **激活方式改为全自动**：项目没有 `ContextPocket/` → Agent 在第一轮实质对话时主动 `bootstrap`；已有 → 读 `index.md` + `state.md` 后续写。**用户永远不需要执行任何命令**。
- **底层能力完全保留**：`log amend`、`absolute add` 等 CLI 子命令与 MCP 工具（现共 26 个）不受影响，只是不再以斜杠命令对外暴露。`SKILL.md`、README（中英）、`docs/`（FAQ / COMPATIBILITY / MIGRATION）、`SKILL-advanced.md`、`SKILL-reference.md`、`CONTRIBUTING.md`、模板（`readme.md` / `absolute.md` / `config.md` / `on-demand/handoff.md`）以及运行时输出（`generateHandoff` 的 Resume 段、`validator` 的 handoff 过期提示、`distill` 报告头）中的斜杠命令引用已全部改写。
- 破坏性变更仅限交互层：**CLI 子命令与 MCP 工具名一个都没动**，`ContextPocket/` 数据格式仍是 `format: v1`，存量项目无需迁移。

### Fixed

**🔍 `sync` 覆盖判定只认严格格式，每次提交都多出冗余 `[auto]` T-block**

- `parseActionLine`（`lib/parser.js`）原本只匹配 `<操作> <文件> — <描述>` 这一种格式，解析不出 `file` 就丢弃。Agent 按 SKILL.md 要求写了"文件路径 + 操作类型"但没用破折号时（例如 `新增 src/a.ts 和 src/b.ts`），`file` 为 null → `detectUnrecorded` 判定为"未记录" → **每次提交都被自动补录一个 `[auto]` T-block**，日志逐渐膨胀。
- 修法：`parseActionLine` 新增 `files` 字段，从整行里用 `PATH_TOKEN_RE` 抽出所有路径（目录段可选 + `stem.ext`，扩展名必须字母开头）。因此 `1.0` / `3000` / `v1.2.3` / 纯中文描述都不会被误当路径，Windows 反斜杠路径正常识别。
- `detectUnrecorded`（`lib/sync.js`）与 `extractFilesFromBlock`（`lib/query.js`）改为优先使用 `files`，回落到旧的 `file` 字段，老数据不受影响。
- 副作用（正向）：`context-pocket why` 的反查命中率同步提高，自然语言 Action 里提到的文件现在也能反查到。
- **取舍**：这样会把"在描述里提到但未实际改动"的文件也算作已覆盖，可能漏掉真正的漏记。方向上这是安全的一侧（宁可多记一条带免责声明的 `[auto]`，也不要放过真实漏记），且该性质在原有 em-dash 格式下本就存在。
- `SKILL.md` 的 Steps 补上 Action 行的硬格式规范 `<操作> <文件路径> — <做了什么>`，并说明它不是格式洁癖而是 `sync` / `why` 的读取依据。

**🔀 `pitfall` / `pitfalls` 参数名不一致**

- `state update` 历史上用单数 `--pitfall`，`log append` / `log amend` 用复数 `--pitfalls`。改任一边的名字都会破坏已有脚本，因此**两个名字都收**。
- `lib/core.js` 新增 `pickFirst(obj, ...keys)`；CLI（`state update` / `log append` / `log amend`）与 MCP（`context_pocket_state_update` / `_log_append` / `_log_amend`）统一走它，inputSchema 与帮助文本标注了别名关系。
- 旧名全部保留，无破坏性变更。

**🐛 端到端实测发现并修复的 3 个 P0 缺陷（此前版本会真实阻塞用户）**

1. **pre-commit hook 会锁死提交，且无自救路径** → 新增 `log amend`
   - `log append` 的 `--user` 是可选参数，但 `verify` 把缺 `### User` 判为 **ERROR**，而 hook v2 的规则是"error 阻止提交"——于是 `log append`（不带 `--user`）产出的状态被自己的健康检查拒绝，**此后每一次 commit 都被拦下（实测 exit 1）**。
   - 更糟的是此前**没有任何命令能补上已写入 T-block 的 User 段**，而 SKILL.md 又明令"禁止手改 markdown"，用户只剩 `git commit --no-verify` 或卸掉 hook 两条路；verify 给出的 `Fix:` 建议本身不可执行。
   - 新增 `context-pocket log amend <Tn> --user "..." [--action "..."] [--decisions|...]` / MCP `context_pocket_log_amend`：只补**缺失**小节，按规范顺序插入，**永不覆盖已有内容**（符合 Corrections 区"只追加、不篡改历史"的哲学）。
   - `lib/validator.js` 的两条 `Fix:` 建议改为直接输出可执行命令。
   - SKILL.md Per-turn rules 增加 MUST：append 时必须传用户原话；已漏记的立即用 `log amend` 补救。
   - 附带修复：`bin/context-pocket.js` 的 `parseArgs` 子命令白名单漏了 `amend`，导致新命令落到"Unknown command"兜底分支。

2. **`absolute.md` 没有任何写入路径，🔒 特性在 CLI/MCP 模式完全不可用**
   - 全仓 `absolute` 只出现在 `parseAbsolute`（读）、`checkAbsoluteConflicts`（读）、`generateHandoff`（读）——**没有一处写**；`putintopocket` / `exportpocket` / `resetpocket` 在所有 JS 文件中出现 0 次。
   - 后果：MCP 模式（自评 10/10）与 CLI 模式（9.5/10）都无法记录一条🔒红线，而 `check-conflicts` 第 6 维在读它、`verify` 有"🔒 完整性"检查，且这两种模式都禁止手改 markdown。
   - 新增 `context-pocket absolute add --text "..." [--gist] [--t-id]` / MCP `context_pocket_absolute_add`，同步更新 `index.md` 的🔒计数；写入时自动清掉 `templates/absolute.md` 里的占位示例块（否则会被 `parseAbsolute` 当成真条目读进来）。
   - SKILL.md / README 命令表同步标注 `/questions`、`/exportpocket` 为 *(agent-side)*，不再宣称"每个命令都 1:1 对应 CLI + MCP 工具"。

3. **`handoff.md` 首次生成就是一面模板占位符 + 空的 Code Map 段**
   - 交接摘要的唯一用途是让下一个 agent 5 秒上手，但 bootstrap 后生成的 handoff 包含 `<2-4 lines: what works…>`、`<known traps: "do NOT change X because …">` 这类**未填写占位符**——对"上下文管理"工具而言是直接的上下文投毒。
   - 根因一：`templates/state.md` 保留全部占位符 → `status` / `handoff` 原样搬运。
   - 根因二：Code Map 段用 `file.ext → desc` 正则匹配，但 `bootstrap` 写进 Structure 的是**盒线目录树**（`├── src/`），永远匹配不上 → 该段对任何 bootstrap 项目恒为空。
   - 新增 `lib/core.js` 的 `isPlaceholderLine` / `stripPlaceholders` / `cleanIdentityLine`（只过滤"整行或整段值都是 `<...>`"的情况，不误伤泛型 / HTML / 路径里的尖括号），应用到 `status` 与 `handoff`。
   - 新增 `parseTreeLines()` 正确解析盒线目录树，输出最多 2 层、带完整父子路径，有手写描述时一并带出。

**📖 文档纠错（文档在教 Agent 做错的事）**

- `/import`：原写"Dry-run by default; `--apply` to write"，**语义完全反了**——实际默认直接写入，且不存在 `--apply` 参数（是 `--dry-run`）。已改正（README / README.zh-CN 同）。
- `/sync`：原写"commit pending ContextPocket changes"，实际语义是**对比 staged 变更与最近 T-block 的文件路径并补录漏记**，`sync` 从不 commit。已改正。
- `/digest`：报告文件名 `.distill-report.md` → 实际是 `digest-<date>.md`。
- MCP 工具清单：原列 16 个且包含**不存在的** `search_no_index`（实为 `search` 的 `noIndex` 参数），同时漏掉 9 个真实工具。现按实际注册列表改为 26 个。
- `/why`：`context-pocket why` 早已实现且在 README CLI 表里，但**两张 slash 命令表都没有** → Agent 根本发现不了。已补入 SKILL.md 与 README / README.zh-CN。
- Hub 路径：`$CONTEXTPOCKET_HOME/hub/` → 实际 `CONTEXTPOCKET_HOME` 就是存放 `hub.json` 的目录本身。
- `/check-conflicts` 的第 6 维描述为 "API"，实际是 "🔒 绝对保留"。

**🔧 输出噪声**

- `check-conflicts` 干净项目原本显示 `info: 6`（把 6 个"该维度无冲突"的占位说明计成了发现）。现在这类项标记 `benign: true`，仍然打印但不计入 info 计数。
- `status` 不再把模板占位符当真实的下一步 / 坑点打印。

### Added

**🔍 Path A：借鉴参考项目的新增机制**

- **`why` 反向检索** — `context-pocket why <file-path> [--limit <N>]`
  - 借鉴 [ThoughtDAG](https://github.com/chenxiachan/thoughtdag) 的 `why_file` / `why_check` 思路
  - 给定文件路径，返回提到该文件的所有 T-block，按时间倒序
  - 检索范围：Action / Changes / Pitfalls / Notes / Commits / User section
  - 路径分隔符自动兼容（Windows `\` ↔ Unix `/`）
  - 新 MCP 工具 `context_pocket_why`（参数：filePath / limit）
  - 新增文件：`lib/query.js` 新增 `why()` 函数

- **`verify --drift` cognition refresh 轻量版** — `context-pocket verify --drift [--drift-last-n <N>]`
  - 借鉴 [AOCI-CODE](https://github.com/aoci-spec/aoci-code) 的 cognition refresh 概念
  - 对比「最近 N 个 T-block 引用的文件」vs「working tree 中实际存在的代码文件」
  - 检测两类 drift：
    - **Unrecorded (WARNING)**：working tree 中有但 T-block 没提到的代码文件
    - **Phantom (INFO)**：T-block 提到了但 working tree 找不到的文件
  - 默认关闭（路径扫描开销大），需显式 `--drift` 启用
  - `--drift-last-n <N>` 调节回看的 T-block 数（默认 5）
  - MCP 工具 `context_pocket_verify` 新增 `drift` / `lastN` 参数
  - `lib/validator.js` 新增 `checkLogCognitionDrift()` 函数

**📦 Path B：借鉴 Basic Memory 的新增机制（2026-09-19）**

- **检索索引层** — `context-pocket index [--rebuild]` / `context_pocket_search [--no-index]`
  - 借鉴 [Basic Memory](https://github.com/basicmachines-co/basic-memory) 的「Markdown 为唯一真相源 + 派生索引缓存」架构
  - Markdown 文件始终先写；索引只是 `ContextPocket/assets/search-index.json` 里一份可随时重建的派生缓存
  - 索引范围：log.md + log-archive.md 的所有 T-block、decisions.md 的 ADR、requirements.md 的需求、preferences.md 的偏好行
  - 分词：拉丁词按非字母数字切分；CJK 文本取二字组（bigram），中英混合查询均可命中；查询用 AND 语义 + 子串校验去噪
  - 懒刷新：search 前对比源文件 mtime+size 签名自动增量重建；缓存损坏 / 缺失 / `INDEX_VERSION` 对不上都是**当场重建后仍走索引**，只有连重建都做不成（只读盘、`assets/search-index.json` 那个位置被别的东西占住）才透明回退到全量扫描，两条路径的命中与排序相同。（这一句最初写的是"索引损坏 / 缺失自动回退到全量扫描"，与实测不符，2026-10-06 收尾时按实测改过——见上面 `--no-index` 那一节，四种情况都有用例钉住）
  - 新 MCP 工具 `context_pocket_index`（参数：rebuild）
  - 新增文件：`lib/indexer.js`（buildIndex / searchWithIndex）

- **用户级 Hub** — `context-pocket hub [list|pref|remove]`
  - 借鉴 Basic Memory 的「跟着人走」用户级知识库定位
  - 存储位置：`~/.contextpocket/hub.json`（可用 `CONTEXTPOCKET_HOME` 环境变量重定向到网盘 / dotfiles 仓库，实现多机共享）
  - 内容：注册过的项目（路径 → 名称 / 类型 / 最新 T / 最近活跃时间）+ 用户级全局偏好（跨项目生效，项目 preferences.md 缺失时兜底）
  - 设计原则：hub 只是注册表，项目数据永远在各项目的 `ContextPocket/` 里；所有写入都是 best-effort，hub 故障绝不影响正常记录
  - 触发点：`bootstrap` 自动 `registerProject`；`log append` 自动 `touchProject` 更新最新 T
  - 新 MCP 工具 `context_pocket_hub`（action: list / pref / remove）
  - 新增文件：`lib/userhub.js`（getHubDir / getHubFile / readHub / writeHub / registerProject / touchProject / removeProject / listProjects / setGlobalPref / getGlobalPref）

- **旧信息蒸馏** — `context-pocket distill [--dry-run]`
  - 借鉴 Basic Memory 的「活文档」思路：归档不等于埋葬
  - 扫描 log-archive.md + log.md 旧轮次，把仍然有价值的决策 / 坑点 / 偏好 / 待确认项 提取成 `ContextPocket/digest-<date>.md` 报告
  - 由 Agent 或用户逐条判断后合回 `decisions.md` / `state.md` / `preferences.md` 这些活文档
  - 报告只读不改活文档 —— 合并动作由 Agent 完成（需人工判断是否仍然有效），合并完可删
  - 新 MCP 工具 `context_pocket_distill`（参数：dryRun）
  - 新增文件：`lib/distill.js`（distill）

- **历史会话导入** — `context-pocket import --file <session.jsonl> [--source auto|claude-code|codex] [--limit N] [--truncate N] [--dry-run]`
  - 让「中途启用」的项目不丢历史
  - 把各家 Agent 留在本地磁盘的会话记录（JSONL）解析成 T-block 批量补录进 log.md，T 编号从当前最新继续，统一打 `[imported]` 标签
  - 支持 `claude-code`（`~/.claude/projects/<project>/<session>.jsonl`）、`codex`（`~/.codex/sessions/`）、`auto`（嗅探兜底，识别任何 `{message:{role,content}}` / `{role,content}` 形状的 JSONL）
  - 自动跳过工具调用噪音（tool_use / tool_result）、命令标记、系统注入文本
  - 新 MCP 工具 `context_pocket_import`（参数：file / source / limit / truncate / dryRun）
  - 新增文件：`lib/importer.js`（importSession）

### Changed

**🪶 文档精简（2026-09-19）**

- **`SKILL.md` 拆分为 3 文件**（51.7 KB → 18.8 KB 主文件，−64%）
  - [`SKILL.md`](SKILL.md) — 日常必读主体：YAML + Usage boundary + Execution modes + Commands + Per-turn rules + Pre-reply safety hook + Corrections + Cross-agent handoff（18.8 KB / 203 行）
  - [`SKILL-advanced.md`](SKILL-advanced.md) — 按需加载：Bootstrapping from templates + Project type templates + Archiving + Edge cases（含 Version migration）（6.8 KB / 79 行）
  - [`SKILL-reference.md`](SKILL-reference.md) — 纯参考：完整 Layout + 每个文件的模板注释 + log.md T-block 完整规范 + filled example + config.md 字段表（13.4 KB / 265 行）
  - 顶部加交叉链接 + 入口说明
- **`templates/help/` 目录移除**（11 文件 / 14.9 KB → 0）
  - 之前用于存放 `/help` 命令的分类回复模板，但**所有代码均不引用**（`bin/context-pocket.js` / `lib/*.js` / `mcp-server.js` 都没有 `readFileSafe('help/...')` 调用）
  - SKILL.md 中 `/help` 段改为"Agent 内联生成，引用本文件 Commands 区与 `docs/FAQ.md`"
  - CHANGELOG 历史记录保留（自然注脚）
- **README 中英版**顶部加一行提示三件套；CONTRIBUTING 的"在 SKILL.md 加 Bootstrapping 表一行"改为指向 `SKILL-advanced.md`

**🛣️ Roadmap 全部完成**

- **`bootstrap` 命令** — `context-pocket bootstrap` 一键初始化项目 ContextPocket
  - 自动检测项目类型（frontend / backend / fullstack / data / mobile）
  - 扫描项目目录树，预填 code-map.md 和 state.md
  - 复制所有模板到 ContextPocket/，更新 index.md、readme.md、config.md
  - 支持 `--project-type` / `--mode` / `--language` 参数
  - 新文件 `lib/bootstrap.js`（detectProjectType / scanProjectTree / bootstrap / prefillTemplate / updateConfigValues / updateGitignore）

- **查询命令** — `context-pocket recall` / `diff` / `search` / `check-conflicts`
  - `recall <T-id>` — 查看指定 T-block 完整详情
  - `diff <Ta> <Tb>` — 对比两轮的需求 / ADR / 文件变化
  - `search <keyword>` — 全文搜索所有 T-block（含 gist、tags、notes）
  - `check-conflicts` — 6 维冲突扫描（技术栈 / 需求 / ADR / 风格 / 部署 / 🔒），三级严重度（critical / warning / info）
  - 新文件 `lib/query.js`

- **归档命令** — `context-pocket archive [--keep-last <N>] [--dry-run]`
  - 归档前 verify → 归档 → 归档后 verify → 失败自动回滚
  - 旧 T-block 移到 log-archive.md（压缩为 3-4 行摘要）
  - 附件移到 assets/archive/，更新所有路径引用
  - writer.js 新增 archiveLog()

- **状态写入命令** — `context-pocket state update` / `preferences update` / `code-map update`
  - `state update --summary "..." [--next-step "..."] [--pitfall "..."]` — 更新 state.md
  - `preferences update --key "..." --value "..."` — 更新 preferences.md
  - `code-map update` — 重扫项目目录，保留已有描述，新文件标记 TODO
  - writer.js 新增 updateState() / updatePreferences() / updateCodeMap()

- **迁移工具** — `context-pocket migrate [--to <version>] [--dry-run] [--list]`
  - 格式版本自动检测（readme.md `format: v<N>`）
  - 迁移前自动备份（ContextPocket.backup-TIMESTAMP）
  - 迁移后 verify，失败自动回滚
  - 当前 v1 noop 迁移（格式校验）
  - 新文件 `lib/migrate.js`

- **Git pre-commit hook v2** — `context-pocket install-hook` / `uninstall-hook`
  - **v2 两步行为**（升级自 v1 的单步 verify）：
    1. `context-pocket sync --auto` — git 漏记兜底：自动检测 staged 变更中未被最近 T-block 记录的文件，自动补录一个 `[auto]` T-block（解决 Agent 漏记的核心问题）
    2. `context-pocket verify --quiet` — 健康检查：有 error 阻止提交，warning 放行
  - `install-hook` 自动升级：已安装 v1 hook 时再次运行自动替换为 v2，无需手动卸载
  - Hook 安装时注入 CLI 绝对路径（正斜杠格式），不依赖 node_modules / npx
  - Hook 内 git 出错 / node 找不到 / CLI 不存在时均跳过（不阻断提交）
  - 成对 MARKER 管理 hook 区块，精确安装/升级/卸载
  - 新文件 `lib/sync.js`（detectUnrecorded / buildCatchupBlock / sync）
  - `lib/hooks.js` 升级为 v2

- **`sync` 命令** — `context-pocket sync [--auto] [--dry-run] [--last-n <N>] [--quiet]`
  - **检测原理**：对比「git staged 变更」与「最近 N 个 T-block 的 Action 文件路径」，找出漏记项
  - 默认 report-only（不写入），`--auto` 时自动补录 `[auto]` T-block
  - `--dry-run` 显示补录计划而不写入；`--quiet` 单行输出（hook 使用）
  - 覆盖判定：同一文件在最近 N 个 T-block 中出现过则跳过（幂等）
  - 忽略 `ContextPocket/` 自身；非 git / 无 log.md / git 出错时安全降级（skip 不报错）
  - CLI exit code：0 = 成功（含 clean/auto-fill/skipped），1 = 检测到 error 需要手动处理
  - MCP 新增 `context_pocket_sync` 工具（参数：auto / dryRun / lastN）

- **MCP Server 全量工具** — mcp-server.js 新增 11 个工具
  - `context_pocket_bootstrap` / `context_pocket_recall` / `context_pocket_diff` / `context_pocket_search`
  - `context_pocket_check_conflicts` / `context_pocket_state_update` / `context_pocket_preferences_update` / `context_pocket_code_map_update`
  - `context_pocket_archive` / `context_pocket_migrate` / `context_pocket_install_hook` / `context_pocket_uninstall_hook`

- **CLI 路由完善** — bin/context-pocket.js 现有 17 个命令全部完成路由

**三形态架构（MCP + CLI + 纯 Skill）**
- **纯 Skill 模式可靠性提升 6/10 → 8/10**
  - SKILL.md 新增「Pre-reply safety hook」强化版：每轮开始前**强制 T 编号一致性检测**（读 log.md 最新 T → 对比对话窗口内容 → 漏记则拒绝继续并补档）
  - 所有关键规则改为 **MUST 强制措辞**，P0 规则（`log.md` 必须追加）标注为 non-negotiable
  - Mode 3 描述明确说明：Pre-reply safety hook 中的 MUST-rules 是**不可绕过的强制规则**
  - Lite mode 描述强化：即使 Lite mode 也必须遵守所有 per-turn MUST-rules

- **CLI 工具** `bin/context-pocket.js`（零依赖 Node.js 脚本，6 个命令）
  - `verify` — 健康检查（10 项校验：文件存在性 / T-id 连续性 / R-id 连续性 / ADR 连续性 / index 一致性 / T-block 格式 / 引用完整性 / code-map 漂移 / handoff 过期 / 标题一致性）
  - `status` — 一行状态摘要（当前 T 编号 / 开放需求数 / 待确认数 / 绝对保留数）
  - `log append` — 追加 T-block 轮次记录（自动分配 T-id / 自动更新 index / session 分组）
  - `req add` — 新增需求（自动分配 R-id / 安全编号校验 / 防止重复）
  - `decision add` — 新增架构决策（自动分配 ADR 编号 / 安全校验）
  - `handoff` — 生成单文件交接摘要 handoff.md
- **MCP Server** `mcp-server.js`（零依赖，stdio 传输协议）
  - 6 个 MCP 工具：`context_pocket_status` / `context_pocket_verify` / `context_pocket_log_append` / `context_pocket_req_add` / `context_pocket_decision_add` / `context_pocket_handoff`
  - 支持 MCP 的 Agent（Trae / Claude Desktop 等）可直接调用，结构化参数零格式错误
- **核心逻辑层** `lib/`（6 个模块，CLI 和 MCP 共享同一套逻辑）
  - `constants.js` — 常量定义（文件名、优先级、标签等）
  - `core.js` — 路径解析 / 配置读取 / 工具函数
  - `parser.js` — Markdown 结构化解析（log / requirements / decisions / index / state / preferences / absolute）
  - `validator.js` — 校验器（10 类检查项，按严重程度分级）
  - `writer.js` — 写入器（安全编号生成 / 自动同步 index / 防重复）
  - `formatter.js` — CLI 输出格式化（彩色 / 分组 / 严重度标识）

**Skill 升级**

- SKILL.md 新增「Execution modes」章节：三模式自动降级链路（MCP → CLI → 纯 skill），Agent 启动时自动检测最优模式
- `/openpocket` 新增模式检测逻辑：优先用 MCP，其次 CLI，最后 fallback 到纯 skill 手写
- Per-turn 写入流程改为模式化：有 CLI/MCP 就调工具，没有就手写
- 新增 `/check-conflicts` 命令：全面扫描 ContextPocket 中的潜在冲突（6 项扫描范围，按严重程度分级输出）

**文档完善**

- `docs/MIGRATION.md` — 版本迁移指南（迁移策略 / 自动检测 / 手动迁移步骤 / 回滚方案）
- `docs/FAQ.md` — 常见问题详细解答（数据存储 / 工作流 / 协作 / 性能 / 边界 / 故障 6 大类）
- `docs/COMPATIBILITY.md` — Agent 兼容性列表 + 最小子集降级方案
- `CONTRIBUTING.md` — 贡献指南（Bug 报告 / 功能建议 / PR 流程 / 开发约定）
- README.md 新增三模式安装说明 + MCP 配置示例
- README.md 新增 Quick Start 快速上手指南
- README.zh-CN.md — 完整中文文档

**模板优化**

- `templates/on-demand/` — 按需创建模板目录（log-archive.md / handoff.md），bootstrap 时不复制
- `templates/help/` — 11 个 /help 分类回复模板，从 SKILL.md 拆分出来
- `templates/code-map.md` — 从单文件占位扩充为完整骨架模板（Structure / Key Relationships / Recently Changed 三节）
- `templates/config.md` — 新增标签双语说明注释

### Changed

- SKILL.md 精简：/help 章节从 ~430 行减至 ~50 行，详细回复模板移至 `templates/help/`
- SKILL.md 结构优化：头部新增 YAML frontmatter（name / description / version / format / tags）
- SKILL.md ADR 模板：新增 `Supersedes:` 字段，与 templates/decisions.md 对齐
- SKILL.md 冲突检测：从模糊描述改为 7 项 checklist（技术栈 / 需求 / ADR / 风格 / 部署 / 🔒 / API）
- SKILL.md 归档机制：增加归档前验证、归档后验证、失败回滚机制
- SKILL.md 标签说明：明确标签语言跟随 `language` 配置（zh / en 两套默认标签）
- SKILL.md Edge cases：新增版本迁移说明（格式版本检测 + /migrate-pocket 预留）
- `/help` 命令大幅强化：采用多级菜单导航（8 个分类 + 多种查询方式）
  - `/help` 主菜单（8 个分类入口，数字 / 分类名导航）
  - `/help all` 完整命令列表（扁平视图）
  - `/help <数字/分类名>` 进入对应分类详情
  - `/help <命令名>` 单命令详细说明
  - 智能识别（自然语言匹配，如"怎么用" / "出问题了" 等）
- README.md 排版优化：顶部更紧凑，开头直接说明使用场景 / 效果 / 方法
- CHANGELOG.md 结构调整：更清晰的版本分层 + Roadmap 章节

### Fixed

- ADR 模板不一致：SKILL.md 正文 ADR 模板缺少 Supersedes 字段，现已补充
- `status` 命令偏差：T-block 含 `[auto]` 标记时 action gist 格式与普通 T-block 不同，now correctly extracts gist from `· [` separator
- `index.md` 计数不一致：bootstrap 后 `templates/preferences.md` 包含 6 条示例内容未被清理，导致 verify 告警；已替换为注释说明占位
- `verify` bootstrap 误报：bootstrap 后 `index.md` 预填 `T0 (empty)` 且 `log.md` 为空是正确状态，`lib/validator.js` 新增 bootstrap 空白状态容错（index=T0 & log.latestT=0 时不报警）
- `lib/bootstrap.js`：index.md T-range 预填改为 `T0 (empty — bootstrap state)`，与容错逻辑对齐
- README 示例与规则不一致：T-block 示例的 Action 动词改为中文操作类型，与 language 配置对齐
- log-archive 模板与"按需创建"矛盾：模板移至 on-demand 目录，bootstrap 不复制
- README FAQ 折叠面板渲染问题：HTML 标签在部分渲染器不生效，改为纯 Markdown Q&A 格式
- README 底部 Star 提示 HTML 标签渲染问题：改为纯 Markdown 文本
- **`lib/hooks.js` exit code bug**：hook 脚本末尾无条件 `exit 0` 丢弃了 verify 失败时的 `$VERIFY_RC=1`，导致所有 commit 均被放行；已修复为 `exit $VERIFY_RC`，确保 verify error 时正确阻止提交

---

## [1.0.0] - 日期未留档

> 1.0.0 的确切发布日没在本仓库留档（没有 git 历史可查，npm/GitHub 的 release 记录才是权威），
> 所以这里不编一个日期，只保留版本号。
>
> 以下是 1.0.0 **当时对外宣称**的特性清单，原样保留作为历史记录。其中有几条与代码实际行为不符，
> 以上面 `[1.1.0]`（2026-10-07）一节的 Added / Changed / Fixed 为准：文件布局是 **10 核心 + 2 按需**
> （lite 5 个），不是 12；`archive_at` 只产生提示，**归档从不自动发生**；斜杠命令层已在 1.1.0 整体移除；
> `verify` 现在是 15 项检查而非 6 项。

### 核心特性

- **12 文件完整布局**：readme / index / state / requirements / preferences / decisions / code-map / log / log-archive / absolute / handoff / config
- **12 个对应模板**：`templates/` 目录下每个文件都有规范模板
- **T-block 轮次记录**：每轮对话一个 T-block，包含 Summary / Tags / Action / Changes / Decisions / Pitfalls / Questions 等结构化字段
- **R-id 需求追踪**：每条需求有唯一编号，状态管理（open / done / superseded），支持优先级和分类
- **ADR 架构决策记录**：Architecture Decision Records，记录每个重要技术决策的上下文、选择、后果
- **P0–P6 优先级降级**：token 紧张时按优先级跳过非核心文件，log.md 永远不跳

### 命令系统

- **激活 / 状态**：`/openpocket`（激活 + 漂移检查）、`/statuspocket`（一行状态）、`/putintopocket`（标记本轮重要内容）
- **查询检索**：`/recall`（查看某轮）、`/diff`（对比两轮）、`/searchpocket`（关键词搜索）
- **待办管理**：`/questions`（待确认项汇总）、`/sync`（补档漏记轮次）
- **交接协作**：`/handoff`（生成交接摘要）、`/verify`（6 项健康检查）、`/exportpocket`（快照导出）
- **维护**：`/resetpocket`（归档重建）、`/help`（帮助系统）

### 智能化特性

- **项目类型自动检测**：frontend / backend / fullstack / data / mobile 五种类型，自动预填 code-map 和 state 扩展字段
- **Lite 模式**：mode: lite 只建 5 个核心文件，适合小项目
- **自动归档**：log.md 超过 archive_at 行自动触发归档，旧轮次压缩移到 log-archive.md
- **🔒 绝对保留区**：absolute.md 永不压缩归档，存放最重要的约束和红线
- **强需求检测**：自动识别"必须 / 绝不 / MUST / NEVER"等强语气，提示标记为绝对保留
- **冲突检测**：写入前检测方向性矛盾，冲突时标记 superseded 由用户裁决
- **漂移检查**：code-map vs 实际目录树对比，检测新增 / 删除 / 移动的文件
- **Pre-reply 安全钩子**：回复前三问自检，防漏记
- **append-only 修正**：历史 T 块有错不篡改，追加 T<n>-fix 修正块

### 安全与可靠性

- **永不静默覆盖**：检测到冲突时保留旧信息并标记，由用户裁决
- **快照导出**：/exportpocket 导出单文件快照，保留最新 3 份
- **/verify 体检**：6 项健康检查（文件存在 / 编号连续 / 引用有效 / 漂移 / 过期 / 计数一致）
- **串行交接约定**：明确同一项目只能一个 Agent 写，避免并发冲突

---

## 🛣️ Roadmap

> 下面三档功能已全部随 **1.1.0（2026-10-07）** 发布，改动明细见本文件上面的 1.1.0 一节。
> 唯一没做的一条是 MCP resources / prompts，留给后续版本。

### 优先级 🔥 高（已 ✅）

- [x] **`bootstrap` 命令** — CLI 一键创建 ContextPocket，自动检测项目类型、预填 code-map 和 state
- [x] **查询命令** — recall / diff / search / check-conflicts
- [x] **`check-conflicts` 命令** — CLI 版冲突扫描，6 项扫描范围，三级严重度

### 优先级 ⭐ 中（已 ✅）

- [x] **归档功能** — `context-pocket archive`，归档前/后验证 + 自动回滚
- [x] **更多写入命令** — state update / preferences update / code-map update

### 优先级 🟢 低（已 ✅）

- [x] **迁移工具** — `context-pocket migrate`，格式检测 + 备份 + 回滚
- [x] **Git pre-commit hook** — `install-hook` / `uninstall-hook`
- [ ] **MCP 增强** — 资源（resources）和提示（prompts），后续版本

---

## 版本说明

### 语义化版本

- **Major (X.0.0)**：破坏性变更（模板格式、文件名、命令名变更）
- **Minor (x.X.0)**：新增功能 / 新增命令（向下兼容）
- **Patch (x.x.X)**：Bug 修复 / 文档修正
- 版本号只写一处：`package.json` 的 `version`。CLI 与 MCP 都经 `lib/version.js` 读它，
  不要再往入口里抄第二个字面量（`FALLBACK_VERSION` 是唯一那个必须同步的兜底值，用例盯着它）。

### 数据格式版本

`ContextPocket/readme.md` 头部的 `format: v<N>` 是 **数据格式版本**，与 skill 版本（`package.json`）独立。
当前代码原生理解 `v2`（`lib/migrate.js:25` 的 `CURRENT_VERSION`），新建的 pocket 由 `templates/readme.md:1`
写成 `format: v2`。已经存在的 `format: v1` 目录**照旧可读**，只是每轮没有时间行；要补上就跑
`context-pocket migrate --to latest`（`verify` 会报一条 `format-upgrade` WARNING 提醒，从不拦提交）。
即使 skill 升到 2.0，旧项目的 `format: v1` 仍应可读；未来再有不兼容的格式升级，同样走"登记一跳迁移"
这条路，而不是让旧目录变成砖。

版本号本身（skill / CLI / MCP 那一处 `1.1.0`）只写在 `package.json`，两个入口都经 `lib/version.js` 读：
CLI `context-pocket --version`、MCP `initialize` 回包的 `serverInfo.version`。目录式安装（只拷 `bin/` 与 `lib/`）
拿不到 package.json 时才用 `FALLBACK_VERSION` 兜底，该常量与 package.json 同值由 `tests/unit.js` 断言——
不然升级版本号漏改一处，两个入口就会报两个号。

---

## 贡献者致谢

见 [README.md](README.md) 和 GitHub Contributors 页面。
