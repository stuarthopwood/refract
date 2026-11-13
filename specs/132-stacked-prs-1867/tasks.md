# Tasks: Stacked pull requests via gh stack (#1867)

Test tasks are part of each task (AGENTS.md: new logic gets co-located unit tests; each guard's test must fail when the guard is removed, proven by mutating then restoring). 600-line cap. Run `ci:local` only in the last task. Slices are sized for one worker of about 40 requests; run them in order (each builds on the previous).

## Slice 1: setting, state, notes (FR-001, FR-002, FR-011 to FR-014)

- [x] T001 Setting `stackedPullRequests` (default true): `store/settings.rs`, `store/stacked_pull_requests.rs`, `ipc/settings_stacked_pull_requests.rs`, `ipc/mod.rs`, `shared/ipc.ts`, `shared/model.ts`, `tauri-bridge/index.ts`, `state/settings-store.ts`; copy `codeLigatures`. Tests: default true on an empty file, false persists, non-bool rejected.
- [x] T002 `github/gh_stack_state.rs` (+ test): `GhStackState`, `gh stack --version` parse with 0.3.0 floor, `unknown command` -> `Missing`, in-memory `unavailable_repos`, install/upgrade runner with 120 s timeout via `resolve_gh`. IPC `githubStack.state` and `githubStack.install`. Tests: version compare (0.1.0 Outdated, 0.3.0 Ready, 0.10.0 Ready), missing text, install clears state, unavailable set empty on a fresh process.
- [x] T003 Spike with the real `gh`: record the `stacks/<n>` and `stacks?pull_request=<n>` shapes (create no stacks on the repo; use read-only calls or a scratch repo Stuart names). Output: a fixture in `github/stacks.test.rs` and a line in research.md. If unusable, mark the D2 guard "CLI refusal only" in plan.md. (Done: no scratch stack; guard marked "CLI refusal only".)
- [x] T004 Notes: `resources/refract-stack-rules.md`, `token_guard/rules.rs` `write(dir, stacked)`, `args.rs` `launch_args(dir, plan_mode, stacked)`, `OmpProcessOptions.stacked_prs`, Session launch site sets it from setting plus `Ready`. Tests: block present iff stacked, still one append flag, existing rules-length test unchanged, rules file rewritten when the toggle flips. Plan for the #1859 conflict in `args.rs` (plan.md).

## Slice 2: stack data and merge (FR-004 to FR-007)

- [x] T005 `github/stacks.rs` (+ test): `view_stack`, view JSON types, exit-code table. Tests: fixture parse (3 layers, merged, queued, needsRebase), exit 2 is "not stacked", exit 9 records the repository.
- [x] T006 `src/shared/stack-chain.ts` (+ test): pure chaining. Tests: 3-layer, forked base ignored, merged middle, cycle-safe, no chain.
- [x] T007 Merge routing: `ipc/pull_requests/handlers.rs` dispatch, new `github/stack_merge.rs` (argv builder, the collision guard, error mapping), `shared/ipc.ts` `stackHint`. Tests: stacked argv exact (`stack merge <n> --yes --squash`), plain stays `pr merge`, view result beats a stale hint, guard refuses when a different stack owns the number, no fallback after a failed stack merge, exit 9 sets fallback for that repository only.

## Slice 3: UI (FR-008 to FR-010, FR-012)

- [ ] T008 `StackBadge` and `StackLayers` (shared components extended by prop where needed), wired into `PullRequestRow` and `PullRequestDetail`; `PullRequestList` runs chaining once per load. Logic tests on the position mapping.
- [ ] T009 `MergeDialog`: not-installed/outdated callout with **Install**, "merges layers 1 to N together" line, re-read of the setting; Settings row with toggle and inline state. Copy through `check:ui-text`.

## Slice 4: verify and close

- [ ] T010 `scripts/verify-tauri-1867.mjs` (fake `gh`, isolated instance) for SC-001 to SC-006; screenshots.
- [ ] T011 Docs: PLAN row status, `CONTEXT.md` term **Stacked pull request** (glossary only), README/settings docs if a settings list exists, `check:parity`, `ci:local`.

Dependencies: T001 -> T002 -> T003 -> T005 -> T007; T004 after T002; T006 independent; T008 after T006 and T007; T009 after T002, T007, T008; T010 -> T011.
