# Feature Specification: OMP settings guard

**Feature Branch**: `feat/1184-omp-settings-guard`

**Created**: 2026-10-22

**Status**: Draft

**Input**: User description: "OMP settings guard (issue #1184), items 1-4 only. Refract checks a set of OMP token-cost settings at start and before every Session launch, and resets any that have drifted from Refract's baseline, telling the developer what it changed. Item 5 (the Guarded tag in Settings > OMP and editing the baseline) moved to #691 (Stuart, 2026-10-22 scope comment)."

## Clarifications

### Session 2026-10-22

All answers come from the issue's grilled block (Stuart, 2026-10-22); none were left open.

- Q: What happens on drift, and does the developer confirm? -> A: Refract resets the setting straight away through `omp config set` (global config), then shows one toast. No confirmation dialog.
- Q: When does the guard run? -> A: At Refract start and immediately before each Session launches `omp`, because OMP reads its config once at process start. Checks share one config read with a short cache.
- Q: Where does the baseline live? -> A: Item 5 (stored in Refract settings and edited from Settings > OMP) is out of scope. This feature ships the grilled values as built-in defaults; until #691 lands, a deliberate change made outside Refract is reset.
- Q: How are `compaction.modelThresholds` compared? -> A: Per model entry; extra entries the baseline does not name are left alone, and only drifted entries are reset.
- Q: What if a Project overrides a guarded key in its own `.omp/config.yml`? -> A: Refract never edits that file; it names the override in the toast. (The Settings row wording is item 5, out of scope.)
- Q: What if the guard is slow or a write fails? -> A: A Session launch never waits on the guard past a timeout, and a failed write is reported in the toast; the Session still starts.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Drifted token-cost settings are reset before a Session starts (Priority: P1)

A developer starts a Session while a guarded OMP setting (for example `advisor.reviewMode`) has been changed to a more expensive value by something other than Refract. Refract restores the baseline value before OMP launches, so the Session runs with the intended cost settings.

**Why this priority**: This is the whole point; silent drift undoes the token savings (issue #1184, Problem).

**Independent Test**: Set `advisor.reviewMode` to `turn`, start a Session, confirm the global OMP config now reads `agent-end` before the Session's process starts.

**Acceptance Scenarios**:

1. **Given** `advisor.reviewMode` is `turn`, **When** a Session launches, **Then** the global OMP config is set back to `agent-end` before `omp` starts.
2. **Given** every guarded key matches the baseline, **When** a Session launches, **Then** nothing is written and no notice appears.
3. **Given** `compaction.modelThresholds` has one baseline model entry changed and an extra entry the baseline does not name, **When** a Session launches, **Then** only the changed entry is reset and the extra entry is untouched.
4. **Given** a value differs only in formatting (`120000` against `"120000"`, `true` against `"true"`), **When** the guard compares, **Then** it is not drift.
5. **Given** Refract starts, **When** the app window is up, **Then** the guard runs once without waiting for a Session.

---

### User Story 2 - The developer is told what changed (Priority: P1)

After a reset, one notice tells the developer which settings were reset and what they were before, with a Details view listing every key.

**Why this priority**: An unannounced reset of a setting the developer chose would be surprising.

**Independent Test**: Cause two keys to drift, start a Session, and confirm one notice names both with old and new values and that Details lists them.

**Acceptance Scenarios**:

1. **Given** two keys were reset, **When** the guard finishes, **Then** exactly one toast reads like "Reset 2 OMP settings: advisor.reviewMode turn → agent-end, ..." with a Details control.
2. **Given** the toast is shown, **When** the developer activates Details with the keyboard, **Then** a dialog lists every reset key as old → new, any key that could not be reset with the reason, and any Project override.
3. **Given** the toast appears, **When** a screen reader is running, **Then** it is announced once through the existing toast live region.
4. **Given** nothing was reset and nothing failed, **When** the guard finishes, **Then** no toast is shown.

---

### User Story 3 - A guard problem never blocks a Session or edits a Project file (Priority: P1)

If OMP is slow, missing, or a write fails, the Session still starts. A Project's own `.omp/config.yml` is never edited.

**Why this priority**: A safety net must not become an outage.

**Independent Test**: Make a write fail; confirm the Session starts and the notice names the key that could not be reset. Add a Project `.omp/config.yml` overriding a guarded key; confirm it is unchanged and named in the notice.

**Acceptance Scenarios**:

1. **Given** the guard has not finished within its timeout, **When** a Session launches, **Then** `omp` launches anyway.
2. **Given** a write to one key fails, **When** the guard finishes, **Then** the other keys are still reset, the failed key is named in the notice, and the Session starts.
3. **Given** the Session's Project overrides a guarded key in `.omp/config.yml`, **When** the guard reports, **Then** the file is byte-identical afterwards and the notice names the override.
4. **Given** several Sessions launch at once, **When** the guard runs for each, **Then** OMP's config list is read once within the cache window.

### Edge Cases

- `omp` is not installed or `config list` fails: the guard logs and does nothing; no notice, no block.
- A guarded key is absent from OMP's config list (older OMP): it is skipped, not written.
- The renderer is not listening yet when the start-up guard finishes: the notice is delivered again at the next launch check, once.
- Two guard runs overlap: they are serialised so no key is written twice.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Refract MUST hold the baseline below as built-in defaults: `advisor.reviewMode` agent-end; `modelRoles.advisor` github-copilot/gemini-4-argon:auto; `compaction.thresholdTokens` 200000; `compaction.modelThresholds` per model (github-copilot/claude-opus-5.5 200000; claude-sonnet-5.5, claude-sonnet-5 and claude-haiku-5.5 120000; gemini-4-argon and gpt-5.6-terra 150000); `compaction.idleEnabled` true; `compaction.idleThresholdTokens` 80000; `compaction.idleTimeoutSeconds` 240; `task.softRequestBudget` 80; `task.maxConcurrency` 6; `autolearn.autoContinue` false.
- **FR-002**: Refract MUST run the guard once at app start and immediately before each Session launches `omp`.
- **FR-003**: The guard MUST read OMP's effective global config once and share that read across checks inside a short cache window.
- **FR-004**: The guard MUST compare values normalised so numbers, booleans and strings that differ only in representation are equal.
- **FR-005**: `compaction.modelThresholds` MUST be compared per model entry; entries outside the baseline are left alone and only drifted entries are written.
- **FR-006**: The guard MUST reset each drifted key to its baseline value through `omp config set` (global config) and log each reset with its old value.
- **FR-007**: The guard MUST NOT block a Session launch beyond a bounded timeout; a write failure MUST NOT stop a launch.
- **FR-008**: The guard MUST NOT edit a Project's `.omp/config.yml`; when that file sets a guarded key, the notice MUST name the key and file.
- **FR-009**: When anything was reset or failed, Refract MUST show one toast per guard run, using the existing toast live region, naming each key with old → new, plus a Details control listing every key, old → new, each failure and each override.
- **FR-010**: Details MUST be keyboard reachable and built from existing shared components.
- **FR-011**: The backend MUST deliver the notice to the renderer through one new event on the existing event channel, declared in `src/shared/ipc.ts`.

### Key Entities

- **Baseline entry**: a guarded OMP key and its intended value (one entry per model for `compaction.modelThresholds`).
- **Guard notice**: the result of one run: reset entries (key, old, new), failures (key, old, new, reason), overrides (key, file).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A drifted guarded setting is back at its baseline in the global OMP config before the Session's `omp` starts, in every launch where the guard finishes within its timeout (SC-003 covers the rest).
- **SC-002**: A run with no drift adds no visible notice and one config read per cache window regardless of how many Sessions start.
- **SC-003**: A Session still starts in every guard failure case (slow, missing OMP, write failure).
- **SC-004**: A developer can open Details from the toast and read every changed key using the keyboard alone.

## Assumptions

- The baseline is the 2026-10-22 token-cost decision recorded in `docs/PLAN.md`; item 5 (baseline editing, the Settings "Guarded" tag) is delivered by #691.
- OMP's `config list --json` reports effective global values, and `omp config set <key> --json -- <value>` writes the global config.
- A Project's overrides live in `<worktree>/.omp/config.yml`.
- No new tests beyond Rust unit tests for the pure compare logic (prototyping rule, Rust-lane exception).
