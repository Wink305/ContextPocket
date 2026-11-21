# 产品能力：跨项目记忆检索（hub search）

> 结论先行：把「用户级 Hub」从**纯注册表**升级为**只读的跨项目检索入口**。
> 新增 `context-pocket hub search <kw>` 与 MCP `context_pocket_hub action=search`，
> 命令面仍是 28 个，工具面仍是 28 个；不改数据格式、不写任何项目的索引、不发版。

## 1. 摘要

当前定位是「跨对话、跨 Agent 的记忆」，但 hub 只记录「哪些项目装过 ContextPocket」，
无法回答用户最自然的问题：**“我在哪个项目解决过这个问题？”**

本轮补上这一层只读能力：

- CLI：`context-pocket hub search "token refresh" [--limit <n>] [--json]`
- MCP：`context_pocket_hub` 的 `action: "search"`，参数 `keyword` / `limit`
- 扫描已注册项目各自的 `ContextPocket/`，按项目分组返回 T-block、ADR、需求、偏好命中
- **严格只读**：强制走全文扫描（`useIndex: false`），不建/不刷新索引，不写 hub
- **尊重隔离**：跳过处于隔离状态的项目；缺失/不可读的项目只报告，不中断
- 结果按项目最近活跃排序；用轮转选取保证多个项目都能露头，而不是被最新项目吃满

## 2. 现状分析

### 2.1 Hub 已经有什么

[lib/userhub.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/userhub.js) 目前提供：

- `registerProject` / `touchProject` / `removeProject`
- `listProjects()`：按 `lastActiveAt` 倒序返回 `{ key, project }`
- 全局偏好 `setGlobalPref` / `getGlobalPref`
- `projectKey()` 统一为绝对路径 + 正斜杠，可跨 Windows / macOS / Linux

[bin/context-pocket.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/bin/context-pocket.js#L2440-L2468) 的 `cmdHub` 只有 `list` / `pref` / `remove`；
[mcp-server.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/mcp-server.js#L2649-L2695) 的 `toolHub` 同样只有这三种 action。

### 2.2 缺的是检索

- hub 的模块注释自称「跨项目记忆中枢」，但 README 与 SKILL 都明确写“hub 只是注册表”
- 现有 `search` 只能查当前项目（`--dir` 一次一个）
- 没有跨项目聚合，也没有把「项目来源 / T 号 / 最近活跃」带回结果

### 2.3 可直接复用的能力

| 能力 | 位置 | 用法 |
|---|---|---|
| 全项目检索 | [lib/query.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/query.js#L417-L447) `searchAny()` | 传 `{ useIndex: false, limit }` 即纯扫描、零写入 |
| 项目定位 | [lib/core.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/core.js#L48-L57) `isPocketDir()` | 只认 `<projectRoot>/ContextPocket`，不会向上跨项目误读 |
| 隔离判定 | [lib/isolate.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/lib/isolate.js) `detectIsolation()` | 支持环境变量、标记文件、物理改名三种来源 |
| 结果行渲染 | [bin/context-pocket.js](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/bin/context-pocket.js#L1064-L1101) `cmdSearch` 内联循环 | 抽成 `formatSearchHitLines()` 后复用，保证 CLI 输出一致 |

## 3. 能力规格（决策完成）

### 3.1 CLI

```
context-pocket hub search <keyword> [--limit <n>] [--json]
```

- `keyword` 必填；位置参数 `slice(1).join(' ')`，支持不加引号的多词
- `--limit`：**跨项目返回的命中总数**，默认 20；`≤0` 表示全部（此时 JSON 的 `limit` 为 `null`）
- `--dir` 只影响当前进程的隔离判定，不影响搜索范围（搜索是全局 hub 行为）
- 退出码：成功 0；缺少 keyword 1；无注册项目仍为 0（属于正常空结果）

### 3.2 MCP

工具名不变：`context_pocket_hub`

```jsonc
{
  "action": "search",
  "keyword": "token refresh",
  "limit": 20
}
```

- `action` 枚举扩为 `["list", "search", "pref", "remove"]`
- `keyword` / `limit` 为新增可选属性；仅在 `action=search` 时生效
- 缺少 `keyword` → `isError: true`，文本 `❌ Error: keyword is required for action=search`
- 其余 action 行为完全不变

### 3.3 扫描语义

对 `listProjects()` 返回的每个项目（已按 `lastActiveAt` 倒序）：

1. `pocketDir = path.join(key, 'ContextPocket')`
2. `isPocketDir(pocketDir)` 为假 → `skipped.push({ key, name, reason: 'missing-pocket' })`
3. `detectIsolation({ cwd: key, pocketDir })` 命中 → `skipped.push({ key, name, reason: 'isolated' })`，**绝不读取内容**
4. 否则 `searchAny(pocketDir, keyword, { useIndex: false, limit: 单项目上限 })`
   - `useIndex: false` 是硬要求：不建索引、不刷新索引、不写 `assets/`
   - 单项目上限 = 全局上限（`0` 时为不限制），避免一次拉爆
5. 单项目异常（权限、解析失败）→ `skipped.push({ key, name, reason: 'error', message })`，继续下一个
6. 同一个真实路径重复注册时按 `path.resolve(pocketDir)` 去重

**选取算法（轮转，避免最新项目吃满）**

```
round = 0
while 已选 < 上限:
  added = false
  for 每个有命中的项目（按 lastActive 倒序）:
    if 该项目还有第 round 条命中:
      选中它；added = true；已选 += 1
      if 已选 == 上限: break
  if !added: break
  round += 1
```

- 每个项目仍上报自己的 `total`（完整命中数）与 `count`（实际展示数）
- 跨项目不做全局相关性排序：不同项目的索引分数不可比，按项目分组才诚实

### 3.4 输出

**人类输出（CLI）**

```
  Hub search: "token refresh"
  2 of 3 project(s) matched · 7 match(es) · showing 3
  ────────────────────────────────────────

  ▸ my-app · T42 · last active 2026-11-18 · 2/5
    /abs/path/my-app
    T42 [auth] refresh token rotation
       ↳ [gist] ...
    T39 [auth] login retry
    ↳ 3 more in this project — context-pocket search "token refresh" --dir "/abs/path/my-app"

  ▸ lib-x · T8 · last active 2026-11-15 · 1/2
    /abs/path/lib-x
    T7 [auth] session cache key

  ↳ skipped: sandbox (isolated), old-proj (missing pocket)
```

**JSON**

```jsonc
{
  "ok": true,
  "keyword": "token refresh",
  "limit": 20,
  "projects": 3,        // hub 注册总数
  "searched": 2,        // 实际扫描的 pocket 数
  "matched": 2,         // 至少有一条命中的项目数
  "count": 3,           // 实际返回条数
  "total": 7,           // 全部命中数（所有项目求和）
  "hasMore": true,
  "skipped": [
    { "key": "/path/sandbox", "name": "sandbox", "reason": "isolated" }
  ],
  "results": [
    {
      "key": "/path/my-app",
      "name": "my-app",
      "projectType": "node",
      "latestT": 42,
      "lastActiveAt": "2026-11-18T10:00:00.000Z",
      "total": 5,
      "count": 2,
      "hasMore": true,
      "rows": [ /* searchAny 的行对象，原样透传 */ ]
    }
  ]
}
```

**MCP 文本**

```markdown
## Hub search: "token refresh"
2 of 3 project(s) matched · 7 match(es) · showing 3

### my-app · T42 · last active 2026-11-18 · 2/5
- **T42** [auth] refresh token rotation
  - ↳ [gist] ...
- **T39** [auth] login retry
- ↳ 3 more — context-pocket search "token refresh" --dir "/abs/path/my-app"

### lib-x · T8 · last active 2026-11-15 · 1/2
- **T7** [auth] session cache key

- Skipped: sandbox (isolated), old-proj (missing pocket)
```

### 3.5 边界情况

| 情况 | 行为 |
|---|---|
| 无注册项目 | 退出 0，人类输出 `(no projects registered — run context-pocket bootstrap first)`；JSON `projects:0` |
| 全部项目都缺失/隔离 | 退出 0，输出 skipped 明细与 `0 match(es)` |
| 关键词太长/无命中 | 正常空结果，不报错 |
| 单个项目损坏 | 记 `reason:'error'`，其余项目继续 |
| 项目正在被另一 Agent 写 | 只读；Markdown 写入是 temp+rename 原子替换，读到的是完整旧版或新版 |
| 隔离标记在项目的父目录 | `detectIsolation` 已向上找 5 层，照常跳过 |

## 4. 具体改动

### 4.1 `lib/userhub.js`：新增 `searchProjects()`

**为什么**：让 CLI 与 MCP 共用同一套扫描、跳过、轮转逻辑，避免两边各写一份。

**怎么做**
- 在 `listProjects()` 之后新增 `searchProjects(keyword, opts = {})`，返回 3.4 的 JSON 结构
- 顶部不加新 require；在函数内部惰性引入，避免 `hub list` 冷启动多加载模块：

```js
const { isPocketDir } = require('./core');
const { detectIsolation } = require('./isolate');
const { searchAny } = require('./query');
```

- `limit` 归一：`const cap = intOption(opts.limit, 20); const max = cap <= 0 ? null : cap;`
- 用 `projectKey` 的同一套 `path.resolve(...).replace(/\\/g, '/')` 对 `pocketDir` 去重
- 每个项目 `searchAny(..., { useIndex: false, limit: max === null ? 0 : max })`
- 结果项目按 `listProjects()` 原顺序；组内保持 `searchAny` 的命中顺序
- 导出 `searchProjects`

**不做**：不读全局偏好、不写 hub、不动项目文件。

### 4.2 `lib/formatter.js`：抽出 `formatSearchHitLines()`

**为什么**：hub 结果与 `search` 的 T/ADR/R/pref/FIX 行格式必须一致；复制一份必然漂移。

**怎么做**
- 把 [cmdSearch 的 1064–1101 行](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/bin/context-pocket.js#L1064-L1101) 内联渲染抽成：

```js
function formatSearchHitLines(row, opts = {}) {
  const indent = opts.indent || '  ';
  const highlightIndent = opts.highlightIndent || '     ';
  // 逐行返回，含颜色；调用方负责 console.log
}
```

- 默认参数必须与现有输出逐字一致（`search` 的既有测试是护栏）
- `cmdSearch` 改为 `for (const line of formatSearchHitLines(r)) console.log(line);`
- 导出该函数；Lite 不需要（Lite 无 hub，也不引用 formatter 的这段）

### 4.3 `bin/context-pocket.js`：`hub search`

- 从 `./lib/userhub` 的 require 列表补 `searchProjects`
- `cmdHub` 在 `pref` 分支之后、`remove` 之前加入：

```js
if (action === 'search') {
  const keyword = positional.slice(1).join(' ').trim();
  if (!keyword) { failJson(options, 'keyword is required. Usage: context-pocket hub search <keyword> [--limit <n>]'); /* 人类错误 + exit 1 */ }
  const data = searchProjects(keyword, { limit: options.limit });
  if (options.json) { emitJson(data); return; }
  // 按 3.4 的人类输出渲染：项目标题 + formatSearchHitLines({indent:'    ', highlightIndent:'       '})
  // 每个项目 total > count 时打印 “↳ N more — ... --dir <key>”
}
```

- 不调用 `ensurePocket()`：`hub` 本来就允许在非项目目录运行
- `--limit` 已在 `VALUE_OPTIONS` 中，无需改参数解析
- 缺少关键词的人类提示保持现有风格：
  `❌ Error: keyword is required` + `Usage:` + 示例

### 4.4 `lib/help.js`：帮助与 MCP 描述

- `HELP_GROUPS` 第 67 行：
  `['hub', 'Cross-project registry + read-only search + global prefs (~/.contextpocket)']`
- `COMMAND_HELP.hub.text`：

```
  Usage: context-pocket hub [list|search|pref|remove] [options]

  ...
    search <keyword> [--limit <n>]  Read-only search across registered projects
                                    (default 20; 0 = all; never writes indexes)
```

  并补一段说明：跳过隔离项目、缺失 pocket 只报告不中断、结果按项目分组。
- `TOOL_DESCRIPTIONS.context_pocket_hub`（第 728 行）：在 Actions 里加
  `search <keyword> (read-only, grouped by project; never writes indexes or hub)`，
  并删掉“The hub is only a registry”这句，改成“registry + read-only search; project data never leaves its own ContextPocket/”。

### 4.5 `mcp-server.js`：`context_pocket_hub` 的 search action

- 从 `./lib/userhub` 补 `searchProjects`
- `TOOLS` 中 hub 的 `inputSchema`（第 975–997 行）：
  - `action.enum` 加 `'search'`
  - 新增 `keyword: { type: 'string', ... }` 与 `limit: { type: 'integer', ... }`
  - `required` 保持现状（不强制，交给 handler 校验）
- `toolHub(args)`（第 2649 行）在 `pref`/`remove` 之后、
  `list` 兜底之前加 `action === 'search'` 分支：
  - 缺 keyword → `isError: true`
  - 有 keyword → `searchProjects(keyword, { limit: args.limit })`，按 3.4 的 Markdown 渲染
  - 行渲染写成本地小函数（MCP 不引入 formatter 的颜色逻辑）
- 工具数量、工具名、其余 action 均不变

### 4.6 文档

- [README.md](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/README.md#L304-L310) 命令表：
  `hub [list\|search\|pref\|remove]`，说明补 “read-only search across registered projects”
- [README.md](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/README.md#L495-L506) Hub 章节：
  - 标题改为 `User-level Hub (cross-project registry + search)`
  - “Design: only a registry” 改为“registry + read-only search；搜索不写索引、不复制数据、跳过隔离项目”
  - Commands 行加入 `context-pocket hub search "token refresh"`
- 中文版对应位置：[README.zh-CN.md](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/README.zh-CN.md#L309) 命令表、[Hub 章节](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/README.zh-CN.md#L492-L503)
- [docs/FAQ.md](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/docs/FAQ.md#L421) 的 `hub list|pref|remove` 补 `search`
- [SKILL.md](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/SKILL.md#L36)：
  - “User-level hub”段落补一句“只读跨项目检索；搜索强制走全文扫描，不写索引”
  - Quick responses 表加一行：`Find how another project solved X → hub search <kw> → matches grouped by project`

### 4.7 CHANGELOG

[CHANGELOG.md](file:///c:/Users/13401/Desktop/项目/ContextPocket-git/CHANGELOG.md#L10) 的 `## [Unreleased]` 下加 3–4 条：
跨项目只读检索、隔离/缺失项目跳过、轮转展示、零索引写入。**不升版本号**。

## 5. 测试

全部追加到现有测试文件，**不新建文件**（避免主包 68 个文件与 Lite 30 个文件的基线变化）。

### 5.1 `tests/cli.js`

1. **基础聚合**
   - 两个临时项目分别 `log append` 唯一词 `hubsearch7741`（用 `--no-index`，保证无索引）
   - 从其中一个项目跑 `hub search hubsearch7741 --json`
   - 断言：`projects >= 2`、`matched >= 2`、`results` 含两个项目、每条 `rows` 有 T 号
2. **零写入**
   - 运行前记录两个 pocket 的 `assets/search-index.json` 与 `hub.json` 的 hash/是否存在
   - 运行后必须完全一致；`hub search` 不得生成索引
3. **隔离跳过**
   - 在项目 A 根写 `.contextpocket-isolate` 标记，放唯一词
   - 从项目 B 搜索：stdout 不含该词；JSON `skipped` 含 A 且 `reason: 'isolated'`
4. **缺失 pocket**
   - 注册项目 C 后删除其 `ContextPocket/`；搜索不崩溃，`skipped` 含 C 且 `reason: 'missing-pocket'`
5. **轮转**
   - A 两条命中、B 一条命中；`--limit 1` 只返回最近活跃项目的一条，`count:1 < total:>=3`
6. **错误与空态**
   - 无 keyword：退出 1，含 `Usage:`；`--json` 返回 `ok:false`
   - 无注册项目：退出 0，人类输出含 `no projects registered`
7. **帮助一致**
   - `context-pocket hub --help` 含 `search <keyword>`（`tests/help.js` 的单源断言会自动覆盖）

### 5.2 `tests/mcp.js`

1. `action:'search'` + `keyword` 返回 Markdown，含两个项目名与 `match(es)`
2. 缺 keyword → `isError: true`，文本含 `keyword is required`
3. 原有 `action:'pref'` / `list` 用例不改，作为回归护栏

### 5.3 既有测试

- `tests/cli.js` 的 `search` 输出测试：验证 `formatSearchHitLines` 抽取后逐字不变
- `tests/help.js`：`hub` 的 `--help` 与 `TOOL_DESCRIPTIONS` 仍单源
- `tests/mcp.js` 第 370 行的 CLI/MCP 命令映射：hub 仍在两侧
- `lite/tests/metrics.js`：文件数不变；主包体积若超出 1% 容差，只更新主包基线的绝对值，Lite 基线不动

## 6. 假设与决策

1. **放在 `hub` 下而不是新命令**：`hub search` 属于既有命令的子动作；
   CLI 命令数与 MCP 工具数都不变，符合“不是加命令”的约束。
2. **不做全局相关性排序**：各项目索引独立，分数不可比；按“最近活跃项目优先 + 组内原顺序 + 轮转”更可解释。
3. **强制 `useIndex:false`**：跨项目搜索是只读操作，绝不能因为搜索而在别人的项目里生成/刷新索引。
   代价是 O(项目数 × 日志大小)，由 `--limit` 与显式触发控制。
4. **隔离优先级最高**：被隔离项目直接跳过且不读取内容；只暴露“被跳过”这一事实。
5. **错误隔离到单项目**：一个坏 pocket 不影响其余项目；错误只带简短 message。
6. **不合并数据**：本轮只读；不做跨项目去重、迁移、写入。
7. **不改 Lite**：Lite 没有 hub，命令面与体积都不动；仅在 README 说明该能力属于完整包。
8. **不发版**：功能进入 `[Unreleased]`；主包版本号、Lite 版本号、tag、Release 均留到发版步骤。

## 7. 验证

实现完成后：

1. **静态核对**
   - `git diff` 确认 CLI / MCP 都走 `searchProjects()`，没有第二套扫描逻辑
   - 确认 `hub search` 路径里没有 `ensureFreshIndex` / `writeHub` / `writeAtomic`
2. **门禁（工作区未受信任，由用户执行）**
   - `npm run lint`
   - `npm test`
   - `npm run smoke`
   - `npm run smoke-live`
   - `node scripts/verify-format.js`
3. **手动场景**
   ```bash
   # 项目 A、B 各 bootstrap 并记录含同一关键词的一轮
   context-pocket hub search "token refresh"
   context-pocket hub search "token refresh" --json
   context-pocket hub search "token refresh" --limit 1
   # 在 A 放 .contextpocket-isolate 后，从 B 再搜：A 必须被跳过且内容不出现
   # 搜索前后对比 A/B 的 assets/ 与 hub.json：必须零变化
   ```

## 8. 明确不做

- 不做跨项目写入、合并、去重、迁移（后续可基于本轮数据做 `hub merge`）
- 不建全局索引/缓存（未来若慢再加，先保持零写入语义）
- 不改变 hub.json 格式（仍 v1）
- 不引入新依赖、不新增 CLI 命令或 MCP 工具
- 不发布、不升版本
