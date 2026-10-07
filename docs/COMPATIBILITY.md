# 兼容性 / Compatibility

ContextPocket 设计为 **Agent-agnostic**——所有文件是纯文本 Markdown,任何能读 Markdown 的 Agent 都能用。

**没有按 Agent 划分的命令表。** ContextPocket 只有一套 CLI 子命令和一套 MCP 工具；你用大白话说需求，Agent 判断意图后自己挑对应的那一个去调。因此兼容性只看三件事：能不能读 Markdown、能不能写项目目录、能不能调 CLI 或 MCP 工具。

## 已验证兼容

| Agent / 工具 | Skill 加载方式 | 备注 |
|--------------|---------------|------|
| **MiniMax Code** | 把 `context-pocket/` 放到 `~/.minimax/skills/` | ✅ 推荐 |
| **Claude Code** | 把 `context-pocket/` 放到 `~/.claude/skills/` | ✅ 完全兼容 |
| **Cursor** | `~/.cursor/skills/context-pocket/` 或项目内 `.cursor/skills/` | ✅ 完全兼容 |
| **Continue.dev** | 把 `SKILL.md` 路径加到 `~/.continue/config.json` 的 `slashCommands` | ✅ 兼容 |
| **Cline / Roo Cline** | 把 `context-pocket/` 加到 VSCode 的 skill 路径 | ✅ 兼容 |
| **Aider** | 通过自定义 `.aider.conf.yml` + system prompt 引用 | ✅ 兼容(无原生 skill 加载，需手工引入) |
| **直接编辑器** | 不需要 skill 加载,直接读 `ContextPocket/*.md` | ✅ 完全兼容 |

## 使用 SKILL.md 的最小子集

如果你的 Agent 不支持 `templates/` 自动 bootstrap,Agent 只需要:

1. **能读 Markdown** — 99% 的 Agent 都满足
2. **能写入项目目录** — 创建 `ContextPocket/` 文件夹
3. **能调用下面的能力**（CLI 子命令或对应 MCP 工具，支持任意子集）：

| 能力 | 对应子命令 | 必需? | 降级方案 |
|------|-------|-------|---------|
| 初始化 / 恢复 | `bootstrap` | ✅ 必需 | "读 SKILL.md,然后初始化 ContextPocket/" |
| 状态摘要 | `status` | ⭐ 推荐 | "从 index.md 读状态" |
| 🔒 绝对保留 | `absolute add` | ⭐ 推荐 | "把上一轮写进 absolute.md" |
| 待确认项清单 | 读 `❓` 行（无工具） | ⭐ 推荐 | 列出所有 ❓ |
| 交接摘要 | `handoff` | ⭐ 推荐 | "生成 handoff.md" |
| Git 漏记补档 | `sync` | ⭐ 推荐 | "把漏记的补上" |
| 回看某轮 | `recall <Tn>` | 可选 | "读 log.md 找 T<n>" |
| 两轮对比 | `diff <Ta> <Tb>` | 可选 | "对比 log.md 的 T<a> 到 T<b>" |
| 全文检索 | `search <关键词>` | 可选 | grep / ripgrep |
| 健康检查 | `verify` | 可选 | "检查所有引用是否完整" |
| 导出快照 | Agent 直接写文件（无工具） | 可选 | "合并所有文件成单个 snapshot" |
| 重置 | `archive --keep-last N` + 重建 | 可选 | "归档旧 ContextPocket/ 然后重建" |

### MCP 模式

支持 MCP 的 Agent 不用 shell,直接调工具即可——CLI 子命令与 MCP 工具一一对应,共 27 个,工具名是子命令名加 `context_pocket_` 前缀(如 `context_pocket_log_amend`、`context_pocket_absolute_add`、`context_pocket_repair`)。检索索引的开关是 `context_pocket_search` 的 `noIndex` 参数,不是单独一个工具。这条对应关系不是文档承诺,而是断言:`context-pocket help --json` 给出命令全集,`tests/mcp.js` 拿它逐个核对 `tools/list` 去掉前缀后的工具名,少一个测试就红。

## 不兼容 / 有限支持

| 场景 | 问题 | 临时方案 |
|------|------|---------|
| 没有文件写入权限 | 完全无法使用 | 不适用 ContextPocket,改用外部笔记 |
| 单轮对话工具(如 ChatGPT 网页) | 无法维护 state | 每次对话手工贴 ContextPocket 内容 |
| Agent 只支持纯文本输入 | 无法调 CLI / MCP 工具 | 直接说自然语言,让 Agent 自己读写 Markdown 文件 |
| 多 Agent **同时**编辑同一台机器上的 ContextPocket/ | 写入交错 | 由写入锁排队(`lib/io.js` 的 `withPocketLock`,锁文件在 `os.tmpdir()`,按 pocket 路径命名),不需要人工串行 |
| 多 Agent **同时**编辑跨机器的 ContextPocket/(共享 git 仓库) | 两个克隆各自算 `latestT + 1`,合并后撞到同一个 T 号 | 仍按串行交接用(谁做完谁提交,下一个先 `git pull`);真撞上了用 `context-pocket repair --dry-run` → `repair` 收回来,`verify` 会把撞号报成 error 并直接给出这条命令 |

## 平台特定说明

### MiniMax Code / Claude Code
标准 skill 加载,无特殊配置。

### Cursor
1. `Cmd+Shift+P` → "Open User Settings (JSON)"
2. 添加:
   ```json
   {
     "claude.skillPaths": ["~/.cursor/skills/"]
   }
   ```
3. 把 `context-pocket/` 复制到该路径
4. 重启 Cursor

### VSCode + Continue
编辑 `~/.continue/config.yaml`:
```yaml
slashCommands:
  - name: ContextPocket
    description: "Cross-agent dev context sync"
    source: "file:///<path-to>/context-pocket/SKILL.md"
```

### Aider
在 `.aider.conf.yml` 加:
```yaml
read: [CONVENTIONS.md]  # 创建一个 CONVENTIONS.md,内容写"用大白话提需求,Agent 会自动记 ContextPocket"
```

---

## 报告兼容性问题

发现新 Agent 兼容 / 不兼容的情况,欢迎:
- [GitHub Issue](/issues) — 标题前缀 `[Compat]`
- 或直接 PR 改这个文件

---

最后更新:2026（对应 skill 1.2.0；CLI 子命令与 MCP 工具各 27 个）