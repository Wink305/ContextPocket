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
- **影响范围**: 会影响哪些现有命令 / 模板 / 行为？

### 提交代码 / 文档

1. **Fork** 本仓库
2. **创建分支**: `git checkout -b feat/your-feature-name`
3. **修改**:
   - 修改 `SKILL.md` 时,请保持现有章节顺序与术语一致
   - 修改 `templates/` 时,确保新模板符合"占位符用 `<...>` 包裹"的约定
   - 修改 README/CHANGELOG 时同步更新相关章节
4. **本地验证**:
   - 至少在一个真实项目里跑过 `/openpocket` → `/handoff` → `/verify` 全流程
   - 检查 `/help` 各种模式的回复仍然合理
5. **Commit message** 建议遵循 [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: 新增 /help troubleshooting 模式`
   - `fix: /recall 在归档 T 块时找不到附件`
   - `docs: README 补充 mobile 项目类型示例`
   - `refactor: 把 boot logic 从 SKILL.md 拆到 templates/`
6. **Push** 并创建 **Pull Request**

### PR 合并标准

- ✅ 通过基本流程（openpocket → handoff → verify）
- ✅ 不破坏现有命令的语义
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

- 动词开头: `/openpocket` / `/putintopocket` / `/statuspocket`
- 短命令优先（< 15 字符）
- 触发条件清晰（自然语言也能识别意图）
- 输出可预测（一行 / 多行 / 结构化）

---

## 项目结构

```
context-pocket/
├── README.md              # GitHub 主页文档
├── SKILL.md               # Agent 加载的 skill 定义
├── LICENSE                # MIT
├── CHANGELOG.md           # 变更日志
├── CONTRIBUTING.md        # 本文件
├── .gitignore
├── templates/             # bootstrap 时复制到 ContextPocket/ 的模板
│   ├── readme.md
│   ├── config.md
│   ├── index.md
│   ├── state.md
│   ├── requirements.md
│   ├── preferences.md
│   ├── decisions.md
│   ├── code-map.md
│   ├── absolute.md
│   ├── log.md
│   ├── log-archive.md
│   └── handoff.md
└── docs/                  # (未来) 详细文档
```

---

## 发布流程（维护者）

1. 更新 `CHANGELOG.md` 的 `[Unreleased]` 部分
2. 在 README 里改版本徽章
3. 创建 Git tag: `git tag -a v1.2.0 -m "Release 1.2.0"`
4. 创建 GitHub Release,粘贴 CHANGELOG 摘要
5. 在社区/Discord 发公告（如果有）

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