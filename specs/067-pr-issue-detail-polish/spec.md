# spec 067: Pull request and Issue detail polish (#1397, #1393, #1389, #1391)

Four small renderer changes in one batch. Renderer only: no Rust, no IPC change.

## Clarifications

### Session 2026-10-30 (self-grill, Skippy delegated by Stuart; each issue already carries Stuart's grill answers)

- Q: Copy link label? [Decided] "Copy Issue Link", as #1397 states (the UI ruling suggested "Copy link"; the issue wins). Announcement "Issue link copied", as `IssueCreatedPanel.tsx`.
- Q: CopyButton size? [Decided, ui-architect-v3] Keep the default `icon-xs` (24px, the same as `RefreshButton`'s `icon-sm`); no className.
- Q: Which states hide the PR actions? [Decided, #1393 grill] `merged` and `closed` only. `draft` keeps today's behaviour, so the predicate is not `state !== 'open'`.
- Q: Focus after a merge when Merge unmounts? [Decided, #1393] `onMerged` reloads; the Merge dialog already falls back to the heading (`restoreFocusFallbackTo={headingRef}`), so no new code. The fork warning cannot open from a hidden New session button.
- Q: Spacing that replaces each divider? [Decided, ui-architect-v3] Header `p-4` loses its border (16px plus the tabs' `mt-2` gives 24px). Checks and Comment box become `px-4 pt-2 pb-4`, because the Timeline above ends with `p-4`, so every region gap is 16 + 8 = 24px. ChecksSection changes one class only (palette slice 2 edits that file).
- Q: Dark (high contrast) keeps these lines? [Decided, #1389 grill] No. Whitespace only. Recorded as a region-divider exception in `docs/design/accessibility.md`.
- Q: Shared width? [Decided, ui-architect-v3] Export `FILTER_PICKER_CLASS = 'w-40 shrink-0'` from `ProjectListPane.tsx`, used by the Project and Label pickers. `OptionSelect`'s default (Usage filters) is unchanged; those filters are out of scope and ADR 0003 asks for a caller re-check before changing a shared default.
- Q: Truncation? Verified in the live check.

## Functional requirements

- FR-1 (#1397): The Issue detail header shows the shared icon-only `CopyButton` (label "Copy Issue Link") after Open on GitHub. The local `copied` state, `copyLink` handler and `sr-only` status are removed.
- FR-2 (#1393): `PullRequestDetail` omits Merge, Review and New session when `detail.state` is `merged` or `closed`. Refresh and Open on GitHub always show. Open and draft pull requests are unchanged.
- FR-3 (#1389): The PR detail header, Checks section and Comment box draw no horizontal line; the spacing in the clarifications replaces them. Timeline cards, the comment editor box, the per-file diff header, the tab bar and the vertical pane borders are unchanged.
- FR-4 (#1391): The Project and Label pickers in the Filters panel are 160px wide and never shrink or grow; a narrow column wraps them (the row keeps `flex-wrap`).

## Success criteria

- SC-1: Each change is visible in the built app (screenshots in the session files folder).
- SC-2: `pnpm ci:local` and `pnpm check:ui-text` pass.
- SC-3: No new tests (rapid-prototyping phase); existing assertions change only where the intended behaviour changed.
