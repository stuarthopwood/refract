# Contract: Session kind on the wire

Applies to the Rust to renderer boundary (`sessions.list`, `sessions.create`, session events) and to `registry.json`.

## Session JSON

A Project Session is unchanged except for one added field:

```json
{ "id": "...", "kind": "project", "repositoryId": "r1", "branch": "b", "baseBranch": "main", "worktreePath": "C:\\...", "name": "..." }
```

The Personal Agent:

```json
{ "id": "...", "kind": "personal", "repositoryId": null, "branch": null, "baseBranch": null, "worktreePath": null, "name": "My Agent" }
```

- `kind` is always written. A reader that finds no `kind` (an old `registry.json`) MUST treat the row as `project`.
- The four repository fields are never absent: strings for `project`, `null` for `personal`.
- `sessions.list` rows (`SessionSummary`) carry the same fields plus the existing runtime fields.

## Error codes

Wire codes are `RegistryErrorCode::as_str()` values passed through `map_registry_error` (`ipc/mod.rs:228-233`).

| Code | Raised by | Meaning |
|------|-----------|---------|
| `personal-agent-exists` | `add_session` | A `personal` Session already exists; nothing changed. |
| `personal-agent-protected` | `sessions.archive`, `sessions.delete`, and the registry backstop | The Personal Agent cannot be archived or deleted; nothing changed and no agent was stopped. |

Both are added to the accepted wire code list in `ipc/mod.rs` (the list around `:238-278`). Existing codes keep their meaning.

## Handlers (phase notes)

| Handler | #2004 | Later |
|---------|-------|-------|
| `sessions.list` | returns `personal` rows with null fields; no per-Session git work for them | #2007 summary gives a clean not-applicable worktree state |
| `sessions.archive` / `sessions.delete` | refuse `personal` first, before any side effect | #2007 renderer shows the actions disabled with the reason |
| `sessions.rename` | accepts `personal` | none |
| `sessions.create` | project path unchanged; takes no `personal` input | #2005 adds a separate open-or-create handler with no repository or branch input |
| repo-only handlers (git changes, files, diff, PR) | skip or return existing empty/not-found for `personal`; no panic, no error log | #2007 returns an explicit not-applicable result |

No new RPC command crosses the OMP boundary.
