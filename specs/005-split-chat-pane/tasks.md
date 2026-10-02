# Tasks: Split chat pane

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/ipc.md](contracts/ipc.md), [quickstart.md](quickstart.md)

**Prerequisites**: everything spec 001's tasks.md prerequisites list, plus at least two Sessions
already created (spec 001 Story 1) to exercise a split. Windows 11 only.

**Tests**: none. Refract is a prototype (constitution, Development Workflow). Each phase ends with
a **Checkpoint** that runs the matching [quickstart.md](quickstart.md) section by hand. `pnpm
typecheck` and `pnpm build` MUST pass before a change lands on `main`.

**Probes**: none. This spec introduces no new OMP, Electron, GitHub CLI, or Windows behaviour
(constitution Principle IV's named scope) — it only generalises spec 001's already-verified
process/IPC/security primitives from one visible session to a set of up to two. The one
third-party-library behaviour it newly relies on (keyboard-operable resize handle,
`onLayoutChanged` persistence) is sourced from the installed library's own documentation
(research.md Decision 5) and checked live in Phase 3's checkpoint, not by a separate probe task.

**Organization**: tasks are grouped by user story so each story can be built and checked on its
own. Paths are relative to the repository root. IDs run `T001` upward within this spec; GitHub
issue titles are prefixed `005-` (e.g. `005-T001`) since spec 001 already owns plain `Tnnn:`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: the user story from [spec.md](spec.md) (US1 to US4). Foundational and Polish tasks
  carry no story label.
- Tasks that edit the same file are never both marked [P].

---

## Phase 1: Foundational — shared contract and main process (blocks every user story)

**Purpose**: the one new piece of persisted state (`Settings.split`) and the generalisation of
"visible session" from a single id to a set, which every story's renderer work depends on.

- [ ] T001 [P] Add `SplitLayout` to `src/shared/model.ts` and `split: SplitLayout \| null` to
      `Settings`, exactly as in [data-model.md](data-model.md) (field names and literal unions). (#171)
- [ ] T002 In `src/shared/ipc.ts`: change `RefractApi.sessions.setVisible` from
      `(sessionId: string \| null)` to `(sessionIds: string[])`; add
      `RefractApi.settings.setSplit(layout: SplitLayout \| null): Promise<Result<Settings>>` and
      the matching `IPC_REQUESTS.SETTINGS_SET_SPLIT = 'settings.setSplit'` channel name, per
      [contracts/ipc.md](contracts/ipc.md) (depends on T001). (#174)
- [ ] T003 [P] `src/main/store/settings.ts`: add `setSplit(layout: SplitLayout \| null):
      Promise<Settings>`, same atomic-write pattern `setApprovalMode` already uses (write, persist,
      return this call's own written value) (depends on T001). (#177)
- [ ] T004 `src/main/SessionManager.ts`: replace `visibleSessionId: string \| null` with
      `visibleSessionIds: Set<string>`; generalise `setVisible(sessionIds: string[])` (clears
      `unread` and flushes a transcript `reset` for every newly-visible id) and the
      `isVisible`/`patch`-forwarding closures inside `getOrCreateAgent` to set-membership checks,
      so the existing per-session unread rule in `SessionAgent.setStatus` now correctly reflects
      "shown in either pane" (FR-018, SC-006) with no change to `SessionAgent.ts` itself (depends
      on T001). (#180)
- [ ] T005 `src/main/ipc/sessions.ts`: update the `SESSIONS_SET_VISIBLE` handler to accept and
      validate `string[]` instead of `string \| null` (depends on T002, T004). (#183)
- [ ] T006 `src/main/ipc/settings.ts`: add the `SETTINGS_SET_SPLIT` handler, calling
      `manager.settings.setSplit` and broadcasting `settings:changed`, same shape as
      `setApprovalMode`'s handler (depends on T002, T003). (#186)
- [ ] T007 `src/main/index.ts`: at startup, after the registry loads and before the window first
      reads settings, validate the persisted `split` against `RegistryStore`'s in-memory
      `Session[]` (FR-015): drop any id no longer present or now archived; if one id survives,
      rewrite `split` to `null` (a single pane, not a one-element `SplitLayout`); if none survive,
      rewrite to `null`; write the corrected value back with `settings.setSplit` so a stale id is
      never offered again. This reads the registry only — it MUST NOT call `SessionAgent.start()`
      or otherwise touch any agent (FR-014) (depends on T003, T004). (#190)
- [ ] T008 [P] `src/preload/index.ts`: update the `sessions.setVisible` bridge to take
      `sessionIds: string[]`; add the `settings.setSplit` bridge (depends on T002). (#193)

**Checkpoint**: `pnpm typecheck` and `pnpm build` pass with the renderer still on its old
single-session store (Phase 2 updates it next); a scratch script can call
`window.refract.sessions.setVisible([])` and `settings.setSplit(null)` without error.

---

## Phase 2: Foundational — renderer stores (blocks every user story)

**Purpose**: generalise the renderer's single-visible-session state into the per-pane `Split`
(data-model.md), reusing the per-session shape `queue-store.ts` already established.

- [ ] T009 `src/renderer/state/transcript-store.ts`: change from one `{ sessionId, items }` pair to
      `Record<sessionId, TranscriptItem[]>`, the same shape `queue-store.ts` already uses; update
      `Transcript.tsx` to select its own pane's items by the `sessionId` prop it is given rather
      than a store-wide singular field (depends on T002). (#197)
- [ ] T010 NEW `src/renderer/state/split-store.ts`: `paneSessionIds: string[]`,
      `focusedIndex: number`, `dividerPercent: number`, `pristineIds: Set<string>`, and the actions
      `openInSplit`, `replaceFocused`, `focusPane`, `closePane`, `setDividerPercent`,
      `markOpened`, `restoreFromSettings` implementing exactly the state-transition table in
      [data-model.md](data-model.md); every action that changes `paneSessionIds` calls
      `window.refract.sessions.setVisible` with the resulting full set (depends on T002, T008,
      T009). (#199)
- [ ] T011 [P] `src/renderer/state/index.ts`: export `useSplitStore`. `src/renderer/state/
      init-stores.ts`: after the initial `settings.get()` resolves, call
      `useSplitStore.getState().restoreFromSettings(settings.split)` (marks both restored ids
      pristine, calls `sessions.setVisible` with both ids so unread-clearing and patch routing
      work immediately, and never calls `sessions.open`, per research.md Decision 4) (depends on
      T010). (#204)
- [ ] T012 `src/renderer/state/sessions-store.ts`: remove `visibleSessionId`/
      `setVisibleSessionId` and the visibility-flipping half of `open()`; `open(id)` keeps
      starting/reattaching an agent and returning its snapshot, but visibility is now set by
      whichever `split-store` action triggers the open, before `open()` is called — preserving the
      existing ordering rule in `src/main/ipc/sessions.ts` ("Visibility is NOT set here... set
      solely by the explicit `sessions.setVisible` IPC") (depends on T010). (#208)

**Checkpoint**: `pnpm typecheck` and `pnpm build` pass. `useSplitStore`'s `pristineIds`/
`paneSessionIds` can be exercised from a scratch script via `window.__refractStores` (dev-only).

---

## Phase 3: User Story 1 - Put a second session beside the first (Priority: P1)

**Goal**: "Open in split" and Ctrl+click turn one pane into two side-by-side panes, each a
complete, independently streaming chat; the divider drags and keyboard-resizes; a pane matches
what a single chat pane already shows for every state that session can be in.

**Independent test**: [quickstart.md](quickstart.md) Story 1.

- [ ] T013 [US1] `src/renderer/App.tsx`: the chat region renders one `ChatPane` when
      `paneSessionIds.length === 1`, or a horizontal `ResizablePanelGroup` of two `ChatPane`s
      separated by `ResizableHandle withHandle` when it is 2, driven by `useSplitStore`; the
      group's `onLayoutChanged(layout, meta)` calls `split-store.setDividerPercent` only when
      `meta.isUserInteraction` (research.md Decision 5), never on the initial/restored mount
      (FR-002). (#215)
- [ ] T014 [US1] `src/renderer/features/chat/ChatPane.tsx`: accept `sessionId: string` and
      `paneIndex: number` props instead of reading a singleton `visibleSessionId`; when
      `pristineIds.has(sessionId)` (a just-restored, not-yet-opened pane, research.md Decision 4),
      skip the existing snapshot-fetch effect and render from the Session's own `SessionSummary`
      (`status`, `stopReason`) with an empty transcript and no stop-reason banner — the same look
      the list already gives a never-opened Session; otherwise the existing effect, stop-reason
      banner, and `RequestCard` rendering are unchanged, so a pending approval/question in either
      pane stays visible and answerable without focusing it first (FR-003, FR-014, FR-019). (#221)
- [ ] T015 [P] [US1] `src/renderer/features/sessions/SessionList.tsx`: `SessionRow` gets an
      **Open in split** `DropdownMenuItem` and a Ctrl+click handler on the row's open button, both
      calling `split-store.openInSplit(session.id)` (FR-001); the plain-click handler becomes
      pane-aware per the data-model.md transition table: a session already shown in the focused
      pane wakes it directly (`open()`), one not shown anywhere replaces the focused pane
      (`replaceFocused`), covering FR-008 for this story (FR-009's unfocused-pane case lands in
      Phase 4) (depends on T010). (#228)
- [ ] T016 [US1] Make a deleted session close its own pane (FR-016): in `split-store.ts`, react to
      `session:list-changed`/the next `sessions.list()` refresh by removing from `paneSessionIds`
      any id no longer present in the list (a session is only ever removed from the registry by
      `sessions.delete`), leaving the other pane at full width with no further action; update
      `ChatPane.tsx`'s existing `DeleteDialog` `onDeleted` callback so deleting the session shown
      in a pane closes that pane (via `split-store.closePane`) instead of only moving focus inside
      it. An archived or agent-stopped session's pane needs no new code: it already shows the
      same stopped/archived look a single, unsplit pane gives, via the unchanged banner logic T014
      preserves (depends on T010, T014). (#234)
- [ ] T017 [US1] Update the docs and verify live: `docs/DESIGN.md` Layout (two panes, the
      divider) and Chat (each pane is a complete, independently-scoped chat); then on the built
      app in an isolated instance: [quickstart.md](quickstart.md) Story 1 checks 1-5 all pass,
      including two Sessions streaming concurrently with no observable delay introduced by either
      (FR-004, SC-002), and deleting the session in one pane closes only that pane (FR-016)
      (depends on T013, T014, T015, T016). (#241)

**Checkpoint**: run quickstart Story 1. Then `pnpm typecheck` and `pnpm build`.

---

## Phase 4: User Story 2 - Work in either pane (Priority: P1)

**Goal**: exactly one pane is focused, visibly marked by more than colour; clicking, typing, and a
keyboard command move focus; a session row click and every pane-scoped control act only on the
focused/owning pane.

**Independent test**: [quickstart.md](quickstart.md) Story 2.

- [ ] T018 [US2] `src/renderer/features/chat/ChatPane.tsx` (or a small shared wrapper): mark the
      focused pane with `role="region"`, an `aria-label` naming its Session, a visible accent bar,
      and a text "Focused" marker (never colour alone, mirroring `SessionList.tsx`'s existing
      `aria-current` pattern); clicking or typing anywhere inside a pane calls
      `split-store.focusPane(paneIndex)` (FR-005, FR-006, FR-022). (#247)
- [ ] T019 [P] [US2] Add the focus-move keyboard command (**Ctrl+Shift+\\**, research.md Decision
      8) as a window-level `keydown` listener active only while a split is open (same pattern
      `MessageInput.tsx`'s existing Ctrl+Shift+X listener uses), plus a small focusable icon
      button on the `ResizableHandle` doing the same thing on click/Enter (FR-007); add one
      shared `aria-live="polite"` text node in the chat region announcing "Focused: <Session
      name>" on every focus change (FR-022) (depends on T013). (#253)
- [ ] T020 [US2] Finish the pane-aware row-click rule started in T015: a row already shown in the
      *unfocused* pane focuses that pane instead of duplicating the session (FR-009); confirm
      `MessageInput.tsx`, the Stop control, queue chips, and `RequestCard.tsx` need no change
      beyond the `sessionId` prop each pane already passes them, since every one of those already
      reads only its own `sessionId`'s store slice (FR-010) (depends on T015, T018). (#259)
- [ ] T021 [US2] Update the docs and verify live: `docs/DESIGN.md` Keyboard (add the focus-move
      chord and the visible button) and Chat (the focused-pane marker); then on the built app in
      an isolated instance: [quickstart.md](quickstart.md) Story 2 checks 1-6 all pass (depends on
      T018, T019, T020). (#264)

**Checkpoint**: run quickstart Story 2.

---

## Phase 5: User Story 3 - Close or change the split (Priority: P2)

**Goal**: either pane closes independently back to one full-width pane; "Open in split"/Ctrl+click
while already split replaces the unfocused pane, never opens a third.

**Independent test**: [quickstart.md](quickstart.md) Story 3.

- [ ] T022 [US3] Add a close control to each pane (`ChatHeader.tsx` or `ChatPane.tsx`, a small
      icon button) calling `split-store.closePane(paneIndex)`, implementing the `[A,B] ->
      [survivor]` transition (FR-011, FR-013); implement the "Open in split"/Ctrl+click
      **unfocused-pane replace** rule (FR-012) and the focused-pane no-op rule (research.md
      Decision 7) in `split-store.ts`'s `openInSplit` action (depends on T010, T015). (#269)
- [ ] T023 [US3] Update the docs and verify live: `docs/DESIGN.md` Chat (the pane close control,
      the replace-unfocused-pane rule); then on the built app in an isolated instance:
      [quickstart.md](quickstart.md) Story 3 checks 1-3 all pass (depends on T022). (#274)

**Checkpoint**: run quickstart Story 3.

---

## Phase 6: User Story 4 - The split survives a restart (Priority: P2)

**Goal**: the same two sessions, divider position, and focused pane reopen after a restart,
without starting either agent; a session dropped at restart falls back to a single pane.

**Independent test**: [quickstart.md](quickstart.md) Story 4.

- [ ] T024 [US4] Confirm end to end that T007's startup validation (drop missing/archived ids,
      rewrite `settings.json`, never start an agent) and T011's `restoreFromSettings` (mark both
      ids pristine, never call `sessions.open`) compose correctly for all three outcomes in
      data-model.md's restart row: both survive, one survives, none survive (FR-014, FR-015). (#280)
- [ ] T025 [US4] Persist `split` on every pane-changing `split-store` action (open-in-split,
      replace, close, focus-move, and a user-driven divider resize) via `settings.setSplit`,
      debounced ~300 ms while the divider drags (research.md Decision 5) (depends on T010, T013). (#285)
- [ ] T026 [US4] Update the docs and verify live: `docs/DESIGN.md` (restart persists the split,
      including the divider position and focus) and `quickstart.md` Story 4; then on the built app
      in an isolated instance: [quickstart.md](quickstart.md) Story 4 checks 1-4 all pass,
      confirmed with `Get-Process omp` that neither agent is running immediately after restart
      (FR-014) (depends on T024, T025). (#291)

**Checkpoint**: run quickstart Story 4.

---

## Phase 7: Polish & cross-cutting

- [ ] T027 [P] Implement the narrow-window collapse (FR-017, SC-007, research.md Decision 6):
      measure the chat region's available width (`App.tsx` or a small hook); below `2 × 360px`,
      render only the focused pane and a small chip in `ChatHeader.tsx` naming the other (hidden)
      session, which swaps focus-and-display to it in one click; re-split automatically once the
      width allows both panes again, at the last `dividerPercent` (depends on T013, T018). (#296)
- [ ] T028 Accessibility pass (FR-022, FR-023, SC-005): confirm the pane close button, the
      focus-move button, the narrow-width chip, and the divider handle are all reachable and
      operable by keyboard alone with a visible focus indicator throughout, and that the
      `aria-live` focus announcement fires exactly once per focus change, not once per unrelated
      re-render (depends on T018, T019, T027). (#301)
- [ ] T029 Update the docs and verify live: `docs/DESIGN.md` Layout, Chat, and Keyboard sections
      (final wording for everything landed above) and `quickstart.md`'s narrow-window and
      accessibility sections; then on the built app in an isolated instance: run every
      [quickstart.md](quickstart.md) section in this spec end to end once more after all stories
      land (depends on T027, T028). (#307)

**Checkpoint**: `pnpm typecheck` and `pnpm build` pass; every quickstart.md section in this spec
passes end to end.

## Dependencies & Execution Order

- **Setup (Phase 1-2)**: no story label — blocks every user story below.
- **User Stories (Phase 3+)**: all depend on Foundational completion.
  - **User Story 1 (P1)**: start after Foundational — MVP.
  - **User Story 2 (P1)**: depends on US1's `ChatPane`/pane plumbing (T013-T016) existing to have
    something to focus between.
  - **User Story 3 (P2)**: depends on US1's split existing and US2's focused-pane concept (to
    know which pane is "unfocused" to replace).
  - **User Story 4 (P2)**: depends on US1-US3's full pane-targeting logic to have a layout worth
    persisting and restoring.
- **Polish (Phase 7)**: depends on every user story's pane/focus plumbing existing.

### Parallel example (Foundational, Phase 1-2)

```text
Task: "T001 [P] Add SplitLayout to src/shared/model.ts"
Task: "T003 [P] src/main/store/settings.ts: add setSplit"
Task: "T008 [P] src/preload/index.ts: bridge the two changed/added methods"
Task: "T011 [P] src/renderer/state/index.ts + init-stores.ts: export useSplitStore, restore on load"
```

## Notes

- `[Story]` labels map every task to one user story for traceability.
- FR-003's readout chip row and FR-020's Subagents panel are intentionally not built by any task
  here: both depend on spec 004, which does not exist yet; a pane simply has none of either until
  spec 004 ships (spec.md Assumptions).
- FR-021 (the split's state survives the Settings screen/Pull-requests view replacing the chat
  area) needs no dedicated task: `split-store.ts` is a module-level zustand store, already
  outliving any one component the same way `sessions-store` does today, and neither the Settings
  screen nor the Pull-requests view exists yet to unmount it against.
- Each user-story task is specific enough for one agent to complete independently.
- Verify each phase's quickstart section before starting the next; commit after each checkpoint.
- Avoid: vague tasks, same-file conflicts marked `[P]`, cross-story dependencies that break
  independent testability.

GitHub issues: every task has an issue titled `005-Tnnn: ...`.
