# Tasks: Transcript row action gutter (#1612)

No test tasks: the prototyping rule forbids new tests; existing tests are only run.

## Phase 1: Discovery
- [ ] T001 Find existing tests and drivers that depend on the header layout (`data-slot=collapsible-trigger`, `flex items-start gap-1`) and on `ToolRowKebab`/`ChainShowPanelButton` classes. (FR-007)
- [ ] T002 Locate how existing drivers seed a transcript (recorded-frame fake omp tapes) and pick or write a tape with tool, failed tool, thought, note and asked-user rows. (SC-001)

## Phase 2: Implementation (US1, US2, US3)
- [ ] T003 `CollapsedLine.tsx`: header wrapper `group/line relative`, trigger fill on `group-hover/line:`, `aria-hidden` `w-6` gutter after the chevron, absolute action slot over it. (FR-001..FR-004)
- [ ] T004 `ToolRowMenu.tsx` and `SubagentChainRow.tsx`: drop the compensating offsets; chain `triggerClassName` to `group-hover/line:bg-row-hover-bg`. (FR-003, FR-007)
- [ ] T005 Confirm the non-expandable branch is untouched. (FR-006)

## Phase 3: Docs
- [ ] T006 `docs/design/components.md` and `docs/design/product-chat.md`: describe the gutter. (FR-008)
- [ ] T007 `CHANGELOG.md` Unreleased entry; `docs/PLAN.md` #1612 row "in review". (FR-008)

## Phase 4: Live driver
- [ ] T008 `scripts/verify-tauri-1612.mjs`: mixed transcript; assert chevron x-centres equal within 1px, trigger width equals row width, `…` hidden at rest and visible on hover with the chevron unmoved; screenshot default, hover and failed row. `node --check` only. (SC-001..SC-003)

## Phase 5: Checks
- [ ] T009 `pnpm typecheck`, targeted chat vitest files, `check:file-size`, `check:comment-density`, `check:spacing`. (SC-004)
