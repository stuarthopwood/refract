# Feature Specification: Checklist per-item controls and the send path

**Feature Branch**: `feat/checklist-controls-2013`
**Created**: 2026-11-20
**Status**: Clarified
**Input**: GitHub issue #2013 (P0, `feature`, child of epic #2015). Builds on #2011 (merged, `2b765e18`, spec 138) and assumes #2012 (the panel, spec 139) merges first. Protocol: [ADR 0011](../../docs/adr/0011-checklist-protocol.md), [design](../../docs/design/checklist-protocol.md). Route: specify. The grill ran as a written step because Stuart is away. Out of scope: the #2014 `MessageSource::ChecklistItem` variant and its chat-row rendering.

## Clarifications

Evidence is `file:line` as read on `origin/main` at `78d21cf4`, or "design" for `docs/design/checklist-protocol.md` (lines 294-345 are the envelope and send path). Task T001 re-reads each cited line before it is relied on.

### Session 2026-11-20

- Q: Which pieces does #2013 build, and which does #2012 or #2014? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): #2013 builds `checklist.itemMessage`, the tag-parameterised envelope with `<checklist-item>`, `send_checklist_item`, the send record written before the send, the `pendingComplete` wiring and settle, then the per-item renderer controls inside the #2012 panel. #2012 owns the panel shell, store and `CHECKBOX_BOX_ONLY_CLASS`; #2014 owns the `MessageSource` variant and the row.
- Q: One disclosure per item, with a RadioGroup, or two peer buttons? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): one disclosure per item. Its textarea has a `RadioGroup` ("Ask the agent" / "Provide a value") and one `default` `sm` Send. Only one form is open at a time, so Send is the single commit action (`components.md` Button table). Two peer buttons break the one-filled-button rule and hide that the caps differ (value 1024, ask 4096; `CHECKLIST_CAPS`).
- Q: Does the renderer call `mutate` and then `itemMessage` for a value? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): no. Rust applies `setValue` inside `itemMessage action="value"` (design:316), so the renderer calls `itemMessage` alone. Two calls would produce two revs and two events.
- Q: What happens with no live agent? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): value still works from the store (design:470). With no live agent, value mode reads "Save value" and calls `mutate setValue`. Ask and "Do this item" are disabled, with visible reason text linked by `aria-describedby`, not a tooltip.
- Q: What is the agent-trigger control? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): "Do this item", a `ghost` `sm` button, shown only when `agentCompletable`, owner is not `human` and status is not `complete`. It needs a developer-set value (`valueBy === 'developer'`, design:325), unlike the tick where any value counts. It stays mounted as `aria-disabled` "Agent is doing this item" while `in_progress`.
- Q: Where do in-progress and awaiting-input come from? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): derived from `item.status` and `value`. `Checklist` has no `pendingComplete` (it is on `ChecklistFile`), and Rust sets `in_progress` on accept. "Needs a value" is an icon plus a word, and a button that opens value mode.
- Q: Draft and focus rules? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): one open textarea at a time. Drafts are keyed `(sessionId, checklistId, itemId)` and cleared only on success. Escape or success returns focus to the item's disclosure button.
- Q: Keyboard, counter, warning, delivery text, refusal? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): Ctrl+Enter sends, using plain `ui/textarea`. A byte counter shows. The plaintext warning is static text linked by `aria-describedby`. A delivery line reads "Queued after the current turn", "Held until you resume" or "Agent not running". A refused send shows `role=alert` "Not sent. Your value is saved on the item" and keeps the draft.
- Q: How can the send record hold the turn hash when the envelope carries the `rev` the same call creates? -> A: Decided (Skippy, added by the spec author 2026-11-20, reason: `accept_complete` in `checklist/records.rs:68` hashes `text` that must already contain the `rev` it computes): `accept_complete` takes a builder `FnOnce(u64) -> String` instead of `text`; it computes the new `rev`, builds the whole turn text with it, hashes that text and returns `(rev, text)`. `ask` and `value` use the same builder with the checklist's current `rev` (after the `setValue` for `value`). The hash is therefore of the exact text sent.
- Q: Does `checklist.itemMessage` take `baseRev`? -> A: Decided (Skippy, added by the spec author 2026-11-20, reason: `value` and `complete` run `apply_developer`, whose `check_agent_change` (`developer_ops.rs:78`) needs it; a stale panel must get `item_changed`, not overwrite an unseen agent change): `checklist.itemMessage(sessionId, checklistId, itemId, baseRev, action, text?)`. `ask` ignores `baseRev` because it changes nothing.
- Q: Which error does a not-eligible `complete` return? -> A: Decided (Skippy, added by the spec author 2026-11-20, reason: design:325 names the code but `ErrorCode` in `checklist/ops.rs:17-31` has no such variant): add `ErrorCode::NotAgentCompletable` (`not_agent_completable`); `ErrorCode::ALL` goes from 12 to 13 and `result.rs` `message()` gets its sentence. The check order is: unknown item, then `not_agent_completable` (not `agentCompletable`, owner `human`, status `complete`, or a pending entry), then `value_required` (`requiresValue` with no developer-set value).
- Q: Who is `by` on the `checklist:update` that a settle restore emits? -> A: Decided (Skippy, added by the spec author 2026-11-20, reason: the restore reverses the developer's own `in_progress`, and the panel only needs a non-agent `by` so it never badges it as an agent change): `Actor::Developer`.
- Q: What is returned, and how is a refusal shown? -> A: Decided (Skippy, added by the spec author 2026-11-20, reason: design:309-313 and `ipc/checklist.rs:62` set the refusal convention): success returns `{ delivery: "sent" | "queued" | "held", checklist }`. An engine refusal returns the existing `{ error: { code, message }, checklist }` data shape. A failed send after a stored `value` returns an `IpcError` `agent-not-running` or `prompt-failed`; the value stays stored and the renderer shows the refusal line.

## User Scenarios and Testing

### User Story 1 - Give a value or ask about one item (Priority: P1)

The developer opens a disclosure on an item, picks "Provide a value" or "Ask the agent", types, and sends with Send or Ctrl+Enter. A value shows on the item at once and reaches the agent as a `<checklist-item>` turn; an ask reaches the agent the same way.

**Independent Test**: `checklist.itemMessage` with `action: "value"` on a Session with a fake agent stores the value, writes the send record, sends one envelope and returns `delivery`.

1. **Given** an idle Session, **When** the developer sends a value, **Then** the item shows it, the turn is sent undecorated, and `delivery` is `sent`.
2. **Given** a working Session, **When** the developer sends an ask, **Then** `delivery` is `queued` and the line "Queued after the current turn" shows.
3. **Given** a paused Session, **Then** `delivery` is `held` and the line "Held until you resume" shows.
4. **Given** no live agent, **When** the developer saves a value, **Then** `mutate setValue` stores it and ask is disabled with its reason.
5. **Given** a refused send, **Then** the value stays stored, the draft stays, and `role=alert` "Not sent. Your value is saved on the item" shows.

### User Story 2 - Do this item (Priority: P1)

For an `agentCompletable`, non-human, not-complete item with a developer-set value (or none required), "Do this item" sends the fixed-template `complete` turn. The item goes `in_progress` and returns to where it was unless the agent or developer re-statuses it.

**Independent Test**: accept, start (own turn reaches the transcript), settle: the entry is removed and the previous status restored only if `statusRev` still equals `turnMarker`.

1. **Given** an eligible item, **When** the developer clicks it, **Then** the item is `in_progress`, an entry and a send record exist, and one envelope was sent.
2. **Given** the agent then completes the item, **Then** the entry is cleared, no revert happens and the item stays complete.
3. **Given** the turn settles with no status change, **Then** the item returns to its previous status.
4. **Given** a refused send, **Then** the status, entry and record are restored before the call returns an error.
5. **Given** `requiresValue` with only an agent-set value, **Then** the call fails `value_required` before anything is sent.
6. **Given** a stop with a queued, unstarted `complete`, **Then** `stop()` settles the entry.

### User Story 3 - Announced states (Priority: P2)

Awaiting-input and in-progress are announced by icon plus word, never colour only; the textarea manages focus.

### Edge Cases

- A `</checklist-item>` or `<session-message ...>` in item text or a value is escaped one level and unescaped on parse (one escape table for both tags).
- Item text with U+2028, U+2029 or bidi controls is flattened with `approval::flatten` before it is quoted, so the quote is one line.
- A `complete` turn for an item whose send record was evicted (501st send) never starts; the settle hook restores it.
- A double click while a call is in flight sends once: the pending entry makes the second `complete` fail `not_agent_completable`; the renderer also disables Send while the call runs.
- Ask or value body over its cap: `too_large` with `field: "text"`, nothing sent.
- A `<checklist-item>` turn is not parsed in the handoff-note turn and not inside a `session-message` body.

## Requirements

### Functional Requirements

- **FR-001**: `agent_tools/envelope.rs` has one tag table; `shift_tags`/`tag_at` escape and unescape both `session-message` and `checklist-item` (open and close, every nesting level). `parse` still accepts exactly one `session-message` envelope. A new `checklist_envelope` module wraps and parses exactly one `<checklist-item checklist item rev action>` envelope, rejects a raw tag of either name in the body, and escapes `checklist` and `item` attributes. Round-trip tests cover each tag inside each envelope.
- **FR-002**: `SessionAgent::send_checklist_item(text) -> Result<MessageDelivery, AgentError>` sits beside `send_session_message` (`chat.rs:51`): held while paused, queued while busy, undecorated, no notice consumed. Both share one private body.
- **FR-003**: `checklist.itemMessage` is a new IPC request (`ipc/checklist_item.rs`, renderer type, `tauri-bridge`, parity script) with actions `ask`, `value`, `complete` and the return shape in Clarifications.
- **FR-004**: `ask` body is the developer's text, at most 4096 bytes (`MAX_ITEM_MESSAGE_BYTES`); `value` text is at most 1024 bytes (`MAX_VALUE_BYTES`); an empty or whitespace-only text is `invalid_input`.
- **FR-005**: `value` applies `setValue` (developer-authored) through `apply_developer` first, then sends the value as the body. A refused send leaves the value stored.
- **FR-006**: `complete` follows the check order in Clarifications, builds the fixed template ("this step you wrote" when `createdBy` is `agent` and `editedByDeveloper` is not set, else "this step the developer wrote"), quotes the item text after `approval::flatten`, then runs `accept_complete`.
- **FR-007**: The send record `{ checklistId, itemId, rev, action, textHash }` is written under the Session lock in the same write as the call's state change, before the send. On a refused send `ask`/`value` records are removed and `complete` uses `refuse_complete`.
- **FR-008**: `ask` and `complete` with no live agent return `agent-not-running` before any state change.
- **FR-009**: `clear_resolved` runs after every accepted checklist op: the agent tool, `checklist.mutate`, `checklist.itemMessage` and `create` with `replace`.
- **FR-010**: An entry starts when the `message_start` user turn of its own envelope reaches the transcript and a send record matches `checklistId`, `itemId`, `rev`, `action == complete` and the text hash. The pass skips the handoff-note turn and never parses a `session-message` body.
- **FR-011**: `handle_turn_settled` runs `settle_started`; `stop()` runs `settle_unstarted`; a process exit or relaunch runs `settle_all`. Each emits `checklist:update` when it changed the checklist.
- **FR-012**: Renderer controls follow the Clarifications decisions: disclosure, RadioGroup, Send, Ctrl+Enter, counter, static plaintext warning with `aria-describedby`, delivery line, refusal alert, "Do this item", awaiting-input and in-progress states, draft keys, focus return.
- **FR-013**: Comments say why, never what (#1322); no touched or new file exceeds 600 lines; every new or changed module has a co-located test file named in tasks.md (Testing rule V1); each guard's test fails when the guard is removed.

### Key Entities

- **Checklist item turn**: a developer chat turn that is exactly one `<checklist-item>` envelope.
- **Send record**: hash-only note of such a turn (stored by #2011, written here).
- **Pending complete entry**: `{ checklistId, itemId, turnMarker, started }` on `ChecklistFile`.

## Success Criteria

- **SC-001**: Envelope round-trip tests pass for each tag inside each envelope, and a forged tag of either name is rejected.
- **SC-002**: A fake-agent test proves `itemMessage` order: state change and record are stored before `send_checklist_item` runs.
- **SC-003**: A lifecycle test proves accept, refuse, start, settle, stop and relaunch for the `complete` entry, and that an agent or developer status change blocks the restore.
- **SC-004**: A live scratch Tauri debug build shows ask, value, save-value and Do this item with real input and screenshots.
- **SC-005**: `pnpm ci:local` is clean, including `check:file-size`, `check:comment-density` and `check:parity`.

## Assumptions

- #2012 is merged first; its panel files, store and `CHECKBOX_BOX_ONLY_CLASS` are re-read in T001 and the task file lists use the names found there.
- Values are plain text (design "Values are not secrets"); the warning here is the static text, not a redaction.
- `CHECKLIST_CAPS` in `src/shared/checklist.ts` carries the 1024 and 4096 caps; T001 confirms, and T012 adds the missing one if absent.
- No `MessageSource` variant or row rendering is written here (#2014).
