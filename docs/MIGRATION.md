# 版本迁移指南

本文档说明 ContextPocket 的版本体系、数据格式兼容性，以及版本间迁移的方法与步骤。

---

## 版本说明

ContextPocket 存在两套独立的版本号，各司其职：

| 版本类型 | 位置 | 示例 | 说明 |
|---------|------|------|------|
| **Skill 版本** | `SKILL.md` / `CHANGELOG.md` | `1.0.0` | 遵循 [语义化版本](https://semver.org/lang/zh-CN/)，代表 skill 功能的迭代 |
| **数据格式版本** | `ContextPocket/readme.md` 中的 `format:` 字段 | `v1` | 代表 `ContextPocket/` 目录内数据文件的结构版本 |

### 兼容性原则

> **新 skill 能读旧数据，旧 skill 可能不识别新数据。**

- **向前兼容（forward compatible）**：高版本 skill 可以读取低版本格式的数据（如 skill 2.0 能读 `format: v1` 的项目），读取时自动忽略不识别的字段。
- **不向后兼容**：低版本 skill 读取高版本格式的数据时（如 skill 1.0 遇到 `format: v2`），可能无法正确解析新增字段，应提示用户升级 skill 或进行迁移。

---

## 当前格式版本

| 项目 | 值 |
|------|----|
| 当前数据格式 | **v1** |
| 对应 skill 版本 | **1.x.x** |
| 状态 | 稳定 / 当前 |

`format: v1` 是 ContextPocket 的首个正式数据格式，包含全部 12 个核心文件及 T-block / R-id / ADR 等基础结构。

---

## 迁移策略

### 自动检测

Agent 在执行 `/openpocket` 时会自动：

1. 读取 `ContextPocket/readme.md` 中的 `format:` 字段
2. 与当前 skill 支持的格式版本比对
3. 如果版本不兼容（旧 skill 遇到新格式），提示用户并建议迁移或升级 skill

示例提示：
```
⚠️ ContextPocket 数据格式为 v2，但当前 skill 版本仅支持 v1。
建议升级 skill 到 2.x，或执行 context-pocket migrate --dir <project-root> --to v1 进行降级迁移。
```

### 迁移命令

#### `context-pocket migrate`（已实现）

CLI 迁移命令，支持：

- 自动检测当前数据格式版本与目标版本
- 迁移前自动备份 `ContextPocket/` 目录到 `ContextPocket.backup-<timestamp>/`
- 执行对应版本的迁移脚本（新增字段、重组结构、重命名文件等）
- 迁移完成后运行 `verify` 验证结果完整性
- 失败时自动回滚到备份

```bash
# 查看可用迁移
context-pocket migrate --dir <project-root> --list

# 预览迁移（不实际执行）
context-pocket migrate --dir <project-root> --to v2 --dry-run

# 执行迁移
context-pocket migrate --dir <project-root> --to v2
```

In MCP mode, use `context_pocket_migrate` tool.

### 手动迁移

如果自动迁移不可用或需要更精细的控制，可以按以下步骤手动迁移：

1. **备份**：复制整个 `ContextPocket/` 目录到 `ContextPocket.backup/`
   ```bash
   cp -r ContextPocket/ ContextPocket.backup/
   ```
2. **导出快照**：执行 `/exportpocket` 生成完整快照文件，作为额外备份
3. **重置**：执行 `/resetpocket` 清空当前 context，重建空的格式版本
4. **恢复**：从备份快照中逐条提取关键信息（decisions、requirements、preferences 等），写入新格式的对应文件

手动迁移适用于跨大版本升级、数据损坏修复，或需要在迁移过程中清理历史数据的场景。

---

## v1 → v2 迁移（预留）

> 本节为预留内容，将在 v2 格式发布时填充。

### 变更内容

- （预留：v2 格式相比 v1 的主要变更）
- （预留：新增字段 / 废弃字段 / 文件结构调整）

### 迁移步骤

1. （预留）
2. （预留）
3. （预留）

### 向后兼容说明

- （预留：skill 2.x 读取 v1 数据时的兼容行为）
- （预留：skill 1.x 读取 v2 数据时的限制）

---

## 回滚方案

### 迁移失败回滚

如果迁移过程中出现错误或迁移后数据异常：

1. 停止操作，不要继续写入 `ContextPocket/`
2. 删除有问题的 `ContextPocket/` 目录
3. 将备份目录重命名回 `ContextPocket/`
   ```bash
   mv ContextPocket.backup/ ContextPocket/
   ```
4. 执行 `/verify` 确认回滚后数据健康

### 迁移前检查清单

执行任何迁移操作前，**必须**完成以下两项：

- ✅ `/verify` — 确认当前 ContextPocket 状态健康（无 broken refs、文件齐全）
- ✅ `/exportpocket` — 导出完整快照作为离线备份

如果 `/verify` 报告异常，应先修复问题再进行迁移，避免将问题带入新版本。

---

## 相关链接

- [CHANGELOG.md](../CHANGELOG.md) — Skill 版本变更记录
- [SKILL.md](../SKILL.md) — Skill 规范与格式定义
- [FAQ.md](FAQ.md) — 常见问题
