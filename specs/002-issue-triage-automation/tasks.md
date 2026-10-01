# Tasks: Issue triage automation

**Input**: Design documents from `/specs/002-issue-triage-automation/`

**Prerequisites**: plan.md, spec.md

**Tests**: `.github/scripts/triage.test.mjs` (`node:test`, 38 cases) covers `heuristicClassify`,
`isSpecRelated`, `normalise`, `mergeWithExisting`, the marker JSON helpers, `sanitizeRationale`,
`resolveFeatureDirectory`, `renderPickupPlan`, and `renderComment`; it runs as a required step in
the `triage` job on every trigger, so it executes on every real dispatch. There is no end-to-end
workflow test harness in this repository; beyond the unit tests, verification is `actionlint` and
live `workflow_dispatch` runs against throwaway issues, as called out per task.

**Organization**: Tasks are grouped by user story from spec.md so each story can be built,
verified, and checkpointed independently.

## Path Conventions

- Workflow: `.github/workflows/issue-triage.yml`
- Script: `.github/scripts/triage.mjs`
- Tests: `.github/scripts/triage.test.mjs`
- Maintainer doc: `docs/issue-triage.md`
- Dependency updates: `.github/dependabot.yml`

## Phase 1: Setup

**Purpose**: Scaffold the files every later task edits in place.

- [x] T001 Create `.github/workflows/issue-triage.yml` with `name: Issue triage`, `on.issues.types:
      [opened]`, `on.workflow_dispatch.inputs` (`issue_number`, required string; `force`, optional
      boolean, default `false`), and a top-level `permissions: {}`.
- [x] T002 Create `.github/scripts/triage.mjs` as an executable Node 22 ESM file with no npm
      dependencies.
- [x] T003 Create `.github/scripts/triage.test.mjs` (`node:test`) alongside it.

## Phase 2: Foundational (blocking prerequisite for all stories)

**Purpose**: Core issue-loading, labeling, and idempotency plumbing that every user story's
classification and pickup-plan logic builds on.

**CRITICAL**: No user-story-specific behavior should be implemented until this phase is complete.

- [x] T004 In `.github/scripts/triage.mjs`, implement the issue loader: `GET
      /repos/{owner}/{repo}/issues/{number}` via the REST API using the built-in `fetch` with
      `Authorization: Bearer <GITHUB_TOKEN>`, returning title, body, and existing labels; skip
      with a no-op output when the number is actually a pull request.
- [x] T005 In `.github/scripts/triage.mjs`, implement label read/create/apply/remove helpers: list
      the repository's existing labels; create any missing label via `POST
      /repos/{owner}/{repo}/labels`; add labels via `POST
      /repos/{owner}/{repo}/issues/{number}/labels`; remove a label via `DELETE
      .../labels/{name}` (ignoring a 404 — already gone).
- [x] T006 In `.github/scripts/triage.mjs`, implement the idempotency check: if the loaded issue
      already carries `triaged` and `FORCE` is not `"true"`, log the skip reason and exit before
      any classification call (depends on T004, T005).
- [x] T007 In `.github/workflows/issue-triage.yml`'s single `triage` job, resolve the
      trigger-specific inputs — `ISSUE_NUMBER: ${{ github.event.issue.number ||
      inputs.issue_number }}` and `FORCE: ${{ inputs.force }}` — so one script invocation serves
      both the `issues.opened` and `workflow_dispatch` triggers; pin the checkout's `ref` to the
      repository's default branch rather than the triggering ref.

**Checkpoint**: Issue loading, labeling, and the triaged/force skip all work; classification logic
can now be layered in.

## Phase 3: User Story 1 - Automatic triage on new issues (Priority: P1)

**Goal**: Every newly opened issue is classified, labeled, and commented on with no maintainer
action.

**Independent Test**: Open or dispatch against a test issue with obviously-matching text; confirm
correct labels and exactly one disclosure comment ending in a pickup plan within the triggering
run.

- [x] T008 [US1] In `.github/scripts/triage.mjs`, implement the classifier: `POST
      https://api.anthropic.com/v1/messages` with header `x-api-key: <ANTHROPIC_API_KEY>`, model
      `TRIAGE_MODEL` (default `claude-haiku-4-5`), and a system prompt constraining output to the
      JSON schema (`type`, `area`, `priority`, `state`, `duplicate_of`, `speckit_route`,
      `rationale`, `pickup_notes`); `ANTHROPIC_API_KEY` is optional.
- [x] T009 [US1] In `.github/scripts/triage.mjs`, implement the deterministic keyword-heuristic
      fallback covering every field except `area` and `pickup_notes` (always unset/empty), used
      whenever `ANTHROPIC_API_KEY` is absent, the Anthropic call throws, or its reply has no
      extractable JSON object (depends on T008).
- [x] T010 [US1] [P] In `.github/scripts/triage.mjs`, implement label-precedence application: for
      each of type/area/priority/**state**, apply the classifier's value only if the issue does
      not already carry a maintainer-set label from that dimension's set (depends on T005, T008,
      T009).
- [x] T011 [US1] [P] In `.github/scripts/triage.mjs`, implement the single live triage comment:
      compose it starting with the literal line `> *This was generated by AI during triage.*`,
      summarizing type/area/priority/state/rationale/speckit_route and naming the heuristic
      fallback when it was used, identify any prior triage comment by a hidden JSON marker, and
      `PATCH` it in place if found or `POST` a new one if not (depends on T008, T009).
- [x] T012 [US1] In `.github/scripts/triage.mjs`, apply the `triaged` label last, only after other
      labels and the comment have succeeded (depends on T010, T011).
- [x] T013 [US1] [P] `.github/scripts/triage.test.mjs` covers `heuristicClassify`, `normalise`,
      `mergeWithExisting`, and `parseModelJson`; wired as a required step in the `triage` job
      before classification runs (depends on T008, T009, T010).
- [x] T014 [US1] In `.github/workflows/issue-triage.yml`, the `triage` job: `actions/checkout`,
      `actions/setup-node` (both pinned to a full commit SHA), `permissions: {contents: read,
      issues: write}` (no `models:` permission — GitHub Models is retired), runs `node
      .github/scripts/triage.mjs` with `GITHUB_TOKEN: ${{ github.token }}` and optional
      `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}` (depends on T007, T012, T013).
- [x] T015 [US1] Live-test (heuristic path): dispatched the workflow against throwaway issue #90
      ("rename Pinion to Refract") and confirmed it landed `chore`/`p1` plus a state label and a
      disclosure comment naming the heuristic fallback (depends on T014).
- [ ] T016 [US1] Live-test (model path): with `ANTHROPIC_API_KEY` configured as a repository
      secret, dispatch against an eligible issue and confirm the Anthropic-classified labels,
      comment, and pickup plan appear without disclosing a fallback (depends on T014).
- [x] T017 [US1] Live-test: dispatched the workflow against throwaway issue #91 ("logo/icon
      design") and confirmed it landed `design`/`p2` plus a state label and the disclosure comment
      (depends on T014).

**Checkpoint**: User Story 1 is independently complete — every opened issue is labeled and
commented on automatically. Verified live for the heuristic path on #90 and #91; the model path
remains the only pending verification (needs the secret).

## Phase 4: User Story 2 - Manual re-triage via workflow dispatch (Priority: P2)

**Goal**: A maintainer can safely re-run triage on demand, including forcing a re-run on an
already-triaged issue, with any maintainer-set label (including state) always winning.

**Independent Test**: Dispatch against an already-triaged issue with no `force` and confirm the
existing comment is untouched; dispatch again with `force: true` and confirm that same comment is
updated in place and stale bot-owned labels are cleared without touching maintainer-set ones.

- [x] T018 [US2] Confirm the idempotency check (T006) is force-aware: with `force: true` it
      re-classifies and reaches T011's comment step, which `PATCH`es the existing triage comment
      rather than creating a second one (depends on T006, T011).
- [x] T019 [US2] In `.github/scripts/triage.mjs`, fail loudly (non-zero exit, readable error) when
      the resolved `ISSUE_NUMBER` does not resolve to an existing issue, via the issue loader's
      REST error handling (depends on T004).
- [x] T020 [US2] In `.github/scripts/triage.mjs`, record the labels the bot itself applies as JSON
      in the hidden marker comment (`renderMarker`/`parseMarker`); a `force` re-triage reads the
      prior marker to exclude the bot's own earlier labels from "maintainer intent", and removes
      any stale bot-owned label across all four dimensions (type, area, priority, state) whose
      value the new result disagrees with — never a label a maintainer set (depends on T010,
      T011).
- [x] T021 [US2] Live-test: re-dispatched the workflow against issue #90 (already triaged by T015)
      with no `force` and confirmed the triage comment was unchanged; re-dispatched with `force:
      true` and confirmed that same comment updated (depends on T018, T015).

**Checkpoint**: User Story 2 is fully implemented and live-verified.

## Phase 5: User Story 3 - Spec Kit pickup plan for a routable issue (Priority: P2)

**Goal**: A `ready-for-agent` or `ready-for-human` issue's comment names the exact, ordered Spec
Kit commands to run next, with the converge route naming the real target feature directory.

**Independent Test**: Trigger triage for a `specify`-routed issue and confirm the comment lists
`/speckit.specify` through `/speckit.implement` in order; trigger it for a `converge`-routed issue
and confirm the comment names an existing feature directory and the converge sequence instead.

- [x] T022 [US3] In `.github/scripts/triage.mjs`, implement `resolveFeatureDirectory(route,
      labels, existingDirs)`: pure and filesystem-free (existingDirs is the caller's directory
      listing); returns `null` unless `route === "converge"`; maps a `spec:NNN` label to its
      existing `specs/NNN-*` directory; falls back to `specs/001-core-session-workspace` when no
      label is present and that directory exists.
- [x] T023 [US3] In `.github/scripts/triage.mjs`, implement `listSpecsDirs()` to read the real
      `specs/` directory listing from the checked-out workspace, and wire it with T022's pure
      resolver into `main()` (depends on T022).
- [x] T024 [US3] In `.github/scripts/triage.mjs`, implement `renderPickupPlan(classification,
      featureDirectory)`: deterministic from `state`/`route`/`type` alone — no model call needed.
      `needs-info` and `needs-triage`/`duplicate_of` list no Spec Kit command; `ready-for-agent`
      lists the ordered pipeline for `specify` or `converge` (or a one-line hint by `type` when
      the route is `none`); `ready-for-human` lists the same pipeline prefixed to say it applies
      after the human decision/manual work is done (depends on T022).
- [x] T025 [US3] In `.github/scripts/triage.mjs`, support the optional model field `pickup_notes`
      in `normalise`: cap at 4 entries of at most 160 characters each, dropping non-string/blank
      entries; the heuristic fallback always returns `[]` (depends on T009).
- [x] T026 [US3] In `.github/scripts/triage.mjs`'s `renderComment`, embed the pickup plan under a
      `## Spec Kit pickup plan` heading, and render non-empty `pickup_notes` as a `Watch for:`
      bullet list (each entry sanitised and wrapped in an inline code span, same as `rationale`),
      omitted entirely when empty (depends on T024, T025).
- [x] T027 [US3] [P] Unit tests for `resolveFeatureDirectory`, `renderPickupPlan` (every
      route/state/type combination), and `renderComment`'s pickup-plan/pickup-notes rendering
      (depends on T022, T024, T025, T026).

**Checkpoint**: User Story 3 is fully implemented and covered by the unit suite.

## Phase 6: User Story 4 - Unready or unclear issues are safely declined (Priority: P3)

**Goal**: `needs-info` and `needs-triage` issues get a short "not ready" note instead of a Spec
Kit pipeline.

**Independent Test**: Trigger triage on a too-short issue and confirm the comment says
clarification is needed and lists no commands; trigger it on a likely duplicate and confirm the
comment says a human should triage it first, also with no commands.

- [x] T028 [US4] In `renderPickupPlan`, `state: needs-info` returns a clarification-needed message
      with no Spec Kit command, checked before any route logic (depends on T024).
- [x] T029 [US4] In `renderPickupPlan`, `state: needs-triage` or a truthy `duplicate_of` returns a
      human-should-triage message with no Spec Kit command (depends on T024).
- [x] T030 [US4] Unit tests confirming both cases list no `/speckit.*` command (depends on T028,
      T029).

**Checkpoint**: User Story 4's gating logic is implemented and unit-tested.

## Phase 7: Polish & Cross-Cutting

**Purpose**: Maintainer-facing documentation, lint pass, and the clean cutover from the
previously-shipped (never live-run) stage 2 design.

- [x] T031 [P] Rewrote `docs/issue-triage.md`: what it does, label/priority/state/route tables,
      the Spec Kit pickup plan's exact rules, setup (nothing required; optional
      `ANTHROPIC_API_KEY` + `TRIAGE_MODEL`), how to run it manually, and security notes
      (`contents: read`/`issues: write` only, issue text only ever reaches the classifier as data,
      no agent runs in CI).
- [x] T032 [P] Ran `actionlint` against the finished `issue-triage.yml` (exit 0).
- [x] T033 Clean cutover: deleted `.github/scripts/prep-guard.mjs`, `.github/triage/prompt.md`
      (and the now-empty `.github/triage/` directory), and the `.triage/` entry from
      `.gitignore`; removed the `triage` job's `outputs:` block, the export/upload-artifact steps,
      and the `prep-agent`/`publish`/`notify-failure` jobs from `issue-triage.yml`; removed
      `computePrepGate`, the real-write-access trust check, the `fixture` live-proof mode, and
      every other stage-2-only code path from `triage.mjs` and its tests. No shims or "removed"
      comments were left behind.

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion. BLOCKS all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational completion.
- **User Story 2 (Phase 4)**: Depends on Foundational completion; its force-aware skip (T018)
  builds directly on User Story 1's idempotency and comment logic (T006, T011).
- **User Story 3 (Phase 5)**: Depends on Foundational completion and on User Story 1's classifier
  (T008/T009) and comment renderer (T011) existing.
- **User Story 4 (Phase 6)**: Depends on User Story 3's `renderPickupPlan` existing (T024).
- **Polish (Phase 7)**: Depends on all user stories being complete.

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational. No dependency on other stories.
- **User Story 2 (P2)**: Can start after Foundational; reuses US1's idempotency/comment code, so in
  practice follows it.
- **User Story 3 (P2)**: Can start after Foundational and after US1 exposes the classifier/comment
  renderer; otherwise independent of US2.
- **User Story 4 (P3)**: Depends on US3's `renderPickupPlan` existing; otherwise independently
  testable.

### Within Each User Story

- Script logic before the workflow step that calls it.
- The workflow job/step before its live-test or dry-run verification task.

### Parallel Opportunities

- T002 and T003 (Setup) can run in parallel — distinct files.
- T010 and T011 (US1) can run in parallel once T008/T009 exist — distinct concerns in the same
  file, but non-overlapping line ranges.
- T027 (US3) and T031/T032 (Polish) can run in parallel — distinct files.

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: run T016 live against the model path once the secret exists.
5. Deploy/merge if ready — User Story 1 alone already removes manual first-pass triage.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. User Story 1 implemented and live-verified for the heuristic path (T015, T017) → the model path
   (T016) remains, pending the secret.
3. User Story 2 implemented and live-verified (T018-T021).
4. User Story 3 (the Spec Kit pickup plan) implemented and covered by the unit suite (T022-T027).
5. User Story 4 (safe decline for unready issues) implemented and unit-tested (T028-T030).
6. Polish: docs rewritten, `actionlint` clean, and the clean cutover from stage 2 complete
   (T031-T033).

Each phase adds value without breaking the previous ones: US1 alone is already useful; US2 adds
recoverability; US3 adds the pickup-plan guidance; US4 keeps that guidance from misfiring on an
issue that was never ready for it.

## Notes

- `[P]` tasks touch different files, or non-overlapping sections of the same file, with no
  dependency between them.
- `[Story]` labels map each task to the user story it serves, for traceability back to spec.md.
- Classification uses the Anthropic Messages API, not GitHub Models: GitHub Models
  (`models.github.ai`) is fully retired as of 2026-07-30. `ANTHROPIC_API_KEY` is entirely optional
  — triage always completes via the deterministic heuristic without it.
- Commit after each task or logical group; stop at any checkpoint to validate that story
  independently before continuing.
- Avoid vague tasks, same-file conflicts without an explicit note, and cross-story dependencies
  that would break independent testability.
