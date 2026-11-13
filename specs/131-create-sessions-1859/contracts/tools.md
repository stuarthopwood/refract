# Contract 131: Create and nest Session Host tools

Extends contract 129. Errors use spec 124's `{ error: { code, message } }` with `isError: true`. Results are capped at 8 KiB. Names carry the `refract_` prefix. The caller is the stream owner, never an argument.

## refract_create_session

Args: `{ prompt: string, name?: string, base_branch?: string, role?: string, parent_id?: string | null }`.
`parent_id`: absent = the caller, `null` = a root Session, string = that Session (same Project, not archived).
Result: `{ id, name, branch, parentId?: string, status }`.
Approval: the existing card unless the caller's approval mode is `yolo`.
Errors, in check order: `invalid_input` (empty or > 32 KB prompt, unknown role, unknown branch, archived parent, parent in another Project), `not_found` (unknown `parent_id`), `depth_limit` (parent at depth 3), `child_limit` (parent has 4 live children), `session_limit` (the Project already has 6 live, unarchived Sessions), approval denied, then creation; `start_failed` (the Session exists; message names its id). The parent (still unarchived, same Project), `child_limit` and `session_limit` are checked again under the tree gate after the card. A rename that fails after creation does not fail the call: the result carries a `warning` string and `name` stays the generated name. In `yolo`, `refract_update_session` never raises a card; `refract_create_session` in `yolo` may name any live same-Project parent. The post-approval section runs to the end even if the caller cancels the call. The card clips each line to 200 characters, replaces line breaks, and shows the prompt's total length, "(truncated)" when cut, and the child's start mode.

## refract_update_session

Args: `{ id: string, name?: string, role?: string, parent_id?: string | null }`.
`parent_id`: absent = unchanged, `null` = un-nest, string = nest under that Session.
Result: `{ id, name, parentId?: string }`.
Approval: none when the target and any new parent are inside the caller's own tree (the caller and its descendants); the existing card otherwise.
Errors, in check order: `invalid_input` (nothing to change, unknown role, empty name), `not_found` (unknown target or parent), `invalid_input` (archived or other-Project parent), `invalid_parent` (the Session itself or a descendant), `depth_limit` (any descendant would exceed depth 3), `child_limit` (new parent has 4 live children), approval denied, `session_not_running` (role change on a target with no live agent; message includes its status).

## Tree rules (Rust, from the registry)

- Depth: a root (no parent, or a parent id not in the registry) is 1; a child is its parent's depth + 1; a cycle counts as a root. Maximum 3.
- Live child: not archived. At most 4 per parent.
- Own tree: the caller plus its descendants.
- Delete: live children get `parent_session_id: null`. Archive keeps links.

## First turn of a child

`[Parent Session: "NAME" (id ID). When you finish, report back with refract_send_session_message to that id.]\n\nPROMPT`. Absent for a root Session. Not decorated by working mode.

## Contract 129 additions

`refract_list_sessions` rows and `refract_get_session_status` results add `parentId?: string` when the Session has a parent.

## Registry

`Session.parentSessionId?: string` (`parent_session_id: Option<String>`, `#[serde(default, skip_serializing_if = "Option::is_none")]`). `SessionPatch.parent_session_id: Option<Option<String>>` (`Some(None)` clears).
