# Implementation Plan: Brand watermark

**Branch**: `spec-012-brand-watermark` | **Date**: 2026-10-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/012-brand-watermark/spec.md`

## Summary

Add a faint, single-colour, non-interactive rendering of the new brand mark
(`src/renderer/assets/brand/refract-hero.svg`, prerequisite) anchored to the bottom-right corner of
the chat area — one instance regardless of a single pane or a split (spec 005), sized by a CSS
container-query clamp, coloured from the active theme's own `--muted-foreground` token (spec 007),
and controlled by one new app-wide `watermarkEnabled` setting (default on) in the Settings screen's
existing Appearance section (spec 007), with a small dedicated preview so the switch is checkable
without leaving Settings. The mark never shows on Settings, Readiness, or the future Manage
sessions screen, never intercepts pointer events or Tab focus, is hidden under Windows High
Contrast, and is proven not to drop any themed surface below WCAG 2.2 AA. Design rationale is in
[research.md](research.md); the one new IPC method is in [contracts/ipc.md](contracts/ipc.md).

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

**Constraints**: the mark must never intercept a pointer event or a text selection (FR-011), must
never join the Tab order or be announced to assistive technology (FR-012), must disappear entirely
under `forced-colors: active` regardless of the setting (FR-013), and must not drop any themed
surface below WCAG 2.2 AA at its documented opacity (FR-014). It must cost nothing at runtime
beyond its one-time paint: no animation, no per-frame JavaScript, no new dependency, no remote
request (FR-021).

**Scale/Scope**: one new boolean setting, one new IPC method, one new component (plus its reuse as
a Settings preview), a handful of new CSS declarations; 21 functional requirements across 4 user
stories.

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1 design. Constitution v1.8.0.*

| Principle | Status | How the design meets it |
|---|---|---|
| I. OMP is the engine | Pass (not applicable) | This spec touches no OMP process, flag, or frame; it is a renderer/main UI and settings feature. |
| II. RPC wire contract | Pass (not applicable) | No RPC traffic is added or changed. |
| III. Session and process lifecycle | Pass (not applicable) | No Session, worktree, or process lifecycle is touched; the setting is app-wide (Assumptions), not per-Session. |
| IV. Evidence before design | Pass (not applicable) | Nothing this spec depends on is an OMP/RPC behaviour; the one platform fact it relies on (CSS container query units in this app's pinned Electron/Chromium) is an already-shipped, multi-year-old web standard, not a project-specific unknown — research.md decision 6 cites the shipped version rather than marking it UNVERIFIED. No probe task is needed. |
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
├── research.md           # 12 decisions, no UNVERIFIED items
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
    │   └── globals.css                      # EDIT: `--watermark-opacity` in :root, `.watermark-mark`/`.watermark-mark--preview` rules, forced-colors hide rule
    └── features/
        ├── chat/
        │   └── BrandWatermark.tsx          # NEW: the shared mask-image component (`live`/`preview` variants)
        └── settings/
            └── AppearanceSection.tsx       # EDIT: new sub-section — Switch + description + <BrandWatermark variant="preview" />
App.tsx                                      # EDIT: wraps the "chat" ResizablePanel's existing <ErrorBoundary> in a new relative/container-type div, mounts <BrandWatermark variant="live" /> as its first child (research.md decision 8)
docs/
└── DESIGN.md                                # EDIT: "Look and feel" (new bullet), "Settings in the first build" (new line)
scripts/
└── check-theme-contrast.mjs                 # EDIT: extend to include the watermark's worst-case composited pair, per built-in theme preset (spec 007's established hand-run pattern)
```

**Structure Decision**: no new source root and no new renderer-only store; this spec only adds one
new component file (`BrandWatermark.tsx`) and extends spec 001's existing `settings.json`/IPC/
Settings-screen plumbing in place, reusing spec 004's `AppearanceSection.tsx` host and spec 007's
theme tokens exactly as they already exist on `main` in this checkout.

## Design overview

- **One boolean, one setter, reusing an established pattern exactly** (research.md decision 10):
  `watermarkEnabled` and `setWatermarkEnabled` mirror `sessionReadout`/`setReadoutVisibility`
  field-for-field, not a new shape.
- **One component, two variants, never two implementations** (data-model.md): `BrandWatermark.tsx`
  is the single source of the mark's visual, mounted once live in `App.tsx` and once, at a fixed
  smaller size, as the Settings preview — so the preview can never visually drift from the real
  mark.
- **CSS owns placement and colour; JS owns only the on/off boolean.** No React state tracks size,
  position, or opacity — those are container-query clamps and theme tokens in `globals.css`
  (research.md decisions 4-7); the component's only runtime decision is `watermarkEnabled ? render
  : null`.
- **The clipping boundary is scoped to the mark's own leaf wrapper, never an ancestor of real
  content** (research.md decision 8): the one new wrapper `div` `App.tsx` adds has no `overflow`
  rule of its own, so no existing Radix-portaled popover, dropdown, or hover card is put at risk of
  being clipped.
- **Full-screen views stay watermark-free by construction, not by a suppression flag**
  (research.md decision 2): because the mark is mounted inside the "chat" `ResizablePanel`'s own
  subtree, and `App.tsx` already replaces that whole region's render branch for
  Settings/Readiness/the future Manage sessions screen, there is no extra `view === 'chat'` check
  to add or forget.

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
