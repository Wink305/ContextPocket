# ContextPocket · LOG

> Append-only. One block per substantive turn. Never rewrite existing blocks.
> Omit empty subsections. Never carry over the previous block's content into a new block.
> Session divider before a block when the date changed: `--- SESSION: <YYYY-MM-DD> ---`

## T1 · <one-line gist> · [tag1] [tag2]

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
