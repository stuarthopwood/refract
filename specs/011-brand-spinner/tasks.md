# Tasks: Brand spinner

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [quickstart.md](quickstart.md)

**Prerequisites**: the redesigned brand assets (`build/refract-icon-v2.svg`,
`src/renderer/assets/brand/refract-hero.svg`) landed first (spec.md "Prerequisite"). Spec 007 (app
themes) already on `main`. Windows 11 only.

**Tests**: none. Refract is a prototype (constitution, Development Workflow). Each phase ends with
a **Checkpoint** that runs the matching [quickstart.md](quickstart.md) section by hand, on the
built app. `pnpm typecheck` and `pnpm build` MUST pass before a change lands on `main`.

**Organization**: tasks are grouped by user story. Paths are relative to the repository root. Task
IDs in this file (`T001` onward) are local to spec 011.

**GitHub issues**: every task below gets an issue titled `011-Tnnn: ...` on the existing
`stuarthopwood/refract` repo; issue numbers are recorded on each task line as `(#NNN)` once
created, and the full mapping is posted as a comment on the tracking issue and kept here.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: the user story from [spec.md](spec.md) (US1, US2). Foundational and Polish tasks
  carry no story label.

---

## Phase 1: Foundational (blocks both user stories)

**Purpose**: the component and its CSS every story builds on.

- [X] T001 (#398) [P] Write `src/renderer/components/brand/BrandSpinner.tsx`: `BrandSpinnerProps`
  (`size: 16 | 20 | 24 | 32 | 48`, `className?: string`), the exported `LEGIBILITY_FLOOR_PX = 24`
  constant, the size-ladder-gated choice between two separately authored path sets -- Full (every
  facet, built from the prerequisite mark's own path data) at 24/32/48px, and a placeholder
  Simplified set (hand-tuned for real in T010) at 16/20px -- a fixed core group, always
  `aria-hidden` with no accessible-name prop (research.md decisions 2, 4, 7, 8), the per-arm
  opacity-only cascade (0.35 baseline to 1.0 peak, no `transform`/"lift") with the mount-time
  computed `animation-delay` (`-(Date.now() % 1200)` ms, research.md decisions 3, 5), and the 16px
  internal positioning needed so the rendered mark's vertical centre aligns with adjacent row text
  within 0.5px (FR-015, research.md decision 13).
- [X] T002 (#399) [P] Add the spinner's `@keyframes` to `src/renderer/styles/globals.css`: one
  definition (or one reused by all three arms with different `animation-delay`s) whose `0%`/`100%`
  frames are identical "at rest" frames (each arm at its dim 0.35 baseline opacity, never the
  bright peak) with one brief frame partway through reaching the 1.0 peak, 1.2s, ease-in-out,
  infinite, animating only `opacity` -- no `transform`, `filter`, or `box-shadow` (research.md
  decisions 3, 5, 6, spec.md FR-005); no edit needed to the existing `@media
  (prefers-reduced-motion: reduce)` block (lines 260-269), which already matches `*, *::before,
  *::after` and therefore already covers the new keyframes.
- [X] T009 (#427) Add `@media (forced-colors: active)` to the same stylesheet (`globals.css`): map
  the spinner's arm and core fills to system colour keywords (for example `CanvasText`) instead of
  their fixed brand hex values (FR-014, research.md decision 14) (depends on T002, same file).
- [ ] T010 (#428) [P] Author and verify the dedicated Simplified path set for real, at both its
  ladder sizes (16px, 20px): hand-tune flat, single-tone arm hulls with the gaps between arms and
  the core optically widened, replacing T001's placeholder; render it side by side with the Full
  variant scaled down to 16px and capture a throwaway rasterised comparison as evidence that the
  dedicated set reads more clearly, then discard the comparison harness entirely (FR-006,
  research.md decision 2) (depends on T001).

**Checkpoint**: `pnpm typecheck` and `pnpm build` pass; `BrandSpinner` renders (temporarily mounted
anywhere, e.g. a throwaway line in a dev scratch file not committed) without throwing, at every
ladder size, with the Simplified and Full variants visibly distinct; the rasterised comparison
evidence (T010) confirms the Simplified variant is more legible at 16px than the Full variant
scaled down; the forced-colors fills (T009) are visible in a quick toggle of a Windows contrast
theme.

---

## Phase 2: User Story 1 - The working indicator is the brand mark (Priority: P1)

**Goal**: `StateIcon`'s `working` case renders `BrandSpinner` instead of `LoaderCircleIcon`, and
every one of its three callers shows the identical result with no other change.

**Independent test**: [quickstart.md](quickstart.md) Story 1.

- [X] T003 (#400) [US1] Edit `src/renderer/features/sessions/sessionDisplay.tsx`: remove the
  `LoaderCircleIcon` import and its use in `StateIcon`'s `working` case; render `<BrandSpinner
  size={16} aria-hidden className={cn(className, 'shrink-0')} />` in its place, leaving `idle`,
  `needs-you`, and `stopped` untouched, and `StateIcon`'s own `{ status: SessionStatus }` props
  signature unchanged (FR-001, FR-012) (depends on T001).
- [ ] T004 (#401) [US1] Verify live, on the built app: quickstart.md Story 1 checks 1 to 7 -- the brand
  mark appears identically in the session list, chat header, and details card; the other three
  states are unchanged; several concurrent working Sessions stay phase-locked; the sr-only
  "Working" announcement is unaffected; a repository-wide `animate-spin` search finds it only in
  the seven kept sites (SC-001, SC-002) (depends on T002, T003).

**Checkpoint**: quickstart.md Story 1 passes in full; `pnpm typecheck` and `pnpm build` pass.

---

## Phase 3: User Story 2 - The mark stays legible, calm, and cheap (Priority: P2)

**Goal**: confirm the component built in Phase 1 actually delivers legibility at 16px, honours
reduced motion, stays phase-locked and cheap at twenty-plus concurrent instances, is
theme-invariant, stays visible under Windows forced-colors mode, and optically aligns with
adjacent row text -- properties of the one component Phase 1 built, not separate new code (plan.md
"Design overview").

**Independent test**: [quickstart.md](quickstart.md) Story 2.

- [ ] T005 (#402) [US2] Verify live, on the built app: quickstart.md Story 2 checks 1 to 7 -- the
  16px Simplified variant reads clearly; turning off Windows' "Animation effects" freezes every
  visible spinner on a uniform dim rest frame while the sr-only text is unaffected, and turning it
  back on resumes the animation; twenty-plus concurrent working Sessions scroll smoothly with no
  attributable stutter (DevTools Performance panel); the rendered colours are pixel-identical
  under the Dark and Dark (high contrast) presets; DevTools confirms only `opacity` is animated
  (no `transform`, `filter`, or `box-shadow`) and that two simultaneous instances' computed
  `animation-delay`s differ by a multiple of 1.2s; under a Windows contrast theme the mark's
  fills switch to system colour keywords and stay visible (FR-014); the 16px mark's rendered
  vertical centre aligns with the adjacent session name's vertical centre within 0.5px in all
  three call sites (FR-015) (FR-005 to FR-011, FR-013 to FR-015, SC-003 to SC-007) (depends on
  T003, T004, T009, T010).
- [ ] T006 (#403) [US2] Build and verify the forward-provisioned large size (research.md decision 10):
  temporarily render `<BrandSpinner size={48} />` behind an unshipped harness (for example, a
  throwaway line added to `src/renderer/features/readiness/Readiness.tsx` and reverted before
  committing), confirm it renders the Full, faceted variant legibly, then remove the harness
  entirely so no trace of it remains in the committed tree (`git diff` confirms `Readiness.tsx` is
  unchanged by this task) (FR-011) (depends on T001, T002).

**Checkpoint**: quickstart.md Story 2 passes in full; the large-size harness check is done and
fully reverted; `pnpm typecheck` and `pnpm build` pass.

---

## Phase 4: Polish

**Purpose**: documentation and a final repository-wide confirmation that nothing outside this
feature's stated scope moved.

- [X] T007 (#404) Edit `docs/DESIGN.md`'s "Shared status icon" bullet: replace "a spinning circle
  for working" with naming the brand mark spinner, and in the same edit correct the bullet's
  surface list from "session list, chat header, status bar, tooltips" to the three real surfaces
  (`SessionList`, `ChatHeader`, `SessionDetailsCard`), leaving the rest of the sentence (one shared
  `StateIcon` component, no surface draws its own icon) unchanged (research.md decisions 11, 12)
  (depends on T003).
- [ ] T008 (#405) Final verification pass: re-run quickstart.md Stories 1 and 2 end to end on the built
  app in one sitting; `grep -rn "animate-spin" src/renderer` confirms exactly the seven kept sites
  from research.md decision 1's table and no others; read `ToolRow.tsx`, `Transcript.tsx`,
  `SubagentPanel.tsx`, `SessionList.tsx`'s create-button, both `Readiness.tsx` sites, `sonner.tsx`,
  and `ChatPane.tsx`'s pulsing dot directly and confirm none of them changed; `pnpm typecheck` and
  `pnpm build` pass; commit (depends on T004, T005, T006, T007).

**Checkpoint**: both stories verified end to end; the kept-spinner inventory confirmed unchanged;
clean `pnpm typecheck`/`pnpm build`; committed.

---

## Dependencies and execution order

- **Foundational (Phase 1)**: T001 and T002 touch different files and can run together; T009
  depends on T002 (same file, `globals.css`); T010 depends on T001 and can run alongside T002/T009.
- **User Story 1 (Phase 2)**: needs Phase 1 complete. T003 is the entire code change; T004 verifies
  it.
- **User Story 2 (Phase 3)**: needs T003/T004 and the forced-colors/simplified-art tasks (T009,
  T010); T005 is verification-only, T006 is a build-then-revert task independent of the
  `StateIcon` wiring.
- **Polish (Phase 4)**: T007 needs T003 (an accurate doc note describing what actually ships); T008
  needs every earlier task done.

## Parallel examples

- Phase 1: T001 and T002 (different files: the component and the stylesheet); T010 alongside T002
  (T010 touches only `BrandSpinner.tsx`, T002/T009 touch only `globals.css`).
- No task in Phase 2 is parallelizable with another (T004 depends on T003).
- Phase 3: T005 and T006 touch no overlapping files and could run together once their own
  dependencies (T004, T009, T010; T001+T002) are met.

## Implementation strategy

1. **MVP**: Phase 1 + Phase 2 (Story 1). Stop and run quickstart Story 1; this alone is the entire
   feature Stuart asked for.
2. Add Story 2 next: it is verification that the same component already built is legible, calm,
   and cheap -- the only further production code is the forced-colors CSS and the dedicated
   Simplified path set (T009, T010), both already part of Phase 1; the large-size harness (T006)
   is reverted before committing.
3. Polish last: the one doc bullet, a final repo-wide confirmation, commit.

## Notes

- Commit after each phase; keep this branch building.
- FR and SC ids in task text refer to [spec.md](spec.md).
- GitHub issues created with `gh issue create` directly against the existing
  `stuarthopwood/refract` repo, following the `011-Tnnn: ...` title convention.

### Implementation evidence (parent, 2026-10-06, scratch profile, real CDP, Dark theme)

- T006: a throwaway change to `StateIcon` rendered the 24, 32 and 48px sizes; all three show the Full faceted mark. The harness was reverted (`git diff` shows only the CSS fix below). Checked.
- T004 (partly verified): session list rows (working x3, idle, needs-you, stopped) show the brand mark for working and the unchanged icons for the other three; the 16px icon's vertical centre equals the row centre for every state (144/194/244 vs 294/344/394 pairs); `aria-hidden="true"`; three concurrent instances share one animation clock (computed delays -0.992s, -1.002s, -1.009s, all within 1.2s). NOT verified: the chat header and details card call sites (they use the same `StateIcon`), the sr-only "Working" announcement.
- T005 (partly verified): only `opacity` is animated (`brand-spinner-arm-1/2/3` keyframes); arm opacity cycles 0.35 to 1.0 live; under `prefers-reduced-motion: reduce` every arm settles on the uniform 0.35 rest frame and the core stays at 1 (this found a bug, fixed in this branch: the base arm opacity was 1, so the animation's end reverted to the bright frame; the base is now 0.35); under emulated forced colors the arm fills compute to the system `CanvasText` colour. NOT verified: the real Windows "Animation effects" toggle, twenty-plus concurrent instances in the DevTools Performance panel, Dark vs Dark (high contrast) pixel comparison, a real Windows contrast theme.
- T010: the dedicated Simplified set ships (four separated flat shapes at 16/20px, read clearly at 10x zoom). The side-by-side raster comparison against a scaled-down Full variant was NOT captured, so T010 stays unchecked.
- T008: `animate-spin` now appears in 11 places, none in `StateIcon`: the seven sites from research.md decision 1 plus four added by spec 003 (`PullRequestDetail` twice, `PullRequestList`, `PullRequestRow`). Unchecked until Stories 1 and 2 are run in one pass.

### Task-to-issue mapping

| Task | Issue |
|---|---|
| T001 | [#398](https://github.com/stuarthopwood/refract/issues/398) |
| T002 | [#399](https://github.com/stuarthopwood/refract/issues/399) |
| T003 | [#400](https://github.com/stuarthopwood/refract/issues/400) |
| T004 | [#401](https://github.com/stuarthopwood/refract/issues/401) |
| T005 | [#402](https://github.com/stuarthopwood/refract/issues/402) |
| T006 | [#403](https://github.com/stuarthopwood/refract/issues/403) |
| T007 | [#404](https://github.com/stuarthopwood/refract/issues/404) |
| T008 | [#405](https://github.com/stuarthopwood/refract/issues/405) |
| T009 | [#427](https://github.com/stuarthopwood/refract/issues/427) |
| T010 | [#428](https://github.com/stuarthopwood/refract/issues/428) |

Created with `gh issue create` (2026-10-05) against the existing `stuarthopwood/refract` repo.
Posted as a comment on tracking issue [#397](https://github.com/stuarthopwood/refract/issues/397).
