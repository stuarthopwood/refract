# Contract 134: Session end tools

Extends contracts 129 and 131. Errors use spec 124's `{ error: { code, message } }` with `isError: true`. Results are capped at 8 KiB. Names carry the `refract_` prefix. The caller is the stream owner, never an argument. Check order for every tool: arguments, existence, target refusal, state, approval, re-check under the Project tree gate, action.

## Schemas

All `parameters` are `{ type: "object", additionalProperties: false }`, `id` required and a non-empty string.

| Tool | Args | Result |
|---|---|---|
| `refract_archive_session` | `{ id: string, include_children?: boolean }` (default false) | `{ outcome: "archived", ids: string[] }` (target first, then descendants) |
| `refract_unarchive_session` | `{ id: string }` | `{ outcome: "unarchived", id }` |
| `refract_stop_session` | `{ id: string }` | `{ outcome: "stopped", id }` |
| `refract_pause_session` | `{ id: string }` | `{ outcome: "paused", id }` |
| `refract_resume_session` | `{ id: string }` | `{ outcome: "resumed", id }` |
| `refract_delete_session` | `{ id: string }` | `{ outcome: "deleting", id }` (removal continues in the background) |

## Errors

| Code | When |
|---|---|
| `invalid_input` | bad or unknown arguments, empty `id`, `include_children` not a boolean or sent to a tool other than archive |
| `not_found` | no Session with that id, or it is in another Project |
| `invalid_target` | target is the caller, an ancestor of the caller, or the Personal Agent (message names which) |
| `invalid_state` | archive of an archived Session; unarchive of a live one; stop of a stopped one; pause of a paused one; resume of a Session that is not paused; any call on a Session being deleted, or an archive cascade containing one |
| `session_not_running` | pause, resume or stop on a stopped Session; resume never starts a Session |
| `child_limit` | unarchive when the parent already has 4 live children |
| `denied` | the developer denied the card |
| `cancelled` | the approval was cancelled, the caller was deleted or Refract is shutting down, or the cascade set or the caller's own-tree status changed while the card was open |
| `delete_refused` | the Delete Session refusals (worktree holder, removal already running, not a Project Session); message carries the Delete flow's text |

## Approval cards

`approval::session_card(call_id, tool, title, details)`.

| Tool | Title | Details |
|---|---|---|
| archive | `Archive Session NAME` or `Archive N Sessions` | one line per Session name when cascading |
| stop | `Stop Session NAME` | none |
| pause / resume | `Pause Session NAME` / `Resume Session NAME` | none |
| unarchive | `Unarchive Session NAME` | none |
| delete | `Delete Session NAME` | `Its worktree and Conversations are removed.`, and `Live child Sessions become root Sessions.` when it has any |

Card policy: archive and stop ask unless `yolo`; pause, resume and unarchive ask unless `yolo` or the target is in the caller's own tree; delete always asks.

## Side effects

- Archive: stops each agent, clears process records, stamps `archivedAt`, notifies list changed; children keep `parentSessionId`.
- Delete: ADR 0009 re-rooting happens in `Registry::remove_session` in the same persist as the removal. A later failure arrives as `session-delete-failed`, not as a tool result.
