# Tasks: Right pane shell

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Prerequisites**: spec 001 (core session workspace), spec 004 (Settings screen, Subagents panel,
`subagent-store.ts`, `readout-store.ts`), and spec 012 (`watermarkEnabled` precedent) already
built on `main` in this checkout. `docs/design/components.md`, `patterns.md`,
`foundations-icons.md`, `accessibility.md` are cited from PR #580 (`docs/design-system-474`, not
yet merged) — re-read them from wherever they land before each task that cites one, per spec.md's
Assumptions. Windows 11 only.

**Tests**: none. Refract is a prototype (constitution, Development Workflow). Each phase ends with
a **Checkpoint** that runs the matching [quickstart.md](quickstart.md) section by hand, on the
built app. `pnpm typecheck` and `pnpm build` MUST pass before a change lands on `main`; run
`pnpm check:ui-text`, `pnpm check:theme-contrast`, and `pnpm check:drag-regions` (if present on
the base branch) once per full gate, not per task.

**Organization**: tasks are grouped by user story so each story can be built and checked on its
own, and the groups are ordered to match the assignment's four slices (shell/store, launcher+tabs
with Subagents hosted, FDB placeholders+Settings switch, non-drag resize+verification). Paths are
relative to the repository root. Task IDs (`T001` onward) are local to this spec.

**GitHub issues**: not yet filed (`/speckit.taskstoissues` not run during this planning pass);
file them before implementation starts if the team wants per-task tracking, titled
`013-Tnnn: ...`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: the user story from [spec.md](spec.md) (US1 to US6). Setup, Foundational, and
  Polish tasks carry no story label.
- Tasks that edit the same file are never both marked [P].

---

## Slice 1 / Phase 1: Foundational — the shell and its store (blocks every user story)

**Purpose**: the one new store, the static panel registry, and the window-controls-corner wiring
every later task builds on. No user-visible behaviour change yet (the shell exists but nothing
calls `togglePanelFromRail` until Slice 2).

- [ ] T001 Create `src/renderer/features/right-pane/panel-registry.ts`: `HostedPanelDescriptor[]`
  and `PanelId` (data-model.md), with three entries (`subagents`, `fdb-knowledge`,
  `agent-builder`) and `getPanelCount(id, sessionId)` (research.md decision 8 for the icon
  choices: `BotIcon`, `LibraryIcon`, `HammerIcon`).
- [ ] T002 Create `src/renderer/state/right-pane-store.ts`: `RightPaneState` (data-model.md) —
  `open`, `widthPx`, `openPanelIds`, `activePanelId`, `openPanel`, `closePanel`,
  `togglePanelFromRail`, `setWidth`, `syncRenderedState` (depends on T001 for `PanelId`).
- [ ] T003 [P] Export the new store from `src/renderer/state/index.ts` (depends on T002).
- [ ] T004 [P] Create `src/renderer/features/right-pane/IconRail.tsx`: one button per
  `HostedPanelDescriptor`, `aria-pressed` bound to `openPanelIds.includes(id)`, full icon-only
  bundle (Tooltip/aria-label/Kbd/24px target, FR-023, FR-026), `onClick` calls
  `togglePanelFromRail(id)` (depends on T001, T002).
- [ ] T005 [P] Create `src/renderer/features/right-pane/PanelLauncher.tsx`: centred list of every
  `HostedPanelDescriptor`, each row a button with icon, name, and `getPanelCount` where non-null
  (FR-010, FR-012); activating a row calls `openPanel(id)` (depends on T001, T002).
- [ ] T006 Create `src/renderer/features/right-pane/PanelTabBar.tsx`: ARIA tabs pattern over
  `openPanelIds` (arrow keys move focus, Delete closes the focused tab, each tab shows icon, name,
  live count, and its own close button), plus the single-panel title-row variant (FR-007, FR-008,
  FR-011's window-controls spacer) (depends on T001, T002).
- [ ] T007 Create `src/renderer/features/right-pane/WidthPresetControl.tsx`: three buttons
  (Min/Default/Max — 240/320/520px) calling a passed-in `resize(px)` callback (FR-025; the shell
  wires this to the `ResizablePanel` ref in T009) (depends on T002).
- [ ] T008 Create `src/renderer/features/right-pane/RightPaneShell.tsx`: renders `PanelTabBar`
  (0 open -> delegates header to `PanelLauncher` instead, 1 open -> title row, 2+ -> tabs) plus the
  active panel's content; mounts `IconRail` is NOT here (it sits beside the `ResizablePanelGroup`
  in `App.tsx`, not inside this pane's own content) (depends on T004, T005, T006, T007).
- [ ] T009 Edit `App.tsx`: rename the `subagents` `ResizablePanel` to host `RightPaneShell`
  instead of the raw `SubagentPanel` conditional; generalise the existing `onResize` handler
  (lines 366-394 on `main` today) to read/write `right-pane-store.ts`'s `open`/`widthPx` via
  `syncRenderedState` instead of `useSubagentPanelStore.open` (research.md decision 2, FR-017);
  mount `IconRail` as a fixed sibling of the `ResizablePanelGroup`, always visible (FR-001);
  compute the right-most `ChatPane`'s `reservesWindowControls` prop as `!rightPaneOpen`
  (research.md decision 4, FR-011) (depends on T008).
- [ ] T010 [P] Edit `ChatHeader.tsx`'s doc comment only (no behaviour change — its
  `reservesWindowControls` prop already does the right thing once T009 passes the right value; the
  comment at lines 8-11 currently describes split-only reasoning and should name the right-pane
  case too) (depends on T009).

**Checkpoint**: with no panel registered as hosting real content yet (T011+ not done), the rail
shows three icons, clicking one opens the pane and shows an empty `RightPaneShell` title row with
no crash; dragging the handle still collapses/reopens it; the window-controls corner is reserved
by the pane header while open and by `ChatHeader` while closed. Run quickstart.md Story 1 steps
1-2 and 8 only (full Story 1 needs T011 below for a second panel to open).

---

## Slice 2 / Phase 2: Launcher and tabs, Subagents hosted (User Stories 1, 2, 3)

**Purpose**: wire the Subagents panel in as the shell's first real hosted panel, retarget its
existing chip, and this makes User Stories 1 and 2 fully exercisable (two real panels to open).

- [ ] T011 [US3] Edit `subagent-store.ts`: keep every existing action
  (`selectSubagent`/`applyPatch`/`reset`/`resetForNewTurn`) unchanged; repurpose `openPanel`/
  `closePanel` to be called BY the shell (via `right-pane-store.ts`'s `openPanel('subagents')`/
  `closePanel('subagents')`) rather than toggling their own `open` boolean as the source of truth
  — `sessionId` stays the field that says "which Session this panel's content is bound to"
  (research.md decision 3, FR-015).
- [ ] T012 [US3] Edit `SubagentPanel.tsx`: remove its own `h-10` title-row/Close-button header
  (lines 55-66 on `main` today); the shell's `PanelTabBar`/title row now owns that chrome
  (research.md decision 5); keep the subagent list and stream content exactly unchanged (depends
  on T011).
- [ ] T013 [US3] Edit `ReadoutChips.tsx`'s `SubagentsChip`: `onActivate` calls
  `useRightPaneStore.getState().openPanel('subagents')` then binds the Session via
  `subagent-store.ts`'s existing session-binding call, instead of
  `useSubagentPanelStore.openPanel(sessionId)` directly (FR-016) (depends on T011).
- [ ] T014 [US1] Register `subagents` in `panel-registry.ts` as rendering `SubagentPanel` (depends
  on T001, T012).
- [ ] T015 [US2] Verify the launcher (T005) shows the Subagents count (FR-013) correctly sourced
  from `readout-store.ts`'s `bySession[frontSessionId].readout.subagentCount.running` via
  `getPanelCount` (depends on T001, T014).
- [ ] T016 [US3] Re-verify `App.tsx`'s generalised `onResize` guard (T009) against every one of
  spec 004's own collapse-desync edge cases (drag-to-collapse while open, drag-to-open with no
  `frontSessionId`, drag-to-open with a focused Session) using the Subagents panel specifically,
  since it is the one hosted panel with real session-binding state to desync (depends on T009,
  T011).

**Checkpoint**: quickstart.md Stories 1, 2, and 3 all pass in full — two real panels (Subagents
plus any placeholder stub from Slice 3, or a temporary second registry entry if Slice 3 is not yet
landed) exercise the tab bar, the launcher, and the Subagents regression bar end to end.

---

## Slice 3 / Phase 3: FDB placeholders and the Settings switch (User Stories 4, 5)

**Purpose**: the two placeholder panels and the one new persisted setting that switches their
content — independent of Slice 2's files, can be built in parallel with it once Slice 1 lands.

- [ ] T017 [P] Extend `src/shared/model.ts`'s `Settings` interface with `showSampleData: boolean`
  (data-model.md).
- [ ] T018 Extend `src/shared/ipc.ts`: add `IPC_REQUESTS.SETTINGS_SET_SHOW_SAMPLE_DATA =
  'settings.setShowSampleData'` and `RefractApi.settings.setShowSampleData(enabled: boolean):
  Promise<Result<Settings>>` (contracts/ipc.md) (depends on T017).
- [ ] T019 Extend `src/main/store/settings.ts`: default row gains `showSampleData: false`;
  `SettingsStore.open` treats a missing or non-boolean stored `showSampleData` as `false` in
  memory (same lazy-correction pattern as `watermarkEnabled`); add
  `setShowSampleData(enabled: boolean): Promise<Settings>` (depends on T017).
- [ ] T020 Extend `src/main/ipc/settings.ts`: `registerSettings` gains the
  `SETTINGS_SET_SHOW_SAMPLE_DATA` handler, validating a boolean, calling
  `store.setShowSampleData`, broadcasting `settings:changed` (depends on T018, T019).
- [ ] T021 [P] Extend `src/preload/index.ts`: expose `settings.setShowSampleData` (depends on
  T018).
- [ ] T022 [P] Extend `settings-store.ts`: `DEFAULT_SETTINGS.showSampleData = false`, add
  `setShowSampleData` action (same shape as `setWatermarkEnabled`) (depends on T018, T021).
- [ ] T023 [P] Extend `view-store.ts`: `SettingsSectionId` gains `'right-pane'`; `openSettings`'s
  validation switch gains the case (data-model.md) (no file dependency beyond T017 existing
  conceptually).
- [ ] T024 Create `src/renderer/features/settings/RightPaneSection.tsx`: the "Show sample data"
  switch plus a one-line description, mirroring `AppearanceSection.tsx`'s layout convention
  (research.md decision 7) (depends on T022).
- [ ] T025 Edit `SettingsScreen.tsx`: `SECTIONS` gains `{ id: 'right-pane', label: 'Right pane' }`;
  render `RightPaneSection` for it (depends on T023, T024).
- [ ] T026 [P] [US4] Create `src/renderer/features/right-pane/placeholders/FdbKnowledgePanel.tsx`:
  reads `Settings.showSampleData`; `false` -> the three-part empty state (icon, one line, next
  action — FR-018); `true` -> sample search/ask/agent-tools content, each element carrying a
  visible "Sample data" label (FR-021) (depends on T022).
- [ ] T027 [P] [US4] Create
  `src/renderer/features/right-pane/placeholders/AgentBuilderPanel.tsx`: same two-state shape,
  naming Agent Builder and its own sample cloud-agent content (depends on T022).
- [ ] T028 [US4] Register `fdb-knowledge` and `agent-builder` in `panel-registry.ts` as rendering
  the two new components (no count, per FR-013) (depends on T001, T026, T027).

**Checkpoint**: quickstart.md Stories 4 and 5 pass in full — both placeholders show the honest
empty state with the switch off, make no network call, and show clearly labelled sample content
with it on; the switch persists across a restart.

---

## Slice 4 / Phase 4: Non-drag resize and full verification (User Story 6, Polish)

**Purpose**: the WCAG 2.5.7 alternative, then the cross-slice gate and live verification the
assignment requires before a PR is called ready.

- [ ] T029 [US6] Wire `WidthPresetControl.tsx` (T007) into `RightPaneShell.tsx`'s header, calling
  the `ResizablePanel` ref's `.resize()` through the same ref `App.tsx` already holds (research.md
  decision 12, FR-025) (depends on T008, T009).
- [ ] T030 [P] Run `pnpm typecheck` and `pnpm build`; fix any error before proceeding.
- [ ] T031 [P] Run `pnpm check:ui-text` against the built bundle; fix any leaked spec term in the
  new Settings section or either placeholder.
- [ ] T032 [P] Run `pnpm check:theme-contrast`; confirm no new `token missing` row (research.md
  decision 13 — no new token expected).
- [ ] T033 [P] Run `pnpm check:drag-regions` if present on the implementation branch's base.
- [ ] T034 Full [quickstart.md](quickstart.md) pass in an isolated scratch Electron instance (own
  `--user-data-dir`): every story's numbered steps, at both 380px and 1280px window widths, with
  screenshots of the rail, the launcher, a two-tab bar, closing the last panel back to the
  launcher, both placeholders with the switch off and on, and the window-controls corner clear at
  both widths (depends on T009 through T028).
- [ ] T035 Update `docs/PLAN.md` row C1 only: status, branch, PR number (minimal diff, this
  story's own row) (depends on T034 passing).

**Checkpoint**: every quickstart.md story passes at both widths; the four gate commands above
exit 0; `docs/PLAN.md` row C1 reflects the real PR.

---

## Dependency summary

- Slice 1 (T001-T010) blocks every later task.
- Slice 2 (T011-T016) depends on Slice 1 only; independent of Slice 3's files.
- Slice 3 (T017-T028) depends on Slice 1 only (specifically T001/T002 for the registry/store
  shapes); independent of Slice 2's files — the two slices can run in parallel once Slice 1 lands.
- Slice 4 (T029-T035) depends on Slice 1 for T029, and on every prior slice for T034-T035 (full
  verification needs every panel registered).

## Parallel example

Once Slice 1 lands, Slice 2 and Slice 3 touch disjoint files (`subagent-store.ts`/
`SubagentPanel.tsx`/`ReadoutChips.tsx` versus `src/shared/model.ts`/`ipc.ts`/
`settings-store.ts`/`view-store.ts`/`SettingsScreen.tsx`/the two new placeholder files) and can be
built by two parallel subagents, each finishing with their own slice's Checkpoint, before Slice 4
runs the combined gate.
