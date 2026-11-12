# Feature Specification: Live-verify the token guard Settings keys (#1935)

**Feature Branch**: `chore/1935-token-guard-live-verify`

**Created**: 2026-11-12

**Status**: Draft (docs only; no code yet)

**Input**: GitHub issue #1935, "Token guard: verify which of the 18 remaining keys apply live to running Sessions", with the grill outcome comment (Stuart, 2026-11-12). Amends `specs/021-token-guard` (FR-036, research sections 9 and 10). Route: converge (amend 021), specify, clarify, plan, tasks, analyze, implement.

## Problem

Settings > Advanced shows "Applies to new Sessions" on every token guard row that is not proven to reload into a running Session. Four keys carry `live: true` in `TOKEN_GUARD_KEYS` (`src/shared/tokenGuard.ts`): `compaction.thresholdPercent`, `compaction.modelThresholds`, `compaction.methodOrder` (probed in #1765) and `tools.xdev` (probed in #1767). The other 17 rows carry the label because the #1765 probe could not observe them. Some of those keys may in fact apply live, so Refract tells the user to start a new Session when it need not.

Why each key was not proven (`specs/021-token-guard/research.md` section 10):

| Group | Keys | Why not proven |
|---|---|---|
| Idle compaction | `compaction.idleEnabled`, `compaction.idleThresholdTokens`, `compaction.idleTimeoutSeconds` | An RPC session starts no idle maintenance (`session.enableIdleMaintenance` is opt-in; only the TUI enables it), so no trigger exists |
| Subagents | `task.maxConcurrency`, `task.softRequestBudget` | The scripted model's fan-out was not repeatable |
| Start-of-turn prompt | `plan.defaultOnStartup`, `prewalk.enabled`, `todo.eager`, `autolearn.autoContinue`, `advisor.reviewMode` | The system-prompt hash varied for reasons unrelated to the key |
| Never probed | `snapcompact.toolResults`, `snapcompact.systemPrompt`, `grep.contextBefore`, `grep.contextAfter`, `read.defaultLimit`, `read.summarize.enabled`, `tools.artifactSpillThreshold` | Not attempted |

The issue says 18 keys; `TOKEN_GUARD_KEYS` has 21, 4 are already live, so 17 remain (grill decision 1).

## Clarifications

### Session 2026-11-12 (grill, Stuart; decided)

- Q: How many keys? -> A: 17, not 18. `TOKEN_GUARD_KEYS` has 21 keys and 4 already have `live: true`.
- Q: Which keys are probed, and what if a key has no deterministic observable? -> A: Probe all 17. A key with no deterministic observable stays startup-only (no `live` flag), and `specs/021-token-guard/research.md` records why. #1765 closes when every key has a verdict.
- Q: `tools.xdev`? -> A: Keep the #1767 result without a re-probe.
- Q: The old probe scripts? -> A: `C:/Users/shopwood/refract-live-check-1765/probe/` no longer exists; the lane rewrites the probes. The amended spec dir is `specs/021-token-guard` (not `001`).

### Session 2026-11-12 (clarify; derived from the grill and the issue, nothing invented)

- Q: What does "live" mean? -> A (derived from #1765 and research section 9): a change made to the global config while the OMP process keeps running changes the behaviour of the next turn of that same process, with no restart. Refract writes the global config on Save through `omp config set`, so the probe makes the edit the same way.
- Q: What counts as proof? -> A (derived from issue AC 1): a probe with a deterministic observable, run as an A/B. Control run: the key keeps its first value across both turns. Test run: the key changes between turns. The key is live only if the observable changes in the test run and not in the control run. A key whose observable cannot be made deterministic stays startup-only.
- Q: What do the probes run against? -> A (derived from research section 9 and the AGENTS.md live-check rules): the real `omp` (18.17.0 on this machine) in `--mode rpc-ui`, a scratch `PI_CODING_AGENT_DIR` and scratch data dir, and a local scripted OpenAI-compatible provider. No real model, key or user config is touched.
- Q: Why did the system-prompt hash vary? -> A: unknown (the research does not say). The lane must stop comparing whole-prompt hashes and compare a per-key marker (text present or absent, request model id, tool result text) instead, with a no-edit control run to show the natural variance is zero for that marker. Whether a prompt marker exists for every key is settled by the probe and recorded per key.
- Q: Where do the rewritten probes live? -> A (assumption, not a grill answer): in the repo under `scripts/`, so they are reviewable and the loss that forced this rewrite cannot recur. Flagged under Open Questions.

## Open Questions

- **OQ-1 (idle keys)**: An RPC Session never runs idle maintenance, so Refract-hosted Sessions may ignore the three idle keys entirely, not only until restart. The grill rule gives them startup-only status plus a recorded reason. Does Stuart also want a follow-up issue ("idle compaction settings have no effect in Refract")? Default if unanswered: record the finding in research.md and the PR body, file nothing.
- **OQ-2 (keys that apply at `/new`)**: `plan.defaultOnStartup` and `prewalk.enabled` are documented as applying when a fresh session starts. The definition above counts only the next turn of the same process. If such a key applies only after `new_session` in the same process, it stays startup-only under this spec. Default if unanswered: that definition.
- **OQ-3 (probe location)**: probes committed under `scripts/` (assumption above) versus kept outside the repo as before. Default: commit them.

## User Scenarios & Testing

### User Story 1 - The label is true for every row (Priority: P1)

A user edits a token guard row with a Session running.

**Independent Test**: for each of the 17 keys, the recorded probe verdict agrees with whether the row shows "Applies to new Sessions".

**Acceptance Scenarios**:

1. **Given** a key the probe observed changing a running process's next turn, **When** Settings > Advanced renders its row, **Then** the row does not show "Applies to new Sessions".
2. **Given** a key with no deterministic observable or no live effect, **When** its row renders, **Then** it still shows "Applies to new Sessions".
3. **Given** the four keys already live, **When** the PR lands, **Then** their flags are unchanged.

### User Story 2 - Every verdict is reproducible (Priority: P1)

A maintainer upgrades OMP and wants to recheck the flags.

**Independent Test**: running the probe command on a clean checkout prints one verdict per key, with its observable and control result.

**Acceptance Scenarios**:

1. **Given** the probes, **When** run twice on the same omp version, **Then** each key gets the same verdict both times.
2. **Given** a key whose probe cannot be made deterministic, **When** the probe runs, **Then** it reports "inconclusive" for that key and never "live".

### User Story 3 - The record stays in one place (Priority: P2)

**Independent Test**: `specs/021-token-guard/research.md` has a section covering all 17 keys, each with verdict, observable and reason.

## Requirements

- **FR-001**: Every one of the 17 keys MUST get one verdict: `live`, `startup-only` (observed to change nothing in a running process), or `inconclusive-startup-only` (no deterministic observable), each with the observable used (issue AC 1).
- **FR-002**: Probes MUST run the A/B described in the Clarifications against a real `omp --mode rpc-ui` with a scripted local provider in scratch directories, with no model cost and no touch of the user's real config or `%APPDATA%\refract-tauri`.
- **FR-003**: A key MUST get `live` only when its test run changes the observable and its control run does not, in at least two consecutive probe runs.
- **FR-004**: `src/shared/tokenGuard.ts` MUST carry `live: true` for exactly the keys with verdict `live` plus the four existing keys, and `src/shared/tokenGuard.test.ts` `LIVE_KEYS` MUST match (issue AC 2).
- **FR-005**: `specs/021-token-guard/research.md` MUST gain a section recording the 17 verdicts, observables, omp version and reasons; `spec.md` FR-036 and `quickstart.md` MUST be updated to the final live set (issue AC 3).
- **FR-006**: `tools.xdev` MUST keep its #1767 result and MUST NOT be re-probed.
- **FR-007**: Pure probe logic (verdict derivation, frame and request-body parsing, A/B comparison) MUST have co-located unit tests; the probe scripts stay under 600 lines each (AGENTS.md).
- **FR-008**: The change MUST NOT alter the label wording, the Settings layout or any Rust code.

## Success Criteria

- **SC-001**: 17 of 17 keys have a recorded verdict; 0 are unaccounted for.
- **SC-002**: `appliesToNewSessionsOnly(key)` is false for exactly the keys whose verdict is `live` plus the four existing ones.
- **SC-003**: Two consecutive probe runs agree on all 17 verdicts.
- **SC-004**: #1765 can close on this PR's merge (controller's step).

## Assumptions

- omp stays at 18.17.0 for the run; the probe records the version it ran against.
- A scripted OpenAI-compatible provider is enough to drive every observable (as in #1765 section 9). Where a key needs a feature the provider cannot drive (for example advisor review), that key is `inconclusive-startup-only`.
- Out of scope: new Settings UI, changing which keys exist, changing defaults, re-probing the four existing live keys, fixing the idle keys' lack of effect in RPC sessions.
