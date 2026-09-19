# Code Map · T<n> · <date>

> Module/file map: role, key functions, deps, reqs, last-changed T#.
> Update every turn when files are created/modified/deleted.

## Structure
```
src/
├── <entry-file>     → <one-line role, e.g. "app entry, initializes framework">
│                      key: <main functions / exports>
│                      deps: <what it imports / depends on>
│                      reqs: R<x>, R<y>
│                      T<n>: <last change>
├── <subdir-1>/
│   ├── <file-a>     → <one-line role>
│   │                  key: <main functions>
│   │                  deps: <deps>
│   │                  reqs: R<x>
│   │                  T<n>: <change>
│   └── <file-b>     → <one-line role>
│                      key: <main functions>
│                      deps: <deps>
│                      T<n>: <change>
├── <subdir-2>/
│   ├── <nested-dir>/
│   │   └── <file>   → <one-line role>
│   │                  key: <main functions>
│   │                  deps: <deps>
│   │                  T<n>: <change>
│   └── <file-c>     → <one-line role>
│                      key: <main functions>
│                      deps: <deps>
│                      T<n>: <change>
└── <shared-or-utils>/
    └── <file>       → <one-line role>
                       key: <main functions>
                       deps: <deps>
                       T<n>: <change>

tests/
├── <file.test.ext>  → <one-line role, e.g. "unit tests for src/...">
│                      key: <N tests, test framework>
│                      deps: <source files under test>
│                      T<n>: <change>
└── <e2e-or-integration>/
    └── <file>       → <one-line role>
                       key: <test scope>
                       T<n>: <change>

<root-config-file>   → <one-line role, e.g. "build config">
                       key: <main config fields>
                       T<n>: <change>
<root-config-file-2> → <one-line role, e.g. "dependency manifest">
                       key: <key deps / scripts>
                       T<n>: <change>
```

## Key Relationships
- <file-a> → <file-b> (<description, e.g. "mounts / calls / guards">)
- <file-c> ↔ <file-d> (<description, e.g. "bidirectional data flow">)
- <module-x> = <single source of truth for …>

## Recently Changed (last 5)
- T<n>: <file> — <change>
- T<n>: <file> — <change>
- T<n>: <file> — <change>
- T<n>: <file> — <change>
- T<n>: <file> — <change>
