# 贡献指南

感谢你考虑为 ContextPocket 做贡献！🎉

## 如何贡献

### 报告 Bug

请在 [GitHub Issues](/issues) 新建 issue，包含：

1. **清晰标题** — 一句话说清问题
2. **复现步骤** — Agent 是怎么操作的？上下文是什么？
3. **期望行为** — 应该发生什么
4. **实际行为** — 实际发生了什么
5. **环境信息**:
   - Agent 平台与版本（MiniMax Code / Claude Code / Cursor …）
   - Skill 版本（`SKILL.md` 顶部声明）
   - 项目类型（frontend / backend / …）
6. **相关文件** — 如有可能,附上 `ContextPocket/log.md` 中有问题的 T 块

### 提出新功能

同样在 Issues,但请先说明：

- **动机**: 你想解决什么问题？
- **方案**: 你心目中的实现是什么？
- **替代方案**: 考虑过哪些其他方法？各自的取舍？
- **影响范围**: 会影响哪些现有 CLI 子命令 / 模板 / 行为？

### 提交代码 / 文档

1. **Fork** 本仓库
2. **创建分支**: `git checkout -b feat/your-feature-name`
3. **修改**:
   - 修改 `SKILL.md` 时,请保持现有章节顺序与术语一致
   - 修改 `templates/` 时,确保新模板符合"占位符用 `<...>` 包裹"的约定
   - 修改 README/CHANGELOG 时同步更新相关章节
4. **本地验证**（三条都要过，`package.json` 里已配好脚本）:
   - `npm test` — 跑 `tests/run.js`（零依赖自研骨架，当前 60+60+16+17+16+19+27+18 = 233 个用例：单元 / pocket 集成 / git hook / 会话导入 / 格式迁移 / T 编号修复 / CLI 契约 / MCP 契约）。测试会自己建临时项目，绝不碰你的真实 `ContextPocket/`，也不会往 `~/.contextpocket/hub.json` 里写注册项（`tests/harness.js` 把 `CONTEXTPOCKET_HOME` 重定向到临时目录）
   - `npm run lint` — 对仓库内每个 `.js` 跑 `node --check`
   - `npm run smoke` — 用真实 stdio 跑一遍 MCP server（`initialize` / `tools/list` / 27 个工具里的 append、amend、absolute add、index、distill、hub、verify 等；`repair` 不在冒烟覆盖里——它要先人为造出撞号的目录，这件事由 `tests/repair.js` 与 `tests/mcp.js` 盯着）。不带参数时它会在 OS 临时目录里现造一个一次性 pocket 并把 `CONTEXTPOCKET_HOME` 隔离到同一目录，退出即删，所以可以直接跑；想对着指定项目跑就写 `npm run smoke -- /path/to/project`（此时若没设 `CONTEXTPOCKET_HOME`，hub 写入会落到你真实的 `~/.contextpocket`，脚本会先打印一行提示）。收尾断言是 `verify` 必须返回 `All checks passed`——所以往冒烟步骤里加任何声明（尤其是 `### Attachments` 那条路径）都得把文件真的写出来，否则第 15 项检查会让冒烟红）
   - `node tests/run.js pocket` 之类的前缀参数可以只跑某个文件
   - `tests/hooks.js` 里有五条 `git init` + 真提交的端到端用例（健康放行、坏 pocket 拦住、无 pocket 不禁用、带密钥拦住、只有 PII 放行），本机缺 `git` 或 `sh` 时它们会打印 `(skipped…)` 并跳过；**跳过不算通过**，改 hook 逻辑请在有 git 的机器上至少跑一次。其中"坏 pocket 必须拦住提交"这条是另外几条端到端用例的对照开关：它一红就说明 hook 根本没被执行，此时"放行"的结论不可信
5. **再跑一遍人的链路**:
   - 在一个真实项目里跑完整条链路: 首次进项目时自动 `bootstrap`（用户无需执行任何命令）→ 用户说「交接一下」时跑 `context-pocket handoff` → 用户说「查一下有没有漏」时跑 `context-pocket verify`
   - 用自然语言把「现在什么情况」「有什么待确认的」「这玩意儿怎么用」等意图各问一遍，确认 Agent 都走对工具、回复仍然合理
6. **Commit message** 建议遵循 [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: 归档后 index 的起始 T-id 计算修正`
   - `fix: context-pocket recall 在归档 T 块时找不到附件`
   - `docs: README 补充 mobile 项目类型示例`
   - `refactor: 把 boot logic 从 SKILL.md 拆到 templates/`
7. **Push** 并创建 **Pull Request**

### PR 合并标准

- ✅ `npm test` 与 `npm run lint` 全绿（新增行为要带用例，否则不算完成）
- ✅ 通过基本流程（自动 bootstrap → 用户说「交接一下」时 `handoff` → 用户说「查一下有没有漏」时 `verify`）
- ✅ 不破坏现有意图映射与 CLI 子命令的语义
- ✅ 更新 CHANGELOG.md（如果是用户可见的变更）
- ✅ 至少 1 位维护者 review 通过

---

## 开发约定

### 文件命名

- 严格小写: `readme.md` / `index.md` / `log.md` / ...
- 永远不要用 `README.md` / `LOG.md` 等大写形式
- 模板文件名固定,不能改（向下兼容）

### Markdown 风格

- 标题层级: 最多 4 级（`#` `##` `###` `####`）
- 列表: 优先用 `-` 而非 `*`
- 代码块: 标明语言 (` ```markdown `)
- 表格: 对齐 `|` 符号便于阅读

### 模板占位符

- 占位符用 `<...>` 包裹,例如 `<n>` / `<date>` / `<slug>`
- 必填项必须明确说明"替换为实际值"
- 可选项用注释说明默认行为

### 命令设计原则

ContextPocket 面向用户的入口是**自然语言意图**，不是斜杠命令：用户用日常说法表达需求，Agent 依据 `SKILL.md` 的「Quick responses」意图表推断意图，再调用对应 CLI 子命令（`context-pocket <subcommand>`）或 MCP 工具。设计新能力时：

- CLI 子命令动词开头: `bootstrap` / `status` / `handoff` / `verify`
- 短命令名优先（< 15 字符）
- 意图表用用户的口语说法，触发条件清晰（同一意图的多种说法都要能命中）
- 输出可预测（一行 / 多行 / 结构化）
- **只写 flag 不给值 = 没传，判据只有一份**：`lib/fields.js` 的 `textOption(obj, ...keys)` 收字符串/数字，其它形状（`true`、`false`、`''`、只有空白、数组）一律 `undefined`。CLI 的 `missingValue()` 就是 `textOption(...) === undefined`，MCP 各写入工具直接调 `textOption`。为什么必须统一：`VALUE_OPTIONS` 里的键，parseArgs 在 flag 后面紧跟另一个选项时会给它布尔 `true`，而这个值会一路走到写入层——`state update --summary --json` 曾在 state.md 里写下 `- true`，`decision add --context` 写下 `- Context: true`，`req add --status` 干脆造出一个 `## true` 分组标题。用 `pickFirst` 或直接 `obj.x !== undefined` 读带值选项就是把这个漏洞重新开一遍；要判"给没给"，请用 `textOption`。
- 新增能力时同步更新 `SKILL.md` 的意图表与本文件的相关章节，让用户一句话就能触发
- **选项名 = MCP 参数名的 kebab-case，一个概念只有一个名字**：`tId` → `--t-id`、`tA`/`tB` → `--t-a`/`--t-b`。历史上同一个 T 号漂过三种写法（`recall --id` / `log amend --t` / `absolute add --t-id`），因为这三个键都在 `VALUE_OPTIONS` 里——猜错的那一种会被 `parseArgs` 正常解析、再被对应命令静默丢掉，报错于是谎称"你没传"。现在 `bin/context-pocket.js:266` 的 `tIdOption()` 是唯一的取号入口（长写法 `--t-id` + 历史别名 `--t` / `--id`，只写 flag 不给值仍算没传），`diff` 用 `tIdPairOption()` 取 `--t-a` / `--t-b`。**要加新入参就加新名字，别再给同一个概念加第二个名字**；位置参数永远是首选写法，选项是它的同义替代。
- **代码读了的开关，每个读它的命令都要在自己的 `--help` 里教**：`--no-index` 在 `search`（`:909`）上是"这次查询不信缓存"，在 `log append`（`:1131`）/ `log amend`（`:1199`）上是"这次写完不刷缓存"，而过去只有 `search --help` 提到它——写入侧的开关对使用者等于不存在，读过 `search` 帮助的人还会把它理解反。同名不同读法必须显式写清（`tests/cli.js` 有一条断言钉住三个帮助都教得到，另有一条钉住"跳过刷新后下一轮 search 自愈重建、命中不少一条"）。判据同上一条：**能自愈的行为差异要写进文档，不要靠用户读源码**。全局开关同理：要进 `HELP_OPTIONS`（`bin/context-pocket.js:345`），并且要有一例断 `help` 输出里认得出它——`--version` 就是这么补进去的。

### 如何加一条密钥 / PII 检测规则（`lib/secrets.js`）

pocket 是要被下一轮会话重新读进上下文的明文历史，所以"用户贴了带 key 的报错"会一路复制。检测表 `SECRET_RULES`（`lib/secrets.js:37`）一条 = 一类形状：

```js
{ label: 'Stripe key', severity: 'error', pattern: '(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}' },
{ label: 'CN mobile number', severity: 'warning', pattern: '\\b1[3-9]\\d{9}\\b', guard: false },
```

加规则时四条不变量必须守住，它们都有用例盯着（`tests/unit.js` 的 5 条 secrets 用例 + `tests/pocket.js` 的 5 条闸门用例 + `tests/hooks.js` 的 2 条端到端）：

1. **`severity` 决定闸门，不是决定提醒。** `error` 会让 `verify` 的 `errorCount` 涨，pre-commit 的 `verify --quiet` 因此退 1，`archive` 与 `migrate` 也会当场拒绝——所以只有"机器签发、泄露即失效"的凭证形状配得上 `error`。人的信息（手机号、身份证、卡号）与手写赋值一律 `warning`：拦下来只会让人绕开工具，不会让人改用例。
2. **结果里绝不能有完整值。** `mask()` 只留前 6 位 + 长度，因为工具输出会被 Agent 抄进下一条 T-block；任何新序列化字段都要走 `masked`，不许新增 `raw` / `matched`。
3. **默认 `guard` 是词边界**（`(?<![A-Za-z0-9_])…(?![A-Za-z0-9_])`），规则自带 `\b` 或前面可能就是 `/`、`-` 的（URL 里的 webhook、`-----BEGIN`）要写 `guard: false`，否则会漏检或把 `https://` 的前缀吃掉。
4. **取值字符类不要用 `[^\s...]`。** 明文赋值那条曾用 `[^\s"',;]{6,}`，于是 `password: xxxx）` 里连续吞进中文标点，`templates/config.md` 自己的注释被扫成一条 warning（pocket 里躺着这个模板，新项目的 `verify` 一上来就红）。改成 ASCII 可打印类 `[\x21-\x7e]{6,}` 之后既截得住英文口令，也不会因为行尾注释的长度而误报。

新加规则先写一条"命中 + 一条良性语料不命中"的用例（`scanText(benign)` 必须为空是硬门槛，那串正常技术描述里全是数字、commit hash、版本号），再补 `templates/config.md` 与 `lib/constants.js` 的 `DEFAULT_CONFIG`——两处都对不上就是文档说谎。

### 如何新增一个迁移步骤（数据格式升版）

`ContextPocket/` 的格式真要变了（加必填小节、拆文件、改编号规则），走 `lib/migrate.js` 这套机制，不要写一次性的 sed 脚本：它管的是"用户手里已经存在的历史文件"，这类数据只能全升或全不升。

**唯一需要改的地方是登记表 `MIGRATIONS`（`lib/migrate.js:35`）**，一条记录 = 一跳。登记表里现在真的有两跳（第二条 `migrateV1ToV2` 就是"改内容的一跳"长什么样的参照）：

```js
const MIGRATIONS = [
  { from: 'v1', to: 'v1', name: 'v1-to-v1 (noop — format verification)', type: 'noop' },
  { from: 'v1', to: 'v2', name: 'v1-to-v2 (add the "--- WHEN: <date> (day) ---" time line to every T-block)', run: migrateV1ToV2 },
  // 下一跳从这里开始，v2 → v3：
  {
    from: 'v2', to: 'v3',
    name: '把 ### Follow-up 拆成独立文件',
    run: (pocketDir) => { /* 只改 pocketDir 里的文件内容 */ },
  },
];
```

执行逻辑（找路径、备份、逐步 verify、回滚）不用碰：`context-pocket migrate --to latest` 会用 BFS（`findStepPath`）把 `v1 → v2 → v3` 串成一条链一次走完，`--to v2` 只走半程。

写 `run(pocketDir)` 时的六条规矩：

1. **不要自己写版本号戳**。`format: v2` 由框架在每一跳成功后统一盖上（`executeStepWithLabel` → `setFormatVersion`，`lib/migrate.js:444`）。自己写一遍不算错，但漏写会让下一跳又从旧版本开始判断。
2. **不要抛"业务提示"**。`run` 抛异常 = 这一跳失败 = 整个 `ContextPocket/` 回滚到本次运行开始前的备份，备份目录随即删掉（回滚成功后它就是当前内容的副本）。只有真出错才抛。
3. **改动要可重复执行**。框架在每一跳之前只保证"verify 干净"，不保证这一跳从没跑过；幂等写法（先查再改）比靠版本号保险。
4. **只用 `fs` / `lib/io.js` 的 `writeAtomic`**。迁移是整目录重写，非原子写会把用户历史留在半截状态。
5. **新字段要两侧同时落地**。迁移这一跳负责把老 pocket 补齐，写入侧（`lib/writer.js` / `lib/indexer.js` / `lib/importer.js`）负责让新 pocket 天生就带它，两边都得在同一次改动里到位。反过来说，**旧版本的 pocket 不能凭空长出格式里没有的东西**：`formatSupportsWhen()` 为假时写入层就不写这一行，而用户显式给过的取值也不能被悄悄吞掉——`log append --when` 在 v1 里照记块、把"没落盘"讲回去（`whenSkipped`），这是 v1→v2 那一跳定下的样式。
6. **迁移不许无中生有**。只能用文件里已经写得出来的信息（v1→v2 取块上方最近的那条 `--- SESSION: <日期> ---`）；找不到就什么都不写，并把这种情况计进返回的 `stats`（那条是 `noDate`），既不拿文件 mtime 冒充，也不做任何时间算术。已经有值的字段一律**只放宽、不替换**。

**同一笔提交里必须一起改的地方**（少一处就会出现"新项目和老项目的版本号口径不一致"）：

- `templates/readme.md:1` 的 `# ContextPocket · format: v2` → 新格式正式发布后改 here；这是 `detectFormatVersion` 对新建 pocket 的唯一真相源。只登记跳而不抬模板，新项目一出生就带着"有升级可用"；只抬模板而不登记跳，老项目永远升不动。
- `lib/migrate.js:25` 的 `CURRENT_VERSION`（代码原生理解的版本）
- `docs/MIGRATION.md` 的「当前格式版本」表与已发布的那一跳的说明节
- `README.md:245` / `README.zh-CN.md:245` 的 migrate 行、`SKILL-advanced.md` 的版本迁移节、`docs/FAQ.md` 的 migrate 问答、`SKILL-reference.md` 的字段格式
- `CHANGELOG.md`

登记表一跳落地后，`verify` 的第 14 项（`checkFormatUpgrade`，`lib/validator.js:74`）会自动开始对停在旧版本的 pocket 报 `format-upgrade` WARNING——它读的就是 `listMigrations()`，不需要再改一遍；想让它闭嘴的唯一办法是别把不可用的一跳登记进去。

**测试**：`tests/migrate.js` 用 `registerMigration()`（它返回一个反注册函数，`finally` 里必须调用，否则假跳会污染同一进程后面的用例）临时拼出一条链来验证多跳与回滚。新增真跳时至少补这几类用例：这一跳单独跑内容确实变了、版本戳抬到 `to`、`--dry-run` 一个字节都不写、重跑第二遍一个字节都不改、**新行落在它属于的那个块里**（用"标题行的下一行"这种相邻断言，而不是全文 `includes`——后者会把写到隔壁块也算通过，`tests/migrate.js` 的 `lineAfter()` 就是为这个加的），以及没有可用信息的块确实被留空。跑法：`node tests/run.js migrate`。

顺带一句：`CURRENT_VERSION`（`lib/migrate.js:25`）不是"最新格式"的意思，它是代码原生理解的版本，也是 `latestVersion()` 的下界；登记表里最高的 `to` 才是 `--to latest` 的目标。

---

## 项目结构

```
context-pocket/
├── package.json           # 零依赖；bin 里注册 context-pocket / context-pocket-mcp；engines.node >=14
├── README.md / README.zh-CN.md
├── SKILL.md               # Agent 每轮必读的主体（意图 → 动作对照表）
├── SKILL-advanced.md      # 按需：bootstrap / 项目类型预填 / 归档 / 边缘情况（含版本迁移）
├── SKILL-reference.md     # 按需：字段级精确格式与模板注释
├── CHANGELOG.md / CONTRIBUTING.md / LICENSE
├── .gitignore
├── bin/
│   └── context-pocket.js  # CLI 入口（人类输出 + --json 一行输出）
├── lib/                   # 全部实现；CLI 与 MCP 都只调这里，不在入口里写业务逻辑
│   ├── bootstrap.js  constants.js  core.js  distill.js  fields.js
│   ├── formatter.js  hooks.js      importer.js  indexer.js  io.js
│   ├── lifecycle.js  migrate.js    parser.js    query.js    repair.js
│   ├── secrets.js    sync.js       userhub.js   validator.js writer.js
│   └── when.js        # v2 时间行的唯一解析/渲染处：parseWhen / whenLine / describeWhen / formatSupportsWhen
├── mcp-server.js          # MCP stdio 入口（换行分隔 JSON-RPC，27 个工具）
├── mcp-smoke.js           # 真实 stdio 冒烟测试（npm run smoke）
├── tests/
│   ├── run.js             # 零依赖跑批（可按文件前缀只跑一个）
│   ├── harness.js         # test/tmpProject/makePocket + CONTEXTPOCKET_HOME 隔离
│   ├── unit.js  pocket.js  hooks.js  importer.js  migrate.js  repair.js  cli.js  mcp.js
├── templates/             # bootstrap 复制的是这个目录的**根**层文件（10 个）
│   ├── readme.md  config.md  index.md  state.md  requirements.md
│   ├── preferences.md  decisions.md  code-map.md  absolute.md  log.md
│   └── on-demand/         # 不被代码读取：log-archive.md / handoff.md 由工具自己生成，
│       ├── log-archive.md # 这两个只是"纯文本 Agent 手工建文件"时的参照
│       └── handoff.md
├── scripts/
│   └── pre-commit         # 参考副本；真正装进 .git/hooks 的脚本由 lib/hooks.js 生成（会嵌入 CLI 绝对路径）
├── assets/                # 仓库自己的 logo（与项目 pocket 的 assets/ 无关）
└── docs/
    ├── FAQ.md  COMPATIBILITY.md  MIGRATION.md
```

---

## 发布流程（维护者）

版本号在本包只有一处真值：`package.json` 的 `version`。CLI 的 `context-pocket --version` 与 MCP
`initialize` 回包的 `serverInfo.version` 都经 `lib/version.js` 的 `pkgVersion()` 读它，
其余三处（`FALLBACK_VERSION`、`SKILL.md` 的 `version:`、CHANGELOG 的节标题）是静态抄本，
所以定版顺序是固定的：

1. 改 `package.json` 的 `version`，同时改两处抄本：`lib/version.js` 的 `FALLBACK_VERSION`、
   `SKILL.md` frontmatter 的 `version:`。这三处加上下面 CHANGELOG 的节标题一共四个位置，
   `tests/unit.js` 有两条用例逐个比对（`tests/mcp.js` 还有一条断 CLI 与 MCP 报的是同一个号）——
   漏改任何一处都不会在入口报错，只会让不同地方各说一个号，所以报警器只能长在测试里。
2. 把 `CHANGELOG.md` 顶部 `[Unreleased]` 累积的条目切成 `## [<新版本>] - <YYYY-MM-DD>` 一节，
   上面留一个空的 `[Unreleased]` 占位。日期写真实发布当天；已经发生但没有留档的历史版本
   （1.0.0）宁可标"日期未留档"，也不要编一个日期。
3. README / README.zh-CN **目前没有版本徽章**（`README.md:5-7` 只有 License / format / PRs 三枚），
   所以这一步通常无事可做；将来若加了版本徽章，定版时必须一起改，别让它停在旧号上。
   注意 `format-v1` 那枚指的是 `SKILL.md` 的文档排版版本，与包版本、数据格式版本都是三回事。
4. `npm test`、`npm run lint`、`npm run smoke` 三条全绿。
5. 新增过文件就跑一次 `npm pack --dry-run`，核对 `package.json` 的 `files` 白名单（`:36`）真的把它带上了。
   落在 `bin/` `lib/` `templates/` `assets/` `docs/` `scripts/` 里的会自动带上；白名单外的目录要显式加，
   否则发布出去的包缺文件，用户拿到的就是"读不到 package.json、只能报兜底版本"那种安装。
6. 创建 Git tag: `git tag -a v1.2.0 -m "Release 1.2.0"`
7. 创建 GitHub Release,粘贴 CHANGELOG 摘要
8. 在社区/Discord 发公告（如果有）

---

## 行为准则

- 友好、包容、建设性
- 不接受人身攻击 / 歧视 / 骚扰
- 接受建设性批评
- 关注对社区最有利的事

---

## 联系方式

- Issues: [GitHub Issues](/issues)
- Discussions: [GitHub Discussions](/discussions)
- 邮件: （如果有的话，填这里）

---

<p align="center">
  再次感谢你的贡献! ⭐
</p>