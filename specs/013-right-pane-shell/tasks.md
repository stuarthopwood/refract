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

- [x] T001 Create `src/renderer/features/right-pane/panel-registry.ts`: `HostedPanelDescriptor[]`
  and `PanelId` (data-model.md), with three entries (`subagents`, `fdb-knowledge`,
  `agent-builder`) and `getPanelCount(id, sessionId)` (research.md decision 8 for the icon
  choices: `BotIcon`, `LibraryIcon`, `HammerIcon`).
- [x] T002 Create `src/renderer/state/right-pane-store.ts`: `RightPaneState` (data-model.md) —
  `open`, `widthPx`, `openPanelIds`, `activePanelId`, `openPanel`, `closePanel`,
  `togglePanelFromRail`, `setWidth`, `syncRenderedState` (depends on T001 for `PanelId`).
- [x] T003 [P] Export the new store from `src/renderer/state/index.ts` (depends on T002).
- [x] T004 [P] Create `src/renderer/features/right-pane/IconRail.tsx`: one button per
  `HostedPanelDescriptor`, `aria-pressed` bound to `openPanelIds.includes(id)`, full icon-only
  bundle (Tooltip/aria-label/Kbd/24px target, FR-023, FR-026), `onClick` calls
  `togglePanelFromRail(id)` (depends on T001, T002).
- [x] T005 [P] Create `src/renderer/features/right-pane/PanelLauncher.tsx`: centred list of every
  `HostedPanelDescriptor`, each row a button with icon, name, and `getPanelCount` where non-null
  (FR-010, FR-012); activating a row calls `openPanel(id)` (depends on T001, T002).
- [x] T006 Create `src/renderer/features/right-pane/PanelTabBar.tsx`: ARIA tabs pattern over
  `openPanelIds` (arrow keys move focus, Delete closes the focused tab, each tab shows icon, name,
  live count, and its own close button), plus the single-panel title-row variant (FR-007, FR-008,
  FR-011's window-controls spacer) (depends on T001, T002).
- [x] T007 Create `src/renderer/features/right-pane/WidthPresetControl.tsx`: three buttons
  (Min/Default/Max — 240/320/520px) calling a passed-in `resize(px)` callback (FR-025; the shell
  wires this to the `ResizablePanel` ref in T009) (depends on T002).
- [x] T008 Create `src/renderer/features/right-pane/RightPaneShell.tsx`: renders `PanelTabBar`
  (0 open -> delegates header to `PanelLauncher` instead, 1 open -> title row, 2+ -> tabs) plus the
  active panel's content; mounts `IconRail` is NOT here (it sits beside the `ResizablePanelGroup`
  in `App.tsx`, not inside this pane's own content) (depends on T004, T005, T006, T007).
- [x] T009 Edit `App.tsx`: rename the `subagents` `ResizablePanel` to host `RightPaneShell`
  instead of the raw `SubagentPanel` conditional; generalise the existing `onResize` handler
  (lines 366-394 on `main` today) to read/write `right-pane-store.ts`'s `open`/`widthPx` via
  `syncRenderedState` instead of `useSubagentPanelStore.open` (research.md decision 2, FR-017);
  mount `IconRail` as a fixed sibling of the `ResizablePanelGroup`, always visible (FR-001);
  compute the right-most `ChatPane`'s `reservesWindowControls` prop as `!rightPaneOpen`
  (research.md decision 4, FR-011) (depends on T008).
- [x] T010 [P] Edit `ChatHeader.tsx`'s doc comment only (no behaviour change — its
  `reservesWindowControls` prop already does the right thing once T009 passes the right value; the
  comment at lines 8-11 currently describes split-only reasoning and should name the right-pane
  case too) (depends on T009).

**Checkpoint**: with no panel registered as hosting real content yet (T011+ not done), the rail
shows three icons, clicking one opens the pane and shows an empty `RightPaneShell` title row with
no crash; dragging the handle still collapses/reopens it; the window-controls corner is reserved
by the pane header while open and by `ChatHeader` while closed. Run quickstart.md Story 1 steps
1-2 and 8 only (full Story 1 needs T011 below for a second panel to open).

**Deviations from this phase's description, found during gate remediation**: T001's registry
(`panel-registry.ts`) lists only the `subagents` entry this slice -- `fdb-knowledge`/
`agent-builder` are appended once their own components exist (PR2/T028), so the rail/launcher
never show an entry with no content behind it; the `PanelId` type still names all three. T002's
`togglePanelFromRail` lives in `features/right-pane/hosted-panel-actions.ts` (`toggleHostedPanel
FromRail`), not on the store itself, because opening/closing a panel also needs that panel's own
binding/cleanup (`subagent-store.ts`), which the store deliberately never imports (research.md
decision 3); `getPanelCount` is the reactive hook `usePanelCount` in `panel-registry.ts`, not a
bare function, since rail/tab/launcher counts must re-render live.

---

## Slice 2 / Phase 2: Launcher and tabs, Subagents hosted (User Stories 1, 2, 3)

**Purpose**: wire the Subagents panel in as the shell's first real hosted panel, retarget its
existing chip, and this makes User Stories 1 and 2 fully exercisable (two real panels to open).

- [x] T011 [US3] Edit `subagent-store.ts`: keep every existing action
  (`selectSubagent`/`applyPatch`/`reset`/`resetForNewTurn`) unchanged; repurpose `openPanel`/
  `closePanel` to be called BY the shell (via `right-pane-store.ts`'s `openPanel('subagents')`/
  `closePanel('subagents')`) rather than toggling their own `open` boolean as the source of truth
  — `sessionId` stays the field that says "which Session this panel's content is bound to"
  (research.md decision 3, FR-015). Gate remediation added `suspend()`/`resume()`: dragging the
  pane fully shut keeps the panel open and bound (FR-003), pausing only the live stream.
- [x] T012 [US3] Edit `SubagentPanel.tsx`: remove its own `h-10` title-row/Close-button header
  (lines 55-66 on `main` today); the shell's `PanelTabBar`/title row now owns that chrome
  (research.md decision 5); keep the subagent list and stream content exactly unchanged (depends
  on T011).
- [x] T013 [US3] Edit `ReadoutChips.tsx`'s `SubagentsChip`: `onActivate` calls
  `openHostedPanel('subagents', sessionId)` (`features/right-pane/hosted-panel-actions.ts`), which
  opens the pane via `right-pane-store.ts` and binds the Session via `subagent-store.ts`'s
  existing `openPanel`, instead of `useSubagentPanelStore.openPanel(sessionId)` directly (FR-016)
  (depends on T011).
- [x] T014 [US1] Register `subagents` in `panel-registry.ts` as rendering `SubagentPanel` (depends
  on T001, T012).
- [x] T015 [US2] Verify the launcher (T005) shows the Subagents count (FR-013) correctly sourced
  from `readout-store.ts`'s `bySession[frontSessionId].readout.subagentCount.running` via
  `usePanelCount` (depends on T001, T014).
- [x] T016 [US3] Re-verify `App.tsx`'s generalised `onResize` guard (T009) against every one of
  spec 004's own collapse-desync edge cases (drag-to-collapse while open, drag-to-open with no
  `frontSessionId`, drag-to-open with a focused Session) using the Subagents panel specifically,
  since it is the one hosted panel with real session-binding state to desync (depends on T009,
  T011). Round 2 gate remediation revised the ruling: collapsing keeps every open panel bound
  (FR-003), and a second round fixed the store's `open` flag surviving a non-chat view switch
  too; dragging open with no open panels shows the launcher (FR-009), never a forced default
  panel, whether or not a Session is focused.

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
- [~] T026 [P] [US4] Create `src/renderer/features/right-pane/placeholders/FdbKnowledgePanel.tsx`:
  reads `Settings.showSampleData`; `false` -> the three-part empty state (icon, one line, next
  action — FR-018); `true` -> sample search/ask/agent-tools content, each element carrying a
  visible "Sample data" label (FR-021) (depends on T022). **Empty-state branch only this PR; the
  sample branch (`Settings.showSampleData`, FR-021) is PR3 (T017-T025).**
- [~] T027 [P] [US4] Create
  `src/renderer/features/right-pane/placeholders/AgentBuilderPanel.tsx`: same two-state shape,
  naming Agent Builder and its own sample cloud-agent content (depends on T022). **Empty-state
  branch only this PR, same split as T026.**
- [x] T028 [US4] Register `fdb-knowledge` and `agent-builder` in `panel-registry.ts` as rendering
  the two new components (no count, per FR-013) (depends on T001, T026, T027). **Prerequisite
  carried from PR1's gate (deferred, not optional)**: once this task makes `openPanelIds.length
  >= 2` reachable for the first time, `PanelTabBar.tsx`'s tab bar must be restructured so each
  tab's close button sits fully outside `role="tablist"`'s own DOM subtree (today it is a DOM
  sibling of the `role=tab` button inside a shared, non-semantic wrapper `<span>` -- harmless in
  practice per the pattern the W3C ARIA working group tested, w3c/aria#2322, but still flagged by
  axe-core's static `aria-required-children` rule) -- needs per-tab width measurement
  (`ResizeObserver`) to keep a detached close button visually aligned, and **must be verified
  against a real screen reader now that the tab bar is reachable, not only against axe (this check
  is NOT done -- open on issue #650, same as PR1's own backlog there)**.

**Deviations from this phase's description, found while implementing PR2** (T017-T025 are NOT
done in PR2 -- Stuart's own PR2/PR3 split, posted as a decision comment on issue://538 before
implementation started): T026/T027 do not read `Settings.showSampleData` yet, since that field
does not exist until T017-T022 land (PR3) -- both placeholders always render the honest
empty-state branch only, unconditionally; the sample-content branch and its "Sample data" label
(FR-021) are PR3's work, not built here. T028's carried prerequisite is done EXCEPT the real
screen-reader verification its own text requires (round-1 gate finding, High: the first push of
this PR marked it "done in full", which overclaimed that specific check -- corrected here):
`PanelTabBar.tsx`'s tablist now contains only `role=tab` buttons; every close button is a DOM
sibling in a separate overlay, positioned per tab via each tab button's own measured
`offsetLeft`/`offsetWidth`/`offsetTop`/`offsetHeight`, recomputed by a `ResizeObserver` watching
every tab button (a live count changing a tab's own width shifts every later tab too) and on
`openPanelIds` changes -- **verified by direct DOM query (the tablist's own children are only
`role=tab`), not by running axe, and not against a real screen reader**. `IconRail.tsx` also
gained roving-tabindex arrow-key navigation (ArrowUp/ArrowDown/Home/End) now that it has three
buttons instead of one -- not called out as its own task, but the conventional ARIA toolbar
pattern this phase's second real panel needs (there was nothing to rove between with only
`subagents` registered).

**Round-1 gate remediation (High, all three functional reviewers converged)**: the tab strip
overflowed the pane's own width at its 320px default and its 240px minimum (every tab was
`shrink-0`, and the window-controls spacer reserved the rail's own 40px a second time) -- fixed by
letting tabs shrink and truncate their label (`min-w-0 shrink` plus a truncating `<span>`), by
subtracting the rail's width from the spacer, and by scrolling the active tab into view
defensively. Focus rings on tabs and close buttons were clipped by the scrolling wrapper's own
28px height (an outset `outline-offset-2` drew outside it) -- fixed by insetting the ring
(`outline-offset-[-2px]`), matching `RightPaneShell.tsx`'s own content-focus convention. Closing a
tab could leave keyboard focus on a tab OTHER than the one the store made active once three panels
existed (`closeTab` computed its own neighbour index independently of `right-pane-store.ts`'s own
choice, which activated the LAST remaining tab, not the neighbour) -- fixed in both places: the
store's own `closePanel` now activates the neighbour (see the state table below), and `closeTab`
reads that choice back from the store instead of recomputing it, with `closeHostedPanel`'s own
rail/chip fallback suppressed (`skipFocusFallback`) whenever another panel remains so the two
focus-restoration paths can't race.

**Round-2 gate remediation (High, Code2 and Verif2 converged; A11y2 PASSed with the same finding
at Medium)**: round 1's `min-w-0 shrink` let a tab's own measured box (used to position its close
button) shrink below content that does not shrink -- the icon, and the close button's own reserved
space -- so at narrow widths with three panels open the close button landed ON TOP OF the icon:
clicking a tab's icon closed it instead of selecting it (WCAG 2.5.8), and at the pane's 320px
default with three panels every tab's label clipped to near nothing with no Tooltip to recover the
name (FR-026). **Replaced round 1's shrink/truncate approach entirely**, rather than patching it
further: every tab EXCEPT the active one is now a fixed 28px icon-only square (`w-7 shrink-0`, no
close button ever drawn on it, `aria-label` carrying its full name and count, and its own Tooltip
-- the FR-026 icon-only bundle); only the ACTIVE tab shows its icon, a truncating label, a
truncating count, and the one close button this bar ever renders at a time, with a `min-w-14`
(56px) floor sized around the icon plus the close button's own reserved space specifically, never
the label (which may truncate to nothing at that exact floor -- the active state is already marked
by more than its label, via the underline and surface change, and its close button carries its own
Tooltip with the full name). This needs no width-measurement or compact/non-compact toggle at all:
the floor is a fixed minimum regardless of pane width, proven to fit at every supported pane width
with up to three panels open, including one showing a live count, by the geometry table below --
`overflow-x-auto` on the wrapper stays only as a safety net for a future fourth panel, not because
this spec's own three ever need it. Closing an inactive tab from the pointer is therefore
select-then-close (click selects it, revealing its close button); Delete on a focused inactive tab
still closes it directly (`handleTabKeyDown` reads the keystroke from the tab button itself, never
from the close overlay) -- unchanged from round 1, re-verified this round.

Also this round: `scrollIntoView` (round 1) scrolled every scrollable ancestor needed to bring the
active tab into view, including `RightPaneShell`'s own `overflow-hidden` region and the
`ResizablePanel` itself, both still technically "scrollable containers" to the browser even though
neither is meant to scroll -- replaced with a manual `scrollLeft` adjustment on the tab strip's own
wrapper ref only, and the effect now returns early while the pane is collapsed. `closeTab`'s dead
`remainingCount === 0` branch (round 1: this function only ever runs from the tab-bar render
branch, which never renders with fewer than two open panels, so closing one here always leaves at
least one behind) is deleted. The `[data-panel-close]` focus query is now scoped to this
component's own wrapper ref, not the whole document (Sec2, Low). The `hosted-panel-actions.ts`
comment describing the round-1 focus race was corrected: the Subagents chip's own restore runs
SYNCHRONOUSLY inside `closePanel`, not via a `requestAnimationFrame` the way the rail fallback
does -- it was the chip restore firing before `closeTab`'s own deferred focus call that caused the
flash, not a race between two `requestAnimationFrame` callbacks as the round-1 comment claimed.

Two honesty corrections, both found by Verif2 hash-checking the evidence instead of trusting the
round-1 PR body's own claims: `refract-live-check-538-pr2/07-fdb-knowledge-empty-state.png` was
still byte-identical to `03-launcher.png` (sha256 `66da9e86…eddd`) despite the round-1 PR body
saying it had been "retaken" -- it had not; a genuine new screenshot showing FDB Knowledge open
alone is captured this round and the stale file is deleted by literal path so it cannot be cited
again. `06-after-drag-to-240.png` showed a pane of about 312px, not 240 (only `06b`, the
keyboard-driven resize, actually reached the floor) -- the stale `06` is deleted by literal path
too, and the PR body's wording is aligned with `06b`'s own keyboard-driven method throughout
(round 1's text inconsistently said "dragging" in one place and "keyboard-driven" in another).

### Tab-strip width geometry (gate remediation, PR2 round 2)

Proves the round-2 redesign fits at every pane width this spec supports (240px floor, 320px
default, 520px maximum) with one, two or three panels open, including one showing a live count --
**no scrollbar is needed at any of these**, so `overflow-x-auto` on the wrapper is a pure safety
net, never actually exercised by this spec's own panel set. Available width is the pane's own
`widthPx` minus the outer row's `px-2` (16px) minus its `gap-1` to the window-controls spacer (4px)
minus the spacer itself (`max(0px, calc(100vw - env(titlebar-area-width, 100vw) - 2.5rem))`,
measured live at a stable ~98px on this machine's caption-button cluster regardless of pane width,
since it is a window-relative, not pane-relative, calculation) -- `available(widthPx) = widthPx -
118`, confirmed against the live-measured `clientWidth` values below. Required (compact mode, N
open tabs) = `(N - 1) * 28` (inactive icon squares) `+ 56` (the active tab's floor) `+ (N - 1) * 4`
(the `gap-1` between every pair of tabs) -- independent of which specific panels are open or
whether the active one is showing a count, since the count only ever takes space ABOVE the 56px
floor, never below it (it uses `min-w-0 truncate`, so it shrinks to nothing before anything else
breaks).

| Pane width | `available(widthPx)` (measured) | N=1 | N=2 required | N=2 fits? | N=3 required | N=3 fits? |
|---|---|---|---|---|---|---|
| 240 (floor) | 122-123 | n/a (single title row, no tab bar) | 88 | yes | 120 | yes |
| 320 (default) | ~202 | n/a | 88 | yes | 120 | yes |
| 520 (maximum) | ~402 | n/a | 88 | yes | 120 | yes |

N=1 never reaches this code at all (`openPanelIds.length === 1` renders the single title row
branch above, not a tab bar). At every width this spec supports, required stays far below
available even at the 240px floor with three panels and a live count on the active tab --
confirmed live this round (see the live-check section below), not just by this table's own
arithmetic.

**Checkpoint**: quickstart.md Story 4 steps 2 and 3 pass (both placeholders' empty states, live
and screenshotted) — step 1 (confirming the Settings switch is off by default) cannot run, since
the switch does not exist yet (PR3); step 4 (DevTools Network tab, no request from either
placeholder) was verified by reading the components' source (both are static JSX with no hook, no
effect, no call of any kind), not by an actual live Network-tab check. Story 5 (the Settings switch
and sample content) is out of scope for this checkpoint — PR3 builds T017-T025 and re-runs
quickstart.md Story 5 against them. The now-three-panel rail/launcher/tab-bar paths from Slice 1/2
pass with a real second and third panel exercising them for the first time, including round 1's
focus/selection fixes and round 2's icon/close-button-overlap and tab-strip overflow fixes above
-- the tab strip now genuinely meets SC-007 (no horizontal scrollbar) at every pane width this
spec supports, with up to three panels open, proven by the geometry table above and confirmed live.

### Right-pane store `closePanel` active-tab transitions (gate remediation, PR2 round 1)

Round 1's High finding: `closePanel` activated the LAST remaining tab unconditionally, which
desynced from `PanelTabBar.tsx`'s own (separately computed) focus target once three panels
existed. Fixed: `closePanel` now activates the NEIGHBOUR at the closed tab's own index, clamped to
the new last index -- the standard tabs-pattern rule ("select the tab now in the closed tab's old
seat"), traced here cell by cell against the final code (`right-pane-store.ts`'s `closePanel`).

| Event (`openPanelIds` before, closed id, `activePanelId` before) | `openPanelIds` after | `activePanelId` after | Why |
|---|---|---|---|
| `[A]`, close A, active A (the only panel) | `[]` | `null` | `nextIds.length === 0` |
| `[A, B]`, close A, active A (closing the active FIRST of two) | `[B]` | `B` | `index=0`, `min(0, 0)=0` -> `nextIds[0]` |
| `[A, B]`, close B, active B (closing the active LAST of two) | `[A]` | `A` | `index=1`, `min(1, 0)=0` -> `nextIds[0]` |
| `[A, B, C]`, close A, active A (closing the active FIRST of three) | `[B, C]` | `B` | `index=0`, `min(0, 1)=0` -> `nextIds[0]` (the tab that slides into A's old seat) |
| `[A, B, C]`, close B, active B (closing the active MIDDLE of three) | `[A, C]` | `C` | `index=1`, `min(1, 1)=1` -> `nextIds[1]` |
| `[A, B, C]`, close C, active C (closing the active LAST of three) | `[A, B]` | `B` | `index=2`, `min(2, 1)=1` -> `nextIds[1]` (the new last tab) |
| `[A, B, C]`, close A, active B (closing an INACTIVE tab) | `[B, C]` | `B` (unchanged) | `activePanelId !== id` -> the ternary's else branch, never recomputed |
| `[A, B, C]`, close C, active A (closing an INACTIVE tab at the end) | `[A, B]` | `A` (unchanged) | same as above |

`PanelTabBar.tsx`'s `closeTab` reads this same `activePanelId` back from the store after calling
`closeHostedPanel` (a synchronous zustand `set()`, so the new value is already committed by the
time `closeTab` reads it) and focuses that tab's own ref -- never a separately computed index, so
the two can no longer disagree. When exactly one panel remains, the tablist itself unmounts into
the single-panel title row; `closeTab` focuses that row's `[data-panel-close]` button instead
(there is no tab ref left to focus). When none remain, `closeHostedPanel`'s own existing rail/chip/
launcher fallback (unchanged, FR-024) runs as before.

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

## Subagents stream state table (gate remediation, rounds 4–5)

Four gate rounds each found a new hole in the Subagents panel's suspend/resume state machine
(round 3: a dead stream after a Settings round trip; round 4: a dead stream reopening through the
rail after a drag-collapse). Round 5 traced this table cell by cell against the code and found it
still undercounted `fetchSeq` on two round-trip rows (each is a `suspend()` **and** a `resume()`,
not one call), was missing the collapsed-pane and remount-while-collapsed cases entirely, and
overstated the launcher as reachable while the pane is collapsed (`RightPaneShell` is `inert` then,
so only the rail and the Subagents chip — not the launcher — can reopen it). This revision is
verified against the code as it stands after round 4's fixes (`openPanel`'s same-Session branch no
longer touches `suspended`; `fetchSeq` only bumps on a real rebind; the `App.tsx` mount branch is
gated on size, view AND the store's own `open` flag) with no further source changes.

| Event | `suspended` after | `streams` after | `selectedId` after | main's `setVisibleSubagent` | `fetchSeq` |
|---|---|---|---|---|---|
| Open panel, Session S, no prior binding | `false` (if `suspended` was already stale-`true` with no session bound, `openPanel`'s same-ish branch here does not clear it directly — harmless: the next expand's `resume()` clears it, with `selectedId` still `null`, so there is nothing to re-fetch) | `{}` | `null` | not called yet | unchanged |
| Select subagent A (first time) | `false` | `{A: [...]}` | `'A'` | `(S, A)` | unchanged |
| Drag-collapse (A selected, streaming) | `true` | `{}` (cleared) | `'A'` (kept) | `(S, null)` | **+1** |
| Drag-expand (same mount) | `false` | `{A: [...]}` (refetched) | `'A'` | `(S, A)` restored | **+1** (from `resume()`) |
| Reopen via rail/chip after a drag-collapse (same Session; the launcher is `inert` while collapsed and cannot be the one reopening it) | `false` | `{A: [...]}` (refetched) | `'A'` | `(S, A)` restored | **+1** (from `resume()`, NOT from `openPanel`) |
| chat → Pull requests → chat (one mount, programmatic collapse/expand) | `false` | `{A: [...]}` (refetched) | `'A'` | `(S, A)` restored | **+2** (`suspend()` leaving chat, `resume()` returning to it) |
| chat → Pull requests → Settings/Manage sessions → chat (remount, was suspended) | `false` | `{A: [...]}` (refetched) | `'A'` | `(S, A)` restored | **+2** (`suspend()` on the chat → Pull requests leg; the Settings → chat remount's mount branch calling `resume()`; no further event fires across the Pull requests → Settings leg itself, since the whole `ResizablePanelGroup` unmounts) |
| chat → Settings/Manage sessions → chat directly (remount, never suspended) | `false` (unchanged) | `{A: [...+ any live patches]}` (never interrupted) | `'A'` | `(S, A)` (never stopped) | unchanged (`resume()` no-ops) |
| Remount of a drag-collapsed pane (chat → Settings/Manage sessions → chat, pane left collapsed, `open: false`) | `true` (unchanged, already true) | `{}` (cleared again) | `'A'` (kept) | `(S, null)` (fired again, redundant but harmless) | **+1** (the mount branch's `resume()` is skipped since `paneStore.open` is `false`; the Panel still mounts at its non-zero `defaultSize` regardless, so the layout effect's own `handle.collapse()` fires a genuine second collapse transition on this remount, calling `suspend()` again) |
| Rebind: open panel for a different Session T | `false` | `{}` | `null` | `(S, null)` then none for T until selected | **+1** |
| New turn while collapsed (pane drag-collapsed, bound Session's turn restarts; `openPanelIds` still includes `'subagents'` — collapsing never removes it) | `false` (forced by the `closePanel` branch below, overwriting the suspended-`true` it had) | `{}` | `null` (this is a full `closePanel`, not a selection reset: `sessionId` clears too, and `'subagents'` is removed from `openPanelIds` — reopening afterward lands on the **launcher**, not the Subagents panel) | `(S, null)` (redundant with `suspend()`'s earlier call) | **+1** (via `resetForNewTurn`'s `closePanel` branch) |
| New turn, no subagents, panel open (same `closePanel` branch as above — `resetForNewTurn` only checks `openPanelIds`, never the pane's collapsed/expanded state) | `false` | `{}` | `null` (`sessionId` also clears; `'subagents'` is removed from `openPanelIds`, so the next view shows the launcher, not a reset Subagents panel) | `(S, null)` | **+1** |
| New turn, no subagents, panel not open (not in `openPanelIds`) | `false` | `{}` | `null` | unchanged | **+1** |
| Archive/delete the bound Session | `false` | `{}` | `null` (unbound) | `(S, null)` | **+1** |
| Explicit Close (title row/tab) | `false` | `{}` | `null` (unbound) | `(S, null)` | **+1** |
| Reset (Session switch/recover, different Session) | `false` | `{}` | `null` (unbound) | `(S, null)` | **+1** |

Not covered above because the resize handle is `disabled` outside the chat view (no drag is
possible there): a manual drag while Pull requests or Settings/Manage sessions is showing.
