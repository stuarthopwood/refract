# Implementation Plan: Brand watermark

**Branch**: `spec-012-brand-watermark` | **Date**: 2026-10-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/012-brand-watermark/spec.md`

## Summary

Add a faint, single-colour, non-interactive rendering of the new brand mark
(`src/renderer/assets/brand/refract-hero.svg`, prerequisite) anchored to the bottom-right corner of
the **reading area** (the scrollable transcript region above the composer, corrected after design
review from an earlier draft that anchored to the outer chat panel and sat behind the opaque
composer) — one instance, belonging to the right-most or single pane regardless of a split (spec
005), sized by a CSS container-query clamp, coloured from the active theme's own
`--muted-foreground` token (spec 007), and controlled by one new app-wide `watermarkEnabled`
setting (default on) in the Settings screen's existing Appearance section (spec 007), in its own
sub-section separated from the theme picker's Save/Cancel row, with a small dedicated preview so
the switch is checkable without leaving Settings. The mark never shows on Settings, Readiness, or
the future Manage sessions screen, never intercepts pointer events or Tab focus, is hidden under
Windows High Contrast and reduced transparency (both confirmed real, recognised media features at
this app's pinned Electron/Chromium, research.md decision 11), and is proven not to drop any themed
surface below WCAG 2.2 AA using contrast numbers computed directly from the real tokens (research.md
decision 13), not an unverified estimate. Design rationale is in [research.md](research.md); the
one new IPC method is in [contracts/ipc.md](contracts/ipc.md).

## Technical Context

**Language/Version**: TypeScript (`strict: true`) on Node 24.21.0 as bundled by Electron 44.5.1;
React 19.3.0 in the renderer. Same stack as spec 001; no new runtime added.

**Primary Dependencies**: none new. CSS container query units (`cqw`) and `mask-image` are native
Chromium features already available in this app's pinned Electron version (research.md decision 6)
— no polyfill, no new npm package.

**Storage**: extends the existing `settings.json` (spec 001 data-model.md) with one new field,
`watermarkEnabled: boolean`. No new stored file.

**Testing**: none. Refract is a prototype (constitution, Development Workflow); each story is
verified by running the app per [quickstart.md](quickstart.md). `pnpm typecheck` and `pnpm build`
must pass before a change lands on `main`.

**Target Platform**: Windows 11 only.

**Project Type**: desktop-app (Electron: main, preload, renderer) — extends spec 001's shell, adds
no new process type.

**Performance Goals**: from the spec: toggling the switch changes the chat area and the Settings
preview within the same render pass, with no restart (SC-002); no measurable layout shift from the
mark at any window size or theme (SC-006).

**Constraints**: the mark must never intercept a pointer event or a text selection (FR-012), must
never join the Tab order or be announced to assistive technology (FR-013), must disappear entirely
under `forced-colors: active` or `prefers-reduced-transparency: reduce` regardless of the setting
(FR-014), must never be covered by the composer at any composer height (FR-007, by the reading
area's own `flex-1` layout, not a tracked CSS variable), and must not drop any themed surface below
WCAG 2.2 AA at its documented opacity (FR-015). It must cost nothing at runtime beyond its one-time
paint: no animation, no per-frame JavaScript, no new dependency, no remote request (FR-022).

**Scale/Scope**: one new boolean setting, one new IPC method, one new component (reused across up
to three mount points plus a Settings preview), a handful of new CSS declarations; 22 functional
requirements across 4 user stories.

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1 design. Constitution v1.8.0.*

| Principle | Status | How the design meets it |
|---|---|---|
| I. OMP is the engine | Pass (not applicable) | This spec touches no OMP process, flag, or frame; it is a renderer/main UI and settings feature. |
| II. RPC wire contract | Pass (not applicable) | No RPC traffic is added or changed. |
| III. Session and process lifecycle | Pass (not applicable) | No Session, worktree, or process lifecycle is touched; the setting is app-wide (Assumptions), not per-Session. |
| IV. Evidence before design | Pass (not applicable) | Nothing this spec depends on is an OMP/RPC behaviour. Two platform facts were verified directly rather than assumed: CSS container query units (research.md decision 6, an already-shipped, multi-year-old web standard) and `prefers-reduced-transparency` support at this app's pinned Electron 44.5.1/Chromium 152 (research.md decision 11, confirmed live via a throwaway Electron probe after a design review raised it). Neither is marked UNVERIFIED (constitution IV's marker is reserved for OMP/RPC facts); no probe task is needed in tasks.md since both are already resolved here. |
| V. Electron security baseline | Pass | The mark is pure CSS (`mask-image`) against the already-bundled `refract-hero.svg`, loaded under the existing CSP's `img-src 'self' data:` with no change (research.md decision 12); it makes no remote request. The one new IPC method (`settings.setWatermarkEnabled`) follows the existing typed, allowlisted `contextBridge` pattern, persisted only by main (`SettingsStore`), the same as every other `settings.*` setter. |
| Platform and Stack | Pass | Windows 11 only; Electron + Vite + React, strict TypeScript. |
| Development Workflow | Pass | Spec Kit order (`/speckit.checklist` → `/speckit.plan` → `/speckit.tasks` → `/speckit.taskstoissues`, this pass); no automated tests; typecheck and build gate; verified by running the app (quickstart.md). |

No violations, so the Complexity Tracking table is empty. No constitution amendment is needed.

## Project Structure

### Documentation (this feature)

```text
specs/012-brand-watermark/
├── spec.md
├── plan.md               # this file
├── research.md           # 14 decisions, no UNVERIFIED items
├── data-model.md          # Settings.watermarkEnabled, BrandWatermarkProps
├── quickstart.md          # how to run and verify each story
├── contracts/
│   └── ipc.md             # settings.setWatermarkEnabled
├── checklists/requirements.md
└── tasks.md                # produced by /speckit.tasks
```

### Source code (repository root, additions/changes to spec 001's layout)

```text
src/
├── shared/
│   ├── model.ts                            # EDIT: Settings gains `watermarkEnabled: boolean`
│   └── ipc.ts                              # EDIT: SETTINGS_SET_WATERMARK_ENABLED, RefractApi.settings.setWatermarkEnabled
├── main/
│   ├── store/
│   │   └── settings.ts                     # EDIT: default `watermarkEnabled: true`, migration merge, setWatermarkEnabled(), validation-on-read
│   └── ipc/
│       └── settings.ts                     # EDIT: registerSettings() gains the setWatermarkEnabled handler
├── preload/
│   └── index.ts                            # EDIT: expose settings.setWatermarkEnabled
└── renderer/
    ├── state/
    │   └── settings-store.ts               # EDIT: DEFAULT_SETTINGS.watermarkEnabled, setWatermarkEnabled action
    ├── styles/
    │   └── globals.css                      # EDIT: `--watermark-opacity` in :root (starting 0.06, documented ceiling 0.12, research.md decision 5/13), `.watermark-mark`/`.watermark-mark--preview` rules, combined forced-colors/reduced-transparency hide rule (research.md decision 11)
    └── features/
        ├── chat/
        │   ├── BrandWatermark.tsx          # NEW: the shared mask-image component (`live`/`preview` variants)
        │   └── ChatPane.tsx                # EDIT: new `showWatermark?: boolean` prop; mounts <BrandWatermark variant="live" /> inside its own transcript container (relative + [container-type:size] added to the existing class string) and its own `!session` Empty fallback (research.md decisions 1, 3, 8)
        └── settings/
            └── AppearanceSection.tsx       # EDIT: new sub-section, separated from the theme picker's Save/Cancel by a divider — Switch ("Background watermark") + description + <BrandWatermark variant="preview" /> (research.md decision 14)
App.tsx                                      # EDIT: passes `showWatermark` to exactly one rendered ChatPane (the single pane, or paneB/index 1 of a true split — never paneA); mounts <BrandWatermark variant="live" /> in its own `paneSessionIds.length === 0` div (research.md decision 3)
docs/
└── DESIGN.md                                # EDIT: "Look and feel" (new bullet), "Settings in the first build" (new line)
scripts/
└── check-theme-contrast.mjs                 # EDIT: extend to include the watermark's worst-case composited pair, per built-in theme preset (spec 007's established hand-run pattern; starting numbers already computed in research.md decision 13)
```

**Structure Decision**: no new source root and no new renderer-only store; this spec only adds one
new component file (`BrandWatermark.tsx`) and extends spec 001's existing `settings.json`/IPC/
Settings-screen plumbing in place, reusing spec 004's `AppearanceSection.tsx` host and spec 007's
theme tokens exactly as they already exist on `main` in this checkout. `ChatPane.tsx` is the one
file this spec touches that was not anticipated in the first draft, added after design review
confirmed the outer-panel anchor sat behind the composer (research.md decision 1) — the fix is a
smaller change than the first draft's own new App.tsx wrapper, not a larger one.

## Design overview

- **One boolean, one setter, reusing an established pattern exactly** (research.md decision 10):
  `watermarkEnabled` and `setWatermarkEnabled` mirror `sessionReadout`/`setReadoutVisibility`
  field-for-field, not a new shape.
- **One component, several mount points, never several implementations** (data-model.md):
  `BrandWatermark.tsx` is the single source of the mark's visual, mounted at whichever of up to
  three eligible places in `App.tsx`/`ChatPane.tsx` is actually active, plus once more, at a fixed
  smaller size, as the Settings preview — so the preview can never visually drift from the real
  mark, and there is only ever one real implementation to keep correct.
- **CSS owns placement and colour; JS owns only the on/off boolean and which pane is eligible.**
  No React state tracks size, position, or opacity — those are container-query clamps and theme
  tokens in `globals.css` (research.md decisions 4-7); the only runtime decisions are
  `watermarkEnabled ? render : null` and `App.tsx`'s existing single/right-pane computation,
  reused via the new `showWatermark` prop rather than duplicated inside `ChatPane`.
- **Composer clearance is a structural guarantee, not a tracked value** (research.md decisions 1,
  8): the mark is anchored to the reading area's own `flex-1` container, whose bottom edge is
  always exactly the composer's current top edge by ordinary flex layout — no `ResizeObserver`, no
  CSS variable tracking the composer's height, and so no way for the two to drift out of sync.
- **The clipping boundary reuses an existing one, never adds a new ancestor over real content**
  (research.md decision 8): `BrandWatermark` mounts inside the transcript container's own,
  already-present `overflow-hidden` (needed for `Transcript`'s scrolling regardless of this spec),
  so no existing Radix-portaled popover, dropdown, or hover card is put at any new risk of being
  clipped.
- **Full-screen views stay watermark-free by construction, not by a suppression flag**
  (research.md decision 2): because every mount point lives inside `App.tsx`'s chat-area render
  branch or `ChatPane.tsx` itself, and `App.tsx` already replaces that whole region's render branch
  for Settings/Readiness/the future Manage sessions screen, there is no extra `view === 'chat'`
  check to add or forget.
- **Amended 2026-11-04 (#1647)**: the mark is the shared inline SVG `BrandMark` (per-facet greys,
  `--watermark-tone-*` in `:root`), both marks target about 1.3:1 per theme, and the holiday glyph
  shows in transcript panes and the Appearance preview. `scripts/verify-tauri-1647.mjs` asserts
  the computed opacity, ratio and glyph live.

### Build order and dependencies on other specs

1. **The prerequisite brand-asset change** (branch `brand-icon-v2`, not yet merged into `main` as
   of this plan) must land first: `src/renderer/assets/brand/refract-hero.svg`. Every task in this
   spec that references that path is blocked until it exists; this spec does not recreate it.
2. **Spec 004's Settings screen** and **spec 007's Appearance section/theme tokens** are already
   built on `main` in this checkout (confirmed by direct read of `SettingsScreen.tsx`,
   `AppearanceSection.tsx`, `globals.css`'s `.theme-dark`/`.theme-dark-high-contrast` blocks) — no
   sequencing risk, unlike spec 007's own plan.md, which once had to wait on spec 004 landing
   first.
3. **Spec 005's split chat pane** is already built (`App.tsx`'s two-pane `ResizablePanelGroup`
   branch, `useSplitStore`) — this spec's User Story 1/4 tasks can be fully verified against it
   immediately, not deferred.
4. Within this spec: the Foundational phase (Settings field + IPC + store action) and User Story
   1's visual component can be built in either order relative to each other (they touch disjoint
   files) but both must land before User Story 2's Settings control, since that control calls the
   setter and renders the preview variant of the same component.

## Phase 1 re-check (post-design)

The data model and contracts introduce no new process, native module, or renderer capability beyond
those already covered by the Constitution Check: the one new IPC method is an ordinary,
already-allowlisted pattern extended to one new boolean fact, and the visual mark itself is pure CSS
against an already-bundled, already-CSP-covered asset. There are no open evidence gaps and no
UNVERIFIED items (Phase 0 found none needing a probe).

## Complexity Tracking

None — the Constitution Check above has no violations.
