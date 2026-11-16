# Data Model: Personal Agent

## Session (persisted, `registry.json`)

Existing entity (`src-tauri/src/store/registry.rs:33-74`, `src/shared/model.ts:33-57`). Only the rows that change are listed; every other field is untouched.

| Field | `project` | `personal` | Notes |
|-------|-----------|------------|-------|
| `kind` | `"project"` | `"personal"` | New. Absent on disk means `project` (FR-004). |
| `repositoryId` | required string | `null` | Unchanged for `project`. |
| `branch` | required string | `null` | |
| `baseBranch` | required string | `null` | |
| `worktreePath` | required string | `null` | No worktree is ever created for `personal`. |
| `name` | user or generated | defaults to `"My Agent"`, renameable (FR-009) | Same validation as any Session. |
| `parentSessionId` | optional | always absent | A Child Session needs a worktree (OQ-1 interim). |
| everything else | as today | as today | `sessionDir`, `currentConversation`, `lastModel`, `pausedHeld`, `archivedAt`, `hiddenAt`, ... |

### Rust shape

`kind: SessionKind` (`Project` default, `Personal`) serialised lowercase; the four repository fields are `Option<String>` with `#[serde(default)]`, written as `null` when `None` (no `skip_serializing_if`, so the wire shape is a clean union). `Session::project_binding()` returns the four values together or `None` for `personal`.

### TypeScript shape

```ts
interface SessionBase { /* every field except the four repository fields and kind */ }
interface ProjectSession extends SessionBase {
  kind: 'project'; repositoryId: string; branch: string; baseBranch: string; worktreePath: string;
}
interface PersonalSession extends SessionBase {
  kind: 'personal'; repositoryId: null; branch: null; baseBranch: null; worktreePath: null;
}
type Session = ProjectSession | PersonalSession;
type SessionSummary = Session & { /* runtime fields, as today */ };
```

## Invariants (enforced in `RegistryStore`)

| # | Rule | Enforcement | Spec |
|---|------|-------------|------|
| I1 | At most one `personal` Session | `add_session` refuses a second with `personal-agent-exists`; registry unchanged | FR-003 |
| I2 | A `project` Session has all four repository fields | `add_session` refuses a `project` row missing any; `open` treats a stored one as a malformed file (quarantine and default, as today) | FR-002 |
| I3 | `personal` needs no Project | `add_session` skips the Project-exists, worktree-path and branch checks for `personal` | FR-005 |
| I4 | `personal` cannot be archived | `update_session` refuses `archived_at: Some(Some(_))`; `sessions.archive` refuses before any side effect; `personal-agent-protected` | FR-006 |
| I5 | `personal` cannot be deleted | `remove_session` refuses; `sessions.delete` refuses before any side effect; `personal-agent-protected` | FR-006 |
| I6 | Stop, start, pause, rename, new Conversation allowed | no rule added | FR-006 |
| I7 | A Project removal never touches `personal` | `remove_repository` compares `repository_id` as an optional value, so a `null` never matches | spec edge case |
| I8 | Two `personal` rows on disk load; earliest by `createdAt` is the singleton; the rest are logged as a warning and kept | `open`; OQ-3 interim | OQ-3 |

## State and lifecycle

The Personal Agent has the same runtime states as any Session (`SessionStatus`). Lifecycle differences:

```text
absent --open (#2005)--> exists, stopped --start--> running <--> paused
exists --archive/delete--> refused (stays as is)
exists --rename / new Conversation--> allowed
```

It is never archived, never hidden from the list (OQ-2 interim), never auto-cleaned (FR-010), and never a parent or child.

## Derived and non-persisted

- Working folder: not stored; resolved to the home folder on every launch (#2005, FR-012).
- Display state on the launcher (#2006): derived from the same runtime summary as a Session row.
