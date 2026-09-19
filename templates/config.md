# ContextPocket · CONFIG
> Optional. Absent → defaults below apply. Edit anytime; picked up on next /openpocket.

- project_type: <frontend|backend|fullstack|data|mobile>
- mode: full               # full = 全套 12 文件；lite = 只建核心 5 个（readme/state/code-map/log/index），其余用到才建
- archive_at: 800            # log.md 超过多少行触发归档
- recent_keep: 30            # 归档时保留最近多少个完整 T 块
- gitignore: true            # true = 把 ContextPocket/ 加进 .gitignore（项目本地）；
                              #        false = 让 ContextPocket/ 进 git（跨设备同步，需配合串行交接约定）
- language: zh               # 记录语言（zh / en / follow user）
- quiet: true                # true = 每轮最多一行确认；false = 详细报告
# 标签跟随 language 配置变化：
#   language: zh → 使用中文标签（下方默认值）
#   language: en → 使用英文标签：requirement-change, code-logic, arch-decision, bug, preference, dependency, test, ui, api, deploy, docs, pitfall, conflict, correction
- tags_default: [需求变更, 代码逻辑, 架构决策, Bug, 偏好, 依赖, 测试, UI, API, 部署, 文档, 坑点, 冲突, correction]
