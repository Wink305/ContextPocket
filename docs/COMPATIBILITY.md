# 兼容性 / Compatibility

ContextPocket 设计为 **Agent-agnostic**——所有文件是纯文本 Markdown,任何能读 Markdown 的 Agent 都能用。

## 已验证兼容

| Agent / 工具 | Skill 加载方式 | 备注 |
|--------------|---------------|------|
| **MiniMax Code** | 把 `context-pocket/` 放到 `~/.minimax/skills/` | ✅ 推荐 |
| **Claude Code** | 把 `context-pocket/` 放到 `~/.claude/skills/` | ✅ 完全兼容 |
| **Cursor** | `~/.cursor/skills/context-pocket/` 或项目内 `.cursor/skills/` | ✅ 完全兼容 |
| **Continue.dev** | 把 `SKILL.md` 路径加到 `~/.continue/config.json` 的 `slashCommands` | ✅ 兼容 |
| **Cline / Roo Cline** | 把 `context-pocket/` 加到 VSCode 的 skill 路径 | ✅ 兼容 |
| **Aider** | 通过自定义 `.aider.conf.yml` + system prompt 引用 | ⚠️ 部分兼容(无原生 slash command) |
| **直接编辑器** | 不需要 skill 加载,直接读 `ContextPocket/*.md` | ✅ 完全兼容 |

## 使用 SKILL.md 的最小子集

如果你的 Agent 不支持 `templates/` 自动 bootstrap,Agent 只需要:

1. **能读 Markdown** — 99% 的 Agent 都满足
2. **能写入项目目录** — 创建 `ContextPocket/` 文件夹
3. **支持以下命令中的任意子集**:

| 命令 | 必需? | 降级方案 |
|------|-------|---------|
| `/openpocket` | ✅ 必需 | "读 SKILL.md,然后初始化 ContextPocket/" |
| `/statuspocket` | ⭐ 推荐 | "从 index.md 读状态" |
| `/putintopocket` | ⭐ 推荐 | "把上一轮进 absolute.md" |
| `/recall T<n>` | 可选 | "读 log.md 找 T<n>" |
| `/diff T<a> T<b>` | 可选 | "对比 log.md 的 T<a> 到 T<b>" |
| `/searchpocket` | 可选 | grep / ripgrep |
| `/questions` | ⭐ 推荐 | 列出所有 ❓ |
| `/handoff` | ⭐ 推荐 | "生成 handoff.md" |
| `/verify` | 可选 | "检查所有引用是否完整" |
| `/sync` | ⭐ 推荐 | "把漏记的补上" |
| `/exportpocket` | 可选 | "合并所有文件成单个 snapshot" |
| `/resetpocket` | 可选 | "归档旧 ContextPocket/ 然后重建" |
| `/help` | 可选 | (本文件就是兜底) |

## 不兼容 / 有限支持

| 场景 | 问题 | 临时方案 |
|------|------|---------|
| 没有文件写入权限 | 完全无法使用 | 不适用 ContextPocket,改用外部笔记 |
| 单轮对话工具(如 ChatGPT 网页) | 无法维护 state | 每次对话手工贴 ContextPocket 内容 |
| Agent 只支持纯文本输入 | 无 slash command | 用自然语言(效果差不多) |
| 多 Agent **同时**编辑 ContextPocket/ | 冲突 | 必须串行(Usage boundary 已说明) |

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
read: [CONVENTIONS.md]  # 创建一个 CONVENTIONS.md,内容是 /openpocket 等命令的说明
```

---

## 报告兼容性问题

发现新 Agent 兼容 / 不兼容的情况,欢迎:
- [GitHub Issue](/issues) — 标题前缀 `[Compat]`
- 或直接 PR 改这个文件

---

最后更新:2024