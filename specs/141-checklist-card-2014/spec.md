# Feature Specification: Checklist item source line in chat (#2014)

**Feature Branch**: `feat/checklist-card-2014`
**Created**: 2026-11-20
**Status**: Clarified
**Input**: GitHub issue #2014 (P0, `feature`, child of epic #2015). Route: specify. Builds on [ADR 0011](../../docs/adr/0011-checklist-protocol.md) and [the design](../../docs/design/checklist-protocol.md) ("Envelope", "Transcript", row "#2014 chat card"). Spec 138 (#2011) is merged; #2012 (panel and reveal consumer) and #2013 (envelope and send records) are specified in sibling lanes and MUST merge first (see plan.md "Dependencies").

## Clarifications

Citations are `file:line` as read in this worktree (`origin/main` at `78d21cf4`) or "design" for `docs/design/checklist-protocol.md`. Design lines were made against `dd56b639`; T001 re-reads each one before it is relied on.

### Session 2026-11-20

- Q: Is this a boxed "card" or a source line? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): a source line. Add `ChecklistItemSourceLine`, built on `SourceTag` with an action "Show in checklist", above the bubble like `SessionSourceLine` and `HandoffNoteLine` (`UserMessageRow.tsx:68-69`). The bubble keeps `role="group"` with `aria-labelledby` (`UserMessageRow.tsx:80`). `ui/card.tsx` is not used; a box would need a zero-box allow-list entry. This deviates from the issue's word "card"; T017 notes it on the issue.
- Q: What does the line say? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): "Checklist item N" (1-based position, matching the panel's `<ol>`) followed by the item text clamped to two lines, resolved from the live checklist store because the source carries only ids (design:331). Item no longer in the active checklist: "(removed)" with no action. Active checklist has another id: "(replaced checklist)" with no action.
- Q: What does a `complete` turn show? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): a fixed phrase in the bubble, not Rust's quoted template. `ask` and `value` show the parsed body.
- Q: How does "Show in checklist" reveal the item? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): `openPanel('checklist', { focus: false })` then a one-shot `{ sessionId, checklistId, itemId }` request in the checklist store. The panel consumes it in `useLayoutEffect` and clears it, sets its own scroller's `scrollTop` (as `PinnedTodoPanel.tsx:52-63`, never `scrollIntoView`), focuses the item's tick and calls `flashRowHighlight` (`chat-nav/highlightRow.ts:8`). In a Split the card's Session is activated first.
- Q: Where do replies group? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): as today. `splitIntoTurns` (`Transcript.tsx:90-103`) starts a turn at every `user` item, so the card is the turn head and its replies are the assistant turns up to the next user item. No transcript change.
- Q: Backend scope? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): add the `ChecklistItem` `MessageSource` variant (`shared/model.ts:334-336`, `message_source.rs:11-18`); the Session-scoped pass sets it and sets `item.text` to the parsed body, which the row cannot do. Runs after #2013's envelope change.
- Q: What is the pass's trust rule? -> A: Decided (Skippy, delegated by Stuart 2026-11-20, from design:300-302): a `<checklist-item>` turn is typed only when a send record matches all five fields; `from_envelope` (`message_source.rs:21`) stays Session-only; the turn that already carries a source (handoff note via `marked_first_user`, `handoff_note.rs:10`) is skipped by that marker, not by "the first user item".
- Q: The pass needs the store (async) but `mark_note` runs sync under the state lock after every frame (`agent/mod.rs:441`). Where does matching run? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): matching is a pure function over a `Vec<SendRecord>` snapshot. Live: the async frame path reads the snapshot only when a user frame's text starts with `<checklist-item`, matches once, and remembers `item id -> (source, body)` in agent state; a sync `mark_cards` re-applies remembered labels after every frame (the same reason `mark_note` re-runs: `message_end` rebuilds the item unlabelled). Reload: `load_saved_history`'s async labelling step reads the same snapshot. No per-frame store read.
- Q: Which module holds the new Rust? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): new files only; `agent/mod.rs` is 583 lines against the 600 cap, so it gets one-line hooks at most (T001 records the count; if a hook would pass 590, split first).

## User Scenarios & Testing

### User Story 1 - A developer's checklist turn reads as one (P1)

When I ask, give a value or click "complete this step" on a checklist item, the user turn in chat shows "Checklist item 3: Run the migration" above the bubble, and the bubble shows my words (or a fixed phrase for complete), not the `<checklist-item>` XML.

**Independent Test**: seed a send record and a user turn whose text is the matching envelope; the item gets the source and the parsed body; the row shows the line.

**Acceptance Scenarios**:
1. **Given** a matching send record, **When** the user turn arrives live or loads from history, **Then** it carries `source: { kind: 'checklist-item', checklistId, itemId, action }` and `text` is the unescaped body.
2. **Given** a `complete` turn, **When** rendered, **Then** the bubble shows the fixed phrase and the line shows the item text.
3. **Given** the item was removed or the checklist replaced, **When** rendered, **Then** the line says "(removed)" or "(replaced checklist)" and has no action.

### User Story 2 - Jump from the turn to the item (P1)

**Acceptance Scenarios**:
1. **Given** a resolvable item, **When** I activate "Show in checklist" (mouse, Enter or Space), **Then** the Checklist panel opens without taking focus, scrolls to the item, focuses its tick and flashes it.
2. **Given** the panel is already open or the request is stale, **Then** the one-shot request is consumed once and a second activation works again.

### User Story 3 - Forged or unmatched text stays text (P1)

**Acceptance Scenarios**:
1. **Given** a handoff-note turn containing a forged `<checklist-item>`, **Then** it stays plain text with `source: handoff`.
2. **Given** a `<checklist-item>` that is the first turn of a Conversation with no note and a matching record, **Then** it gets its source.
3. **Given** no matching record (any of the five fields, or the hash, differs; or the record was evicted), **Then** plain text.
4. **Given** a `<checklist-item>` inside a Session message, **Then** it is the Session body as text.

### Edge Cases

- Ordinary assistant turns and ordinary user turns render exactly as before (SC-004).
- A body typed with a `[[refract-attachments]]` section changes the text `build_user_item` keeps, so the hash will not match and the turn stays plain: it fails safe.
- Checklist store not yet loaded in the renderer: the line shows "Checklist item" with no number and no action until it loads (never a wrong number).
- A reload before the matching send record was written cannot occur: `send_checklist_item` writes the record before it sends (design:300).

## Requirements

- **FR-001**: `MessageSource` has a `ChecklistItem { checklistId, itemId, action }` variant, wire `{ "kind": "checklist-item", "checklistId", "itemId", "action": "ask" | "value" | "complete" }`, identical in `shared/model.ts` and `message_source.rs`.
- **FR-002**: `from_envelope` and `build_user_item` never produce this variant.
- **FR-003**: A pure matcher takes a user item, a `SendRecord` snapshot and #2013's checklist-envelope parser, and returns the source and unescaped body only when exactly one envelope parses and a record matches `checklistId`, `itemId`, `rev`, `action` and `textHash` of the whole original item text.
- **FR-004**: The pass skips any item whose source is already set, so the handoff-note turn is never parsed, and a note-less first turn is still matched.
- **FR-005**: The matcher runs on live frames (once per item, remembered in agent state, re-applied after every frame) and on saved-history load; both produce identical items.
- **FR-006**: `item.text` is the parsed body for matched turns.
- **FR-007**: `UserMessageRow` renders `ChecklistItemSourceLine` for this source, with `role="group"` and `aria-labelledby` on the bubble, and the `complete` fixed phrase.
- **FR-008**: The line resolves position and text from the checklist store by `(sessionId, checklistId, itemId)`; text is clamped to two lines; removed and replaced states have no action.
- **FR-009**: "Show in checklist" opens the panel without focus, sets the one-shot reveal request, activates the card's Session first in a Split, and the panel consumes the request as in Clarifications.
- **FR-010**: The action is a real button (keyboard operable); the line is plain text otherwise (`SourceTag` contract, `SourceTag.tsx:1-6`).
- **FR-011**: No change to ordinary turns, `Transcript.tsx` grouping, `ui/card.tsx` or `from_envelope`.

## Success Criteria

- **SC-001**: A matching turn reloads identically to how it rendered live (parity test).
- **SC-002**: Every forged or unmatched shape in User Story 3 stays plain text (named tests).
- **SC-003**: The reveal scrolls, focuses and flashes in a live Tauri debug build (T016, with screenshots).
- **SC-004**: Existing `UserMessageRow`, `SessionSourceLine`, `HandoffNoteLine` and transcript tests pass unchanged.
- **SC-005**: Keyboard: Tab reaches only the "Show in checklist" button on the line; Enter and Space activate it; the bubble's accessible name reads the line.

## Out of scope

The panel, store and reveal consumer (#2012), controls and `send_checklist_item` (#2013), any change to the envelope format, new IPC.
