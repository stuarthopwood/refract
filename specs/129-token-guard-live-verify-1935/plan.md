# Plan: Live-verify the token guard Settings keys (#1935)

**Branch**: `chore/1935-token-guard-live-verify` | **Date**: 2026-11-12 | **Spec**: `specs/129-token-guard-live-verify-1935/spec.md`

**Input**: amends `specs/021-token-guard` (FR-036, research section 10).

## Summary

Rewrite the lost #1765 probes as committed scripts that run a real `omp --mode rpc-ui` against a scripted local provider in scratch directories, A/B each of the 17 unverified keys with a deterministic observable, then set the `live` flags in `src/shared/tokenGuard.ts` to match and record the verdicts in `specs/021-token-guard/research.md`. No Rust, no UI change. A key with no deterministic observable stays startup-only.

## Technical Context

**Language/Version**: Node ESM scripts (`.mjs`), TypeScript for `src/shared/tokenGuard.ts`

**Primary Dependencies**: the installed `omp` (18.17.0), Node `http` for the scripted provider, existing `scripts/verify-tauri-scratch-helpers.mjs` (`safeRmSync`, scratch dirs)

**Storage**: scratch `PI_CODING_AGENT_DIR` (seeded `config.yml`, `models.yml`), scratch repo for tool fixtures; all under the OS temp dir

**Testing**: pure logic tested co-located with vitest, added to the explicit `scripts/` include list in `vitest.config.ts`; the live probes themselves are run by hand once, output recorded in research.md

**Target Platform**: Windows dev machine (same as #1765)

**Project Type**: desktop app repo; this slice is verification scripts plus a flag table

**Constraints**: no model cost, no real config touched, no `%APPDATA%\refract-tauri`, files under 600 lines, "why"-only comments

**Scale/Scope**: 17 keys, 6 probe groups, 2 runs per verdict

## Constitution Check

- I (OMP is the engine): probes drive `omp --mode rpc-ui` over stdio and edit config with `omp config set`, as Refract does. No embedded SDK. Pass.
- Live checks use scratch dirs and fake providers; nothing reads the user's real profile. Pass.
- Tests co-located with new logic (AGENTS.md). Pass.
- A change to a Principle II/III rule needs a FINDINGS row: no such rule changes. Pass.
- No UI change, so the design checklist does not apply.
- Advisor constraint (Stuart, 2026-10-30): no `WATCHDOG.yml` roster anywhere. The advisor probe uses the default advisor, driven by `modelRoles.advisor` in the scratch `config.yml` only, pointing at the scripted provider. Pass.

## Approach

### A. Probe harness (`scripts/token-guard-probe/`)

- `provider.mjs`: scripted OpenAI-compatible `chat/completions` server. Each request body is recorded (model id, messages, system text, tool results). Responses come from a per-run script (list of steps: text, tool call, hold-until-released), so fan-out and ordering are decided by the script, not by a model. This replaces the nondeterministic fan-out of #1765: subagent requests are held open until the probe releases them, so in-flight concurrency is counted exactly.
- `host.mjs`: spawns `omp --mode rpc-ui` with scratch `PI_CODING_AGENT_DIR` and cwd; sends prompts as JSONL, collects frames, applies a config edit with `omp config set` against the same agent dir, waits until the config file shows the new value, then sends the next turn.
- `ab.mjs` (pure): given the observable extracted from a control run and a test run, returns `live`, `startup-only`, or `inconclusive-startup-only`; applies the two-consecutive-runs rule (FR-003). Unit tested.
- `observe.mjs` (pure): extractors over recorded frames and request bodies: compaction frame count, request model id, marker present in system text, image parts in messages, tool-result text, in-flight peak, extra request after agent end. Unit tested against small literal fixtures.
- `run.mjs`: runs the chosen groups, prints one verdict line per key and writes a JSON report to a path given by `--out` (default under the temp dir).
- The scripts sit in their own directory and are not part of `pnpm verify:*`. Add one `package.json` script, `probe:token-guard`.

### B. Probes per group (observable; test edit between turns)

| Keys | Observable in the test run versus control | Notes |
|---|---|---|
| `compaction.idleEnabled`, `idleThresholdTokens`, `idleTimeoutSeconds` | Count of `auto_compaction_start` frames with `reason: idle` after the process has been idle longer than the 60 s minimum timeout, with the keys set low and enabled in the test run | Expected: zero in both runs, because RPC sessions never enable idle maintenance (omp `sdk.md`). Zero in both runs = `startup-only` with that reason; nothing is ever `live` here. See OQ-1 |
| `snapcompact.toolResults`, `snapcompact.systemPrompt` | Turn-two request body: image content parts for a large tool result; system prompt sent as image frames instead of text. Provider is declared vision-capable in `models.yml` | |
| `task.maxConcurrency` | Peak in-flight subagent requests while the script holds them, for N parallel `task` calls with the cap changed between turns | Replaces the unrepeatable fan-out |
| `task.softRequestBudget` | Number of subagent requests before the wrap-up notice text appears in a request, and before the run is force-stopped at 1.5 times the budget | Subagent script loops on tool calls; small budgets |
| `plan.defaultOnStartup`, `prewalk.enabled`, `todo.eager` | Per-key marker in turn-two request: plan-mode text present, request model id switching to the `prewalk.into` model, eager-todo guidance text present. Whole-prompt hashes are not used. Control run measures the marker's natural variance (must be zero) | OQ-2: only the next turn of the same process counts |
| `autolearn.autoContinue` | Provider request count after the agent ends: an extra private capture request. `autolearn.minToolCalls` set to 1 in scratch config so one tool call makes the turn eligible | |
| `advisor.reviewMode` | Number of advisor-role requests per primary turn over a multi-tool-call turn (`turn` versus `agent-end`) | Default advisor via `modelRoles.advisor` in the scratch config only; no roster file. If the scripted provider cannot drive an advisor review deterministically the key is `inconclusive-startup-only` |
| `grep.contextBefore`, `grep.contextAfter`, `read.defaultLimit`, `read.summarize.enabled` | Text of the tool result in the turn-two request after a scripted `grep` or `read` call on a fixture file of known content | Result text is deterministic |
| `tools.artifactSpillThreshold` | Whether a scripted tool call returning output between the old and new threshold gets an `artifact://` spill marker in its result | |

`tools.xdev` and the three `compaction.*` live keys are not run.

### C. Apply the results

- `src/shared/tokenGuard.ts`: add `live: true` to each key with verdict `live`. No other change.
- `src/shared/tokenGuard.test.ts`: update `LIVE_KEYS` to match.
- `specs/021-token-guard/research.md`: new section 11 with all 17 verdicts, observable, omp version, run dates, and the reason for each non-live key; section 10's "Unverified" and "Decision" lines get a pointer to section 11.
- `specs/021-token-guard/spec.md` FR-036 and `quickstart.md` step 9: list the final live set.
- `docs/PLAN.md`: flip the #1935 row at merge (controller).

### D. Run order and risk

1. Cheapest and most deterministic first: tool-result group, snapcompact, artifact spill. 2. Subagent group (held-request provider). 3. Start-of-turn group, then autolearn, then advisor. 4. Idle group last (needs the 60 s+ wait).
- Risk: omp changes frame names between versions. Mitigation: extractors are pure and fixture-tested; the report records the omp version.
- Risk: a marker is absent for a key. Mitigation: the key becomes `inconclusive-startup-only`, per the grill.
- Risk: flaky control run. Mitigation: FR-003 requires two consecutive agreeing runs; a disagreement downgrades to `inconclusive-startup-only`.

## Project Structure

```text
specs/129-token-guard-live-verify-1935/
├── spec.md
├── plan.md
├── research.md      # OMP facts per key, used by the probes
├── quickstart.md    # how to run the probes
├── tasks.md
└── analysis.md

scripts/token-guard-probe/
├── provider.mjs
├── host.mjs
├── ab.mjs  (+ ab.test.mjs)
├── observe.mjs  (+ observe.test.mjs)
└── run.mjs
```

**Structure Decision**: one directory of small modules so each stays well under 600 lines; the two pure modules carry the unit tests; the vitest `include` list gets the two test files.

## Complexity Tracking

No constitution violations.
