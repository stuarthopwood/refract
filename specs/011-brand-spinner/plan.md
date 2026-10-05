# Implementation Plan: Brand spinner

**Branch**: `spec-011-brand-spinner` | **Date**: 2026-10-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/011-brand-spinner/spec.md`

## Summary

`sessionDisplay.tsx`'s `StateIcon` -- the one shared component `docs/DESIGN.md`'s "Shared status
icon" rule already funnels every session-status surface through -- draws its `working` case with
`lucide-react`'s `LoaderCircleIcon` and a plain `animate-spin` class. This feature replaces that one
branch with a new `BrandSpinner` component: an inline SVG rendering of the redesigned app mark
(`build/refract-icon-v2.svg`), animated with a staggered per-arm opacity/lift cascade driven purely
by CSS, synchronised across every concurrently-mounted instance by a computed negative
`animation-delay`, with a simplified (no-facet) variant below a 24px legibility floor and a full
(faceted) variant above it. Every other existing spinner in the app (seven further `animate-spin`
sites across six files, plus one pulsing-dot indicator) is deliberately left unchanged
(research.md decision 1). No Settings, persistence, or IPC surface is added.

## Technical Context

**Language/Version**: TypeScript 7.0.2 as bundled by Electron 44.5.1 / React 19.3.0 in the
renderer. Same stack as every prior spec; no version change.

**Primary Dependencies**: `lucide-react` 1.49.0 (one import removed from `sessionDisplay.tsx`, no
new import added anywhere else in this feature). No new dependency (FR-004).

**Storage**: None. Renderer-only; no `registry.json`/`settings.json`/`processes.json` change.

**Testing**: none. Refract is a prototype (constitution, Development Workflow); each story is
verified by hand per [quickstart.md](quickstart.md). `pnpm typecheck` and `pnpm build` MUST pass
before a change lands on `main`.

**Target Platform**: Windows 11 only, desktop-app (Electron), renderer process only. No new
process type, no new source root.

**Project Type**: desktop-app (Electron); same single-project layout as every prior spec.

**Performance Goals**: no perceptible scroll/input stutter in the session list with twenty or more
concurrent `working` Sessions (FR-013, SC-005); zero per-frame JavaScript cost regardless of
instance count (research.md decision 5).

**Constraints**: inline SVG only, no raster asset, no new dependency, no remote request, passes the
existing CSP (FR-004); animation via `transform`/`opacity` only (FR-005); reuses the existing
global `prefers-reduced-motion: reduce` block, no new media query (FR-008).

**Scale/Scope**: one new component file, one edited feature file, one CSS addition (new
`@keyframes`), one `docs/DESIGN.md` bullet amended. Two user stories.

## Constitution Check

*GATE: passes before Phase 0 research; re-checked after Phase 1 design. Constitution v1.8.0.*

| Principle | Status | How the design meets it |
|---|---|---|
| I. OMP is the engine | Pass (not applicable) | This feature touches no OMP process, RPC call, or command; it is a renderer-only UI/styling change to one existing component. |
| II. RPC wire contract | Pass (not applicable) | No RPC traffic is added, removed, or changed. |
| III. Session and process lifecycle | Pass (not applicable) | No worktree, process, or session-lifecycle behaviour is touched; `SessionStatus` and how it is computed are unchanged -- only how the existing `working` value is drawn changes. |
| IV. Evidence before design | Pass, no new gate needed | Every behaviour this design depends on (the inventory in research.md decision 1, the exact call sites and line numbers, `globals.css`'s existing reduced-motion block) was read directly from this worktree's own source, not assumed. The one general-web-platform technique this design introduces (negative `animation-delay` for phase sync, research.md decision 5) is long-established CSS behaviour, not an OMP-, Electron-, or Windows-version-specific fact, so no `docs/spike/FINDINGS.md` probe is needed (the same "no probe needed" reasoning spec 010 used). |
| V. Electron security baseline | Pass | The component is an ordinary renderer React component with no new IPC channel, no new privileged capability, and no raster/remote asset; it renders under the existing CSP unchanged (FR-004). |
| Platform and stack | Pass | Windows 11 only; no new dependency; TypeScript strict unaffected. |
| Development workflow | Pass | Spec Kit order followed (`/speckit.specify` -> `/speckit.plan` -> `/speckit.tasks` -> `/speckit.taskstoissues`); no automated tests scheduled; typecheck and build gate the change before it lands on `main`. |

No violations, so the Complexity Tracking table is empty.

## Project Structure

### Documentation (this feature)

```text
specs/011-brand-spinner/
├── spec.md          # this feature's spec
├── plan.md           # this file
├── research.md        # Phase 0: the spinner inventory and the ten further design decisions
├── data-model.md       # Phase 1: BrandSpinnerProps, the variant-selection rule, the animation/clock shape
├── quickstart.md       # Phase 1: how to run and verify each story
└── tasks.md            # Phase 2 output (/speckit.tasks)
```

No `contracts/` directory: this feature crosses no IPC boundary and adds no new wire shape
(data-model.md "No change to existing entities"), the same reasoning spec 010 used for omitting
one.

### Source code (repository root, additions only -- every prior spec's tree is otherwise unchanged)

```text
src/renderer/
├── components/
│   └── brand/
│       └── BrandSpinner.tsx      # NEW: the component (research.md decision 9)
├── features/sessions/
│   └── sessionDisplay.tsx         # EDIT: StateIcon's `working` case renders <BrandSpinner size={16} /> instead of LoaderCircleIcon
└── styles/
    └── globals.css                 # EDIT: adds BrandSpinner's @keyframes; no change to the existing prefers-reduced-motion block, which already covers it

docs/
└── DESIGN.md                        # EDIT: "Shared status icon" bullet names the brand mark (research.md decision 11)
```

**Structure Decision**: no new source root; this feature adds one file under a new
`src/renderer/components/brand/` directory (sibling to the existing `components/ui/` and
`assets/brand/`, research.md decision 9) and edits two existing files plus one doc. No change to
`src/main`, `src/preload`, or `src/shared` -- nothing here crosses the renderer/main boundary.

## Design overview

- **One component, one call site changed.** `BrandSpinner.tsx` is new; the only existing file whose
  *rendering* changes is `sessionDisplay.tsx`'s `StateIcon` `working` branch (FR-001). Its three
  callers (`ChatHeader.tsx`, `SessionDetailsCard.tsx`, `SessionList.tsx`) are untouched -- they
  already call `StateIcon` the same way regardless of what it renders internally (FR-012).
- **Every other `animate-spin` site is a deliberate non-change**, not an oversight (research.md
  decision 1, spec.md FR-003); tasks.md's Polish phase re-greps to confirm none were accidentally
  touched (SC-001).
- **No React state anywhere in this feature.** The animation is pure CSS keyframes plus one
  mount-time-computed `animation-delay`; the legibility-floor variant choice is a pure function of
  the `size` prop (data-model.md); nothing here needs a zustand store, unlike every data-carrying
  feature before it.
- **`globals.css` gets one addition, not a new rule.** The existing `@media
  (prefers-reduced-motion: reduce)` block (lines 260-269) already matches `*, *::before, *::after`,
  so `BrandSpinner`'s new `@keyframes`-driven elements are already covered the moment they exist;
  nothing in that block needs editing (research.md decision 6).
- **Colour is the one deliberate exception to "everything follows the theme".** Spec 007 FR-007
  requires every themed surface to take its colours from the active theme; this component is
  explicitly not a themed surface (research.md decision 7), the same way the app icon itself
  (`docs/DESIGN.md` "Fonts" bullet: "The app icon itself (`build/icon.ico`) is a separately authored
  image asset") sits outside the theme system.
- **`docs/DESIGN.md` gets one precise edit**, not a rewrite of the whole "Shared status icon"
  bullet (research.md decision 11); the pre-existing "status bar"/"tooltips" surface-count
  inaccuracy in that same bullet (research.md decision 12) is explicitly left alone.
- **Build order**: `BrandSpinner.tsx` and its `@keyframes` first (nothing else can land without
  it), then the one-line `StateIcon` edit, then the `docs/DESIGN.md` note and a final repo-wide
  verification pass. The two user stories do not have independent build orders the way a
  multi-surface feature would -- User Story 2's qualities (legibility, reduced motion, shared clock,
  performance) are properties of the one component built for User Story 1, not separate code.

## Complexity Tracking

None. No violations.
