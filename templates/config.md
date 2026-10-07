# ContextPocket · CONFIG
> Optional. Absent → defaults below apply. Edit anytime; picked up on the next write.

- project_type: <frontend|backend|fullstack|data|mobile>
- mode: full               # full = 10 个核心文件（log-archive.md / handoff.md 用到才建）；lite = 只建核心 5 个（readme/state/code-map/log/index）
- archive_at: 800            # log.md 达到多少行时 status / verify 提示"该归档了"（归档不会自动发生，必须有人触发）
- recent_keep: 30            # 归档时保留最近多少个完整 T 块；`archive --keep-last N` 可单次覆盖
- gitignore: true            # 初始化时采用的取值：true = 把 ContextPocket/ 加进 .gitignore（项目本地）；
                              #        false = 让 ContextPocket/ 进 git（跨设备同步，需配合串行交接约定）。
                              #        事后改这一行不会重写 .gitignore，要切换请手工编辑 .gitignore
- language: zh               # 记录语言（zh / en / follow user）
- quiet: true                # true = 每轮最多一行确认；false = 详细报告
- secret_scan: true          # verify 是否扫描 pocket 里的密钥 / PII 形状（sk-ant-…、AKIA…、私钥块、JWT、
                              #        身份证、卡号、password: xxxx）。带厂商前缀的那批报 ERROR —— 也就是
                              #        会拦住 pre-commit；PII 与手写赋值只报 WARNING，绝不拦提交。
                              #        确实要在记录里保留这些串（例如在写密钥轮换手册）才改成 false
# 标签跟随 language 配置变化：
#   language: zh → 使用中文标签（下方默认值）
#   language: en → 使用英文标签：requirement-change, code-logic, arch-decision, bug, preference, dependency, test, ui, api, deploy, docs, pitfall, conflict, correction
- tags_default: [需求变更, 代码逻辑, 架构决策, Bug, 偏好, 依赖, 测试, UI, API, 部署, 文档, 坑点, 冲突, correction]
