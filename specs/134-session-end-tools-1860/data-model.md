# Data Model: Session end tools (#1860)

No registry schema change; no new persisted field. Everything below is in-memory or derived.

## Existing fields used

- `Session.id`, `repository_id`, `parent_session_id`, `archived_at`, `name`; `Session::is_personal()`.
- Pause state: `AgentState.pause.held` (persisted by spec 127), driven only through `SessionAgent::pause` / `resume`.
- Delete in-flight set: `delete_in_flight::IN_FLIGHT` (`claim`, `is_deleting`).

## Derived values

| Value | Definition |
|---|---|
| Caller | the Session whose launch registered the tool; never an argument |
| Ancestors of X | repeatedly follow `parent_session_id` (cycle and dangling parent stop the walk, as `depth_of` does) |
| Refused target | `target == caller` or `target` in `ancestors(caller)` or `target.is_personal()` |
| Inside own tree | `tree_gate::inside_own_tree(sessions, caller, target, None)` |
| Cascade set | `[target] + descendants(target)` filtered to `archived_at.is_none()`; order deepest first for the writes, tree order for the card |
| Needs card | `needs_card(tool, inside_own_tree, yolo)` (table in plan.md) |

## Request types (Rust)

```rust
struct EndRequest { id: String, include_children: bool } // include_children only for archive
enum EndTool { Archive, Unarchive, Stop, Pause, Resume, Delete }
```

## State transitions

| Tool | Allowed from | Result |
|---|---|---|
| archive | live (not archived) | `archivedAt` set; agent stopped; with `include_children`, every live descendant too |
| unarchive | archived | `archivedAt` cleared if the parent has fewer than 4 live children |
| stop | any non-stopped, non-archived Session with a process or turn | agent shut down (Stop action) |
| pause | running or idle, not paused | pause held (spec 127) |
| resume | paused with a process | resume drain (spec 127) |
| delete | any non-personal Session not already deleting | in-flight claim, background removal, registry row removed, live children re-rooted |

Anything else returns `invalid_state` (or `session_not_running` for pause/resume/stop on a stopped Session).
