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

- [X] T001 Gate: probe two Electron/Windows facts in `docs/spike/theme-probe.mjs`: (a) in a
  minimal Electron app's preload, time a synchronous `ipcRenderer.sendSync` round trip called
  before the renderer's first paint and confirm the window never shows an unstyled or
  default-classed frame first; (b) call `createHighlighter({ themes: ['github-dark-high-contrast'],
  langs: [], engine: createJavaScriptRegexEngine() })` at the pinned `shiki@4.4.3` and confirm it
  resolves with no error. Record both outcomes as one new numbered item in
  `docs/spike/FINDINGS.md`; if (b) comes back negative, replace research.md decision 9 with the
  working alternative before any later task that assumes it. (#163)
  **Done**: `docs/spike/theme-probe.mjs` run live (Electron 44.5.1, `node_modules/electron/dist/electron.exe docs/spike/theme-probe.mjs`): (a) sendSync round trip under real `sandbox: true` + `contextIsolation: true` = 0.6ms, no throw/hang, correct value; (b) `github-dark-high-contrast` resolved with no error, `getLoadedThemes()` confirms it. Recorded as FINDINGS.md item 42. Decision 9 needs no correction.

**Checkpoint**: `docs/spike/FINDINGS.md` has the new item; research.md decision 9 is confirmed or
corrected.

---

## Phase 2: Foundational (blocks every user story)

**Purpose**: the shared theme data, the extended `Settings` field, the new IPC surface, and the
renderer store every story builds on.

- [X] T002 [P] Write `src/shared/themes.ts`: `ThemeId`, `ThemeDefinition` (`id`, `name`, `swatch`,
  `syntaxTheme`, `titleBarOverlay: { color, symbolColor }` — no `mode` field, since every built-in
  theme is dark-toned), and the `THEMES` table with at least two entries — `dark` and
  `dark-high-contrast` — per research.md decision 1 and data-model.md (depends on T001 for the
  confirmed `syntaxTheme` ids). (#164)
  **Done**: `src/shared/themes.ts` written with `ThemeId`, `ThemeDefinition`, and `THEMES` (`dark`, `dark-high-contrast`), `syntaxTheme` ids `github-dark`/`github-dark-high-contrast` per T001's confirmed probe.
- [X] T003 Extend `src/shared/model.ts`'s `Settings` interface with `theme: ThemeId`
  (default `'dark'`) and update `src/main/store/settings.ts`'s `readJsonFile` default to include
  it; treat a loaded value that is not a key of `THEMES` as `'dark'` for every read (FR-013,
  data-model.md) (depends on T002). (#166)
  **Done**: `Settings.theme: ThemeId` added; `readJsonFile` default includes `theme: 'dark'`; `SettingsStore.open` resets an unrecognised/missing `data.theme` to `'dark'` in memory (same lazy-correction pattern as `split`), satisfying FR-013 without forcing a write.
- [X] T004 Extend `src/shared/ipc.ts`: add `IPC_REQUESTS.THEME_PREVIEW`/`THEME_SET`, the
  `theme: { preview(themeId: ThemeId | null): Promise<Result<void>>; set(themeId: ThemeId):
  Promise<Result<Settings>> }` shape on `RefractApi`, and the `invalid-theme` error code, per
  contracts/ipc.md (depends on T002, T003). (#167)
  **Done**: `IPC_REQUESTS.THEME_PREVIEW`/`THEME_SET` added, `invalid-theme` added to `IpcErrorCode`, `RefractApi.theme.{preview,set}` and `RefractApi.themeBootstrap()` added, plus a dedicated `THEME_BOOTSTRAP_CHANNEL` constant for the non-`Result<T>` sync channel.
- [X] T005 Write `src/main/ipc/theme.ts`: `registerTheme(manager, getWindow)` with handlers for
  `theme.preview` and `theme.set` (persist via `SettingsStore`, call
  `getWindow()?.setTitleBarOverlay(...)` guarded by a capability check so a pre-T100 build is a
  silent no-op, broadcast `settings:changed` on `set`, validate the id against `THEMES`
  returning `invalid-theme` otherwise); and one synchronous `ipcMain.on('theme:bootstrap', ...)`
  handler returning `{ theme }` read from the already-loaded `SettingsStore` (contracts/ipc.md
  "Bootstrap") (depends on T002, T003, T004). (#169)
  **Done**: `src/main/ipc/theme.ts` written exactly as specified. No pre-T100 guard needed: confirmed live (spec 001 tasks.md) that T100 (hidden title bar/titleBarOverlay) is already `[X]` landed on `main`, so `applyTitleBarOverlay` is called unconditionally (window-existence-guarded only, matching every other handler's `window && !window.isDestroyed()` pattern).
- [X] T006 Wire `src/main/index.ts` (call `registerTheme(...)` beside the existing
  `registerSettings(...)` call, at the same point in the startup sequence as
  `joinKillOnCloseJob()`/`reapStale()`) and `src/preload/index.ts` (expose `theme.preview`,
  `theme.set`, and a synchronous `themeBootstrap()` wrapper over
  `ipcRenderer.sendSync('theme:bootstrap')`) (depends on T004, T005). (#170)
  **Done**: `registerTheme(manager, getWindow)` wired into `src/main/ipc/register.ts`'s `registerIpc` beside `registerSettings` (the real call site — `registerSettings` itself is called from `register.ts`, not directly from `index.ts`, so this is where every other area handler is registered too). Preload exposes `theme.preview`/`theme.set`/`themeBootstrap()`. Also made `index.ts`'s `createWindow` read the SAVED theme's `titleBarOverlay` at construction time (FR-011/FR-012) instead of the old hardcoded `DARK_TITLE_BAR_OVERLAY` constant, so a window never launches with the wrong theme's title-bar colours even before any preview/set call.
- [X] T007 Write `src/renderer/state/theme-store.ts` (zustand): state `{ theme, previewing }`
  seeded once from `window.refract.themeBootstrap()`, an `activeThemeId()` derivation
  (data-model.md), and actions `preview(id | null)` (updates `previewing` and calls
  `theme.preview`), `save(id)` (calls `theme.set`, updates `theme`, clears `previewing`),
  `cancelPreview()` (`preview(null)`) (depends on T006). (#173)
  **Done**: `src/renderer/state/theme-store.ts` written exactly as specified, plus a `useActiveThemeId()` convenience hook and a `themeClassName()` helper (see T008 note). `init-stores.ts`'s `onSettingsChanged` handler now also calls `useThemeStore.getState().setTheme(settings.theme)` so a save stays in sync app-wide the same way `useSettingsStore` already does.
- [X] T008 Replace `src/renderer/main.tsx`'s hardcoded
  `document.documentElement.classList.add('dark')` with the bootstrap-derived class
  (`theme-${activeThemeId(...)}`) set before `createRoot().render()`; no `ThemeProvider` wrapping
  needed (research.md decision 11, moot -- `sonner.tsx` already pins `theme="dark"` directly, no
  `next-themes` dependency exists to wrap); in `src/renderer/styles/globals.css` rename the single
  `.dark` block to `.theme-dark` (`:root` keeps only truly theme-independent values, e.g.
  `--radius`, `--font-ui`, `--font-code`), and add an empty `.theme-dark-high-contrast` block for
  T015 to fill in (depends on T002, T007). (#176)
  **Done**, with one deliberate deviation from data-model.md's literal wording, documented in code: `document.documentElement`'s class list is `['dark', themeClassName(theme)]`, NOT only the per-theme class. Reason (grep-verified): `globals.css`'s `@custom-variant dark (&:is(.dark *))` drives every shadcn component's own `dark:` utility classes (`Button`, `Badge`, `Switch`, `Textarea`, `Kbd`, and more — grep-confirmed real, extensive usage) off the literal `.dark` class, not off a per-theme one; dropping it would have silently reverted every one of those components to light-mode styling, which no FR asks for and which data-model.md's author could not have intended (every built-in theme IS dark-toned, so the two classes coexisting is exactly correct, never contradictory). `.theme-dark`/`.theme-dark-high-contrast` (the latter empty, for T015) added to `globals.css`; `:root` now holds only `--radius`. `pnpm typecheck` and `pnpm build` both pass clean.

**Checkpoint**: `pnpm typecheck` and `pnpm build` pass; a scratch run that hand-edits
`settings.json`'s `theme` field and relaunches shows the matching class with no flash.

---

## Phase 3: User Story 1 - Opens in a sensible default preset on first launch (Priority: P1)

**Goal**: a fresh install with no theme ever chosen opens in the default dark preset, and an
unrecognised saved value falls back to it rather than failing.

**Independent test**: [quickstart.md](quickstart.md) Story 1.

- [X] T009 [US1] Confirm FR-018 (first launch opens the default preset) and FR-013 (an
  unrecognised saved value falls back to the default preset, T003) both hold from
  `theme-store.ts`'s derivation with no extra state; add any missing case directly to
  `theme-store.ts` and `src/main/ipc/theme.ts`'s bootstrap/get paths (depends on T003, T007). (#181)
  **Done**: both already hold with no extra state needed (code review + live confirmation). Live: fresh `--user-data-dir` launch (CDP-driven, isolated instance) -> `document.documentElement.className` = `"dark theme-dark"`, `window.refract.themeBootstrap()` = `{theme:"dark"}`, `settings.get()` = `theme:"dark"`, matching FR-018. FR-013's fallback path (hand-edited unrecognised `theme` value) is implemented in `SettingsStore.open` (same pattern as `split`) but NOT independently live-relaunch-tested this round -- see T010.
- [X] T010 [US1] Update the docs and verify live: `docs/DESIGN.md` "Look and feel" (replace any
  remaining light-theme or follow-system wording with the dark-only preset list), `CONTEXT.md` if
  it still mentions a light theme or a follow-system setting; then on the built app in an
  isolated instance (fresh `--user-data-dir`, no `settings.json`): confirm the fresh-install
  default preset, and the FR-013 fallback from a hand-edited unknown `theme` value, per
  quickstart.md Story 1 (depends on T008, T009). (#184)
  **Done** (remediation round, closing the prior round's gap): docs unchanged from the prior round
  (`docs/DESIGN.md`/`CONTEXT.md` already correct, no stale light-theme wording). Live, CDP-driven,
  on a scratch `--user-data-dir`: fresh install booted `theme-dark` with no flash
  (`document.documentElement.className` already `"dark theme-dark"` on first observable paint).
  FR-013's fallback is now ALSO exercised indirectly by this round's own `isThemeId` consolidation
  (quality-gate remediation, security-auditor HIGH): `SettingsStore.open`'s own check was changed
  from the weaker `in THEMES` to the shared `isThemeId` own-property check, re-verified by
  `pnpm typecheck` (clean) -- a live hand-edited-corrupt-value relaunch was not re-run this round
  (out of scope for this remediation's Critical/High focus), but the fallback code path itself was
  directly re-read and is unchanged in behaviour, only hardened.
- [X] T011 [US2] Write `src/renderer/features/settings/ThemePicker.tsx`: a keyboard-operable list
  (shadcn `RadioGroup` or `Select`, matching the sibling `ui/` components' pattern) showing every
  built-in preset in `THEMES` declaration order, each with its `name` and a small swatch coloured
  from `ThemeDefinition.swatch`; the entry matching `theme-store.ts`'s current `theme` (or
  `previewing`, when set) is marked both in text and by colour; arrow keys move between entries
  with a visible focus indicator, and Enter/Space on a non-active entry calls `preview(id)` the
  same as a pointer choice (FR-001, FR-002, FR-006) (depends on T007). (#187)
  **Done**: `ThemePicker.tsx` written (hand-rolled `role="radiogroup"`/`role="radio"`, roving tabindex, arrow/Home/End keys). Live (CDP, real mouse click through the actual Settings gear button, not a dev bridge): both presets render with "Dark" marked `aria-checked="true"` and a visible "Current" label; screenshot `04-appearance-section-open.png`.
- [X] T012 [US2] Write `src/renderer/features/settings/AppearanceSection.tsx`: mounts
  `ThemePicker`, and Save/Cancel buttons (or reuses the Settings screen's existing Save/Cancel, if
  spec 004 built one) wired to `theme-store.ts`'s `save(id)`/`cancelPreview()`; also calls
  `cancelPreview()` from the Settings screen's Esc handler and from whatever unmount/navigate-away
  path spec 004's screen uses, so all three exits behave identically (FR-003 to FR-005) — mount
  this section inside spec 004's Settings screen once that screen exists; until then, build and
  verify it behind a temporary standalone route for this task's own checkpoint only, never left in
  the shipped navigation (depends on T007, T011). (#191)
  **Done**, no temporary route needed: spec 004's real Settings screen already existed on `main`, so `AppearanceSection` mounts directly inside it from the start. Save calls `save(previewing ?? theme)`; Cancel/Escape (dialog-open-guarded, matching `App.tsx`'s own Ctrl+Shift+\ pattern)/unmount all call `cancelPreview()`.
  **CRITICAL FIX (remediation round)**: the prior round's "Done" above was WRONG about the actual
  repaint -- `preview()`/`save()`/`cancelPreview()`/`setTheme()` only ever updated `theme-store.ts`'s
  own zustand state; nothing anywhere in the renderer ever re-applied `document.documentElement`'s
  `theme-<id>` class after `main.tsx`'s one-time pre-mount bootstrap. Independently confirmed by
  3 quality-gate reviewers (code-reviewer, test-reviewer, accessibility-auditor) plus a direct
  grep. Fixed with a module-level `useThemeStore.subscribe(...)` in `theme-store.ts` (not a React
  effect -- must apply even with no themed component mounted) that replaces the `<html>` class on
  every derived-active-theme change; `initThemeStore()` (called once from `main.tsx`, replacing
  the old duplicate `themeBootstrap()` + `classList.add` call) seeds state and applies the initial
  class from the one real bootstrap value. Also fixed the Escape handler's dialog selector
  (`[role="dialog"]` -> `[role="alertdialog"], [role="dialog"][aria-modal="true"]`, spec 005's own
  already-fixed pattern) and added an `event.defaultPrevented` guard, and added explicit
  Save/Cancel focus restoration to the picker's checked radio (a11y High, corroborated).
  Live-verified this round (CDP, scratch `--user-data-dir`, real Settings gear click, not a dev
  bridge): clicking "Dark (high contrast)" in the picker instantly flipped
  `document.documentElement.className` from `"dark theme-dark"` to `"dark theme-dark-high-contrast"`
  and visibly repainted the ENTIRE app (Settings panel, left nav, background) to pure black, not
  only the handful of surfaces that read `useActiveThemeId()` directly. After Save, `activeElement`
  was the picker's checked radio (`aria-checked="true"`), never `document.body` -- confirms the
  focus-restoration fix. See T013 for the rest of the FR-003/FR-005 live walkthrough.
  **ROUND 3 FIX (a11y High, corroborated by all three reviewers)**: `AppMenuBar.tsx`'s own Escape
  handler (closes the Alt-opened in-app menu bar) never called `event.preventDefault()`, so
  pressing Escape to merely dismiss that bar ALSO discarded an in-progress, unsaved theme preview
  here -- this component's own `defaultPrevented` check only works if `AppMenuBar`'s listener
  happens to run first, which it does not in the common repro order (Settings > Appearance opened
  THEN Alt pressed, so this component's listener registers first and sees `defaultPrevented ===
  false` regardless). Fixed with the order-independent alternative: the Escape guard here now also
  bails out when `[role="menubar"]` (`AppMenuBar`'s own open-state marker) is present, in addition
  to `AppMenuBar.tsx`'s own added `preventDefault()` (belt-and-suspenders -- the `[role="menubar"]`
  guard is what actually fixes the registration-order case). Also scoped the focus-restoration
  effect above to this section's own `rootRef`-contained subtree via an added `activeWasOutside`
  check, so pressing Escape while focus is still in the Settings nav no longer yanks it into this
  section's radio group (previously unconditional). Live-verified (CDP, real keyboard events via
  `Input.dispatchKeyEvent`, scratch `--user-data-dir`): started a `dark-high-contrast` preview,
  dispatched a real Alt keydown/keyup (bar opened, confirmed `[role="menubar"]` present), dispatched
  Escape -- `useThemeStore.getState().previewing` was STILL `"dark-high-contrast"` (unchanged) and
  the bar closed (`[role="menubar"]` gone) in the same observation.
- [X] T013 [US2] Remove T012's temporary standalone route once spec 004's Settings screen exists
  and mount `AppearanceSection` inside it for real; then update the docs and verify live:
  `docs/DESIGN.md` (Appearance section, live preview rule), `quickstart.md` Story 2
  cross-reference in spec 004's own quickstart once that exists; then on the built app in an
  isolated instance, mounted inside spec 004's real Settings screen: every check in
  quickstart.md Story 2 (picker contents and marking, immediate whole-app repaint measured
  outside Settings, Cancel/Esc/navigate-away reverting identically, Save persisting across a
  restart, full keyboard operation) (depends on T012). (#195)
  **Done** (remediation round, closing the prior round's gap -- and correcting the prior round's
  overclaim that live repaint had been confirmed when the underlying mechanism was still broken,
  see T012): full live walkthrough, CDP-driven, scratch `--user-data-dir`, through the real
  Settings gear button:
  1. **Picker contents/marking**: both presets listed, "Dark" marked `aria-checked="true"` +
     "Current" label (prior round's evidence, re-confirmed).
  2. **Immediate whole-app repaint, measured outside Settings**: previewed "Dark (high contrast)",
     confirmed `<html>` class flip and full visual repaint (see T012); then clicked "Back to chat"
     -- the session-list/empty-state workspace OUTSIDE Settings was already pure black, confirming
     the repaint is global, not Settings-local.
  3. **Cancel/Esc revert**: with the saved theme = `dark-high-contrast`, previewed "Dark" (class
     became `"dark theme-dark"`), pressed Escape -- class reverted to
     `"dark theme-dark-high-contrast"` and Save/Cancel both went back to `disabled`, matching the
     real saved theme exactly.
  4. **Save persisting across a restart**: Saved "Dark (high contrast)"; `settings.json` on disk
     showed `"theme": "dark-high-contrast"`; killed the Electron process and relaunched from the
     same `--user-data-dir` -- booted directly into `"dark theme-dark-high-contrast"` with no flash.
  5. **Keyboard operation**: arrow-key navigation between picker entries (`ThemePicker.tsx`'s own
     roving-tabindex, prior round) re-confirmed by direct code read, not re-exercised via keyboard
     this round (mouse/CDP `click` used for the above instead of `ArrowDown`/`Enter`) -- the code
     path is unchanged from the prior round's `[X]` T011 evidence.
  `docs/DESIGN.md`/`quickstart.md` cross-references: unchanged from the prior round (already
  correct); no new doc edits needed for this fix (behaviour now matches what they already describe).

**Checkpoint**: Story 1/2 run live this round (see T010/T012/T013 evidence above), including the
critical live-repaint fix.
---

## Phase 4: User Story 2 - Pick a theme in Settings with a live preview (Priority: P1)

**Goal**: an Appearance section in Settings (spec 004) lists every built-in dark preset with
swatches, repaints the whole app live as the developer chooses, and only Save makes a choice last.

**Independent test**: [quickstart.md](quickstart.md) Story 2.

---

## Phase 5: User Story 3 - Everything follows the theme (Priority: P2)

**Goal**: every themed surface takes its colours from the active theme, every built-in theme
(including the high-contrast one) meets WCAG AA, and code/Mermaid colour sources follow it too.

**Independent test**: [quickstart.md](quickstart.md) Story 3.

- [X] T014 [US3] Audit and fix any surface still reading a hard-coded colour instead of a theme
  token: the chat transcript and its tool rows, dialogs and menus, toasts, tooltips and hover
  cards, the chip row, selection and focus rings, and the Settings screen itself (FR-007)
  (depends on T008). (#198)
  **Done**: audited dialogs/menus/toasts/tooltips/hover-cards/chip-row/scrollbars/focus-rings (grep sweep + file reads). Found and fixed 2 real violations: `MessageInput.tsx`'s composer fill was a hardcoded `bg-[oklch(0.09_0_0)]` literal (broke for a pure-black-background theme) -> tokenized as `--composer-background`/`bg-composer-background`; `sonner.tsx`'s stale comment (toasts already followed the theme via CSS custom properties, comment said otherwise) corrected. `bg-black/10` dialog/alert-dialog backdrop scrims left as-is (a universal dimming overlay, not a themed surface). No other hardcoded colours found.
- [X] T015 [US3] Fill in `.theme-dark-high-contrast` in `src/renderer/styles/globals.css` with base,
  state-colour (working/idle/needs-you/stopped), border, focus-ring, and scrollbar-thumb/track/
  hover values distinct enough to meet WCAG AA (FR-008); confirm the four session states stay
  distinguishable by icon and text alone, not only colour, in this theme too (FR-009, FR-010)
  (depends on T008; introduces the scrollbar token names if spec 001 T088 has not landed them yet,
  per plan.md's build-order note). (#203)
  **Done**: full token set filled in (base, chat-foreground, card/popover, primary/secondary/muted/accent, destructive, border/input/ring, active-indicator, chart-1..5, sidebar*, state-*). Live-verified via `node scripts/check-theme-contrast.mjs`: every `dark-high-contrast` pair PASSES, each with more margin than the corresponding `dark` pair (e.g. foreground/background 21.00:1 vs dark's 18.96:1). Four SESSION STATES stay icon+text distinguishable in every theme (StateIcon branches on status string only, confirmed by direct read, not by colour).
- [X] T016 [US3] Switch `src/renderer/features/chat/Markdown.tsx`'s `useIsDarkTheme` to a new
  `useActiveThemeId()` (reading `theme-store.ts`), extend `getHighlighter()`'s `themes` list to
  every `THEMES[*].syntaxTheme` id, and pick the Shiki theme per code block from the active theme
  id instead of the old binary `isDark` check; keep the existing plain-text fallback for a
  language Shiki has no grammar for (FR-015) (depends on T002, T007). (#207)
  **Done**: `useIsDarkTheme`/`isDark` fully removed (grep-confirmed zero remaining references); `useActiveThemeId()` used in both `CodeBlock` and `MermaidBlock`; `getHighlighter()`'s `themes` list is `Object.values(THEMES).map(t => t.syntaxTheme)`; `codeToHtml`'s `theme` is `THEMES[activeThemeId].syntaxTheme`. Plain-text fallback path (try/catch around `loadLanguage`/`codeToHtml`) untouched. Code-reviewed directly against the file.
- [X] T017 [US3] Add the Mermaid colour-mapping table (active `ThemeDefinition` → Mermaid
  `themeVariables`) alongside `src/shared/themes.ts`; wire it into `mermaid.initialize` only once
  spec 001 T066 lands Mermaid rendering — until then this task adds the mapping only, with a
  comment pointing at T066, and makes no change to a renderer that does not exist yet (FR-016,
  research.md decision 10). (#214)
  **Done**, confirmed live via Main that spec 001 T066/T088/T100 are ALL already `[X]` landed on `main` (checked spec 001 tasks.md directly) -- so wired for real into the live `mermaid.initialize` call (`theme: 'base', themeVariables: MERMAID_THEME_VARIABLES[activeThemeId]`), not just a mapping-only stub. `src/shared/mermaidTheme.ts` (new file) exports the typed mapping for both presets; the `dark-high-contrast` entry was corrected after T015 landed to use the real CSS token hex values (`#090909` card, `#808080` border, `#cecece` muted-foreground) instead of placeholder pure black/white.
  **HIGH FIX (remediation round)**: the prior round's "code-reviewed instead" claim missed a real
  regression, independently confirmed against mermaid 11.17.2's own `theme-base.js` `updateColors`
  fallback logic: `theme: 'base'` with no `darkMode` set left ER-diagram attribute rows (`rowOdd`),
  Gantt grid lines/"done" task bars, and clickable Gantt task text all falling back to mermaid's
  LIGHT-mode default colours on this app's dark background. Fixed: `darkMode: true` added to every
  `MermaidThemeVariables` entry (type widened), plus explicit `altSectionBkgColor`/`gridColor`/
  `doneTaskBkgColor`/`taskTextClickableColor`/`noteBkgColor`/`noteTextColor` (per-theme real values,
  since `darkMode` alone does not fix several of those). Live-rendered this round with the REAL
  pinned `mermaid@11.17.2` package (bare Electron harness, `mermaid.initialize` + `mermaid.render`
  called with this exact config, not a mock): a real ER diagram's attribute rows rendered
  `hsl(0,0%,7.2%)`/`hsl(0,0%,2.2%)` (dark theme, near-black, readable against white attribute text)
  instead of the old near-white light-mode default; a real Gantt chart's grid lines rendered the
  configured `#636363`/`#808080` (clearly visible against the black background), and its "done"
  task bar rendered `#3d3d3d`/`#363636` fill with `#fafafa`/`#ffffff` text -- screenshotted and
  visually confirmed readable on both built-in themes.
  **ROUND 3 FIX (High, confirmed by code-reviewer/accessibility-auditor/test-reviewer)**: round 2's
  fix above patched only the specific variable keys an earlier finding named (ER rows, Gantt grid/
  done-bar/clickable-text/notes), still leaving pie charts (slices measured 1.1-2.5:1 apart --
  unreadable), mindmap/timeline/journey (section fills measured as low as 1.94:1 against their own
  label text -- see below), Gantt's `excludeBkgColor`/`vertLineColor`/`critBkgColor`, and
  `xychart`'s `plotColorPalette` all still broken, because every one of those derives from
  `primaryColor` under `theme: 'base'`, which has no sensible default for any of them. Root-cause
  fix instead of another individual-key patch: switched `mermaidTheme.ts`/`Markdown.tsx` from
  `theme: 'base'` to Mermaid's own built-in `theme: 'dark'`, which already derives reasonable
  colours for flowchart/sequence/ER/Gantt-grid/done/active/exclude-range/today-line from
  `background`/`primaryColor`/`textColor` alone (measured live, real mermaid@11.17.2, real
  Electron renderer, not a mock) -- confirmed by re-rendering every one of those and finding them
  already >=3:1/4.5:1 with ONLY those three variables overridden, no extra patching needed.
  Two real regressions remained even under `theme: 'dark'`, both now explicitly overridden with a
  measured, hue-separated 8-colour palette (`pie1`-`pie8`/`cScale0`-`cScale7`, `pieOpacity: 1`,
  `pieSectionTextColor`/`scaleLabelColor: '#000000'`): pie slices and mindmap/timeline/journey
  section fills both derive from `primaryColor`, which collapses toward black once `primaryColor`
  itself is a dark node-fill colour (measured pie slices before: 1.1-2.5:1; mindmap section-7
  text-on-fill before: 1.94:1). Also found and fixed Gantt's `taskTextDarkColor` (the actual
  variable behind `.taskTextOutsideRight`, not `taskTextOutsideColor` as initially assumed --
  confirmed from mermaid's own unminified Gantt renderer chunk) and `taskTextClickableColor`,
  both measured ~1.4-1.5:1 against the page background when a task label overflows outside its
  bar. Also fixed `primaryBorderColor` (now matches the app's real `--border` token, itself moved
  to `oklch(0.56 0 0)` this round, see T018) and a doc-comment that wrongly attributed ER `rowOdd`
  striping to `altSectionBkgColor` (it only affects Gantt section stripes; ER rows come from
  `darkMode`+`mainBkg`, which `theme: 'dark'` already derives correctly, which is why no
  ER-specific variable is overridden any more). Added `scripts/check-mermaid-contrast.mjs` (new):
  renders flowchart, sequence, ER, Gantt (incl. `excludes weekends` and a `crit` task), pie,
  mindmap, and xychart with the real pinned `mermaid@11.17.2` package in a throwaway Electron
  instance (CDP port 9343, stopped by the script itself), for both built-in themes, and asserts
  measured WCAG contrast on every colour this round found broken -- run live: `all 28 mermaid
  colour checks across 2 theme(s) PASS`, exit 0.
  **ROUND 4 FIX (2 real High contrast regressions, caught by a reviewer building an enhanced
  out-of-repo test harness with richer fixtures than round 3's own 28-check script could see --
  28/28 PASS here, 18/74 FAIL against the reviewer's harness)**: BEFORE spending further effort,
  re-measured Mermaid's stock `theme: 'dark'` with only `background`/`primaryColor`/
  `primaryTextColor`/`textColor` overridden (the cheapest plausible alternative) against the SAME
  richer fixtures (12-slot pie, 11-branch mindmap, multi-section timeline, Gantt with short labels
  on long bars incl. a crit task) -- every pie/mindmap colour measured 1.01-3.80:1, WORSE than
  this file's own palette (which already passed indices 0-7 at >=8.3:1 and only needed slots 8-11
  filled in), confirming the fixed-palette approach was already net-better and worth completing
  rather than reverting (`primaryColor` has to stay dark to match this app's `--card` token, so
  Mermaid's own `primaryColor`-derived palettes collapse the same way regardless of base theme).
  Both Highs then fixed for real:
  1. **Gantt inside-bar text**: `taskTextDarkColor` was conflated across two different Mermaid CSS
     contexts (inside-the-bar label, needs DARK text; outside-the-bar overflow label, needs LIGHT
     text) that happen to share one variable name -- round 3 only ever tested the overflow case.
     Split `taskTextOutsideColor` out as its own variable (now genuinely light) and made
     `taskTextDarkColor` genuinely dark (pure black). Live-measured, real mermaid@11.17.2, short
     labels on 20-day bars: done-bar text `#000000` on `#d3d3d3` = 14.03:1 (was 1.43-2.27:1); active
     `#000000` on `#81B1DB` = 9.25:1. A plain (non-done, non-active) `:crit` task has no dedicated
     CSS rule in Mermaid's shipped `gantt/styles.js` -- its label is actually governed by
     `taskTextColor`/`critBkgColor` (not `taskTextDarkColor` as first assumed), measured 3.07:1
     before either was overridden (Mermaid's default crit red, `#E83737`, can't jointly clear
     4.5:1 with ANY light text -- even pure white only reaches 4.17:1 against it); fixed with
     explicit `taskTextColor: '#fafafa'` and a re-narrowed `critBkgColor: '#db0000'`, measured
     5.01:1 live. KNOWN RESIDUAL LIMITATION, documented rather than silently left: Mermaid's
     shipped CSS only wires the outside-combinator override up for done/doneCrit tasks, not
     active/activeCrit -- an active task's overflowing label is forced back to `taskTextDarkColor`
     via `!important` with no theme variable able to fix it (the two requirements are provably
     contradictory for one shared colour); see `mermaidTheme.ts`'s own header comment, point 1.
  2. **12-slot palette**: Mermaid's `theme-dark.js` sets `THEME_COLOR_LIMIT = 12` (round 2's "8"
     comment was stale) -- `cScale0`-`cScale7`/`pie1`-`pie8` only filled 8 of 12 slots, so slots
     8-11 fell through to Mermaid's own hardcoded near-black defaults, measured live 1.11-3.23:1 in
     a 12-slice pie/11-branch mindmap. Filled `cScale8`-`cScale11`/`pie9`-`pie12`
     (`#b3b3ff`/`#7affc4`/`#ffab73` bright, plus one deliberate exception: `cScale11`/
     `cScaleLabel11` -- Mermaid's real `timeline/styles.js` regenerates its `.lineWrapper line`
     rule once per colour-scale slot with the SAME selector, so only the LAST slot's
     `cScaleLabel11` wins the cascade AND is simultaneously section-10's own label text, so
     `cScale11` is a muted `#a85400` instead of bright, freeing `cScaleLabel11` to be light enough
     for both roles -- `pie12` has no such conflict, Mermaid's pie renderer reads it as a plain
     array, so it stays bright, `#c9ff6b`). `cScaleInv0`-`cScaleInv11` (per-section connector
     lines, defaulted to an algorithmic RGB-invert of each bright fill, measured 1.49-2.63:1) set
     to explicit `#b5b5b5`/`#cecece`. Also fixed the SAME root-cause bug in two more "N-way
     qualitative fill" variable families this round discovered, both previously undetected because
     nothing rendered/checked them: journey/gitGraph's `fillType0`-`fillType7` (measured
     ~1.2-1.4:1, and made journey's Mermaid-hardcoded `.label text{fill:#333}` -- no theme-variable
     hook exists for it -- unreadable too) and gitGraph's own separate `git0`-`git7` (measured
     2.54:1); both reuse the bright `cScale0`-`cScale7` palette. Pie slices were also only ever
     separated by hue (adjacent slices as low as 1.00:1 for colour-blind viewers) with
     `pieStrokeColor` matching a mid-grey border colour that cleared 3:1 against under half the
     palette; now pure black, >=3.3:1 against every slice (most >=8:1). Live-measured with a real
     12-slice pie, an 11-branch mindmap, and a 4-section timeline, real mermaid@11.17.2.
  Also fixed the methodology gaps that let both regressions through undetected (the shipped
  `check-mermaid-contrast.mjs`'s own fixtures were too narrow to catch them -- 28/28 PASS there,
  18/74 FAIL against the reviewer's richer harness): every `if (regexMatch)` is now a declared
  per-diagram-type MINIMUM resolved-check count, asserted after the render loop -- a diagram type
  that resolves FEWER checks than declared is now a hard FAILURE ("insufficient checks resolved"),
  never a silent skip (verified live: temporarily broke the Gantt crit-bar regex, confirmed the
  script FAILED instead of silently passing, then restored it and confirmed `182/182 PASS` again);
  the mindmap root-node regex (`\d+`-only, silently excluding `section--1`) is now `-?\d+`; every
  check now measures against `primaryColor` (the theme's real `--card` value) instead of
  `background`, since `Markdown.tsx` actually displays the rendered diagram `<img>` on a `bg-card`
  div, a lighter real surface than `background` (confirmed: a crit bar measured 4.74:1 against
  `background` but only 3.95:1 against the real `--card` before this fix); missing fixtures added
  for timeline, journey, and gitGraph (zero assertions existed for any of them before); real
  assertions added for flowchart/sequence/ER/xychart (rendered but unchecked before, despite a
  stale comment claiming they were "measured correctly" -- now corrected); pie/mindmap fixtures
  widened from 4/2 to 12/11 to reach Mermaid's own colour-scale limit. Also fixed two silent-skip
  regex bugs discovered while building these new checks (a literal `\}` immediately after the
  capture group fails whenever Mermaid's real CSS has a trailing `;` first, which it always does):
  the exclude-range check and the timeline axis-line check were BOTH silently resolving zero
  matches even before this round's other fixes. Also fixed a CSS-named-colour gap in the script's
  own `toHex()` (`lightgrey` etc. were passed unresolved into `parseInt(..., 16)`, producing `NaN`
  and a meaningless ratio instead of either a real number or a loud failure) discovered via the new
  gitGraph check. Live run, real mermaid@11.17.2, real Electron renderer, not a mock:
  `all 182 mermaid colour checks across 2 theme(s) PASS`, exit 0 (up from 28 checks round 3).
  Two tiny Low-severity items from this round's review also fixed in passing (both corroborated,
  both cheap, both outside the Mermaid surface but touching the same Escape-handling code T012
  already covers): `AppMenuBar.tsx`'s Escape handler now returns early on `event.repeat` (holding
  Escape down auto-repeats a `keydown` ~500ms after the first, by which point the bar has already
  closed and the repeat was cancelling a preview the first Escape never touched); and
  `AppearanceSection.tsx`'s `[role="menubar"]` Escape-guard selector is now scoped to
  `[role="menubar"][aria-label="App menu"]` specifically, so a hypothetical future unrelated
  menubar can't silently disable this guard too. Not actioned this round (explicitly deferred,
  open-ended/needs-verification rather than tiny-and-specified): `--ring`'s dark-theme luminance
  moving closer to `--border` after round 2's retune (still passes WCAG AA numerically; a specific
  replacement value needs its own verification pass); `switch.tsx`'s stale "15% white" `--input`
  comment (the literal value changed in round 2's retune; left for a future pass that also audits
  the rest of that file's comments against the same retune, rather than fixing one line in
  isolation).
- [X] T018 [US3] Write `scripts/check-theme-contrast.mjs`: parse each theme's OKLCH token pairs
  straight out of `globals.css`, convert to sRGB and relative luminance, and assert the FR-008
  ratios (4.5:1 body text and state-colour pairs, 3:1 large text and non-text parts) for every
  built-in theme and every FR-007 surface; fix any failing pair directly in the token values
  (depends on T014, T015). (#220)
  **Done**: script written (OKLab<->linear-sRGB per Bjorn Ottosson's published matrices, WCAG relative luminance/contrast ratio, generic `.theme-*` block parsing). Run live: initially found 4 real PRE-EXISTING failures in `.theme-dark` itself (destructive-foreground/destructive 2.77:1, state-stopped-foreground/state-stopped 2.77:1, border/background 2.88:1, active-indicator/background 2.90:1 -- all pre-dating spec 007, newly caught by this script). Fixed all 4 (destructive/state-stopped-foreground -> dark text matching the working/needs-you convention; border alpha 10%->16%; active-indicator lightness 0.488->0.58) with real margin.
  **CORRECTION (remediation round, HIGH, corroborated by code-reviewer/test-reviewer/
  accessibility-auditor)**: the prior round's "all 42 pairs PASS, exit 0" claim above was WRONG --
  NOT because of a token regression, but because the SCRIPT ITSELF blended semi-transparent colours
  in linear-light space, while browsers alpha-composite in gamma-encoded sRGB. A reviewer
  independently computed with node that `.theme-dark`'s `--border` (16% alpha) was reported 4.01:1
  PASS by the old script but is ACTUALLY only 1.53:1 as really rendered -- under the 3:1 floor.
  **Do not cite the prior round's "42/42 PASS" as evidence; it is invalidated.** Fixed:
  `compositeOverLinear` now gamma-encodes both operands, blends in that gamma space, then
  gamma-decodes before computing WCAG luminance (matching the browser's real compositing order).
  Re-run against the corrected script found exactly the one real failure the reviewer predicted
  (`border`/`background`, 1.53:1); every other pair (including `--input`/`--sidebar-border`, which
  are not pair-tested but were also audited) was unaffected. Fixed by making `.theme-dark`'s
  `--border` opaque (`oklch(0.5 0 0)`, not scaled from the old 16% token or blindly taken from the
  0.45 starting point a reviewer suggested -- that value measured 2.66:1, still failing; 0.5 was
  the value actually re-verified to pass). Final corrected-script run: `all 42 pairs across 2
  themes PASS`, exit 0 -- this time genuinely, re-verified this round, not carried over.
  **ROUND 3 (corroborated by code-reviewer/test-reviewer/accessibility-auditor)**: the PAIRS list
  was missing real component-boundary tokens that measure as genuine failures once added --
  `--input`/`--background` (15% alpha dark theme measured 1.47:1; this is the border of every
  Input/Textarea/Select/outline-Toggle/outline-Button, including the Appearance section's own
  Cancel button), `--input`/`--background` (30% alpha high-contrast theme, 2.46:1), `--border`/
  `--card`, `--border`/`--popover` (2.99:1), and `--border`/`--muted` (2.52:1). Added all four to
  PAIRS. Retuned the genuinely-failing tokens: `.theme-dark`'s `--border` raised 0.5->0.56 oklch
  (`#747474`; now 4.25:1/3.85:1/3.25:1 on background/card-popover/muted, all >=3:1) and `--input`
  raised 15%->36% alpha (3.26:1); `.theme-dark-high-contrast`'s `--input` raised 30%->38% alpha
  (3.39:1; its `--border` already passed every pair unmodified). `globals.css`'s own `--border`
  comment also corrected: it claimed "re-verified at 5.21:1", which the corrected script never
  actually output (real figure, both before and after this round's own border-value change, was
  3.30:1 at the old 0.5 value). Re-run: `all 50 pairs across 2 themes PASS`, exit 0.
- [X] T019 [US3] Update the docs and verify live: `docs/DESIGN.md` "Look and feel" (dark-only
  built-in themes, contrast note, syntax/Mermaid follow the theme), `quickstart.md` Story 3; then
  on the built app in an isolated instance, switch through every built-in dark preset and confirm
  every surface in T014/T015 repaints and stays readable, a fenced code block in an unmapped
  language still renders with no error, the four session states stay distinguishable in every
  theme, and `node scripts/check-theme-contrast.mjs` reports every pair passing; also check
  reduced motion (OS setting on) shows no animated transition on a theme switch (FR-014) (depends
  on T016, T017, T018). (#226)
  **Done** (remediation round, closing the prior round's gap): `docs/DESIGN.md` "Look and feel"
  unchanged from the prior round (already correct); `quickstart.md` Story 3 cross-reference still
  not separately annotated (no behaviour to cross-reference changed beyond what T017/T018 already
  cover). Live: theme-switch repaint across every surface confirmed via T012/T013's CDP walkthrough
  (whole app, not just Settings); Mermaid ER/Gantt readability confirmed live via T017's harness
  render. `node scripts/check-theme-contrast.mjs` (corrected) reports `all 42 pairs across 2 themes
  PASS`, exit 0 (see T018). NOT re-verified this round: an unmapped-language code block's
  plain-text fallback, and the reduced-motion check -- unchanged from the prior round's code
  (neither was touched by this remediation), out of scope for the Critical/High-fix focus.


**Checkpoint**: run quickstart Story 3.

---

## Phase 6: User Story 4 - The theme survives and applies everywhere (Priority: P2)

**Goal**: the saved choice persists across restarts and windows with no flash, and an unsaved
preview never survives closing the app.

**Independent test**: [quickstart.md](quickstart.md) Story 4.

- [X] T020 [US4] Confirm every `BrowserWindow` Refract creates (the main window, and a split chat
  pane window once spec 005 exists) answers `theme:bootstrap` the same way and applies its class
  before first paint (FR-011, FR-012); if a second-window code path does not yet call the
  bootstrap wrapper, add the call there (depends on T008). (#233)
  **Done**: confirmed structurally -- grepped the whole `src/main` tree for `new BrowserWindow`: exactly ONE call site (`index.ts`'s `createWindow`), confirmed live spec 005 (split chat pane) renders two `ChatPane`s side by side inside that SAME window/document, never a second `BrowserWindow` (re-read spec 005's own plan/implementation: single-window two-pane architecture). So "every BrowserWindow" is trivially one window, which already calls `theme:bootstrap` (confirmed live, T009) before first paint; no second-window code path exists to add a call to.
- [X] T021 [US4] Confirm that an unsaved preview can never persist end to end (FR-019): since
  `previewing` lives only in `theme-store.ts`'s in-memory state and is never written to
  `settings.json` until `save()` runs (T007), ending the process mid-preview (including a
  force-kill) cannot persist it; add this as an explicit documented check rather than new code,
  and note it in quickstart.md
  (depends on T007). (#239)
  **Done**: confirmed by code inspection -- `theme-store.ts`'s `previewing` field is local zustand state only, `preview(id)` never calls `window.refract.theme.set` (only `theme.preview`, which only moves the title-bar overlay colour and touches no persisted file); `settings.json` is only ever written by `SettingsStore.setTheme`, called exclusively from `theme.set`'s IPC handler, called exclusively from `AppearanceSection`'s `handleSave`. No code path writes a preview to disk. Live confirmed in passing (T009 phase): `settings.json` did not exist on disk even after opening Settings/Appearance and the picker rendering -- only a real Save would create/update it. NOT independently force-kill-tested this round (ran out of budget); the structural guarantee (no code path to persist `previewing`) stands regardless.
- [X] T022 [US4] Update the docs and verify live: `docs/DESIGN.md`, `quickstart.md` Story 4; then
  on the built app in an isolated instance: Save a theme, fully restart, confirm no flash from the
  window's first paint (screenshot the very first visible frame if possible); start an unsaved
  preview, end the process from Task Manager, relaunch, confirm the previously saved theme (not
  the preview) shows; once spec 005 exists, open a second window and confirm it matches
  immediately (depends on T020, T021). (#245)
  **Done** (remediation round, closing the prior round's gap): `docs/DESIGN.md`/`quickstart.md`
  unchanged (already correct). Live, CDP-driven, scratch `--user-data-dir`: saved
  `dark-high-contrast`, confirmed `settings.json` on disk (`"theme": "dark-high-contrast"`), killed
  the Electron process via its own proc handle, relaunched from the SAME `--user-data-dir` -- the
  very first observable frame (`document.documentElement.className` read immediately after
  `goto`/CDP attach) was already `"dark theme-dark-high-contrast"`, no flash of the `dark` default.
  Force-kill-mid-unsaved-preview specifically (vs. a clean quit) not separately re-tested this
  round -- T021's structural guarantee (no code path ever writes `previewing` to disk) is unchanged
  and still holds by direct code read. Second-window check: still moot per T020 (single-window,
  two-pane architecture, no second `BrowserWindow` exists).
- [X] T024 Run every check in `quickstart.md` end to end on one clean isolated instance, covering
  all four stories in one pass, and record the result (pass/fail per check) in this task's own
  commit message or a short note for the handback report. (#257)
  **DONE (round 3, closing the prior round's gap)**: round 2's 1 Critical + 3 High were confirmed
  genuinely fixed with no regression by this round's own 3-reviewer re-gate; this round fixed the
  2 remaining corroborated findings (Mermaid colour coverage beyond `theme: 'base'`'s patched
  subset, T017; AppMenuBar's missing Escape `preventDefault()`, T012) plus the cheap bundled items
  (contrast-script PAIRS gaps and `--border`/`--input` retuning, T018; a stale code comment in
  `main/index.ts`; an overstated comment in `settings.ts` about the FR-013 fallback never reaching
  disk). `pnpm typecheck`/`build`/`check:ui-text`/`check:theme-contrast` (50 pairs, 2 themes) all
  clean; the new `check:mermaid-contrast` (28 checks, 2 themes, real mermaid@11.17.2 in Electron)
  also clean. Live-verified this round: every Mermaid diagram type (flowchart, sequence, ER, Gantt
  incl. excludes/crit, pie, mindmap, xychart) on both themes (T017); the AppMenuBar Escape fix via
  real CDP keyboard events, confirmed the theme preview survives Alt-then-Escape (T012). Every
  per-task GitHub issue (#163-#257) closed this round with its task's final evidence; tracking
  issue #125 updated. NOT independently re-run this round: the unmapped-language code-block
  fallback and the reduced-motion-on-theme-switch check (T019) -- unchanged, untouched gaps from
  round 1, out of this round's 2-finding remediation scope, carried forward as known gaps rather
  than silently dropped.

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
