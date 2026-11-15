# ContextPocket · LOG

> Append-only. One block per substantive turn. Never rewrite existing blocks.
> Conformance fixture for docs/format-spec.md (format v2).

--- SESSION: 2026-11-15 ---

## T1 · 选纯 Markdown 做存储 · [arch] [storage]
--- WHEN: 2026-11-15 09:00 ---

### Author
- claude-code

### User
- 把项目记忆存在本地，不要上云

### Action
- 新增 src/store.ts

### Decisions & Constraints
- 不引入数据库与向量库

--- SESSION: 2026-11-16 ---

## T2 · 实现 T-block 追加 · [core]
--- WHEN: 2026-11-16 10:30 ---

### Author
- codex

### User
- 继续

### Action
- 修改 src/writer.ts

### Uncertain
- ❓ 是否需要并发锁

## T3 · 补回归测试 · [test]
--- WHEN: 2026-11-16 11:00 ---

### Author
- cursor

### User
- 加个锁

### Action
- 新增 tests/writer.test.ts

## T2-fix · 更正：追加前先取锁 · [correction]

### Action
- 补充 T2 遗漏的锁说明；T2 原文不改

### Conflicts
- ⚠️ contradicts T2: 先取锁再追加
