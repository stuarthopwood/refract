# Tasks: App themes

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Prerequisites**: spec 001's core session workspace already built (`src/shared`, `src/main`,
`src/preload`, `src/renderer` as in its plan.md). Windows 11 only.

**Tests**: none. Refract is a prototype (constitution, Development Workflow). Each phase ends with
a **Checkpoint** that runs the matching [quickstart.md](quickstart.md) section by hand, on the
built app, in an isolated instance. `pnpm typecheck` and `pnpm build` MUST pass before a change
lands on `main`.

**Organization**: tasks are grouped by user story so each story can be built and checked on its
own. Paths are relative to the repository root. Task IDs in this file (`T001` onward) are local to
spec 007; they are unrelated to spec 001's `T001`–`T101`.

**GitHub issues**: every task below has an issue titled `007-Tnnn: ...`; issue numbers are
recorded on each task line as `(#NNN)` once created, and the full mapping is posted as a comment
on tracking issue #125 and kept here.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: the user story from [spec.md](spec.md) (US1 to US4). Setup, Foundational, and
  Polish tasks carry no story label.
- Tasks that edit the same file are never both marked [P].

---

## Phase 1: Setup and gates

**Purpose**: settle the two facts the constitution (Principle IV) says must be verified before
the work that depends on them (research.md decisions 4, 9).

- [ ] T001 Gate: probe two Electron/Windows facts in `docs/spike/theme-probe.mjs`: (a) in a
  minimal Electron app's preload, time a synchronous `ipcRenderer.sendSync` round trip called
  before the renderer's first paint and confirm the window never shows an unstyled or
  default-classed frame first; (b) call `createHighlighter({ themes: ['github-dark-high-contrast'],
  langs: [], engine: createJavaScriptRegexEngine() })` at the pinned `shiki@4.4.3` and confirm it
  resolves with no error. Record both outcomes as one new numbered item in
  `docs/spike/FINDINGS.md`; if (b) comes back negative, replace research.md decision 9 with the
  working alternative before any later task that assumes it. (#163)

**Checkpoint**: `docs/spike/FINDINGS.md` has the new item; research.md decision 9 is confirmed or
corrected.

---

## Phase 2: Foundational (blocks every user story)

**Purpose**: the shared theme data, the extended `Settings` field, the new IPC surface, and the
renderer store every story builds on.

- [ ] T002 [P] Write `src/shared/themes.ts`: `ThemeId`, `ThemeDefinition` (`id`, `name`, `swatch`,
  `syntaxTheme`, `titleBarOverlay: { color, symbolColor }` — no `mode` field, since every built-in
  theme is dark-toned), and the `THEMES` table with at least two entries — `dark` and
  `dark-high-contrast` — per research.md decision 1 and data-model.md (depends on T001 for the
  confirmed `syntaxTheme` ids). (#164)
- [ ] T003 Extend `src/shared/model.ts`'s `Settings` interface with `theme: ThemeId`
  (default `'dark'`) and update `src/main/store/settings.ts`'s `readJsonFile` default to include
  it; treat a loaded value that is not a key of `THEMES` as `'dark'` for every read (FR-013,
  data-model.md) (depends on T002). (#166)
- [ ] T004 Extend `src/shared/ipc.ts`: add `IPC_REQUESTS.THEME_PREVIEW`/`THEME_SET`, the
  `theme: { preview(themeId: ThemeId | null): Promise<Result<void>>; set(themeId: ThemeId):
  Promise<Result<Settings>> }` shape on `RefractApi`, and the `invalid-theme` error code, per
  contracts/ipc.md (depends on T002, T003). (#167)
- [ ] T005 Write `src/main/ipc/theme.ts`: `registerTheme(manager, getWindow)` with handlers for
  `theme.preview` and `theme.set` (persist via `SettingsStore`, call
  `getWindow()?.setTitleBarOverlay(...)` guarded by a capability check so a pre-T100 build is a
  silent no-op, broadcast `settings:changed` on `set`, validate the id against `THEMES`
  returning `invalid-theme` otherwise); and one synchronous `ipcMain.on('theme:bootstrap', ...)`
  handler returning `{ theme }` read from the already-loaded `SettingsStore` (contracts/ipc.md
  "Bootstrap") (depends on T002, T003, T004). (#169)
- [ ] T006 Wire `src/main/index.ts` (call `registerTheme(...)` beside the existing
  `registerSettings(...)` call, at the same point in the startup sequence as
  `joinKillOnCloseJob()`/`reapStale()`) and `src/preload/index.ts` (expose `theme.preview`,
  `theme.set`, and a synchronous `themeBootstrap()` wrapper over
  `ipcRenderer.sendSync('theme:bootstrap')`) (depends on T004, T005). (#170)
- [ ] T007 Write `src/renderer/state/theme-store.ts` (zustand): state `{ theme, previewing }`
  seeded once from `window.refract.themeBootstrap()`, an `activeThemeId()` derivation
  (data-model.md), and actions `preview(id | null)` (updates `previewing` and calls
  `theme.preview`), `save(id)` (calls `theme.set`, updates `theme`, clears `previewing`),
  `cancelPreview()` (`preview(null)`) (depends on T006). (#173)
- [ ] T008 Replace `src/renderer/main.tsx`'s hardcoded
  `document.documentElement.classList.add('dark')` with the bootstrap-derived class
  (`theme-${activeThemeId(...)}`) set before `createRoot().render()`, and wrap `<App />` in
  `next-themes`'s `ThemeProvider` with `forcedTheme` hardcoded to `'dark'` (research.md decision
  11); in `src/renderer/styles/globals.css` rename the single `.dark` block to `.theme-dark`
  (`:root` keeps only truly theme-independent values, e.g. `--radius`, `--font-ui`, `--font-code`),
  and add an empty `.theme-high-contrast` block for T016 to fill in (depends on T002, T007). (#176)

**Checkpoint**: `pnpm typecheck` and `pnpm build` pass; a scratch run that hand-edits
`settings.json`'s `theme` field and relaunches shows the matching class with no flash.

---

## Phase 3: User Story 1 - Opens in a sensible default preset on first launch (Priority: P1)

**Goal**: a fresh install with no theme ever chosen opens in the default dark preset, and an
unrecognised saved value falls back to it rather than failing.

**Independent test**: [quickstart.md](quickstart.md) Story 1.

- [ ] T009 [US1] Confirm FR-001 (first launch opens the default preset) and FR-013 (an
  unrecognised saved value falls back to the default preset, T003) both hold from
  `theme-store.ts`'s derivation with no extra state; add any missing case directly to
  `theme-store.ts` and `src/main/ipc/theme.ts`'s bootstrap/get paths (depends on T003, T007). (#181)
- [ ] T010 [US1] Update the docs and verify live: `docs/DESIGN.md` "Look and feel" (replace any
  remaining light-theme or follow-system wording with the dark-only preset list), `CONTEXT.md` if
  it still mentions a light theme or a follow-system setting; then on the built app in an
  isolated instance (fresh `--user-data-dir`, no `settings.json`): confirm the fresh-install
  default preset, and the FR-013 fallback from a hand-edited unknown `theme` value, per
  quickstart.md Story 1 (depends on T008, T009). (#184)

**Checkpoint**: run quickstart Story 1.

---

## Phase 4: User Story 2 - Pick a theme in Settings with a live preview (Priority: P1)

**Goal**: an Appearance section in Settings (spec 004) lists every built-in dark preset with
swatches, repaints the whole app live as the developer chooses, and only Save makes a choice last.

**Independent test**: [quickstart.md](quickstart.md) Story 2.

- [ ] T011 [US2] Write `src/renderer/features/settings/ThemePicker.tsx`: a keyboard-operable list
  (shadcn `RadioGroup` or `Select`, matching the sibling `ui/` components' pattern) showing every
  built-in preset in `THEMES` declaration order, each with its `name` and a small swatch coloured
  from `ThemeDefinition.swatch`; the entry matching `theme-store.ts`'s current `theme` (or
  `previewing`, when set) is marked both in text and by colour; arrow keys move between entries
  with a visible focus indicator, and Enter/Space on a non-active entry calls `preview(id)` the
  same as a pointer choice (FR-001, FR-002, FR-006) (depends on T007). (#187)
- [ ] T012 [US2] Write `src/renderer/features/settings/AppearanceSection.tsx`: mounts
  `ThemePicker`, and Save/Cancel buttons (or reuses the Settings screen's existing Save/Cancel, if
  spec 004 built one) wired to `theme-store.ts`'s `save(id)`/`cancelPreview()`; also calls
  `cancelPreview()` from the Settings screen's Esc handler and from whatever unmount/navigate-away
  path spec 004's screen uses, so all three exits behave identically (FR-003 to FR-005) — mount
  this section inside spec 004's Settings screen once that screen exists; until then, build and
  verify it behind a temporary standalone route for this task's own checkpoint only, never left in
  the shipped navigation (depends on T007, T011). (#191)
- [ ] T013 [US2] Remove T012's temporary standalone route once spec 004's Settings screen exists
  and mount `AppearanceSection` inside it for real; then update the docs and verify live:
  `docs/DESIGN.md` (Appearance section, live preview rule), `quickstart.md` Story 2
  cross-reference in spec 004's own quickstart once that exists; then on the built app in an
  isolated instance, mounted inside spec 004's real Settings screen: every check in
  quickstart.md Story 2 (picker contents and marking, immediate whole-app repaint measured
  outside Settings, Cancel/Esc/navigate-away reverting identically, Save persisting across a
  restart, full keyboard operation) (depends on T012). (#195)

**Checkpoint**: run quickstart Story 2.

---

## Phase 5: User Story 3 - Everything follows the theme (Priority: P2)

**Goal**: every themed surface takes its colours from the active theme, every built-in theme
(including the high-contrast one) meets WCAG AA, and code/Mermaid colour sources follow it too.

**Independent test**: [quickstart.md](quickstart.md) Story 3.

- [ ] T014 [US3] Audit and fix any surface still reading a hard-coded colour instead of a theme
  token: the chat transcript and its tool rows, dialogs and menus, toasts, tooltips and hover
  cards, the chip row, selection and focus rings, and the Settings screen itself (FR-007)
  (depends on T008). (#198)
- [ ] T015 [US3] Fill in `.theme-high-contrast` in `src/renderer/styles/globals.css` with base,
  state-colour (working/idle/needs-you/stopped), border, focus-ring, and scrollbar-thumb/track/
  hover values distinct enough to meet WCAG AA (FR-008); confirm the four session states stay
  distinguishable by icon and text alone, not only colour, in this theme too (FR-009, FR-010)
  (depends on T008; introduces the scrollbar token names if spec 001 T088 has not landed them yet,
  per plan.md's build-order note). (#203)
- [ ] T016 [US3] Switch `src/renderer/features/chat/Markdown.tsx`'s `useIsDarkTheme` to a new
  `useActiveThemeId()` (reading `theme-store.ts`), extend `getHighlighter()`'s `themes` list to
  every `THEMES[*].syntaxTheme` id, and pick the Shiki theme per code block from the active theme
  id instead of the old binary `isDark` check; keep the existing plain-text fallback for a
  language Shiki has no grammar for (FR-015) (depends on T002, T007). (#207)
- [ ] T017 [US3] Add the Mermaid colour-mapping table (active `ThemeDefinition` → Mermaid
  `themeVariables`) alongside `src/shared/themes.ts`; wire it into `mermaid.initialize` only once
  spec 001 T066 lands Mermaid rendering — until then this task adds the mapping only, with a
  comment pointing at T066, and makes no change to a renderer that does not exist yet (FR-016,
  research.md decision 10). (#214)
- [ ] T018 [US3] Write `scripts/check-theme-contrast.mjs`: parse each theme's OKLCH token pairs
  straight out of `globals.css`, convert to sRGB and relative luminance, and assert the FR-008
  ratios (4.5:1 body text and state-colour pairs, 3:1 large text and non-text parts) for every
  built-in theme and every FR-007 surface; fix any failing pair directly in the token values
  (depends on T014, T015). (#220)
- [ ] T019 [US3] Update the docs and verify live: `docs/DESIGN.md` "Look and feel" (dark-only
  built-in themes, contrast note, syntax/Mermaid follow the theme), `quickstart.md` Story 3; then
  on the built app in an isolated instance, switch through every built-in dark preset and confirm
  every surface in T014/T015 repaints and stays readable, a fenced code block in an unmapped
  language still renders with no error, the four session states stay distinguishable in every
  theme, and `node scripts/check-theme-contrast.mjs` reports every pair passing; also check
  reduced motion (OS setting on) shows no animated transition on a theme switch (FR-014) (depends
  on T016, T017, T018). (#226)

**Checkpoint**: run quickstart Story 3.

---

## Phase 6: User Story 4 - The theme survives and applies everywhere (Priority: P2)

**Goal**: the saved choice persists across restarts and windows with no flash, and an unsaved
preview never survives closing the app.

**Independent test**: [quickstart.md](quickstart.md) Story 4.

- [ ] T020 [US4] Confirm every `BrowserWindow` Refract creates (the main window, and a split chat
  pane window once spec 005 exists) answers `theme:bootstrap` the same way and applies its class
  before first paint (FR-011, FR-012); if a second-window code path does not yet call the
  bootstrap wrapper, add the call there (depends on T008). (#233)
- [ ] T021 [US4] Confirm that an unsaved preview can never persist end to end: since `previewing`
  lives only in `theme-store.ts`'s in-memory state and is never written to `settings.json` until
  `save()` runs (T007), ending the process mid-preview (including a force-kill) cannot persist it;
  add this as an explicit documented check rather than new code, and note it in quickstart.md
  (depends on T007). (#239)
- [ ] T022 [US4] Update the docs and verify live: `docs/DESIGN.md`, `quickstart.md` Story 4; then
  on the built app in an isolated instance: Save a theme, fully restart, confirm no flash from the
  window's first paint (screenshot the very first visible frame if possible); start an unsaved
  preview, end the process from Task Manager, relaunch, confirm the previously saved theme (not
  the preview) shows; once spec 005 exists, open a second window and confirm it matches
  immediately (depends on T020, T021). (#245)

**Checkpoint**: run quickstart Story 4.

---

## Phase 7: Polish & cross-cutting concerns

**Purpose**: documentation and cross-spec notes that do not belong to a single story.

- [ ] T023 [P] Update `CONTEXT.md` for any remaining light-theme or follow-system wording, and add
  a short cross-reference note (not new behaviour) that spec 008's profile Theme submenu reuses
  this spec's `theme-store.ts` `save`/`preview` actions and `THEMES` table. (#251)
- [ ] T024 Run every check in `quickstart.md` end to end on one clean isolated instance, covering
  all four stories in one pass, and record the result (pass/fail per check) in this task's own
  commit message or a short note for the handback report. (#257)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies; run first, since its result can change research.md
  decision 9 before Foundational tasks that assume it.
- **Foundational (Phase 2)**: depends on Setup — BLOCKS every user story.
- **User Stories (Phase 3+)**: all depend on Foundational.
  - US1 (T009–T010) has no dependency on US2–US4.
  - US2 (T011–T013) has no code dependency on US1, US3, or US4, but its final live-verify task
    (T013) needs spec 004's real Settings screen to mount into.
  - US3 (T014–T019) has no dependency on US1 or US2; T017 (Mermaid) needs spec 001 T066.
  - US4 (T020–T022) builds on the bootstrap path T008 already lands in Foundational; its
    second-window check (part of T022) needs spec 005.
- **Polish (Phase 7)**: depends on all four stories being complete.

### Cross-spec dependencies (not tasks in this file)

- Spec 004's Settings screen must exist before T012/T013 can mount `AppearanceSection.tsx` for
  real (plan.md build order, item 3).
- Spec 001 T100 must land before `theme.preview`/`theme.set`'s title-bar overlay call is anything
  but a no-op (plan.md build order, item 2).
- Spec 001 T088 and this spec's T015 can land in either order (plan.md build order, item 1).
- Spec 001 T066 must land before T017 does more than add a mapping table (plan.md build order,
  item 4).
- Spec 008's profile Theme submenu is sequenced after T007/T002 exist (plan.md build order,
  item 5) — it is that spec's own task, not one here.

### Parallel Opportunities

- T002 can start immediately after T001; T003 depends on T002 for `ThemeId`.
- T023 (Polish docs) can run in parallel with any story once Foundational is done.
- Across stories, US1 and US3's data/CSS work (T009, T014–T018) can proceed in parallel with US2's
  UI work (T011) even before spec 004 exists, since only US2's final verify task is blocked.

## Notes

- [P] tasks touch different files with no dependency on an unfinished task.
- [Story] maps a task to its user story for traceability; Setup/Foundational/Polish carry none.
- Commit after each task or logical group.
- Stop at any checkpoint to validate a story independently.
- GitHub issues: every task above has an issue titled `007-Tnnn: ...` (see the mapping comment on
  tracking issue #125, and the `(#NNN)` markers to be added to each task line once created).
