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

- [X] T001 [P] Add `SplitLayout` to `src/shared/model.ts` and `split: SplitLayout \| null` to
      `Settings`, exactly as in [data-model.md](data-model.md) (field names and literal unions). (#171) -- Verified: `pnpm typecheck` clean against every consumer; live-confirmed the exact shape round-trips through `settings.json` (`C:\tmp\pinion-split-chat-userdata\settings.json`: `"split":{"sessionIds":[...],"dividerPercent":38.931,"focusedIndex":0}` after a real divider drag, `"split":null` after closing back to one pane).
- [X] T002 In `src/shared/ipc.ts`: change `RefractApi.sessions.setVisible` from
      `(sessionId: string \| null)` to `(sessionIds: string[])`; add
      `RefractApi.settings.setSplit(layout: SplitLayout \| null): Promise<Result<Settings>>` and
      the matching `IPC_REQUESTS.SETTINGS_SET_SPLIT = 'settings.setSplit'` channel name, per
      [contracts/ipc.md](contracts/ipc.md) (depends on T001). (#174) -- Verified: `pnpm typecheck`/`pnpm build` clean; both new/changed methods called successfully dozens of times live in a scratch Electron instance across this session's full verification pass (every split-store action, every restart).
- [X] T003 [P] `src/main/store/settings.ts`: add `setSplit(layout: SplitLayout \| null):
      Promise<Settings>`, same atomic-write pattern `setApprovalMode` already uses (write, persist,
      return this call's own written value) (depends on T001). (#177) -- Verified live: every divider drag/close/split action in this session wrote the exact expected value to `settings.json` on disk (direct file reads throughout this pass confirmed the written `dividerPercent`/`sessionIds`/`focusedIndex` matched the UI action taken).
- [X] T004 `src/main/SessionManager.ts`: replace `visibleSessionId: string \| null` with
      `visibleSessionIds: Set<string>`; generalise `setVisible(sessionIds: string[])` (clears
      `unread` and flushes a transcript `reset` for every newly-visible id) and the
      `isVisible`/`patch`-forwarding closures inside `getOrCreateAgent` to set-membership checks,
      so the existing per-session unread rule in `SessionAgent.setStatus` now correctly reflects
      "shown in either pane" (FR-018, SC-006) with no change to `SessionAgent.ts` itself. The
      `readout`/`subagents`/`subagentPatch` forwarding closures in the same `getOrCreateAgent`
      method (added by spec 004, after this task was originally written) gate on the exact same
      singular `this.visibleSessionId` field as `patch` does, right next to it — convert all four
      closures to the same set-membership check together, in this one task, not three separate
      ones (convergence note below; depends on T001). (#180) -- Verified live, the exact convergence scenario: two real, independently-running agents (`merry-marten`, `earnest-beaver`) each sent a real prompt while both panes were visible simultaneously; both panes' readout chips showed live, independently-updating token counts at the same instant (`58,382/1,000,000 tokens` vs `58,121/1,000,000 tokens`) and both received their own correct, distinct agent replies ("391" for a maths question, a real octopus fact for the other) -- proving all four forwarders (not just `patch`) correctly serve every id in the visible set, not just one.
- [X] T005 `src/main/ipc/sessions.ts`: update the `SESSIONS_SET_VISIBLE` handler to accept and
      validate `string[]` instead of `string \| null` (depends on T002, T004). (#183) -- Verified live: every split-store action in this session's verification pass called this handler with 0/1/2-element arrays with no validation error.
- [X] T006 `src/main/ipc/settings.ts`: add the `SETTINGS_SET_SPLIT` handler, calling
      `manager.settings.setSplit` and broadcasting `settings:changed`, same shape as
      `setApprovalMode`'s handler (depends on T002, T003). (#186) -- Verified live via the same `settings.json` round-trip evidence as T001/T003.
- [X] T007 `src/main/index.ts`: at startup, after the registry loads and before the window first
      reads settings, validate the persisted `split` against `RegistryStore`'s in-memory
      `Session[]` (FR-015): drop any id no longer present or now archived; if one id survives,
      rewrite `split` to `null` (a single pane, not a one-element `SplitLayout`); if none survive,
      rewrite to `null`; write the corrected value back with `settings.setSplit` so a stale id is
      never offered again. This reads the registry only — it MUST NOT call `SessionAgent.start()`
      or otherwise touch any agent (FR-014) (depends on T003, T004). (#190) -- Verified live for all three restart outcomes (data-model.md's own restart row): both survive (split unchanged, both marked pristine, `omp.exe` process count identical before/after restart -- a stable 12-process baseline on this shared machine, confirmed by exact PID-set comparison, not just a count); one survives (`earnest-beaver` archived, restart dropped it, `merry-marten` shown full-width, `settings.json` rewritten to `"split":null`); none survive (both archived, restart showed the empty "Select a Session or create one" view, `settings.json` `"split":null`). The one-survivor case's "shown, focused, full width" delivery (an underspecified area of data-model.md/research.md Decision 3b, since `Settings.split` has no valid one-element form) is my own documented completion: reuses the existing `ui:open-session` event, sent once `did-finish-load` fires (after `main.tsx`'s synchronous `initStores()` call has already registered that listener, confirmed race-free by inspection of the module load order) -- live-verified the survivor auto-opened (status flipped `Stopped` -> `Idle`) exactly as a normal single-pane click would, matching the data-model.md table's explicit "not pristine... keeps today's single-pane behaviour, which does open it".
- [X] T008 [P] `src/preload/index.ts`: update the `sessions.setVisible` bridge to take
      `sessionIds: string[]`; add the `settings.setSplit` bridge (depends on T002). (#193) -- Verified live via every successful call in this session's pass (same evidence as T002).

**Checkpoint**: `pnpm typecheck` and `pnpm build` pass with the renderer still on its old
single-session store (Phase 2 updates it next); a scratch script can call
`window.refract.sessions.setVisible([])` and `settings.setSplit(null)` without error.

---

## Phase 2: Foundational — renderer stores (blocks every user story)

**Purpose**: generalise the renderer's single-visible-session state into the per-pane `Split`
(data-model.md), reusing the per-session shape `queue-store.ts` already established.

- [X] T009 `src/renderer/state/transcript-store.ts`: change from one `{ sessionId, items }` pair to
      `Record<sessionId, TranscriptItem[]>`, the same shape `queue-store.ts` already uses; update
      `Transcript.tsx` to select its own pane's items by the `sessionId` prop it is given rather
      than a store-wide singular field (depends on T002). (#197) -- Verified live: two panes' transcripts stayed fully independent and correct throughout this pass (never cross-contaminated), including the concurrent-streaming test (T004's evidence) where both panes' own distinct replies rendered correctly at the same time.
- [X] T010 NEW `src/renderer/state/split-store.ts`: `paneSessionIds: string[]`,
      `focusedIndex: number`, `dividerPercent: number`, `pristineIds: Set<string>`, and the actions
      `openInSplit`, `replaceFocused`, `focusPane`, `closePane`, `setDividerPercent`,
      `markOpened`, `restoreFromSettings` implementing exactly the state-transition table in
      [data-model.md](data-model.md); every action that changes `paneSessionIds` calls
      `window.refract.sessions.setVisible` with the resulting full set (depends on T002, T008,
      T009). (#199) -- Verified live, every row of the state-transition table exercised directly: `[A]` + Ctrl+click B -> `[A,B]` focus unchanged; Ctrl+click the already-focused session -> no-op (Decision 7); Ctrl+click the already-unfocused session -> focuses it, no duplicate; Ctrl+click a third (unseen) session -> replaces the unfocused pane only (FR-012); plain row click on an unseen session -> replaces the focused pane (FR-008); plain row click on the unfocused pane's session -> focuses it (FR-009); close control -> `[survivor]`, focusedIndex 0; a deleted session's pane auto-closed via `pruneDeleted`.
- [X] T011 [P] `src/renderer/state/index.ts`: export `useSplitStore`. `src/renderer/state/
      init-stores.ts`: after the initial `settings.get()` resolves, call
      `useSplitStore.getState().restoreFromSettings(settings.split)` (marks both restored ids
      pristine, calls `sessions.setVisible` with both ids so unread-clearing and patch routing
      work immediately, and never calls `sessions.open`, per research.md Decision 4) (depends on
      T010). (#204) -- Verified live across every restart in this session's pass: both ids always restored, correctly marked pristine (enabled message box, no stop banner, `Stopped` status, zero new `omp.exe` processes).
- [X] T012 `src/renderer/state/sessions-store.ts`: remove `visibleSessionId`/
      `setVisibleSessionId` and the visibility-flipping half of `open()`; `open(id)` keeps
      starting/reattaching an agent and returning its snapshot, but visibility is now set by
      whichever `split-store` action triggers the open, before `open()` is called — preserving the
      existing ordering rule in `src/main/ipc/sessions.ts` ("Visibility is NOT set here... set
      solely by the explicit `sessions.setVisible` IPC") (depends on T010). (#208) -- Verified: `pnpm typecheck`/`pnpm build` clean (every former `visibleSessionId` reader updated); a full live session (dozens of opens/switches/restarts) showed no regression in agent-start/snapshot-apply behaviour.

**Checkpoint**: `pnpm typecheck` and `pnpm build` pass. `useSplitStore`'s `pristineIds`/
`paneSessionIds` can be exercised from a scratch script via `window.__refractStores` (dev-only).

---

## Phase 3: User Story 1 - Put a second session beside the first (Priority: P1)

**Goal**: "Open in split" and Ctrl+click turn one pane into two side-by-side panes, each a
complete, independently streaming chat; the divider drags and keyboard-resizes; a pane matches
what a single chat pane already shows for every state that session can be in.

**Independent test**: [quickstart.md](quickstart.md) Story 1.

- [X] T013 [US1] `src/renderer/App.tsx`: the chat region renders one `ChatPane` when
      `paneSessionIds.length === 1`, or a horizontal `ResizablePanelGroup` of two `ChatPane`s
      separated by `ResizableHandle withHandle` when it is 2, driven by `useSplitStore`; the
      group's `onLayoutChanged(layout, meta)` calls `split-store.setDividerPercent` only when
      `meta.isUserInteraction` (research.md Decision 5), never on the initial/restored mount
      (FR-002). (#215) -- Verified live: a real mouse drag on the divider resized both panes to specific pixel widths (721px/1131px of 1853px, computed dividerPercent 38.931%), persisted to `settings.json`; a restart loaded the SAME divider position with no spurious re-persist (the `isUserInteraction: false` mount path never rewrote the value).
- [X] T014 [US1] `src/renderer/features/chat/ChatPane.tsx`: accept `sessionId: string` and
      `paneIndex: number` props instead of reading a singleton `visibleSessionId`; when
      `pristineIds.has(sessionId)` (a just-restored, not-yet-opened pane, research.md Decision 4),
      skip the existing snapshot-fetch effect and render from the Session's own `SessionSummary`
      (`status`, `stopReason`) with an empty transcript and no stop-reason banner — the same look
      the list already gives a never-opened Session; otherwise the existing effect, stop-reason
      banner, and `RequestCard` rendering are unchanged, so a pending approval/question in either
      pane stays visible and answerable without focusing it first (FR-003, FR-014, FR-019). (#221) -- Live verification caught and fixed a real bug here: the first restart test showed BOTH restored panes with "The agent is stopped." banners and disabled message boxes, not the intended not-started look -- `stopInfo` correctly stayed `{}` while pristine, but `MessageInput`'s own `notStarted`/`disabled` logic requires an EXPLICIT `'not-started'` `stopReason`, not `undefined`. Fixed by deriving `effectiveStopReason`/`effectiveStopDetail` from the Session's own already-known `SessionSummary.stopReason` while pristine. Re-verified live after the fix: a fresh restart's two restored panes both showed enabled message boxes, no banner, `Stopped` status, zero new agent processes; sending the first message in one pane started only that session's agent (confirmed via a stable `omp.exe` PID-set baseline) while the other stayed untouched; FR-019 separately verified (see T020/T021's evidence) by sending a message to the UNFOCUSED pane via a path that never touches focus, producing a real approval card there while focus stayed on the other pane.
- [X] T015 [P] [US1] `src/renderer/features/sessions/SessionList.tsx`: `SessionRow` gets an
      **Open in split** `DropdownMenuItem` and a Ctrl+click handler on the row's open button, both
      calling `split-store.openInSplit(session.id)` (FR-001); the plain-click handler becomes
      pane-aware per the data-model.md transition table: a session already shown in the focused
      pane wakes it directly (`open()`), one not shown anywhere replaces the focused pane
      (`replaceFocused`), covering FR-008 for this story (FR-009's unfocused-pane case lands in
      Phase 4) (depends on T010). (#228) -- Verified live. One real diagnostic finding along the way: the browser tool's high-level `click(modifiers: ["Control"])` wrapper did NOT deliver a true `ctrlKey` to the page's React handler (confirmed via a temporary `console.log` instrumentation: logged `ctrlKey= false` even when the wrapper was asked for `Control`) -- a CDP/automation-layer artifact, not a product bug: driving the exact same click via raw Puppeteer (`page.keyboard.down('Control')` + `page.mouse.click(x,y)` + `page.keyboard.up('Control')`) correctly delivered `ctrlKey= true` and the app split open exactly as designed (Focused badge, accent bar, close buttons, divider focus-move button, aria-live announcer all present). Every subsequent Ctrl+click test in this pass used the raw-Puppeteer technique. Plain-click FR-008 (replaces the focused pane) also verified live.
- [X] T016 [US1] Make a deleted session close its own pane (FR-016): in `split-store.ts`, react to
      `session:list-changed`/the next `sessions.list()` refresh by removing from `paneSessionIds`
      any id no longer present in the list (a session is only ever removed from the registry by
      `sessions.delete`), leaving the other pane at full width with no further action; update
      `ChatPane.tsx`'s existing `DeleteDialog` `onDeleted` callback so deleting the session shown
      in a pane closes that pane (via `split-store.closePane`) instead of only moving focus inside
      it. An archived or agent-stopped session's pane needs no new code: it already shows the
      same stopped/archived look a single, unsplit pane gives, via the unchanged banner logic T014
      preserves (depends on T010, T014). (#234) -- Verified live: deleted the Session shown in one pane of a real two-pane split (`sessions.delete`); its pane closed immediately, leaving the other at full width, no error, no orphaned UI.
- [X] T017 [US1] Update the docs and verify live: `docs/DESIGN.md` Layout (two panes, the
      divider) and Chat (each pane is a complete, independently-scoped chat); then on the built
      app in an isolated instance: [quickstart.md](quickstart.md) Story 1 checks 1-5 all pass,
      including two Sessions streaming concurrently with no observable delay introduced by either
      (FR-004, SC-002), and deleting the session in one pane closes only that pane (FR-016)
      (depends on T013, T014, T015, T016). (#241) -- `docs/DESIGN.md` Layout and Chat sections updated this round (new Split chat pane bullets). Quickstart Story 1 checks 1-5 all live-verified: check 1/2 (menu item and Ctrl+click both open a split, T015's evidence); check 3 (divider drag + keyboard Tab reaches it, T013/T028 evidence); check 4 (two real concurrent independently-streaming replies with no cross-talk or delay, T004/T009/T030 evidence); check 5 (an approval request in one pane, T020's evidence).

**Checkpoint**: run quickstart Story 1. Then `pnpm typecheck` and `pnpm build`.

---

## Phase 4: User Story 2 - Work in either pane (Priority: P1)

**Goal**: exactly one pane is focused, visibly marked by more than colour; clicking, typing, and a
keyboard command move focus; a session row click and every pane-scoped control act only on the
focused/owning pane.

**Independent test**: [quickstart.md](quickstart.md) Story 2.

- [X] T018 [US2] `src/renderer/features/chat/ChatPane.tsx` (or a small shared wrapper): mark the
      focused pane with `role="region"`, an `aria-label` naming its Session, a visible accent bar,
      and a text "Focused" marker (never colour alone, mirroring `SessionList.tsx`'s existing
      `aria-current` pattern); clicking or typing anywhere inside a pane calls
      `split-store.focusPane(paneIndex)` (FR-005, FR-006, FR-022). (#247) -- Verified live: the CDP accessibility tree showed `region "<Session name> chat"` for each pane; the focused one carried a visible "Focused" text generic plus the left-edge accent bar (confirmed by DOM inspection); clicking inside the unfocused pane's message textarea flipped both the badge and the shared aria-live text to the newly-clicked pane's Session name.
- [X] T019 [P] [US2] Add the focus-move keyboard command (**Ctrl+Shift+\\**, research.md Decision
      8) as a window-level `keydown` listener active only while a split is open (same pattern
      `MessageInput.tsx`'s existing Ctrl+Shift+X listener uses), plus a small focusable icon
      button on the `ResizableHandle` doing the same thing on click/Enter (FR-007); add one
      shared `aria-live="polite"` text node in the chat region announcing "Focused: <Session
      name>" on every focus change (FR-022) (depends on T013). (#253) -- Verified live: a real `Ctrl+Shift+Backslash` key combo (raw Puppeteer `keyboard.down/press/up`, `event.code` not `event.key` so Shift's character remap never matters) flipped focus between two real panes every time it was pressed; the divider's own "Move focus to the other pane" button (confirmed reachable by Tab, see T028) did the same on click; the aria-live text read "Focused: <name>" correctly after every one of these moves throughout the whole verification pass.
- [X] T020 [US2] Finish the pane-aware row-click rule started in T015: a row already shown in the
      *unfocused* pane focuses that pane instead of duplicating the session (FR-009); confirm
      `MessageInput.tsx`, the Stop control, queue chips, and `RequestCard.tsx` need no change
      beyond the `sessionId` prop each pane already passes them, since every one of those already
      reads only its own `sessionId`'s store slice (FR-010) (depends on T015, T018). (#259) -- Verified live: clicking a row already shown in the unfocused pane flipped focus there with no duplicate pane or session (FR-009, both for a plain click and for Ctrl+click on the same target, Decision 7's symmetric case). FR-010/FR-019 scoping verified concretely: moved focus to one pane via the keyboard chord, then sent a real `write`-triggering prompt to the OTHER (now unfocused) pane via a path that never touches focus (`window.refract.chat.send` directly) -- a real Approve/Deny `RequestCard` appeared in that unfocused pane while the aria-live text and "Focused" badge stayed on the other pane the whole time, proving the request card, and by the same one-`sessionId`-prop construction the message box/Stop/queue chips, are correctly scoped per pane with no shared/global state to leak.
- [X] T021 [US2] Update the docs and verify live: `docs/DESIGN.md` Keyboard (add the focus-move
      chord and the visible button) and Chat (the focused-pane marker); then on the built app in
      an isolated instance: [quickstart.md](quickstart.md) Story 2 checks 1-6 all pass (depends on
      T018, T019, T020). (#264) -- `docs/DESIGN.md` Keyboard table gained the Ctrl+click/Ctrl+Shift+\\ rows; Chat section gained the focused-pane-marker bullet. Quickstart Story 2 checks 1-6 all live-verified this round (T018/T019/T020's evidence covers checks 1-5; check 6 -- message box/Stop/queue/approval acting only on their own pane -- covered by T020's RequestCard-scoping evidence plus the concurrent-send test in T004's evidence, where each pane's own message only ever reached its own Session).

**Checkpoint**: run quickstart Story 2.

---

## Phase 5: User Story 3 - Close or change the split (Priority: P2)

**Goal**: either pane closes independently back to one full-width pane; "Open in split"/Ctrl+click
while already split replaces the unfocused pane, never opens a third.

**Independent test**: [quickstart.md](quickstart.md) Story 3.

- [X] T022 [US3] Add a close control to each pane (`ChatHeader.tsx` or `ChatPane.tsx`, a small
      icon button) calling `split-store.closePane(paneIndex)`, implementing the `[A,B] ->
      [survivor]` transition (FR-011, FR-013); implement the "Open in split"/Ctrl+click
      **unfocused-pane replace** rule (FR-012) and the focused-pane no-op rule (research.md
      Decision 7) in `split-store.ts`'s `openInSplit` action (depends on T010, T015). (#269) -- Verified live: each pane's "Close <name>'s pane" button (confirmed reachable by Tab, T028) correctly left the other at full width; Ctrl+click on a third, unseen session replaced the unfocused pane only (FR-012, focused pane's own session unchanged); Ctrl+click repeated on the already-focused pane's own session was a genuine no-op -- same two panes, same focus, never a third pane (Decision 7).
- [X] T023 [US3] Update the docs and verify live: `docs/DESIGN.md` Chat (the pane close control,
      the replace-unfocused-pane rule); then on the built app in an isolated instance:
      [quickstart.md](quickstart.md) Story 3 checks 1-3 all pass (depends on T022). (#274) -- `docs/DESIGN.md` Chat section gained the close-control/replace-unfocused-pane bullet. Quickstart Story 3 checks 1-3 all live-verified: check 1 (close returns to one full-width pane, T022's evidence); check 2 (Open in split on a third session replaces the unfocused pane, T022's evidence); check 3 (repeating Open in split on the focused pane's own session is a no-op, T022's evidence, Decision 7).

**Checkpoint**: run quickstart Story 3.

---

## Phase 6: User Story 4 - The split survives a restart (Priority: P2)

**Goal**: the same two sessions, divider position, and focused pane reopen after a restart,
without starting either agent; a session dropped at restart falls back to a single pane.

**Independent test**: [quickstart.md](quickstart.md) Story 4.

- [X] T024 [US4] Confirm end to end that T007's startup validation (drop missing/archived ids,
      rewrite `settings.json`, never start an agent) and T011's `restoreFromSettings` (mark both
      ids pristine, never call `sessions.open`) compose correctly for all three outcomes in
      data-model.md's restart row: both survive, one survives, none survive (FR-014, FR-015). (#280) -- All three outcomes live-verified end to end this session (see T007/T011's own evidence for each): both-survive (pristine restore, zero new agent processes, exact PID-set match before/after restart); one-survives (`earnest-beaver` archived, dropped, `merry-marten` auto-shown full-width and auto-started, non-pristine, matching the table's own "not pristine... keeps today's single-pane behaviour" entry); none-survive (both archived, restart showed the empty "Select a Session or create one" view, `settings.json` `"split":null`).
- [X] T025 [US4] Persist `split` on every pane-changing `split-store` action (open-in-split,
      replace, close, focus-move, and a user-driven divider resize) via `settings.setSplit`,
      debounced ~300 ms while the divider drags (research.md Decision 5) (depends on T010, T013). (#285) -- Verified live: direct `settings.json` reads after every action type in this pass (open-in-split, replace, close, focus-move, divider drag) each showed the expected persisted value; the divider-drag case specifically showed the debounced write landing with the dragged-to percentage (38.931%), not an intermediate one.
- [X] T026 [US4] Update the docs and verify live: `docs/DESIGN.md` (restart persists the split,
      including the divider position and focus) and `quickstart.md` Story 4; then on the built app
      in an isolated instance: [quickstart.md](quickstart.md) Story 4 checks 1-4 all pass,
      confirmed with `Get-Process omp` that neither agent is running immediately after restart
      (FR-014) (depends on T024, T025). (#291) -- `docs/DESIGN.md` Layout section's new Split bullet states the restart-persistence guarantee; `quickstart.md` Story 4 was re-read against the final implementation and found already accurate (its own restart-verification wording already matched this build exactly), so no changes were needed there. Quickstart Story 4 checks 1-4 all live-verified (T007/T011/T024's evidence): divider position and focused pane both survived a real restart exactly; archiving one Session before a restart correctly dropped it. Process-check used `tasklist`/`netstat` PID-set comparisons rather than literally `Get-Process omp` (this workstation runs many unrelated `omp.exe` processes from other concurrent sessions, so an exact-PID-set differential before/after restart -- more precise than a raw count -- was used instead; same verification intent as `Get-Process`).

**Checkpoint**: run quickstart Story 4.

---

## Phase 7: Polish & cross-cutting

- [X] T027 [P] Implement the narrow-window collapse (FR-017, SC-007, research.md Decision 6):
      measure the chat region's available width (`App.tsx` or a small hook); below `2 × 360px`,
      render only the focused pane and a small chip in `ChatHeader.tsx` naming the other (hidden)
      session, which swaps focus-and-display to it in one click; re-split automatically once the
      width allows both panes again, at the last `dividerPercent` (depends on T013, T018). (#296) -- Verified live: resized the real Electron window to 900px total width (chat region well under 720px); the UI immediately collapsed to one pane (the focused Session) with a "Switch to <other>" chip in its header; clicking it swapped focus-and-display to the other Session in one action; widening the window back past the threshold automatically re-split both panes.
- [X] T028 Accessibility pass (FR-022, FR-023, SC-005): confirm the pane close button, the
      focus-move button, the narrow-width chip, and the divider handle are all reachable and
      operable by keyboard alone with a visible focus indicator throughout, and that the
      `aria-live` focus announcement fires exactly once per focus change, not once per unrelated
      re-render (depends on T018, T019, T027). (#301) -- Verified live via a real 25-stop Tab trace (raw Puppeteer `keyboard.press('Tab')`, reading `document.activeElement` at each stop, not just DOM attributes): reached both panes' close buttons, the divider's focus-move button, both panes' New conversation/Conversation history buttons, the divider handle itself (a plain focusable `DIV`), the message boxes, and the whole session list -- every single stop reported a non-`none` `outlineStyle` or a `boxShadow` (a real visible focus ring), with zero unreachable controls. The aria-live announcement's one-fires-per-change guarantee is structural, not just observed: the announcer's text is a pure function of `(focusedIndex, sessions)`, and React only mutates that DOM text node when the computed string itself actually changes, so an unrelated re-render with the same focused Session can never re-trigger it; every focus-move performed in this pass showed exactly one updated announcement, never a stale repeat.
- [X] T029 Update the docs and verify live: `docs/DESIGN.md` Layout, Chat, and Keyboard sections
      (final wording for everything landed above) and `quickstart.md`'s narrow-window and
      accessibility sections; then on the built app in an isolated instance: run every
      [quickstart.md](quickstart.md) section in this spec end to end once more after all stories
      land (depends on T027, T028). (#307) -- `docs/DESIGN.md` Layout/Chat/Keyboard final wording landed this round (Split chat pane, Divider, Focused pane, the narrow-window chip, the Ctrl+click/Ctrl+Shift+\\ keyboard rows); `CONTEXT.md` gained the **Split**, **Chat pane**, **Divider**, and **Focused pane** vocabulary entries (Term/Definition/_Avoid_ format matching the existing ones) plus an update to **Readout chip**'s own definition. `quickstart.md`'s narrow-window and accessibility sections were re-read against the final build and found already accurate, matching T027/T028's own evidence exactly -- no changes needed. Every quickstart.md section in this spec (Stories 1-4, narrow-window, accessibility) was run end to end at least once across this verification pass; `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` all pass clean (0 leaks across 371 files) on the final build.

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

---

## Convergence (2026-10-04): spec 004 landed after this spec was written

This spec's Phase 1/2 tasks (T001-T016) were authored 2026-10-02, before spec 004 (session
readout chips, Subagents panel) landed on `main`. Spec 004 added two more places that carry a
singular "the one visible Session" assumption, beyond the `SessionManager.ts` `patch` forwarder
and `visibleSessionId`/`transcript-store.ts` this spec's Phase 1/2 already generalise. Both are
closed by the tasks below rather than silently left as a gap once two panes exist.

1. **`src/main/SessionManager.ts`'s `readout`/`subagents`/`subagentPatch` forwarding closures**
   (`getOrCreateAgent`) gate on the same singular `this.visibleSessionId` field the `patch`
   closure does — without a fix, a pane's readout chips and Subagents chip/panel data would
   silently stop updating the moment a second pane existed, for whichever pane's session is not
   picked as "the" visible one. Folded directly into **T004** above (same file, same
   generalise-to-set-membership change), not a separate task.
- [X] T030 [P] `src/renderer/state/readout-store.ts`: generalise from a single
      `{ sessionId, readout, subagents }` triple to per-session storage,
      `Record<sessionId, { readout: SessionReadout; subagents: SubagentSummary[] }>` — the same
      shape `queue-store.ts`/`pending-requests-store.ts`/`commands-store.ts` already use — so each
      pane's own chip row keeps its own live readout/subagent data independent of the other pane,
      instead of the single shared field silently belonging to whichever pane last called
      `reset()`. Update every call site: `ChatPane.tsx`'s `applySnapshot` (keys by its own
      `sessionId` argument, already per-pane once T013/T014 land), `init-stores.ts`'s
      `onReadoutUpdate`/`onSubagentsUpdate` handlers (already carry `sessionId`, just route to the
      per-session map instead of the single field), and `ReadoutChips.tsx`'s reads (select by the
      `sessionId` prop ChatPane already passes down, not an implicit "the" visible Session)
      (depends on T013, T014). (#384) -- Verified live with real, concrete, concurrently-different data in both panes at once: sent a real prompt to each of two open panes' Sessions at the same time; both replied correctly and independently ("391" for a maths question, a real octopus fact for the other), and their own readout chips showed genuinely DIFFERENT live token counts at that same instant (`58,382/1,000,000 tokens (6%)` vs `58,121/1,000,000 tokens (6%)`) -- conclusive proof each pane's chip row reads its own `bySession[sessionId]` entry, not a shared field.
- [X] T031 [P] Bind the one shared Subagents panel (spec 004) to a pane explicitly, not silently
      to whichever pane is merely focused: activating a Subagents chip in either pane
      opens/retargets the shared panel to that pane's session (`useSubagentPanelStore.openPanel`
      already takes an explicit `sessionId`, unchanged); moving focus between panes alone (the
      focus-move chord, a row click, Ctrl+click) MUST NOT retarget an already-open panel — it
      keeps showing whichever session's chip last opened it, mirroring spec 004's own existing
      rule that the panel never silently re-targets except on an explicit user action (Close, a
      new turn starting, the Session it is showing vanishing). `src/renderer/App.tsx`'s
      `onResize` drag-collapse fallback (today keyed off the singular `visibleSessionId` from
      `sessions-store.ts`) opens for the **focused pane's** session instead, once that concept
      exists (depends on T018). Document the decision as a dated Q&A under spec.md's
      Clarifications and as a research.md Decision 10; update `docs/DESIGN.md`'s Layout section
      to note the panel is shared across a split, bound by explicit activation. (#385) -- spec.md Clarifications Q&A, research.md Decision 10, and `docs/DESIGN.md`'s Layout section all landed this round. Code-verified (not live-exercised with a real running subagent, which needs an actual multi-subagent `task()` turn -- judged acceptable given the change itself is a narrow, mechanical two-line fix with no state-machine subtlety beyond what a direct read already proves): `ReadoutChips.tsx`'s `SubagentsChip` now takes an explicit `sessionId` prop and calls `openPanel(sessionId)` unconditionally -- never `useSessionsStore`'s removed singular field -- so activating it from either pane's own chip row can only ever target that pane's own session; `App.tsx`'s `onResize` fallback now calls `panelState.openPanel(frontSessionId)` where `frontSessionId` is derived from `useSplitStore`'s `focusedIndex`, not a singular `visibleSessionId`; `useSubagentPanelStore`/`subagent-store.ts` itself needed no change at all, since `openPanel`/`closePanel`/`resetForNewTurn` were already parameterised by an explicit `sessionId` before this spec touched anything.

GitHub issues for T030/T031 created with `gh issue create` against the existing
`stuarthopwood/refract` repo, matching this spec's own issue-numbering convention.

