# ContextPocket · LOG

> Append-only. One block per substantive turn. Never rewrite existing blocks.
> Omit empty subsections. Never carry over the previous block's content into a new block.
> Session divider before a block when the date changed: `--- SESSION: <YYYY-MM-DD> ---`
> Time line right under each `## T<n>` heading (format v2): `--- WHEN: <YYYY-MM-DD HH:mm> ---`
>   Written by `log append` (default = the moment you recorded it). Other shapes the tool
>   accepts: range `--- WHEN: 2026-05-01 09:00 → 2026-05-01 11:30 ---` · day only, no clock
>   known (this is what a migrated v1 block looks like) `--- WHEN: 2026-05-01 (day) ---` ·
>   the user's own words, never computed `--- WHEN: stated: 上周三下午 ---`

## T1 · <one-line gist> · [tag1] [tag2]
--- WHEN: <YYYY-MM-DD HH:mm> ---

### Author
- <which agent recorded this turn>   (omit when unsigned — the tool never invents a name; `log append --author`)

### User
- <user's full request — all parts, all conditions>

### Action
- <操作类型> <file path> — <what was done>
- <concrete: functions, endpoints, patterns>

### Commits
- <short-hash> — <message>   (omit section if no commits)

### Decisions & Constraints
- <why this approach; non-trivial → also ADR in decisions.md>

### Pitfalls
- <trap discovered → also state.md Pitfalls>   (omit if none)

### Preferences
- <preference this turn>   (omit if none)

### Conflicts
- ⚠️ contradicts T<a>/R<m>/ADR-x: <before vs now>   (omit if none)

### Attachments
- T1 <label>: assets/T01-<slug>.<ext> — <what it is>   (omit if none)

### Uncertain
- ❓ <inferred, unconfirmed>   (omit if none)
