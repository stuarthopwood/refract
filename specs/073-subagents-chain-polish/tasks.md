# tasks 073

- [x] T001 Card classes on the chain row (#1436)
- [x] T002 Dated exception in components.md (#1436)
- [x] T003 Shared status classifier and `settle_subagent` (#1437)
- [x] T004 Settle transcript items from batch, jobs and lifecycle paths (#1437)
- [x] T005 `pnpm ci:local`
- [x] T006 Live check with fake omp (lifecycle-only settle)
- [x] T007 Review gate

## Phase 2: Convergence

- [ ] T010 Keep a background `task` end Running in `apply_batch_task_result` per FR-4 (missing)
- [ ] T011 Settle still-Running subagent items Done after history replay per FR-5 (missing)
- [ ] T012 Rust tests: async end stays Running, `wait` jobs settle with duration, sync end Done, history replay per SC-4 (missing)
- [ ] T013 `pnpm ci:local`, live check with fake omp or log proof (missing)

## Phase 3: Convergence

- [x] T014 Add the opt-in `elbows` option to `SpineList`/`SpineItem` (decorative border tick, forced-colors safe) per FR-6
- [x] T015 Export the `h-5 w-4` icon-slot class from `CollapsedLine` and use it in the Stage and agent rows per FR-8
- [x] T016 Rebuild `ChainStageLine` as an `items-center` Stage row (icon, truncated title, right-end duration, `StageUsesLine` below) with agents in a nested elbowed `SpineList` per FR-7, FR-8
- [x] T017 Turn elbows on for the card's Stage list in `SubagentChainRow` per FR-7
- [x] T018 `pnpm ci:local`, live check `scripts/verify-tauri-1622.mjs` in dark, light and high-contrast per SC-5
