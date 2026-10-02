# Implementation Plan: App themes

**Branch**: `007-app-themes` (no branch created; work lands on `main`) | **Date**: 2026-10-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/007-app-themes/spec.md`

## Summary

Give Refract a set of built-in colour themes (Light, Dark, High contrast) plus a "System" mode
that follows Windows' light-or-dark setting live until the developer picks one. The choice is
made from an Appearance section inside spec 004's Settings screen, with an immediate, whole-app
live preview that Save commits and Cancel/Esc/navigating away discards; the same setter is reused
by spec 008's profile Theme submenu. Every themed surface (chat, tool rows, diffs, session list,
dialogs, menus, scrollbars, code block syntax colours, and eventually Mermaid diagrams) takes its
colours from the active theme, each built-in theme meets WCAG AA contrast, and the choice survives
restarts with no flash of the wrong appearance on first paint. Design rationale and the three
UNVERIFIED Electron/Windows facts this depends on are in [research.md](research.md); the new
renderer-to-main surface is in [contracts/ipc.md](contracts/ipc.md).

## Technical Context

**Language/Version**: TypeScript (`strict: true`) on Node 24.21.0 as bundled by Electron 44.5.1;
React 19.3.0 in the renderer. Same stack as spec 001; no new runtime added.

**Primary Dependencies**: `next-themes` 0.4.6 (already a dependency, today used only by the copied
shadcn `sonner.tsx`; kept narrowly per research.md decision 11, not newly adopted app-wide),
`shiki` 4.4.3 (already a dependency; extends its loaded theme set from two to three, research.md
decision 9), `zustand` 5.0.15 (already a dependency; one new store, `theme-store.ts`), Electron's
own `nativeTheme` module (no new package). No new npm dependency is introduced by this spec.

**Storage**: extends the existing `settings.json` (spec 001 data-model.md) with one new field,
`theme: ThemeSetting`. No new stored file.

**Testing**: none. Refract is a prototype (constitution, Development Workflow); each story is
verified by running the app per [quickstart.md](quickstart.md). Typecheck and production build
must pass before a change lands on `main`.

**Target Platform**: Windows 11 only.

**Project Type**: desktop-app (Electron: main, preload, renderer) — extends spec 001's shell, adds
no new process type.

**Performance Goals**: from the spec: a theme-picker choice repaints every visible pane and panel
within 1 second (SC-003); following System repaints within 2 seconds of a Windows light-or-dark
change (SC-002); a restart shows the right theme from the window's first paint with no observable
flash (SC-005).

**Constraints**: only the main process may set the native window chrome colour (`BrowserWindow.
setTitleBarOverlay`, constitution V — the renderer never touches window chrome directly, only a
typed IPC call and a pushed event); a theme switch carries no CSS transition (FR-017); every
built-in theme must meet WCAG AA (4.5:1 body text, 3:1 large text/non-text parts) across every
surface FR-010 lists (FR-011).

**Scale/Scope**: one `ThemeSetting` value (`'system'`) plus three built-in themes for this spec
(research.md decision 1); about a dozen CSS token groups per theme (base palette, state colours,
diff colours, scrollbar colours, syntax theme); 22 functional requirements across 4 user stories.

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1 design. Constitution v1.7.1.*

| Principle | Status | How the design meets it |
|---|---|---|
| I. OMP is the engine | Pass (not applicable) | This spec touches no OMP process, flag, or frame; it is a renderer/main UI and settings feature. |
| II. RPC wire contract | Pass (not applicable) | No RPC traffic is added or changed. |
| III. Session and process lifecycle | Pass (not applicable) | No Session, worktree, or process lifecycle is touched; the theme setting is app-wide (Assumptions), not per-Session. |
| IV. Evidence before design | Pass, with named gaps | Three Electron/Windows facts this design depends on are not yet proven and are marked UNVERIFIED in research.md (decisions 4, 5, 9); each gets a probe task that runs first in tasks.md, before any task that assumes its answer, with the result recorded in `docs/spike/FINDINGS.md`. |
| V. Electron security baseline | Pass | The renderer never sets window chrome directly: `theme.preview`/`theme.set` are typed, allowlisted IPC calls into main, which is the only place `BrowserWindow.setTitleBarOverlay` is called (spec 001 T100, main-only already). The one synchronous channel (`theme:bootstrap`) returns plain settings/OS data, nothing from the file system or a process, and goes through the same `contextBridge` allowlist as every other channel. No remote content, no renderer access to `nativeTheme` or `fs` directly. |
| Platform and Stack | Pass | Windows 11 only; Electron + Vite + React, strict TypeScript; the one Windows-specific fact (`nativeTheme.updated` reliability) is isolated to a probe and a single main-process listener, same pattern as spec 001's `jobObject.ts`. |
| Development Workflow | Pass | Spec Kit order (`/speckit.checklist` → `/speckit.plan` → `/speckit.tasks` → `/speckit.analyze` → `/speckit.taskstoissues`, this pass); no automated tests; typecheck and build gate; verified by running the app (quickstart.md). |

No violations, so the Complexity Tracking table is empty. No constitution amendment is needed.

## Project Structure

### Documentation (this feature)

```text
specs/007-app-themes/
├── spec.md
├── plan.md              # this file
├── research.md          # decisions and the three UNVERIFIED items
├── data-model.md         # ThemeId/ThemeSetting/ThemeDefinition, extended Settings, theme-store shape
├── quickstart.md         # how to run and verify each story
├── contracts/
│   └── ipc.md            # additions to spec 001's contracts/ipc.md
├── checklists/requirements.md
└── tasks.md               # produced by /speckit.tasks
```

### Source code (repository root, additions/changes to spec 001's layout)

```text
src/
├── shared/
│   ├── themes.ts                          # NEW: ThemeId, ThemeSetting, ThemeDefinition, THEMES table
│   ├── model.ts                           # EDIT: Settings gains `theme: ThemeSetting`
│   └── ipc.ts                             # EDIT: theme.preview/theme.set, theme:os-changed, themeBootstrap
├── main/
│   ├── index.ts                           # EDIT: registerTheme(), nativeTheme listener at startup
│   ├── ipc/
│   │   └── theme.ts                       # NEW: theme.preview/theme.set handlers, theme:bootstrap sync handler
│   └── store/
│       └── settings.ts                    # EDIT: default `theme: 'system'`
├── preload/
│   └── index.ts                           # EDIT: expose theme.preview/theme.set/onThemeOsChanged/themeBootstrap
└── renderer/
    ├── main.tsx                            # EDIT: bootstrap-driven initial class (no hardcoded '.dark'); next-themes ThemeProvider (forcedTheme)
    ├── state/
    │   └── theme-store.ts                 # NEW: zustand store, activeThemeId derivation, preview/save/cancel actions
    ├── styles/
    │   └── globals.css                     # EDIT: `.dark` → `.theme-light`/`.theme-dark`/`.theme-high-contrast`; new high-contrast token block
    └── features/
        ├── settings/
        │   ├── ThemePicker.tsx             # NEW: picker list (System + 3 built-ins), swatches, keyboard nav
        │   └── AppearanceSection.tsx       # NEW: mounts inside spec 004's Settings screen
        └── chat/
            └── Markdown.tsx                 # EDIT: useIsDarkTheme → useActiveThemeId; Shiki theme set extended to 3
docs/
├── spike/
│   ├── theme-probe.mjs                     # NEW: probes nativeTheme.updated, sendSync timing, Shiki theme name
│   └── FINDINGS.md                          # EDIT: new numbered item for the probe result
└── DESIGN.md                                # EDIT: "Look and feel" (three built-in themes, follow-system)
scripts/
└── check-theme-contrast.mjs                 # NEW: WCAG AA ratio check from globals.css's OKLCH tokens
CONTEXT.md                                   # EDIT: if it still calls out "no follow-system setting"
```

**Structure Decision**: no new source root; this spec only adds files inside spec 001's existing
`src/shared`, `src/main`, `src/preload`, `src/renderer` layout, plus one new spike script and one
new verification script at the repository root, matching spec 001's `docs/spike/` and (new)
top-level `scripts/` convention. `AppearanceSection.tsx` and `ThemePicker.tsx` are new files under
`src/renderer/features/settings/`, a folder this spec introduces because spec 004 (Settings
screen) had not yet created it as of this planning pass; if spec 004 lands first and creates that
folder with a different shell component name, this spec's two files are added alongside it, not
renamed to match — their names are independent of the screen's own shell.

## Design overview

- **One derived theme state, not an imperative revert.** `theme-store.ts` holds
  `{ settingsTheme, osDark, previewing }` and always recomputes the active theme id from those
  three fields (data-model.md); Cancel, Esc, and navigating away are all just "clear `previewing`"
  with no separate restore logic (research.md decision 7).
- **CSS owns colour, JS owns metadata.** `src/shared/themes.ts` carries only what the picker, the
  Shiki theme choice, and the title-bar overlay call need (name, swatch, mode, syntax theme id,
  overlay colours); the actual token values stay in `globals.css`, one class per theme (research.md
  decision 2).
- **Main is the only process that touches window chrome or `nativeTheme`.** The renderer calls
  `theme.preview`/`theme.set` and listens for `theme:os-changed`; it never imports `nativeTheme` or
  calls `BrowserWindow` methods itself (constitution V).
- **No flash, by blocking one synchronous call.** `main.tsx`'s first lines call
  `window.refract.themeBootstrap()` (a synchronous IPC call) before anything renders, so the very
  first paint already has the right class (research.md decision 4).
- **Cross-spec surfaces are dependency notes, not tasks that edit another spec's files**: the
  Appearance section mounts inside spec 004's Settings screen once that screen exists; the
  title-bar overlay call is inert until spec 001 T100 lands; Mermaid theming's colour mapping is
  built now but only wired in once spec 001 T066 lands; spec 008's profile Theme submenu reuses
  this spec's `theme-store.ts` actions and `THEMES` table.

### Build order and dependencies on other specs

1. **Spec 001 T088** (scrollbar colour tokens) and **spec 007's own high-contrast token task**
   (tasks.md) can land in either order: whichever lands first introduces the scrollbar-thumb/
   track/hover token names in `globals.css`; the other then only adds that theme's values under
   names that already exist. Neither blocks the other.
2. **Spec 001 T100** (hidden title bar, `titleBarOverlay`) must land before `theme.preview`/
   `theme.set`'s title-bar overlay call does anything visible; until then it is a guarded no-op
   (contracts/ipc.md). This does not block any other part of this spec.
3. **Spec 004** (Settings screen) must land its screen shell before `AppearanceSection.tsx` can be
   mounted inside it (User Story 2's task). Every other story's tasks (System-follow, the theme
   data layer, every surface repainting, persistence) do not depend on spec 004 and can land first.
4. **Spec 001 T066** (Mermaid rendering) must land before the Mermaid-theming task does more than
   add a colour-mapping table (research.md decision 10).
5. **Spec 008**'s profile Theme submenu is sequenced after this spec's `theme-store.ts` and
   `THEMES` exist, since it reuses both rather than defining its own.

## Phase 1 re-check (post-design)

The data model, contracts, and quickstart introduce no new process, native module, or renderer
capability beyond those already covered by the Constitution Check: the one synchronous IPC call
and the one `nativeTheme` listener are both ordinary, already-allowlisted patterns extended to one
new fact (the theme setting) rather than a new category of capability. The three UNVERIFIED items
(research.md decisions 4, 5, 9) remain the only open evidence gaps and are each a first task in
tasks.md.

## Complexity Tracking

None — the Constitution Check above has no violations.
