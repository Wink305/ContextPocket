# Handoff · T<n> · <date>
> ⚠️ STALE if log.md's latest T > T<n>. Regenerate before relying on this.
> generated-at: T<n> · per-section caps, truncation always reported · disposable derived view.

## 0 · Start here (read this, then act)
> STOP CONDITION: read this section, confirm every ❓ and obey every 🔒 line, then you may start.
> Do NOT open other files unless a trigger in "1 · On demand" fires.

### State
<from state.md, including pitfalls; capped at 12 lines>

### 🔒 Red lines (never violate, never compress)
<one line per absolute.md entry; capped at 12>

### ❓ Must confirm with the user before acting
<uncertain requirements + T-block "Uncertain" sections; capped at 8>

### Next
<from state.md nextSteps; capped at 6>

## 1 · On demand (only when triggered)
> Trigger: changing a file → Code Map; judging an old decision → `search <kw> --expand 2 --as-of T<n>`;
> needing detail → `recall T<n>` / `log.md`. Otherwise skip this section entirely.

### Node chains (from open work to constraints / sources)
- <seed> →(<edge type>) <node> →(<edge type>) <node>  [T<n> · T<n>]
- (pruned) ADR-x superseded by ADR-y at T<n> — excluded from Key Decisions
<8-chain safety limit; truncation always reported>

### Recent (last 5 T gists)
- T<…>: <gist>

### Open Requirements
<R-ids + impl files + ❓ flags; capped at 8>

### Key Decisions (current only)
<ADR titles still in force; superseded ADRs excluded; capped at 8>

### Code Map (top 3 levels, capped)
- <path> → <role>
<capped at 12; full detail in code-map.md>

## 2 · Pointers
- Truth: readme.md / state.md / requirements.md / decisions.md / code-map.md / log.md / absolute.md
- Regenerate this view with `handoff`; run `verify` before a formal handoff.
- Detail: `recall T<n>` · `search <kw> --expand 2` · `why <file>` · `diff Ta Tb`.
- ContextPocket is already active — keep recording every turn.

> handoff.md is a disposable derived view. The Markdown sources stay the single truth.
> Every section has a hard cap; when a cap fires the file says how many items were omitted and where to look.
