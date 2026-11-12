# Feature Specification: Clear open CodeQL alerts before the next release (#1942)

**Feature Branch**: `fix/codeql-cleanup`

**Created**: 2026-11-12

**Status**: Draft (docs only; no code yet)

**Input**: GitHub issue #1942, "Bug: clear open CodeQL alerts before the next release". Route: specify, clarify, plan, tasks, analyze, implement. The release waits for this work.

## Problem

263 CodeQL alerts are open on `stuarthopwood/refract`. CodeQL runs under GitHub's DEFAULT setup (languages actions, javascript-typescript, python, rust; default query suite), which cannot exclude paths. Most alerts sit in local, dev-only verification harnesses that are never shipped; the rest are real findings in shipped Rust and in repo scripts.

Alert breakdown (from the grill):

| Rule | Count | Where | Disposition |
|---|---|---|---|
| `js/bad-code-sanitization` | 247 | `scripts/verify-*.mjs` | Excluded from analysis |
| shell-injection | 4 | `verify-tauri-735`, `-ask`, `-side-chat`, `verify-tauri.mjs` | Excluded; `verify-tauri.mjs` also fixed (live script) |
| `js/incomplete-url-substring-sanitization` | 1 | `verify-055` | Excluded |
| `rust/cleartext-logging` | 8 | Seven Rust files under `src-tauri/src` | Fixed in code |
| `js/redos` | 1 | `scripts/check-parity.mjs:94` | Fixed in code |
| `js/incomplete-sanitization` | 2 | `scripts/check-drag-regions.mjs:109`, `scripts/release-changelog.mjs:105` | Fixed in code |

## Clarifications

### Session 2026-11-12 (grill, Stuart; decided)

- Q: Suppress the verify-script alerts, dismiss them one by one, or exclude the files from analysis? -> A: Exclude. Switch from default to advanced setup so `paths-ignore: scripts/verify-*.mjs` can apply. The scripts are local CDP harnesses, never shipped.
- Q: Which languages and queries under advanced setup? -> A: The same as today: actions, javascript-typescript, python, rust, default query suite. Rust uses `build-mode: none`.
- Q: Who turns default setup off? -> A: The controller, at merge time, with `gh api -X PATCH repos/stuarthopwood/refract/code-scanning/default-setup -f state=not-configured`. Not part of the PR, not done by workers.
- Q: Dismiss or fix the non-harness alerts? -> A: Really fix every one.
- Q: How to fix `rust/cleartext-logging`? -> A: Drop session ids and pids from log lines; keep `{err}` (Display) only; rename a `tokens` variable where it trips the heuristic.
- Q: `verify-tauri.mjs`? -> A: It is covered by the exclusion, but it is live (`pnpm verify:tauri`), so it also loses `cmd.exe /c` and reuses the shared build helper in `scripts/verify-tauri-scratch-helpers.mjs` if that fits.
- Q: Does `ci.yml` change? -> A: No.
- Q: Does the release wait? -> A: Yes.

### Session 2026-11-12 (clarify; derived from the decisions, nothing blocked)

- Q: The repo has Actions enabled and only the `CI` workflow is disabled, so the new CodeQL workflow runs on the PR. While default setup is still on, GitHub rejects the advanced run's SARIF upload. What does the PR's CodeQL check do? -> A (derived): it fails red until the controller turns default setup off. That is expected, not a defect. Order: (1) implement and push, (2) controller disables default setup, (3) rerun the PR's CodeQL workflow and confirm it passes and the verify-script alerts are no longer reported, (4) merge.
- Q: Scanning gap on `main` between step 2 and the merge? -> A (derived): accepted risk. `main` has no CodeQL scan in that window; the PR run covers the change itself.
- Q: Workflow triggers? -> A (derived): `pull_request`, `push` to `main`, and a weekly schedule (matches default setup's coverage).
- Q: Does `pid_records.rs` need all five log lines changed? -> A (derived from decision): only those that log ids or pids (`:114`, `:134`, `:148`); `:37` and `:166` carry no ids and are left alone unless CodeQL still flags them.

## User Scenarios & Testing

### User Story 1 - Release is no longer blocked by open alerts (Priority: P1)

The maintainer opens the Security tab before cutting a release.

**Independent Test**: after merge, the open alert count for rules in the table above is zero.

**Acceptance Scenarios**:

1. **Given** advanced setup is active, **When** the CodeQL workflow runs on a PR or `main`, **Then** no file matching `scripts/verify-*.mjs` is analysed and none of its alerts is reported.
2. **Given** the fixes have landed, **When** CodeQL runs, **Then** the 8 `rust/cleartext-logging`, 1 `js/redos` and 2 `js/incomplete-sanitization` alerts are not reported.
3. **Given** the change, **When** CodeQL runs, **Then** all four languages are still analysed with the default query suite.

### User Story 2 - Fixes change no behaviour (Priority: P1)

**Independent Test**: unit tests for each script fix; existing Rust tests pass.

**Acceptance Scenarios**:

1. **Given** the `check-parity.mjs` regex is replaced, **When** it is run on every input the old regex matched, **Then** it matches the same text.
2. **Given** a version string with regex metacharacters, **When** `check-drag-regions.mjs` builds its pattern, **Then** the metacharacters match literally.
3. **Given** a changelog with `## v1.2.3 (` lines, **When** `release-changelog.mjs` looks for a version, **Then** only a line that starts with `## v<version> (` matches (`1.2.3` does not match `1.2.30`).
4. **Given** a failing log path in the Rust files, **When** it fires, **Then** the line carries the error text and no session id or pid.

### User Story 3 - `pnpm verify:tauri` still builds (Priority: P2)

**Acceptance Scenarios**:

1. **Given** `verify-tauri.mjs` runs on Windows, **When** it builds the debug exe, **Then** it does not spawn `cmd.exe /c` and the build succeeds as before.

### Edge Cases

- Default setup still on when the PR's CodeQL run finishes: the check is red for the SARIF rejection; see clarify.
- A future `scripts/verify-*.mjs` is excluded automatically by the glob; a script outside the glob that has alerts is not.
- Dismissed alerts: none are dismissed; the exclusion causes the remaining verify-script alerts to close on the next analysis.

## Requirements

### Functional Requirements

- **FR-001**: `.github/workflows/codeql.yml` MUST run CodeQL for languages actions, javascript-typescript, python and rust (Rust `build-mode: none`) with the default query suite, on `pull_request`, `push` to `main` and a weekly schedule.
- **FR-002**: `.github/codeql/codeql-config.yml` MUST set `paths-ignore: scripts/verify-*.mjs` and the workflow MUST reference it.
- **FR-003**: `ci.yml` MUST NOT change.
- **FR-004**: The eight Rust log lines MUST no longer include session ids or pids; error text uses `{err}` (Display); `pause.rs` changes `{err:?}` to `{err}`; a `tokens`-named variable that trips the heuristic is renamed.
- **FR-005**: `scripts/check-parity.mjs` MUST use `/^\s*(?:\/\/[^\n]*\n\s*)*mod\s+\w+\s*\{/` and match exactly what the old pattern matched.
- **FR-006**: `scripts/check-drag-regions.mjs` MUST escape every regex metacharacter (or use string operations) where it builds a pattern from input.
- **FR-007**: `scripts/release-changelog.mjs` MUST locate a version section without a regex, by checking that a line starts with `## v${version} (`.
- **FR-008**: `scripts/verify-tauri.mjs` MUST NOT spawn `cmd.exe /c` and SHOULD reuse the shared build helper in `scripts/verify-tauri-scratch-helpers.mjs` when it fits.
- **FR-009**: New logic in FR-005 to FR-007 MUST have co-located unit tests; existing tests MUST keep passing; no source file may exceed 600 lines.
- **FR-010**: Disabling default setup MUST NOT be done by the PR or by workers; the controller does it after the implementation is pushed (see Rollout).

### Rollout (non-functional, ordered)

1. Implement and push.
2. Controller sets default setup to `not-configured`.
3. Rerun the PR's CodeQL workflow; confirm it passes and the verify-script alerts are no longer reported.
4. Merge. The scanning gap on `main` between steps 2 and 4 is an accepted risk.

## Success Criteria

- **SC-001**: After merge and the first `main` analysis, zero open alerts remain for the rules in the Problem table.
- **SC-002**: The PR's CodeQL workflow passes after default setup is turned off.
- **SC-003**: Existing test suites pass unchanged; new tests cover each script fix.
- **SC-004**: The release is unblocked.

## Assumptions

- The advanced workflow's check name differs from default setup's, so no branch-protection rule names it (to confirm at implement).
- Rust analysis with `build-mode: none` is supported by the pinned CodeQL action version.
- Out of scope: fixing alerts inside `scripts/verify-*.mjs` other than `verify-tauri.mjs`; changing the query suite; dismissing alerts.
