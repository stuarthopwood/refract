# Tasks: Live-verify the token guard Settings keys (#1935)

**Spec**: `specs/130-token-guard-live-verify-1935/spec.md` | **Plan**: `plan.md`

Slices: A (harness, T001-T006) is the base; B (probes, T007-T013) needs A; C (apply, T014-T018) needs B's results. `[P]` marks a task that can run alongside others in its slice. No UI, no Rust.

## A. Probe harness (FR-002, FR-007)

- [x] T001 [P] `scripts/token-guard-probe/ab.mjs` + `ab.test.mjs`: pure verdict function (`live`, `startup-only`, `inconclusive-startup-only`; control must not change; two consecutive agreeing runs) and tests for each branch, including a flaky control and a disagreeing pair (FR-003, FR-007)
- [x] T002 [P] `scripts/token-guard-probe/observe.mjs` + `observe.test.mjs`: pure extractors (compaction frame count by reason, request model id, marker in system text, image parts, tool-result text, in-flight peak, extra request after agent end) with literal-fixture tests (FR-007)
- [x] T003 [P] `scripts/token-guard-probe/provider.mjs`: scripted OpenAI-compatible server; records request bodies; steps for text, tool call, hold-until-released; vision-capable model entry for `models.yml` (FR-002)
- [x] T004 `scripts/token-guard-probe/host.mjs`: scratch `PI_CODING_AGENT_DIR` with seeded `config.yml` and `models.yml`, spawn `omp --mode rpc-ui` with a fixed argv and no shell, JSONL send/collect, `omp config set` edit between turns, wait for the config file to show the value, clean shutdown; no `WATCHDOG.yml` ever written (FR-002)
- [ ] T005 `scripts/token-guard-probe/run.mjs`: group selection, A/B orchestration, two runs, one verdict line per key, JSON report with omp version (FR-001, FR-003)
- [ ] T006 Register `probe:token-guard` in `package.json`; add `ab.test.mjs` and `observe.test.mjs` to the `scripts/` include list in `vitest.config.ts`; run `pnpm test` for these two files (FR-007)

## B. Probes (FR-001, FR-006)

- [ ] T007 [P] Tool-result group: `grep.contextBefore`, `grep.contextAfter`, `read.defaultLimit`, `read.summarize.enabled` on a fixture file; observable = turn-two tool-result text
- [ ] T008 [P] `tools.artifactSpillThreshold`: tool output between old and new threshold; observable = `artifact://` spill marker
- [ ] T009 [P] `snapcompact.toolResults`, `snapcompact.systemPrompt`: observable = image parts in the turn-two request, system prompt as image frames
- [ ] T010 [P] Subagent group: `task.maxConcurrency` (peak in-flight held subagent requests), `task.softRequestBudget` (requests before wrap-up notice and force-stop)
- [ ] T011 [P] Prompt group: `plan.defaultOnStartup`, `prewalk.enabled`, `todo.eager`; observable = per-key marker or request model id, no prompt hash; control shows zero natural variance (OQ-2 definition)
- [ ] T012 [P] `autolearn.autoContinue` (extra capture request, `autolearn.minToolCalls` lowered) and `advisor.reviewMode` (advisor requests per turn via `modelRoles.advisor` in the scratch config only; if not deterministic, `inconclusive-startup-only`)
- [ ] T013 Idle group: `compaction.idleEnabled`, `idleThresholdTokens`, `idleTimeoutSeconds`; wait past the 60 s minimum with the keys set low; expect no idle compaction frame in either run (verdict `startup-only`, reason: RPC sessions run no idle maintenance). `tools.xdev` is not run (FR-006)

## C. Apply and record (FR-004, FR-005, FR-008)

- [ ] T014 Run `pnpm probe:token-guard` twice; keep both reports outside the repo; confirm the two runs agree on all 17 keys (SC-003)
- [ ] T015 `src/shared/tokenGuard.ts`: add `live: true` to each key with verdict `live`; nothing else changes (FR-004, FR-008)
- [ ] T016 `src/shared/tokenGuard.test.ts`: update `LIVE_KEYS` to the final set (FR-004)
- [ ] T017 `specs/021-token-guard/research.md` section 11 (17 verdicts, observables, omp version, dates, reasons; section 10 points to it), `spec.md` FR-036 and `quickstart.md` step 9 list the final live set (FR-005)
- [ ] T018 `pnpm ci:local` green; PR body lists all 17 verdicts and says #1765 can close on merge; mark the PR ready; hand to the controller (SC-004). Answer OQ-1 in the PR body (idle keys have no effect in RPC sessions) without filing anything unless Stuart asks

## Dependencies

T001-T003 parallel; T004 needs T003; T005 needs T001, T002, T004; T006 after T001-T005; T007-T012 parallel after T005 (each adds its group to `run.mjs`; serialise edits to that file); T013 after T005; T014 after T007-T013; T015-T017 after T014; T018 last.
