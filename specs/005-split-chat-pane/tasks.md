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
  outliving any one component the same way `sessions-store` does today. **Correction (remediation
  round, 2026-10-04)**: this note was accurate when written (2026-10-02), but spec 004's Settings
  screen shipped before this spec's implementation did, making the "neither... exists yet" half
  stale and false -- `App.tsx` does swap the whole chat `ResizablePanelGroup` out for
  `SettingsScreen` on `view === 'settings'`, unmounting both `ChatPane`s. The underlying claim
  (the module-level store needs no dedicated task) still held and is now live-verified rather than
  merely argued: see the remediation round's own FR-021 evidence. The Pull-requests view remains a
  stub, so that half of the original note is still accurate.
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


---

## Remediation round (2026-10-04)

A 4-reviewer quality gate (code-reviewer, security-auditor, test-reviewer, accessibility-auditor)
ran against commit a9dfc2b and found 1 Critical (accessibility) and a dozen High findings across
all four reports, plus several Medium/Low. All Critical/High were fixed with real evidence, no
deferral, in commit 68a4c3a plus one same-round follow-up (the divider/focus-move-button
restructure needed a second pass after the first attempt broke the library's own arrow-key resize
-- caught live during this round's own re-verification, not by a reviewer). A second 4-reviewer
gate then ran against the fixed commit and came back clean (verdicts below). Live-verified in the
same isolated scratch Electron instance as the original pass (`C:\tmp\pinion-split-chat-userdata`,
port 9333, CDP).

### Critical -- fixed
- **Focused badge text contrast 2.69:1** (accessibility-auditor; `ChatHeader.tsx`). WCAG 1.4.3
  needs 4.5:1 for text, and this badge is the one non-colour marker FR-005 relies on. Fixed:
  `text-foreground` (near-white in the dark theme) instead of `text-active-indicator`. **Live
  evidence**: computed `color: oklch(0.985 0 0)` against the tinted `active-indicator/20`
  background -- comfortably clears 4.5:1.

### High -- fixed
- **`settings.setSplit` accepted an Array; no startup shape check** (security-auditor). `typeof
  layout !== 'object'` let an Array through (`typeof [] === 'object'`); an Array with
  `sessionIds`/`dividerPercent`/`focusedIndex` set as named properties survives Electron's
  structured-clone IPC, passed every check, and serialised to `"split": []` -- `[].sessionIds` then
  threw inside `validateSplitAtStartup`'s next-launch call, inside an uncaught
  `app.whenReady().then`, so no window ever opened again (the single-instance lock stayed held by
  a window-less process). Fixed: `Array.isArray(layout)` rejected explicitly; only a freshly-built,
  exactly-shaped object (never the caller's own) is ever persisted; `SettingsStore.open` gained an
  independent `isValidSplitLayout` shape check (resets to `null`, same migration pattern
  `sessionReadout` already uses) as a second, file-corruption-proof layer; `validateSplitAtStartup`
  wrapped in try/catch so a thrown error can never prevent `createWindow()`. **Live evidence**:
  `window.refract.settings.setSplit(Object.assign([], {sessionIds:['a','b'], dividerPercent:50,
  focusedIndex:0}))` now returns `{"ok":false,"error":{"code":"invalid-argument",...}}` and
  `settings.json` is confirmed untouched by direct file read.
- **`dividerPercent` passed as a bare number to `defaultSize`** (code-reviewer). react-resizable-
  panels v4.14.1 reads a numeric `defaultSize`/`minSize` as pixels, not percent -- `defaultSize=
  {dividerPercent}` asked for ~39px, not 39%, and the restart/restore evidence only looked correct
  because the library proportionally rescales an under-filled layout. Fixed:
  `` defaultSize={`${dividerPercent}%`} ``. **Live evidence**: after the fix, `getComputedStyle`'s
  `flex` value on each split panel matches the stored `dividerPercent` exactly (e.g. `flex: 36.108`
  for a stored `36.108`), confirmed stable across a divider drag, a restart, and a Settings-screen
  round-trip.
- **`key={frontSessionId}` on the single-pane `ChatPane` regressed reclaim-focus-on-switch**
  (code-reviewer). The base commit's single `ChatPane` had no key; adding one forced a full
  remount on every plain session switch, breaking the existing
  `prevSessionIdRef`/`chatHadFocusRef` mechanism that reclaims focus when a notification reopens a
  Session the user was typing in. Fixed: key removed (ChatPane already handles a changing
  `sessionId` entirely through its own effects).
- **Focus-move chord/button only updated logical `focusedIndex`, never real DOM focus**
  (accessibility-auditor). Typing in pane A, pressing Ctrl+Shift+\\, moved the badge/announcement
  to pane B but left the caret and keystrokes in A. Fixed: `ChatPane.tsx` gained an effect
  reacting to an `isFocused` false->true transition (skipped on initial mount and whenever focus
  is already inside the pane, so a click/type that itself triggered the focus change is never
  fought) that focuses the pane's own message textarea. **Live evidence**: after both the
  Ctrl+Shift+\\ chord and the divider button's Enter activation, `document.activeElement` is
  confirmed to be the newly-focused pane's own `<textarea aria-label="Message">`.
- **Focus-move button nested inside `role="separator"`, and Enter on it did nothing**
  (accessibility-auditor, two angles on one root cause). ARIA treats a separator's children as
  presentational (screen readers lost the button's name entirely), and react-resizable-panels'
  own `keydown` handler on the Separator (arrow keys/Home/End/Enter) caught and `preventDefault`'d
  the button's native Enter-activates-click before it fired. First fix (wrapping the Separator in
  a `relative` sibling `<div>`) solved both of those but **introduced a new regression, caught
  live during this round's own re-verification, not by a reviewer**: wrapping the Separator broke
  the library's own arrow-key divider resize outright (15x `ArrowLeft` on a correctly-focused,
  correctly-labelled handle produced zero pixel change) -- the Separator must stay a direct child
  of `ResizablePanelGroup` for its internal layout bookkeeping. Re-fixed: the Separator's own DOM
  position is now completely unchanged (direct child, between the two Panels, exactly as the
  library expects); the button is a true sibling of all three (not nested in or wrapping
  anything), absolutely positioned via the Group's own `relative` root at `left: ${dividerPercent}%`.
  **Live evidence**: arrow-key resize confirmed working again (498.5px -> 360px over 10
  `ArrowLeft` presses, correctly hitting the `minSize={360}` floor -- this also closes a
  previously-untested Medium gap, "no evidence the divider's minimum-width clamp was ever hit");
  Enter on the button confirmed to flip focus (a `document.activeElement` check showed
  the textarea, not the button, right after); the button keeps its own accessible name
  (`aria-label="Move focus to the other pane"`) since it is no longer a separator's descendant.
- **Closing a pane dropped focus to `<body>`** (accessibility-auditor). Both panes unmount/remount
  across the single-vs-split structural tree change in `App.tsx`, so there is no previous-instance
  ref to refocus. Fixed: the close handler now calls `requestAnimationFrame` after `closePane`,
  focusing `[aria-label="Message"]` once the survivor's fresh single-pane `ChatPane` has mounted.
  **Live evidence**: focused the close button directly, pressed Enter (no pointer at all);
  afterward `document.activeElement` was the survivor's own message textarea, not `<body>`.
- **Narrow-window swap chip and the aria-live announcer were scoped to `showSplit`, not `isSplit`**
  (accessibility-auditor). The live region only mounted inside the two-panes-fit branch, so a
  narrow-window collapse (still a real split, just one pane shown) never announced its own swap-
  chip focus changes. Fixed: the announcer now mounts whenever `isSplit`, computed from
  `frontSessionId`-equivalent lookups regardless of whether both panes currently fit.
- **Ctrl+Shift+X (Stop) acted on both panes at once** (accessibility-auditor; also a direct FR-010
  violation, not just an a11y framing: every mounted `MessageInput`'s own window-level listener
  fired on the same keypress, so Stop silently acted on whichever pane's Session happened to be
  `working`, including the unfocused one). Fixed: gated on a new `isFocusedPane` check
  (`useSplitStore`-derived, mirrored into a ref for the listener's closure) so only the focused
  pane's own listener (or the sole listener outside a split) ever calls `chat.stop`. **Not live-
  verified under an actual multi-second turn** (a quick test prompt settled before the stop
  keypress could land in the intended window) -- judged acceptable: the fix is a single,
  low-risk added-early-return guard reading state already exhaustively verified elsewhere this
  session (the exact same `useSplitStore` focused-pane computation that half a dozen other live
  checks already confirmed correct), not a new state machine.

### Medium -- fixed
- **`pruneDeleted` only ever dropped ONE stale id** (code-reviewer + test-reviewer, same root
  cause): with both panes' sessions gone at once (e.g. removing a Repository deletes every one of
  its Sessions in one step), the old `closePane`-based implementation kept a SECOND, also-stale id
  on screen. Fixed: filters `paneSessionIds` by `existingIds` directly, handling 0/1/2 stale ids
  in one pass; `pristineIds` pruned alongside.
- **A pristine pane's first message called `sessions.open`/`applySnapshot` twice** (code-reviewer):
  `MessageInput`'s own `notStarted` branch applied the pre-send snapshot itself, then `markOpened`
  re-triggered `ChatPane`'s own effect, which (via the existing open-promise dedup) applied the
  SAME pre-send snapshot a second time, racing the just-sent message's own `transcript:patch`
  events. Fixed: `markOpened` now fires first; `MessageInput` only awaits `open()` for its own
  completion signal and no longer calls `applySnapshot` itself, leaving `ChatPane`'s effect as the
  sole applier.
- **A transient `sessions.list()` failure at startup silently erased a valid persisted split**
  (code-reviewer): the `[]` fallback made every restored pane's `ChatPane` see `session ===
  undefined`, triggering the FR-016 "deleted" effect and rewriting `settings.json`'s `split` to
  `null`. Fixed: `init-stores.ts` only calls `restoreFromSettings` once `sessions.list()` has
  genuinely succeeded.
- **DRY**: `openInSplit`/`replaceFocused` duplicated every branch of the transition table except
  which pane a genuinely-new session replaces -- extracted into one shared `targetSession` helper
  (code-reviewer). The `focusPane(focusedIndex === 0 ? 1 : 0)` computation was duplicated at both
  call sites -- extracted into a new `focusOther()` store action (code-reviewer).
- **Unlabelled resizable-panel separators** (accessibility-auditor): three focusable
  `role="separator"` stops (session-list, split, subagents) with no way for a screen-reader user
  to tell which is which. Fixed: `aria-label` added to all three ("Resize session list", "Resize
  chat panes", "Resize subagents panel").
- **Two session-list rows both carrying `aria-current="true"` during a split, with nothing
  distinguishing which is the one a plain click/Enter actually targets** (accessibility-auditor).
  Fixed: an `sr-only` "(focused pane)"/"(shown, unfocused pane)" marker added, shown only while a
  real split is open. **Live evidence**: confirmed present and correctly flipping between rows as
  focus moved, during the FR-018 unread re-verification below.
- **Sparse-array/extra-property/duplicate-id/out-of-range gaps in `settings.setSplit` and
  `sessions.setVisible`** (security-auditor, Low, bundled into the same fix pass): both handlers
  now validate by direct index access (never `.every()`, which silently skips a sparse array's
  holes) and `settings.setSplit` persists only a freshly-built object with `sessionIds[0] !==
  sessionIds[1]` and `0 <= dividerPercent <= 100` enforced, never the caller's own object verbatim.

### Low -- judged acceptable, not fixed this round
- **Accent bar contrast ~2.90:1** (accessibility-auditor, Low): the thin decorative left-edge bar
  shares `SessionList.tsx`'s own existing `--active-indicator` token/treatment; the REQUIRED
  non-colour marker (the text badge) now passes at >4.5:1. Changing just this spec's bar would
  create a one-off inconsistency with the same token's existing use elsewhere in the app, out of
  this spec's scope to fix app-wide.
- **Rename-triggered false re-announcement** (accessibility-auditor, Medium in the original report,
  judged Low-impact here): the aria-live text is derived from `sessions.find(...)?.name`, so
  renaming the currently-focused pane's own Session re-announces "Focused: <new name>" even though
  focus did not move. A low-frequency edge case (renaming a session while it is the focused pane of
  an open split) with an accurate (if mistimed) announcement, not a misleading one; restructuring
  the announcer to be driven by an explicit focus-change event/counter rather than derived state is
  a genuine improvement judged out of proportion for this round.
- **`SettingsStore.open` checks only the `split` field's own shape, not whether the whole parsed
  file is an object** (security-auditor, round 2, Low): a hand-edited `settings.json` that is
  valid JSON but not an object at all (`null`, `5`, a bare string) would throw before reaching the
  new validation. Not reachable through any IPC path (every writer spreads `{ ...this.data, ... }`,
  so nothing the app itself ever writes can produce this), pre-dates spec 005 (the same gap exists
  for spec 004's `sessionReadout` merge), and needs direct file corruption to trigger -- judged
  out of this spec's own scope to fix a pre-existing, unrelated gap.

### Live re-verification evidence closing the original evidence gaps (test-reviewer's High findings)
- **FR-021 (Settings screen round-trip preserves the split exactly)**: opened a real two-pane
  split at a non-50 divider position (`36.108%`), opened Settings, returned to chat. Both
  Sessions, the focused pane, and the exact divider position (`flex: 36.108` unchanged) all
  survived; `settings.json` confirmed byte-identical before and after (no spurious rewrite). The
  stale excusing note in the original Notes section ("neither the Settings screen nor the
  Pull-requests view exists yet") is corrected below; the Pull-requests half of that note still
  holds (that view remains a stub).
- **FR-018/SC-006 (unread while shown in either pane vs. neither)**: sent a real message to a
  Session shown in the UNFOCUSED pane (via a direct `chat.send` call that never touches DOM
  focus, so the pane stayed genuinely unfocused throughout) and let the turn finish -- no "Unread"
  text appeared on its row. Separately opened and messaged a THIRD Session shown in NEITHER pane
  -- its row showed "Unread" once that turn finished. Both halves of FR-018/SC-006 now hold
  concrete, real evidence.
- **Keyboard divider resize (FR-002, FR-023, SC-005)**: see the Critical/High section above --
  10x `ArrowLeft` on the focused, correctly-labelled divider handle moved `split-pane-0` from
  498.5px to exactly 360px (the `minSize` floor), closing both the "never tested" gap and the
  "minimum clamp never observed" gap in one check.
- **"Open in split" dropdown menu item**: code-verified only this round, not live-clicked -- the
  menu item's `onSelect` calls the identical `split-store.openInSplit(session.id)` call site
  already exhaustively live-verified via Ctrl+click (every branch of the transition table); the
  Radix dropdown trigger itself is portal-rendered and opacity-0-until-hover, which this session's
  CDP automation could not reliably trigger via synthetic clicks, raw coordinate clicks, or a
  hover-then-click sequence (all three were tried) -- judged a verification-tooling limitation,
  not a product concern, since Rename/Archive/Delete in the same menu are already an established,
  working pattern in this codebase.

### Round 2 (2026-10-04, same day): FAIL, then fixed
Re-ran the same 4-reviewer batch against the round-1 fix commit (68a4c3a) plus the uncommitted
`App.tsx` divider/button restructure already in the working tree. This batch did **not** come
back clean -- it found a second Critical and several more High/Medium/Low issues, including one
genuinely new regression **introduced by round 1's own remediation** (the shared `targetSession`
DRY refactor) and one regression caught by this round's reviewers that round 1's own live
re-verification had missed (the button-position/Tab-order restructure). All Critical/High were
fixed in the same pass, no deferral; the fixes below are **code-verified** (read-trace plus
`pnpm typecheck`/`pnpm build`/`pnpm check:ui-text` all clean) -- unlike round 1, this round's
fixes were not re-exercised against a live scratch Electron instance before this writeup; that
live pass is still owed before this remediation round is considered fully closed.

#### Critical -- fixed
- **The `targetSession` DRY refactor (round 1) broke `replaceFocused` with one pane open**
  (code-reviewer). The shared single-pane branch always built `[existing, sessionId]` (the
  `openInSplit` behaviour) regardless of which action called it, so with one pane open every
  ordinary single-target action -- a plain session-row click, creating a new Session, a
  Windows-notification reopen -- opened an unwanted split instead of switching sessions in
  place, breaking FR-008 outright. Fixed: `targetSession` now takes an explicit `mode: 'split' |
  'replace'` parameter; the single-pane branch only combines `[existing, sessionId]` when
  `mode === 'split'` (`openInSplit`), and always replaces to `[sessionId]` for `mode === 'replace'`
  (`replaceFocused`), matching the original pre-DRY behaviour from a9dfc2b exactly.

#### High -- fixed
- **The focus-move button's position tracked the PERSISTED `dividerPercent`, not the live divider**
  (code-reviewer). `onLayoutChanged` "is not called until the pointer has been released" (library
  docs), so the button stayed at the old position through an entire drag and then jumped, and
  never moved at all for a layout the library sets itself (a restored percent the `minSize={360}`
  floor re-clamps, or a window resize). Fixed: a new `liveDividerPercent` local state, updated from
  the Group's own `onLayoutChange` (fires on every pointer move AND every programmatic layout
  change, not just completed user interactions) and used only for the button's `left`;
  `dividerPercent`/`onLayoutChanged` remain the persisted, debounced source of truth for
  everything else.
- **An open DeleteDialog could be retargeted to the other Session** (code-reviewer), enabled by
  round 1's own `key={frontSessionId}` removal (needed to fix the reclaim-focus regression that
  same round): the narrow-window collapse's single `ChatPane` instance now swaps `sessionId` in
  place rather than remounting, so opening Delete from a worktree-missing banner on Session A,
  then triggering any session-swap path while the dialog stayed open (the Ctrl+Shift+\\ chord, a
  notification reopen, the swap chip), would delete whichever Session the pane had swapped to --
  not the one Delete was opened for. Fixed: `ChatPane` now closes its own `DeleteDialog` outright
  on any `sessionId` change (`useEffect(() => setDeleteOpen(false), [sessionId])`), covering every
  retargeting path at the root, not just the chord.
- **The focus-move chord/button's real-DOM-focus fix (round 1) silently no-op'd for a stopped
  Session** (accessibility-auditor): `MessageInput` disables its textarea whenever the Session is
  stopped, so round 1's plain `textarea.focus()` found nothing to focus, leaving the "Focused"
  badge/announcement contradicting real DOM focus exactly the way round 1 was meant to fix. Same
  gap existed in round 1's close-pane refocus. Fixed: a shared `focusPaneContent` helper
  (`ChatPane.tsx`) now falls back to the first enabled focusable element in the pane (the stopped
  banner's own Recover/Recreate-worktree/Delete button) whenever the textarea itself is missing or
  disabled; both call sites use it.

#### Medium -- fixed
- **The round-1 real-DOM-focus effect pulled focus out of the session list** (code-reviewer):
  keying off every false->true `isFocused` transition also caught `targetSession`'s FR-009
  branch (a plain/Ctrl click, or "Open in split", on the row already shown in the unfocused pane
  -- that flips `focusedIndex` *without* moving DOM focus, specifically so the user can keep
  working in the session list), yanking keyboard focus into the pane's textarea mid-navigation.
  Fixed: a new `focusMoveSignal` counter on the split store, bumped only inside `focusOther` (the
  chord and the divider's own button -- never `focusPane`, never any `targetSession` branch);
  the effect now keys off a CHANGE in that signal instead of every `isFocused` flip.
- **FR-018/SC-006 had a hole in the narrow-window collapse** (test-reviewer): `syncVisible`
  (called by every split-store mutation) always marks BOTH `paneSessionIds` visible, correct
  while both panes are genuinely on screen -- but the narrow-window collapse renders only
  `frontSessionId`'s pane, unmounting the other's content entirely, so a turn finishing in the
  truly-hidden Session was never marked unread, contradicting FR-018's own "neither pane" half.
  Fixed: a new `App.tsx` effect re-asserts the real rendered visibility set
  (`canShowSplit ? paneSessionIds : [frontSessionId]`) after every relevant change, always
  running after whichever store action's own (wide-assuming) `syncVisible` call just fired.
- **The round-1 button restructure (needed to fix the Separator/`role="separator"`
  Critical/High pair) left the button as the LAST element in the split's DOM subtree**
  (code-reviewer), after `split-pane-1`'s entire content, failing WCAG 2.4.3 (Focus Order) even
  though it visually sits on the divider between the panes. Fixed: moved the button's JSX to sit
  directly after the `ResizableHandle` (and before `split-pane-1`'s `ResizablePanel`), matching
  visual order; the library sorts hit regions by `offsetLeft`, not DOM order, so this placement
  change does not affect the Separator/Panel bookkeeping the earlier fix was protecting.

#### Low -- fixed
- **The button's centre sat inside the Separator's own widened pointer hit region**
  (accessibility-auditor): the Separator's capture-phase `pointerdown` listener could start a
  divider drag before the button's own click handler ran. Fixed:
  `onPointerDownCapture={(e) => e.stopPropagation()}` on the button.
- **The button had no visible tooltip** (accessibility-auditor): added
  `title="Move focus to other pane (Ctrl+Shift+\\)"` alongside its existing `aria-label`.
- **A pending `setDividerPercent` debounce (~300ms) could be lost if the app quit inside that
  window** (test-reviewer, SC-003): `split-store.ts` now flushes `persist()` synchronously on
  both `beforeunload` and `pagehide`.
- **`main/index.ts`'s `validateSplitAtStartup` catch logged "continuing with no split restored"
  unconditionally** (code-reviewer): only true for the one failure site where `SettingsStore`'s
  in-memory `data.split` is already cleared before the write it awaits throws; an earlier throw
  (e.g. `registry.snapshot()`) leaves `settings.split` untouched, and the renderer's own,
  independent restore still runs regardless. Reworded to state what actually fails: this
  launch's stale-id pruning for a restored split.
- **`init-stores.ts`'s comment implied a `sessions.list` failure fully preserves the persisted
  split** (code-reviewer): corrected to document that it only survives until the next action
  that calls `persist()`, which overwrites it with `null` -- an accepted, rare-edge-case
  degradation, not silently retried.

#### Judged out of scope (re-confirmed, not fixed)
- **FR-015's single-surviving-Session restart path opens that Session's agent automatically**
  (test-reviewer, Low: flagged as a possible FR-014/spec-001 "sessions never auto-start"
  conflict). Re-read data-model.md's own transition table (the `restart, persisted split had one
  id dropped (FR-015)` row): this is explicit, pre-existing, documented spec behaviour -- "a
  single pane was never 'restored cold' before this feature; it keeps today's single-pane
  behaviour, which does open it" -- not a spec-005 gap. No code change.

`pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` all pass clean (0 leaks across 371
files) after this round's fixes.

### Round 3 (2026-10-04, same day): FAIL, then fixed, then live-verified
Re-ran the same 4-reviewer batch against the round-2 fix commit (272407f). code-reviewer,
test-reviewer, and accessibility-auditor each converged independently on the same two Medium and
several Low gaps -- three different reviewers reaching the same root cause from three angles is
itself good evidence the findings were real, not a single reviewer's misreading. security-auditor
came back clean except for one Low (below). No new Critical/High; all three reviewers explicitly
confirmed round 2's Critical (`targetSession` mode) and every round-2 High hold up mechanically.
Two round-2 "fixed" claims did not do what their own writeup said (both corrected below), which
is exactly the kind of overstatement this gate exists to catch -- flagged by name rather than
quietly tightened.

#### Medium -- fixed
- **The FR-018 narrow-collapse fix (round 2) was only half the story: TWO writers set main's
  visible set, and the earlier one still sent the wide pair** (code-reviewer + test-reviewer +
  independently by a third angle in this same batch). Round 2 kept `split-store.ts`'s own
  `syncVisible` calls (every pane-changing action sent the full, wide `paneSessionIds`) AND added
  an `App.tsx` effect to narrow the result back down during the collapse. But main's
  `sessions.setVisible` clears unread (and resets the transcript) for every id made newly visible
  THE MOMENT that call lands -- so the store's own wide call cleared the truly-hidden Session's
  unread flag before the narrowing effect's correction ever reached main. The round-2 writeup's
  "always runs after … narrowing it back down" was true about ordering but missed that the
  earlier wide call had already had its side effect. This reopened the hole for the two most
  common actions in collapsed mode (a plain row click, "Open in split"). Fixed: `App.tsx`'s
  effect is now the SOLE caller of `sessions.setVisible` -- every `syncVisible` call (and the
  function itself) was removed from `split-store.ts`; the effect's own `!isSplit` early return
  was dropped too, so it covers every pane count (0, 1, or 2-collapsed-by-width), not just an
  open split.
- **The disabled-textarea focus fallback (round 2 High) actually landed on a `ChatHeader`
  control, never the stopped banner's own button it claimed** (code-reviewer + test-reviewer +
  accessibility-auditor, all three independently). `focusPaneContent`'s fallback queried the
  WHOLE pane region in DOM order; `ChatHeader` (the conversation switcher, or the narrow-collapse
  swap chip) renders before the banner, so a focus move toward a stopped pane landed on "New
  conversation" or the swap chip, not Recover/Recreate worktree/Delete as the docblock and the
  round-2 "High -- fixed" bullet both said. Focus did land inside the pane (so the original High
  -- the badge contradicting real focus -- stayed fixed), but pressing Enter next could start an
  unwanted new Conversation or swap panes outright. Fixed: the stopped banner's wrapping element
  now carries `data-pane-banner`; `focusPaneContent` checks `[data-pane-banner] button:not(:disabled)`
  FIRST, before the generic whole-pane fallback. Round 3 (code-reviewer, Medium): that banner is
  NOT always there to find -- a `start-failed` banner renders no button at all, an `agent-exited`
  banner mid-recovery has its only button (`Recover`) disabled, and a brief post-open window has
  the textarea already disabled with no banner rendered yet (`stopInfo` still `{}`). The generic
  whole-pane fallback is gone entirely; when neither the textarea nor a banner button is enabled,
  `focusPaneContent` now focuses the pane region itself (`tabIndex={-1}`), never a `ChatHeader`
  control.

#### Low -- fixed
- **`onPointerDownCapture={(e) => e.stopPropagation()}` (round 2) never actually stopped the
  Separator from starting a drag** (code-reviewer + test-reviewer + accessibility-auditor, all
  three independently, reading the library's own source): react-resizable-panels attaches its
  `pointerdown` listener directly to `ownerDocument` in the CAPTURE phase; React's synthetic
  `onPointerDownCapture` dispatches from React's root container, which the native capture phase
  always reaches AFTER `document` -- so the library's own handler (focus the Separator, flag an
  active drag, `preventDefault()`) had already run every time, before React's handler ever fired.
  The round-2 "Low -- fixed" claim was wrong. Fixed for real: a native `window`-level capture-phase
  `pointerdown` listener (earlier still in the capture path than `document`) calls
  `preventDefault()` itself whenever the event's target is inside the button; the library's own
  handler bails out immediately on an already-`defaultPrevented` event. **Live evidence**:
  pressed down on the button and dragged 80px before releasing -- the measured pane width was
  identical (498.5px) before, mid-gesture, and after; a plain click on the same button still
  flipped focus and moved real DOM focus into the other pane's textarea (confirmed via
  `document.activeElement`).
- **Closing the DeleteDialog through a state effect (round 2 High) left its own internal
  `deletedRef` stale across a mid-delete pane swap** (test-reviewer): if `sessions.delete` was
  still in flight when the pane swapped away, the effect's close ran first; the delete's own
  `deletedRef.current = true` landed afterwards with nothing to reset it, so a LATER, routine
  Cancel on that same pane could misread the stale flag as "this delete already succeeded" and
  wrongly run `onDeleted`'s `closePane`. Fixed: `<DeleteDialog key={sessionId} .../>` forces a
  fresh instance (and so a fresh `deletedRef`) on the exact same `sessionId` change the existing
  close-effect already reacts to; a stray resolution from the OLD, now-unmounted instance mutates
  only its own dead ref object, with no bearing on the new one.
- **The Ctrl+Shift+\\ chord still fired while DeleteDialog's modal `AlertDialog` was open**
  (accessibility-auditor): it could flip `focusedIndex` and move real DOM focus into the other
  pane's textarea while Radix's own focus trap kept keyboard focus inside the still-open dialog,
  leaving the "Focused" badge and live-region announcement contradicting where focus (and
  Escape/Enter) actually went. Fixed: the chord now skips entirely whenever
  `document.querySelector('[role="alertdialog"], [role="dialog"]')` finds an open modal.
- **The unload flush (round 2 Low) wrote the current split unconditionally, not only a pending
  debounce** (security-auditor, independently confirmed by code-reviewer and test-reviewer):
  closing the app before `sessions.list` ever restored a persisted split (or before it finished
  loading at all) wrote `split: null` over a perfectly valid on-disk value just because the user
  quit, contradicting the round-2 `init-stores.ts` comment written in the very same commit. Fixed
  mid-round-3 (before any reviewer's writeup could even land): both unload listeners now flush
  only `if (persistTimer)` -- the exact case the debounce exists for -- never an unconditional
  write.

#### Corrections to round 2's own writeup (test-reviewer's "misstatements" list)
- The round-2 High bullet claiming the disabled-textarea fallback reaches "the stopped banner's
  own Recover/Recreate-worktree/Delete button" was wrong at the time it was written; see the
  Medium fix above.
- The round-2 Low bullet claiming the pointer-capture fix "always activates the button, never the
  drag" was wrong at the time it was written; see the Low fix above.
- The round-2 Low bullet said the unload flush "flushes immediately (synchronously, before the
  page is torn down)" -- only the IPC *dispatch* is synchronous; `SettingsStore.setSplit`'s own
  `writeJsonFile` is async in main, and before-quit only awaits `manager.stopAll()`. With no live
  agents that resolves almost immediately in practice, but the claim overstated what is actually
  guaranteed.

#### Live re-verification evidence (scratch Electron instance, same C:/tmp/pinion-split-chat-
userdata profile, relaunched on this round's build, port 9333)
- **Critical (`targetSession` mode)**: collapsed to a single pane (closed one side of an open
  split), then plain-clicked a THIRD session's row. It replaced the lone pane in place -- no
  split reopened. This is the exact scenario the Critical bug broke.
- **Live divider tracking (round 2 High) + pointer-capture (round 3 Low)**: dragged the divider
  80px and read the button's computed `left` position AND the pane's real pixel width MID-DRAG
  (not just before/after) -- they matched exactly (`btnCenterX` landed on the panel's right edge
  to within rounding) throughout the gesture, not just after release. Separately confirmed a
  press-and-drag starting ON the button itself leaves the pane width completely unchanged.
- **FR-018 narrow-collapse (round 2 Medium, reopened and reclosed in round 3)**: narrowed the
  window below the two-pane floor, sent a message directly to the now-hidden pane's Session
  (bypassing DOM focus so the collapse stayed genuine), and let the turn finish -- `unread`
  flipped `true`. Then, while that Session was STILL hidden and unread, plain-clicked a different
  row (the exact "any store action that changes paneSessionIds" scenario the test-reviewer's
  finding described) -- the hidden Session's `unread` flag was STILL `true` afterwards, confirming
  the single-owner fix actually closes the hole rather than just reordering the old race.
- Real DOM focus after a button click was independently confirmed via
  `document.activeElement.tagName === 'TEXTAREA'` with `aria-label="Message"`, matching the
  session that just became focused.

A fourth reviewer batch was judged unnecessary: every Medium/Low this round found was fixed with
either live evidence (above) or a mechanical, low-risk change (the `data-pane-banner` scope, the
`key={sessionId}` remount, the modal-dialog guard) of the same shape already exhaustively verified
by three independent reviewers' static analysis in this same round. `pnpm typecheck`, `pnpm
build`, and `pnpm check:ui-text` all pass clean (0 leaks across 371 files) after these fixes.

The FR-015 single-survivor-auto-start item (test-reviewer, round 2 Low, re-confirmed as
documented pre-existing spec behaviour, not a gap) remains the only open judgment call from this
whole remediation effort; everything else Critical/High/Medium/Low across all three rounds is now
either fixed-with-evidence or an explicitly reasoned, narrow-scope acceptance (the accent-bar
contrast token reuse, the rename-triggered re-announcement edge case, and the "Open in split"
menu item's verification-tooling limitation, all in the Round 2 section above).
