# Agent-created Sessions follow fixed tree rules, and approval follows the own tree

Status: Accepted. Date: 2026-11-13. Deciders: Stuart (grill 2026-11-12), Skippy (delegated).

Slice 3 of the agent sessions epic (#1859) adds `refract_create_session` and `refract_update_session`, so an agent can start a Session of its own and arrange Sessions into a tree. Nothing else limits how far or how wide an agent can fan out, so the rules live in Rust, not in the prompt.

Rules:
- **Shape.** Depth counts from the registry parent chain, root = 1, and at most 3. A parent has at most 4 live children, where live means not archived (stopped and hidden count). A broken or cyclic chain, or a parent id missing from the registry, counts as a root. Errors are `depth_limit`, `child_limit` and `invalid_parent`, never toasts.
- **Atomicity.** One process-wide async gate is held from the limit check to the registry insert (create) or patch (update), so two racing calls cannot both pass the check.
- **Approval scope.** `create_session` raises the approval card unless the caller runs in `yolo`. `update_session` skips the card only when the target and any new parent are both inside the caller's own tree (the caller plus its descendants; un-nesting a Session in the tree counts as inside), or when the caller runs in `yolo`. Anything else raises the card. Whatever the mode, the target must be in the caller's Project (`invalid_input` otherwise, before any card), so `yolo` reaches the caller's Project and no further.
- **Deletion.** Deleting a parent re-roots its live children; archiving keeps the links.
- **Project cap.** An agent create fails with `session_limit` when the Project already has 6 live Sessions. It bounds the fan-out of a `yolo` create, which may name any live same-Project parent (accepted yolo reach). Unarchive and the UI create are user actions and keep only the 4-child limit. Unarchiving takes the same gate and refuses when the parent would pass 4 live children.
- **Access.** Root Sessions at every depth register all five Session tools, because a child must be able to report back with `send_session_message`. The `Role::Child` row stays empty.

**Why:** the limits protect the developer's machine and attention from runaway fan-out, so they cannot depend on a model obeying a rule. The own-tree scope lets an agent tidy its own work without a card on every rename, while anything that touches a sibling, a parent or another root still needs the developer.

**Alternatives rejected:**
- Limits only in the rules text. A model can ignore them.
- A card for every update. It makes a rename in the agent's own tree a chore.
- Counting stopped or hidden children as not live. A parent could then exceed 4 children the developer can still see and resume.

**Consequences:** `parent_session_id` is persisted in `registry.json` with a serde default, so older registries load with no parents. The tree UI (#1862) and the archive and delete tools (#1860) build on these rules and must not bypass the gate.
