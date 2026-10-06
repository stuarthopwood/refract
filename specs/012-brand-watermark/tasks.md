# Tasks: Brand watermark

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Prerequisites**: spec 001's core session workspace, spec 004's Settings screen, spec 005's split
chat pane, and spec 007's app themes already built on `main` in this checkout. The brand-asset
prerequisite (branch `brand-icon-v2`, `src/renderer/assets/brand/refract-hero.svg`) must be merged
before Phase 3. Windows 11 only.

**Tests**: none. Refract is a prototype (constitution, Development Workflow). Each phase ends with
a **Checkpoint** that runs the matching [quickstart.md](quickstart.md) section by hand, on the
built app. `pnpm typecheck` and `pnpm build` MUST pass before a change lands on `main`.

**Organization**: tasks are grouped by user story so each story can be built and checked on its
own. Paths are relative to the repository root. Task IDs in this file (`T001` onward) are local to
spec 012; they are unrelated to any other spec's own `T001`.

**GitHub issues**: every task below has an issue titled `012-Tnnn: ...`; issue numbers are recorded
on each task line as `(#NNN)` once created, and the full mapping is posted as a comment on the
tracking issue and kept here.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: the user story from [spec.md](spec.md) (US1 to US4). Setup, Foundational, and
  Polish tasks carry no story label.
- Tasks that edit the same file are never both marked [P].

---

## Phase 1: Setup and dependency check

**Purpose**: confirm the one external dependency this spec does not build itself.

- [X] T001 Confirm the prerequisite brand-asset change (branch `brand-icon-v2`) is merged into
  `main` and `src/renderer/assets/brand/refract-hero.svg` exists at the path and square viewBox
  (`"96 122 320 320"`) described in spec.md's "Prerequisite" section. If it has not landed yet,
  treat every later task that references that path as blocked and coordinate rather than
  recreating or duplicating the asset. (#408)

**Checkpoint**: the asset exists at the documented path; every later task may proceed.

---

## Phase 2: Foundational (blocks every user story)

**Purpose**: the one new setting, its IPC round trip, and the renderer store action every story
builds on.

- [X] T002 [P] Extend `src/shared/model.ts`'s `Settings` interface with
  `watermarkEnabled: boolean` (data-model.md). (depends on T001 only in that the feature exists;
  no file dependency) (#409)
- [X] T003 Extend `src/shared/ipc.ts`: add `IPC_REQUESTS.SETTINGS_SET_WATERMARK_ENABLED =
  'settings.setWatermarkEnabled'` and `RefractApi.settings.setWatermarkEnabled(enabled: boolean):
  Promise<Result<Settings>>`, per contracts/ipc.md (depends on T002). (#410)
- [X] T004 Extend `src/main/store/settings.ts`: `readJsonFile`'s default row gains
  `watermarkEnabled: true`; `SettingsStore.open` treats a missing or non-boolean stored
  `watermarkEnabled` as `true` in memory (same lazy-correction pattern as `theme`/`split`,
  data-model.md); add `setWatermarkEnabled(enabled: boolean): Promise<Settings>` persisting the
  whole row via the existing `persistWhole` helper, same race-safety contract as
  `setReadoutVisibility` (depends on T002). (#411)
- [X] T005 Extend `src/main/ipc/settings.ts`: `registerSettings` gains an
  `ipcMain.handle(IPC_REQUESTS.SETTINGS_SET_WATERMARK_ENABLED, ...)` handler validating the
  argument is a boolean (`invalid-argument` otherwise), calling `manager.settings
  .setWatermarkEnabled`, and broadcasting `settings:changed` (depends on T003, T004). (#412)
- [X] T006 Extend `src/preload/index.ts`: expose `settings.setWatermarkEnabled` alongside the
  existing `settings.*` methods (depends on T003, T005). (#413)
- [X] T007 Extend `src/renderer/state/settings-store.ts`: `DEFAULT_SETTINGS.watermarkEnabled =
  true`; add a `setWatermarkEnabled(enabled: boolean): Promise<void>` action calling
  `window.refract.settings.setWatermarkEnabled`, mirroring `setReadoutVisibility`'s body exactly
  (depends on T006). (#414)

**Checkpoint**: `pnpm typecheck` and `pnpm build` pass; `settings.get()` returns
`watermarkEnabled: true` on a fresh profile; a hand-edited missing or non-boolean value falls back
to `true` on the next launch (quickstart.md Story 2, checks 5-6).

---

## Phase 3: User Story 1 - Sees Refract's own mark quietly anchored in the workspace (Priority: P1)

**Goal**: a faint, single-colour, correctly anchored, non-duplicating mark shows by default in the
chat area.

**Independent test**: [quickstart.md](quickstart.md) Story 1.

- [X] T008 [US1] Add to `src/renderer/styles/globals.css`: `--watermark-opacity: 0.06;` in `:root`
  (research.md decision 5, documented ceiling `0.12`); a `.watermark-mark` rule (`mask-image:
  url(...refract-hero.svg); mask-size: contain; mask-repeat: no-repeat; mask-position: center;
  background-color: var(--muted-foreground); opacity: var(--watermark-opacity)`, research.md
  decision 4); the "live" variant's sizing/offset (`width: clamp(96px, 20cqw, 280px); aspect-
  ratio: 1; position: absolute; right: 1.5rem; bottom: 1.5rem`, research.md decisions 5-7); and
  `@media (forced-colors: active), (prefers-reduced-transparency: reduce) { .watermark-mark {
  display: none; } }` (research.md decision 11, both media features confirmed real at this app's
  pinned Electron/Chromium) (depends on T001 for the real asset path). (#415)
- [X] T009 [US1] Write `src/renderer/features/chat/BrandWatermark.tsx`: reads
  `useSettingsStore((s) => s.settings.watermarkEnabled)`, renders `null` when `false`; otherwise an
  `aria-hidden` `div` with `pointer-events-none` and the `.watermark-mark` class, sized per
  `variant: 'live' | 'preview'` (data-model.md) — `'live'` gets the responsive clamp from T008 and
  is mounted inside whichever of ChatPane.tsx's eligible render branches is active (T010),
  `'preview'` gets a fixed ~96px box with no corner-anchor positioning, meant to sit inline inside
  a bordered preview container (depends on T007, T008). (#416)
- [X] T010 [US1] Edit `src/renderer/features/chat/ChatPane.tsx`: add a new `showWatermark?:
  boolean` prop (data-model.md); add `relative` and `[container-type:size]` to the existing
  transcript container's class string (`<div className="min-h-0 flex-1 overflow-hidden">`, no new
  wrapper div) and mount `<BrandWatermark variant="live" />` as its first child when
  `showWatermark` is true; also mount it in the component's own `!session` `<Empty>` fallback
  branch under the same prop (research.md decisions 1, 3, 8). Edit `src/renderer/App.tsx`: pass
  `showWatermark` to exactly one rendered `ChatPane` — the single pane shown when there is one, or
  `paneB` (index 1, the right pane) of a true two-pane split, never `paneA` — and mount
  `<BrandWatermark variant="live" />` (with its own small `relative` wrapper) inside the
  `paneSessionIds.length === 0` div (research.md decision 3) (depends on T009). (#417)
- [ ] T011 [US1] Verify live per quickstart.md Story 1: default-on mark anchored to the reading
  area's corner, directly above the composer, never covered by it even as the message box grows to
  its ~8-line maximum; visible in the "Select a Session" empty state; scales on resize with no
  layout shift; exactly one instance, in the right pane's reading area, with a split chat pane
  open; unaffected by the Subagent panel or session list (depends on T010). (#418)

**Checkpoint**: quickstart.md Story 1 passes in full.

---

## Phase 4: User Story 2 - Turns the watermark off, or back on, in Settings (Priority: P1)

**Goal**: a switch in the Appearance section toggles the mark live, persists it, and previews it
without leaving Settings.

**Independent test**: [quickstart.md](quickstart.md) Story 2.

- [X] T012 [US2] Edit `src/renderer/features/settings/AppearanceSection.tsx`: below the existing
  theme picker's Save/Cancel row, add an `<hr className="my-6 border-border" />` divider followed
  by a visually separated sub-section with a `Switch` labelled "Background watermark" + one-line,
  jargon-free description, matching `SettingsScreen.tsx`'s Session readout toggle layout, wired to
  `useSettingsStore`'s `watermarkEnabled`/`setWatermarkEnabled`; beside it, a small bordered box
  containing `<BrandWatermark variant="preview" />`, shown or hidden by the same state (research.md
  decisions 9, 14) (depends on T007, T009). (#419)
- [ ] T013 [US2] Verify live per quickstart.md Story 2: the divider visually separates the switch
  from the theme picker's Save/Cancel row; the switch reflects and changes `watermarkEnabled` live
  with no restart; the preview updates immediately; the real mark in the chat area updates
  immediately; the choice survives a full restart; a missing or non-boolean stored value falls
  back to on (depends on T012, T004). (#420)

**Checkpoint**: quickstart.md Story 2 passes in full.

---

## Phase 5: User Story 3 - The mark never interferes with reading, clicking, or selecting (Priority: P2)

**Goal**: the mark is provably inert — no pointer interception, no Tab stop, no assistive-
technology announcement, hidden under Windows High Contrast, and never drops any themed surface
below WCAG 2.2 AA.

**Independent test**: [quickstart.md](quickstart.md) Story 3.

- [X] T014 [US3] Audit (and fix if needed) `BrandWatermark.tsx`/`globals.css`: confirm
  `pointer-events: none` and `aria-hidden` are present and effective (no native interactive
  element, no implicit ARIA role, no `tabindex`); confirm the combined `forced-colors: active`/
  `prefers-reduced-transparency: reduce` rule actually suppresses it; extend
  `scripts/check-theme-contrast.mjs` to include the mark's worst-case composited pair (the mark's
  silhouette colour at `--watermark-opacity` over `--background`, re-checking the muted-foreground/
  chat-foreground text pairs against it, per theme) for every built-in theme preset, confirming the
  numbers match research.md decision 13's own computed table (depends on T008, T010). (#421)
- [ ] T015 [US3] Verify live per quickstart.md Story 3: drag-select transcript text that overlaps
  the mark; click directly on the mark's visual area in both the empty state and over real
  content; Tab through every chat-area control and confirm the mark is never a stop; browse with
  Narrator and confirm it is never announced; enable Windows High Contrast and confirm the mark is
  not shown regardless of the switch; turn off "Show transparency in Windows" and confirm the same;
  run the extended `check-theme-contrast.mjs` and confirm every built-in theme preset still passes
  (depends on T014). (#422)

**Checkpoint**: quickstart.md Story 3 passes in full, including the extended contrast script's
numbers.

---

## Phase 6: User Story 4 - The mark stays consistent as the layout changes (Priority: P3)

**Goal**: no duplication, no corner-jumping, no mid-resize artifact, across every combination of
session-list/Subagent-panel/split state, and consistently absent from every full-screen view.

**Independent test**: [quickstart.md](quickstart.md) Story 4.

- [ ] T016 [US4] Verify live per quickstart.md Story 4: drag the session-list/chat and
  chat/Subagent-panel dividers through their full range; open and close the Subagent panel and a
  split chat pane repeatedly; narrow the window to the 360px chat-area floor; confirm the mark is
  never shown on the Settings screen, the Readiness screen, or (once spec 008 builds it) the
  Manage sessions screen (depends on T010, T012). (#423)

**Checkpoint**: quickstart.md Story 4 passes in full.

---

## Phase 7: Polish and cross-cutting concerns

**Purpose**: documentation and a final full-spec verification pass.

- [X] T017 [P] Update `docs/DESIGN.md`: a new bullet under "Look and feel" describing the
  watermark (anchor, toggle, hidden on full-screen views), and a new line under "Settings in the
  first build" naming the switch (depends on T011, T013). (#424)
- [ ] T018 Run every check in [quickstart.md](quickstart.md), all four stories, on one clean build;
  confirm `pnpm typecheck` and `pnpm build` both pass (depends on T011, T013, T015, T016, T017). (#425)

**Checkpoint**: every quickstart.md check passes on a single clean build; typecheck and build are
green.

---

## Dependencies & execution order

- **Setup (Phase 1)**: no dependencies — blocks every later task that touches the asset path
  (T008, T009's import).
- **Foundational (Phase 2)**: depends only on Setup; blocks every user story (every story's tasks
  read or write `watermarkEnabled` through this phase's plumbing).
- **User Story 1 (Phase 3)**: depends on Foundational (T007) and Setup (T001); no dependency on
  Stories 2-4.
- **User Story 2 (Phase 4)**: depends on Foundational (T007) and User Story 1's component (T009),
  since it reuses `BrandWatermark` at `variant="preview"`.
- **User Story 3 (Phase 5)**: depends on User Story 1's rendered mark (T008, T010) to audit against.
- **User Story 4 (Phase 6)**: depends on User Story 1's mounted mark (T010) and User Story 2's
  control (T012), since its checks exercise toggling and layout together.
- **Polish (Phase 7)**: depends on every story's own checkpoint passing.

### Parallel opportunities

- T002 has no file dependency on anything upstream of it other than the feature existing.
- T017 (`docs/DESIGN.md`) can run in parallel with T014-T016 once T011/T013 are both done, since it
  touches a different file than any of them.
- Within Phase 2, T002 is the only task markable [P]; T003-T007 each depend on the task
  immediately before it and share a dependency chain through the same few files.

### MVP scope

Phase 1 + Phase 2 + Phase 3 (User Story 1) alone already delivers the visible feature Stuart asked
for (a faint, correctly anchored, non-duplicating mark). Phase 4 (User Story 2) adds the toggle his
request also explicitly named. Phases 5-6 harden and prove it; neither blocks shipping Phases 1-4
first if desired.

## Implementation evidence (parent, 2026-10-06, scratch profile, real CDP, Dark theme)

- T011 (partly verified, unchecked): default on; the mark shows in the "Select a Session" empty state and anchors to the chat reading area's bottom-right corner directly above the composer in a single pane (100px square at 1280px); with a two-pane split open there is exactly one `.watermark-mark`, at x=1155 in the right pane; `aria-hidden="true"`, `pointer-events: none`, opacity 0.06. NOT verified: the composer growing to its 8-line maximum, window resize scaling, the Subagent panel open.
- T013 (partly verified, unchecked): Settings > Appearance shows "Background watermark" with a switch and a bordered preview box with the mark; a real click turns the switch off, the live watermark count drops to 0, and the value persists across a page reload; turning it back on restores it. Default is on for a fresh profile. NOT verified: a hand-edited missing or non-boolean stored value falling back to on.
- Forced colors and `prefers-reduced-transparency: reduce` (emulated): the mark computes `display: none` in both.
- NOT verified: T015 (text selection and clicks through the mark; `pointer-events: none` is confirmed), T016 (drag-resize behaviours), T018 (the full quickstart pass), and the settings screen's dark high-contrast appearance.
