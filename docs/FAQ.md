# 常见问题 (FAQ)

> 详细的 help 命令回复见 `/help 7` 或 `/help faq`。本文档收录更深入的、一次会话内不太会问到的边缘问题。

***

## 数据 / 存储

### Q: ContextPocket/ 会同步到 Git 吗？

**A**: 默认不。`/openpocket` 会在项目根的 `.gitignore` 添加 `ContextPocket/`，作为本地数据。

如果你**想**提交它（比如团队共享一个 Agent 的工作记录）：

```bash
# 在项目根 .gitignore 删掉 ContextPocket/ 行
git add ContextPocket/
git commit -m "chore: track ContextPocket/ for team sharing"
```

> ⚠️ **注意**：共享时所有协作者必须遵守"串行交接"约定，不能两个 Agent 同时写。

### Q: 🔒 区能加密吗？

**A**: 不能。ContextPocket 是纯文本，设计上不加密。如果你的项目包含密码 / API key 等敏感信息，**不要放进 ContextPocket**——它和项目代码在一起，任何读项目的人都能读。

敏感信息应该：

- 用 `.env` + `.gitignore` 管理（标准做法）

- 或用专门的密钥管理工具（1Password / Vault 等）

### Q: 数据格式会变吗？

**A**: `ContextPocket/readme.md` 第一行 `format: v1` 标识了数据格式版本。v1 是当前承诺的稳定版本。如果未来升级到 v2 会：

1. 同时升级 skill 版本（主版本号）
2. 提供自动迁移工具
3. 在 CHANGELOG 详细说明

向后兼容性原则：**新 skill 能读旧数据，旧 skill 可能不识别新数据**。

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

> ⚠️ 两条路径都需要遵守"串行交接"约定：同一时刻只有一个 Agent 在写。Hub 是**注册表**，项目数据永远在各项目的 `ContextPocket/` 里；hub 故障（磁盘满、权限不够）不会影响正常记录。

### Q: `assets/search-index.json` 是什么？能删吗？

**A**: 这是**派生缓存**，不是真相源。每次 `context-pocket search` 会先对比源文件（`log.md` / `log-archive.md` / `decisions.md` / `requirements.md` / `preferences.md`）的 mtime + size 签名，变了才增量重建；不变就直接用缓存。删除它完全安全——下次 `search` 会自动重建（毫秒级，索引几百个 T-block 时只是瞬间）。如果索引损坏或格式过时，搜索会**透明回退**到全量扫描，不会报错。

```bash
# 手动强制重建
context-pocket index --rebuild --dir <root>

# 临时跳过索引走全量扫描（调试时有用）
context-pocket search <keyword> --no-index --dir <root>
```

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

T 编号从当前最新继续，每个导入的 T-block 都打 `[imported]` 标签。工具调用噪音（tool_use / tool_result / 命令标记 / 系统注入）自动跳过。源类型默认嗅探，可用 `--source claude-code` 或 `--source codex` 强制指定。导入后建议跑一次 `/verify` 看有没有 import-shaped 漏填项。

***

## 工作流 / 习惯

### Q: 应该多久跑一次 `/verify`？

**A**: 经验法则：

- 小型项目（< 50 轮）：不需要，/openpocket 时会自动漂移检查

- 中型项目（50-200 轮）：每次 /handoff 前

- 大型项目（> 200 轮）：每 50 轮 /verify 一次，或每周一次

- 交接前：必跑

### Q: `/sync` 和直接 /openpocket 区别？

**A**:

- `/openpocket` — 激活 / 恢复，会读取已有状态、检查漂移

- `/sync` — 补档，只关心"最近几轮是否漏记"

如果怀疑漏记，用 `/sync`。如果只是新会话接入，用 `/openpocket`。

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

团队协作模式：

1. 每人用自己的 Agent，但**串行使用** ContextPocket/（不要同时打开）
2. 或用 `/exportpocket` 各自导出快照，合并时人工合并
3. 或把 ContextPocket/ 提交到 git，大家 `git pull` 后继续

### Q: 能分项目 + 分人记录吗？

**A**: 当前 ContextPocket 是项目级。可以这样做：

- 每个项目独立 ContextPocket/（默认行为）

- 个人偏好可以放到 `preferences.md`（所有人共享，需要协商）

未来可能加 `ContextPocket/users/<name>.md` 做用户级记录，但当前不支持。

### Q: 接手别人项目，多久能上手？

**A**: 如果 ContextPocket/ 维护良好：

1. 读 `readme.md` — 项目名片（1 分钟）
2. 读 `handoff.md`（如果有）— 阶段交接（3 分钟）
3. `/openpocket` — Agent 自己扫描 + 补漂移（2 分钟）

总计 5-10 分钟可以进入实际工作。

***

## 性能 / 资源

### Q: ContextPocket 会让项目变慢吗？

**A**: 几乎不会。ContextPocket/ 是静态 Markdown 文件，不参与构建。最大开销是 Agent 每次启动时读这几个文件（总共 < 50KB）。

### Q: 项目很大（几万行代码），ContextPocket 还能用吗？

**A**: 可以，但建议：

- 用 `code-map.md` 只记**目录层级和关键模块**，不展开到每个文件

- 把详细文档链接进 attachments 而不是全文复制

- 定期归档（log.md 超过 archive\_at 行自动触发），减小 log.md

### Q: token 消耗如何？

**A**: 每轮 Agent 加载 ContextPocket 大约消耗：

- 首次 /openpocket：\~2-3k tokens（读 10 个核心文件 + on-demand 按需加载）

- 后续每轮：\~200-500 tokens（只读增量）

- /recall /diff /search：按需

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

### Q: 我可以不用 / 命令，只靠自然语言吗？

**A**: 可以。Agent 会识别意图，如：

- "激活 ContextPocket" → /openpocket

- "上一轮进绝对保留" → /putintopocket

- "状态怎么样" → /statuspocket

- "T5 那轮说了啥" → /recall T5

但 / 命令更可靠、更快。推荐用 / 命令，只在边界情况用自然语言。

### Q: ContextPocket 会取代 commit message 吗？

**A**: **不取代，互补**。

- commit message：代码层面，精确到 hash，可重放

- ContextPocket T-block：意图层面，记录"为什么"和决策

最佳实践：commit message 写"做了什么"，ContextPocket 写"为什么这么做"和"考虑过的其他方案"。

***

## 故障 / 错误

### Q: /openpocket 后没有任何反应？

**A**: 排查顺序：

1. 检查 Agent 是否真的加载了本 skill（看它怎么回应"读 SKILL.md"）
2. 检查工作目录是否在项目根（不是子目录）
3. 检查 ContextPocket/ 是否已存在（已存在则幂等，只做漂移检查）
4. 试 `/statuspocket` 看是否识别

### Q: log.md 里出现重复内容？

**A**: 通常是 Agent 在 token 紧张时重写而不是 append。修复：

1. 手动删除重复块
2. `/verify` 检查
3. 下次：在 Agent 回复前如果提示"output truncated"或类似信号，主动要求"先 append log.md 再继续"

### Q: 我想完全重置 ContextPocket/，但保留配置？

**A**:

```bash
# 1. 备份配置
cp ContextPocket/config.md /tmp/cp-config-backup.md

# 2. /resetpocket (Agent 会自动归档)
# 3. 恢复配置
cp /tmp/cp-config-backup.md ContextPocket/config.md
```

或用 Agent：说"重置 ContextPocket 但保留 config.md"。

### Q: CLI 命令怎么用？需要安装什么？

**A**: 需要 Node.js 14+，无需额外依赖。

```bash
# 在 project-root 目录执行
node path/to/context-pocket/bin/context-pocket.js <command> --dir <project-root>
```

常用命令：
- `bootstrap` — 一键初始化项目 ContextPocket
- `verify` — 全面体检
- `status` — 一行状态摘要
- `recall <T-id>` — 查看某轮详情
- `diff <Ta> <Tb>` — 对比两轮变化
- `search <keyword>` — 全文搜索
- `check-conflicts` — 6 维冲突扫描
- `archive` — 归档旧轮次（含自动回滚）
- `migrate` — 格式迁移（含备份 + 回滚）
- `install-hook` — 安装 Git pre-commit 钩子

### Q: 如何安装 Git pre-commit hook？

**A**: 在项目根执行：

```bash
node path/to/context-pocket/bin/context-pocket.js install-hook --dir <project-root>
```

这会向 `.git/hooks/pre-commit` 追加验证脚本，每次 commit 前自动运行 `context-pocket verify`。如需移除：

```bash
node path/to/context-pocket/bin/context-pocket.js uninstall-hook --dir <project-root>
```

### Q: 数据迁移怎么处理？

**A**: 使用 `context-pocket migrate` 命令。当前版本 v1 是 noop 迁移（格式校验），未来版本升级时会填充实际迁移逻辑。迁移前会自动备份到 `ContextPocket.backup-TIMESTAMP/`，迁移失败自动回滚。

```bash
# 查看可用迁移
context-pocket migrate --dir <project-root> --list

# 预览迁移
context-pocket migrate --dir <project-root> --to v2 --dry-run

# 执行迁移
context-pocket migrate --dir <project-root> --to v2
```

### Q: archive 会丢数据吗？

**A**: 不会。归档流程为：验证通过 → 压缩旧 T-block 到 log-archive.md → 清理 log.md → 再次验证。如果归档后验证失败，自动回滚。也可用 `--dry-run` 参数先预览效果。

***

## 还有问题？

- [GitHub Issues](/issues)

- [GitHub Discussions](/discussions)

- 或 `/help troubleshooting` 看常见故障排查

最后更新：2026

