# Feature Specification: Checklist right-pane panel (#2012)

**Feature Branch**: `feat/checklist-panel-2012`
**Created**: 2026-11-20
**Status**: Clarified
**Input**: GitHub issue #2012 (P0, `feature`, child of epic #2015). Builds on the merged store (#2011, spec 138, `main` at `2b765e18`) and the decided protocol ([ADR 0011](../../docs/adr/0011-checklist-protocol.md), [design](../../docs/design/checklist-protocol.md)). Route: specify. Stuart is away, so the grill ran as a written step (see Clarifications). The per-item controls (#2013: disclosure, value textarea, Do this item) and the chat source line (#2014) are out of scope; the panel must leave room for them and consume the reveal request #2014 sets.

## Clarifications

Evidence is `file:line` as read in this worktree at `origin/main`, or "design" for `docs/design/checklist-protocol.md`. Plan task T001 re-verifies each cite before it is relied on. Spec dir 139 was confirmed free on `origin/main` (highest is `138-checklist-store-2011`).

### Session 2026-11-20

- Q: Hosted panel or pinned panel? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): keep the hosted `PanelId` `'checklist'`. Pinned panels sit behind `RequiresRepository`; `session-usage` renders with only a `sessionId` (`RightPaneShell.tsx:151`). The issue's "pinned" wording is stale; a note goes on the issue.
- Q: When does the panel auto-open? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): only when `checklist:update` has `opened === true` and `payload.sessionId` is the front Session, with `focus:false`. If `'checklist'` is already in `openPanelIds`, update the store only, because `openPanel` always sets `activePanelId` and clears the front Session's document tab (`right-pane-store.ts:67-81`). The subscription lives in `init-stores.ts`; the store hydrates when a Session becomes front (the #2014 card needs it); a polite live region announces "Checklist opened: <title>, N items".
- Q: How does a tick behave? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): `baseRev` is the rev last rendered; no optimistic update. Pending is `aria-busy` plus `aria-disabled`, never `disabled`; a spinner replaces the tick mark inside the 16px slot so focus never falls to `<body>`. A refusal arrives as `Ok({error, checklist})` (`ipc-checklist.ts:42-48`), not an error: render `refusal.checklist`. For `item_changed`, show a persistent inline `role=alert`: "The agent changed this item to X. Tick again if you still want it." Untick sends `setStatus` with `previousStatus`. A `requiresValue` item with no value gets an `aria-disabled` tick with visible reason text (Rust refuses it).
- Q: How are out-of-order updates and late results handled? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): keep dropping stale revs, now keyed by `(sessionId, checklistId)`. A late `mutate` result lands in the Session captured at call time, never the current one.
- Q: "Tool unavailable": defer or build? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): overturn the deferral. Design (`checklist-protocol.md:519-520`) assigns it to #2012 and its failure table forbids a silently empty panel. The refusal is only `log::warn!` (`agent_tools/mod.rs:114`) with no IPC field, so add a per-Session flag and expose `checklist.get` as `{checklist, toolUnavailable}`. That Rust and IPC change lands first, before #2013 touches `ipc-checklist.ts` and the bridge; it blocks only this state.
- Q: Archive and switcher? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): overturned. `get` returns the active checklist or null and the panel shows only the active one (design:371). On `replace`, swap the panel, announce "Checklist replaced", and move focus to the panel region if it was inside.
- Q: Status map? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): feature-local `CHECKLIST_STATUS_GLYPH`, composing `STATUS_GLYPH['success-done']` (`chat/statusGlyph.ts`) for complete. `TodoTree` is untouched because `CONTEXT.md:183` says a Checklist item is not a Todo task. Icon plus word per status: visible word for `next`, `in_progress`, `blocked`; sr-only word for `upcoming`, `complete`. `aria-current="step"` on the `next` row. `completedBy` is visible text. Complete and in-progress share a colour in dark presets, so icon shape and word must tell them apart. UI text says "item", never "step".
- Q: Text rendering and list markup? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): item text and values render as plain text, `whitespace-pre-wrap break-words`; rows sit in an `<ol>` with stable `<li key=id>`.
- Q: Accessibility bar? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): the tick is labelled by the item text via `aria-labelledby`, 24px target; status never colour alone; the live region stays mounted and announces agent-driven changes; wrapping checked at 240, 320 and 380 px.
- Q: Shared-component changes? -> A: Decided (Skippy, delegated by Stuart 2026-11-20): `ui/checkbox.tsx` gains `CHECKBOX_BOX_ONLY_CLASS` (`CheckboxItem` is a full-row button, so nesting #2013's disclosure inside it is invalid). `scripts/theme-contrast-pairs.mjs` gains `severity-success`, `state-working`, `severity-warning` on `sidebar-right` at 4.5, and `ring` at 3. `globals.css:2577` widens the `[data-slot='message-scroller-item'][data-nav-highlight]` rule to the shared attribute; the checklist row gets `outline-offset:-2px` because the panel scroller clips the outline.
- Q: What does the reveal request look like, and who owns it? -> A: Decided (Skippy, 2026-11-20, added by this spec, not in the record): #2014 sets a one-shot `{sessionId, checklistId, itemId}` in the checklist store; #2012 owns the consumer. Reason: the issue scope lists the consumer, and #2014 needs a stable target. The consumer runs only when the request's Session is front and its `checklistId` is the active one; it scrolls the row into view, calls `flashRowHighlight` (`chat-nav/highlightRow.ts`), and clears the request. A request naming an unknown checklist or item is cleared without effect.
- Q: Where does the `toolUnavailable` flag clear? -> A: Decided (Skippy, 2026-11-20, added by this spec): set at the `log::warn!` site (`agent_tools/mod.rs:114`), cleared by the next successful `refract_checklist` call for that Session and dropped with the Session. Reason: a flag that never clears would show a stale error forever. No `checklist:update` field carries it; the panel reads it from `get` on hydrate and on a front-Session change.

## User Scenarios and Testing

### US1 - The panel opens when the agent creates a checklist (P1)
As a developer asking for a step-by-step plan, I see the Checklist open in the right pane without losing my place.
**Acceptance**
1. Given the front Session, when the agent creates a checklist (`opened: true`), then the `checklist` panel appears in `openPanelIds` without taking keyboard focus, and the live region says "Checklist opened: <title>, N items".
2. Given `'checklist'` is already open, then the store updates and the active tab and document tab are unchanged.
3. Given the update is for a background Session, then nothing opens; switching to that Session hydrates the store from `checklist.get`.

### US2 - Status is readable without colour (P1)
Each item shows tick, text, value (when set) and a status with icon and word; `next` is announced as the current step.

### US3 - Ticking and unticking (P1)
Ticking sends `checklist.mutate` with `baseRev` and `setStatus complete`; unticking restores `previousStatus`. Refusals render without an error toast and resync to `refusal.checklist`.

### US4 - Live updates stay correct (P1)
Agent-driven changes update in place and are announced; stale or out-of-order revs are dropped per `(sessionId, checklistId)`; late results land in their own Session.

### US5 - Tool unavailable is visible (P2)
When the agent's checklist tool was refused, the panel says so instead of staying empty.

### US6 - Reveal request consumer (P2)
A request set by #2014 scrolls to and flashes the item, then clears.

### Edge cases
Empty list; very long item text and values; 240 px width; replace while focus is inside the panel; Session deleted mid-mutate; `store-unsupported` and `store-failed` errors from `checklist.get` (inline error, no crash); reduced motion (the spinner and flash do not depend on motion for meaning).

## Requirements

- **FR-001** A hosted panel `'checklist'` exists in `PanelId`, `HOSTED_PANELS`, the agent panel contract (`actions: []`) and the agent panel list in Rust, rendered by `RightPaneShell` with only `sessionId`.
- **FR-002** `checklist:update` with `opened === true` for the front Session opens the panel with `focus:false`; otherwise it only updates the store. Opening an already-open panel changes no selection.
- **FR-003** A per-Session store holds the active checklist and the `toolUnavailable` flag, hydrates via `checklist.get` when a Session becomes front, and drops any update whose `rev` is not above the held rev for that `(sessionId, checklistId)`.
- **FR-004** Tick sends `checklist.mutate` `setStatus complete` with `baseRev` = rendered rev; untick sends `setStatus` with the item's `previousStatus`. No optimistic update.
- **FR-005** Pending state is `aria-busy` + `aria-disabled` with a spinner inside the 16px tick slot; the control is never `disabled`.
- **FR-006** A refusal result renders `refusal.checklist`; `item_changed` shows a persistent `role=alert` with the decided sentence; other refusals show their message inline.
- **FR-007** A late mutate result applies to the Session captured at call time.
- **FR-008** A `requiresValue` item with no value shows an `aria-disabled` tick and visible reason text.
- **FR-009** `CHECKLIST_STATUS_GLYPH` gives each of the five statuses an icon, colour class and word; visible word for `next`/`in_progress`/`blocked`, sr-only for `upcoming`/`complete`; complete composes `STATUS_GLYPH['success-done']`.
- **FR-010** `aria-current="step"` on the `next` row; `completedBy` (`updatedBy` on completed items) is visible text.
- **FR-011** Rows are `<li key=id>` in an `<ol>`; text and values are plain text with `whitespace-pre-wrap break-words`; the tick is labelled by the item text via `aria-labelledby` with a 24px target.
- **FR-012** A mounted polite live region announces open, replace and agent-driven item changes; developer-driven ticks are not announced twice.
- **FR-013** On `replace`, the panel swaps to the new checklist and, if focus was inside the panel, moves focus to the panel region.
- **FR-014** `checklist.get` returns `{checklist, toolUnavailable}`; the flag is set where the tool refusal is logged, cleared by the next successful call, and dropped with the Session. All existing callers and tests migrate.
- **FR-015** The panel shows a "Checklist tool unavailable" state when the flag is set, and never renders silently empty.
- **FR-016** The reveal-request consumer scrolls to, highlights and clears a matching request; a non-matching one is cleared without effect.
- **FR-017** Shared changes: `CHECKBOX_BOX_ONLY_CLASS`; the four contrast pairs; the nav-highlight rule widened to the shared attribute; checklist row `outline-offset:-2px`.
- **FR-018** UI text says "item", never "step".
- **FR-019** Colours come from design tokens; no hard-coded hex; `ci:local` passes the theme-contrast check across all themes.

## Success Criteria
- **SC-001** Unit tests cover FR-002..FR-016 and fail when each guard is removed.
- **SC-002** `pnpm check:theme-contrast` passes with the new pairs in every theme.
- **SC-003** Live check on a scratch Tauri debug build: a real agent-created checklist opens the panel, a real click ticks an item, a conflicting agent edit shows the alert, widths 240/320/380 wrap without clipping; screenshots reviewed.
- **SC-004** No file over 600 lines; no addition to `scripts/file-size-baseline.json`.

## Out of Scope
#2013 controls (disclosure, textarea, Do this item); #2014 source line and chat card; archive or switcher; optimistic ticking; any change to `TodoTree`.
