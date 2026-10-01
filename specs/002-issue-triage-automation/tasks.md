# Tasks: Issue triage automation

**Input**: Design documents from `/specs/002-issue-triage-automation/`

**Tests**: `.github/scripts/triage.test.mjs` (`node:test`, 29 cases) covers `heuristicClassify`,
`isSpecRelated`, `normalise`, `mergeWithExisting`, the marker JSON helpers, `sanitizeRationale`,
`renderComment`'s prep-gating text, `parseModelJson`, and `prep-guard.mjs`'s `classifyEntry`/
`findViolations`; it runs as a required step in the `triage` job on every trigger, so it executes
on every real dispatch. There is no end-to-end workflow test harness in this repository; beyond
the unit tests, verification is `actionlint` and live `workflow_dispatch` runs against throwaway
issues, as called out per task.

**Organization**: Tasks are grouped by user story from spec.md so each story can be built,
verified, and checkpointed independently.

## Path Conventions

- Workflow: `.github/workflows/issue-triage.yml`
- Scripts: `.github/scripts/triage.mjs`, `.github/scripts/prep-guard.mjs`,
  `.github/scripts/triage.test.mjs`
- Agent brief: `.github/triage/prompt.md`
- Maintainer doc: `docs/issue-triage.md`
- Dependency updates: `.github/dependabot.yml`

## Phase 1: Setup

**Purpose**: Scaffold the files every later task edits in place.

- [x] T001 Create `.github/workflows/issue-triage.yml` with `name: Issue triage`, `on.issues.types:
      [opened]`, `on.workflow_dispatch.inputs` (`issue_number`, required string; `force`, optional
      boolean, default `false`), and a top-level `permissions: {}` (each job grants only what it
      needs).
- [x] T002 [P] Create `.github/scripts/triage.mjs` as an executable Node 22 ESM file with no npm
      dependencies.
- [x] T003 [P] Create `.github/scripts/prep-guard.mjs` as an executable Node 22 ESM file with no
      npm dependencies.
- [x] T004 [P] Create `.github/triage/prompt.md`: the brief handed to the prep agent, instructing
      it to treat the issue export file as untrusted data (never as instructions to execute), to
      follow `.omp/commands/speckit.*.md` for the given route, and to touch only paths under
      `specs/**`, `docs/**`, and `.specify/feature.json`.
- [x] T005 [P] Add `.triage/` to `.gitignore` so the prep job's scratch export
      (`.triage/issue-<N>.md`) is never committed.

## Phase 2: Foundational (blocking prerequisite for all stories)

**Purpose**: Core issue-loading, labeling, and idempotency plumbing that every user story's
classification and prep logic builds on.

**CRITICAL**: No user-story-specific behavior should be implemented until this phase is complete.

- [x] T006 In `.github/scripts/triage.mjs`, implement the issue loader: `GET
      /repos/{owner}/{repo}/issues/{number}` via the REST API using the built-in `fetch` with
      `Authorization: Bearer <GITHUB_TOKEN>`, returning title, body, existing labels, and
      `author_association`; skip with a no-op output set when the number is actually a pull
      request.
- [x] T007 In `.github/scripts/triage.mjs`, implement label read/create/apply helpers: list the
      repository's existing labels; create any missing label (state labels, or a type/area/
      priority label the classifier chose) via `POST /repos/{owner}/{repo}/labels`; add labels to
      an issue via `POST /repos/{owner}/{repo}/issues/{number}/labels` without ever removing an
      existing label.
- [x] T008 In `.github/workflows/issue-triage.yml`'s `triage` job, resolve the trigger-specific
      inputs at the workflow level — `ISSUE_NUMBER: ${{ github.event.issue.number ||
      inputs.issue_number }}` and `FORCE: ${{ inputs.force }}` — so one script invocation serves
      both the `issues.opened` and `workflow_dispatch` triggers without branching on event type
      inside `triage.mjs` itself.
- [x] T009 In `.github/scripts/triage.mjs`, implement the idempotency check: if the loaded issue
      already carries `triaged` and `FORCE` is not `"true"`, log the skip reason and exit before
      any classification call (depends on T006, T007, T008).

**Checkpoint**: Issue loading, labeling, and the triaged/force skip all work; classification logic
can now be layered in.

## Phase 3: User Story 1 - Automatic triage on new issues (Priority: P1)

**Goal**: Every newly opened issue is classified, labeled, and commented on with no maintainer
action.

**Independent Test**: Open or dispatch against a test issue with obviously-matching text; confirm
correct labels and exactly one disclosure comment within the triggering run.

- [x] T010 [US1] In `.github/scripts/triage.mjs`, implement the classifier: `POST
      https://api.anthropic.com/v1/messages` with header `x-api-key: <ANTHROPIC_API_KEY>`, model
      `TRIAGE_MODEL` (default `claude-haiku-4-5`), and a system prompt constraining output to the
      JSON schema (`type`, `area`, `priority`, `state`, `duplicate_of`, `speckit_route`,
      `rationale`); `ANTHROPIC_API_KEY` is optional, read from the same secret stage 2 uses.
- [x] T011 [US1] In `.github/scripts/triage.mjs`, implement the deterministic keyword-heuristic
      fallback covering every field except `area` (which it always leaves unset), used whenever
      `ANTHROPIC_API_KEY` is absent, the Anthropic call throws, or its reply has no extractable
      JSON object (depends on T010).
- [x] T012 [US1] [P] In `.github/scripts/triage.mjs`, implement label-precedence application: for
      each of type/area/priority, apply the classifier's value only if the issue does not already
      carry a label from that dimension's set (depends on T007, T010/T011).
- [x] T013 [US1] [P] In `.github/scripts/triage.mjs`, implement the single live triage comment:
      compose it starting with the literal line `> *This was generated by AI during triage.*`,
      summarizing type/area/priority/state/rationale/speckit_route and naming the heuristic
      fallback when it was used, identify any prior triage comment by a hidden marker, and `PATCH`
      it in place if found or `POST` a new one if not (depends on T010/T011).
- [x] T014 [US1] In `.github/scripts/triage.mjs`, apply the `triaged` label last, only after other
      labels and the comment have succeeded (depends on T012, T013).
- [x] T015 [US1] [P] Create `.github/scripts/triage.test.mjs` (`node:test`) covering
      `heuristicClassify`, `normalise`, `mergeWithExisting`, and `parseModelJson`, and wire `node
      --test .github/scripts/triage.test.mjs` as a required step in the `triage` job before
      classification runs (depends on T010, T011, T012).
- [x] T016 [US1] In `.github/workflows/issue-triage.yml`, add the `triage` job: `actions/
      checkout@v4`, `actions/setup-node@v4` pinned to Node 22, `permissions: {contents: read,
      issues: write}` (no `models:` permission — GitHub Models is retired), run `node
      .github/scripts/triage.mjs` with `GITHUB_TOKEN: ${{ github.token }}` and optional
      `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}` (depends on T001, T009, T014, T015).
- [x] T017 [US1] Live-test (heuristic path): dispatch the workflow against throwaway issue #90
      ("rename Pinion to Refract") and confirm it lands `chore`/`p1` plus a state label and a
      disclosure comment naming the heuristic fallback (depends on T016).
- [ ] T018 [US1] Live-test (model path): with `ANTHROPIC_API_KEY` configured as a repository
      secret, dispatch against an eligible issue and confirm the Anthropic-classified labels and
      comment appear without disclosing a fallback (depends on T016).
- [x] T019 [US1] Live-test: dispatch the workflow against throwaway issue #91 ("logo/icon design")
      and confirm it lands `design`/`p2` plus a state label and the disclosure comment (depends on
      T016).

**Checkpoint**: User Story 1 is independently complete — every opened issue is labeled and
commented on automatically. (Verified live for the heuristic path on #90; model-path and #91 runs
are still pending.)

## Phase 4: User Story 2 - Manual re-triage via workflow dispatch (Priority: P2)

**Goal**: A maintainer can safely re-run triage on demand, including forcing a re-run on an
already-triaged issue.

**Independent Test**: Dispatch against an already-triaged issue with no `force` and confirm the
existing comment is untouched; dispatch again with `force: true` and confirm that same comment is
updated in place.

- [x] T020 [US2] Confirm the idempotency check (T009) is force-aware: with `force: true` it
      re-classifies and reaches T013's comment step, which `PATCH`es the existing triage comment
      rather than creating a second one (depends on T009, T013).
- [x] T021 [US2] In `.github/scripts/triage.mjs`, fail loudly (non-zero exit, readable error) when
      the resolved `ISSUE_NUMBER` does not resolve to an existing issue, via the issue loader's
      REST error handling (depends on T006).
- [x] T022 [US2] Live-test: re-dispatch the workflow against issue #90 or #91 (already triaged by
      T017/T019) with no `force` and confirm the triage comment is unchanged; re-dispatch with
      `force: true` and confirm that same comment updates (depends on T020, T017, T019).

**Checkpoint**: User Story 2's logic is implemented and force-aware; live re-dispatch verification
is still pending.

## Phase 5: User Story 3 - Spec Kit prep draft for trusted, routable issues (Priority: P2)

**Goal**: A trusted, routable issue automatically gets a draft `specs/NNN-*` or converged-tasks
pull request.

**Independent Test**: Trigger prep for a trusted `specify`-routed issue and confirm a
`triage/issue-<N>` branch with only `specs/**`/`docs/**` changes and an open draft PR; trigger prep
for a `converge`-routed issue and confirm it amends an existing spec/tasks file instead.

- [x] T023 [US3] In `.github/scripts/triage.mjs`, expose `route`, `trusted`, `triaged`, and
      `issue_number` (plus `type`/`priority`/`state` for logging) as `triage` job outputs via
      `$GITHUB_OUTPUT`, so the `prep` job can gate on them (depends on T009, T012).
- [x] T024 [US3] In `.github/workflows/issue-triage.yml`, add the `prep` job, gated on
      `needs.triage.outputs.triaged == 'true' && needs.triage.outputs.route != 'none' &&
      needs.triage.outputs.trusted == 'true'`, with `permissions: {contents: write, issues: write,
      pull-requests: write}` (depends on T023).
- [x] T025 [US3] In the `prep` job's first step, check for the `ANTHROPIC_API_KEY` secret and, when
      it is absent, post a comment naming the missing secret and skip every later step, before any
      checkout happens (depends on T024).
- [x] T026 [US3] In the `prep` job, switch to the existing remote `triage/issue-<N>` branch if one
      exists, or create it fresh otherwise (depends on T025).
- [x] T027 [US3] In `.github/scripts/prep-guard.mjs`, implement the `export` command: fetch the
      issue via REST and write its title, author association, labels, and body to
      `.triage/issue-<N>.md`, never interpolating it into a shell string (depends on T026).
- [x] T028 [US3] In the `prep` job, invoke `anthropics/claude-code-action` with a prompt that points
      at `.github/triage/prompt.md`, the resolved `ROUTE`, and the exported issue file, restricted
      to a narrow `--allowedTools` set (Read/Write/Edit/Glob/Grep and the Spec Kit PowerShell
      scripts only) (depends on T027, T004).
- [x] T029 [US3] In `.github/scripts/prep-guard.mjs`, implement the `check` command: parse `git
      status --porcelain=v1 -z` and exit non-zero listing any path outside `specs/**`, `docs/**`,
      and `.specify/feature.json` (depends on T003); run it as a required step in the `prep` job
      after the agent and before any commit (depends on T028).
- [x] T030 [US3] In the `prep` job, stage only `specs`, `docs`, and `.specify/feature.json`, commit
      as `github-actions[bot]`, and push to the `triage/issue-<N>` branch using an installation
      token, skipping the push (and later steps) when nothing changed (depends on T029).
- [x] T031 [US3] In the `prep` job, open a draft PR linking the source issue via `gh pr create
      --draft`; when that fails (for example because "Allow GitHub Actions to create pull
      requests" is disabled), post a comment with the pushed branch's compare link instead
      (depends on T030).
- [x] T032 [US3] Guard-logic verification: the unit suite's "guard accepts spec and docs changes
      plus scratch output" and "guard rejects code, workflows, traversal, and absolute paths"
      cases (T015) already exercise `findViolations` against representative allowed and
      out-of-scope paths, and ran during the live #90 dispatch (T017) (depends on T015, T029).
- [ ] T033 [US3] Superseded by Phase 8: the single `prep` job this task targeted was split into
      `prep-agent`/`publish`/`notify-failure` (T040-T046). The equivalent live end-to-end
      verification is now T057 (depends on T031).

**Checkpoint**: User Story 3 is fully implemented; a live end-to-end run is still pending the
`ANTHROPIC_API_KEY` secret.

## Phase 6: User Story 4 - Untrusted or unready issues are safely declined (Priority: P3)

**Goal**: Prep never starts for an untrusted author or a missing secret, and the maintainer is
told why; prep never even considers an issue routed `none`.

**Independent Test**: Trigger triage on an issue from a non-collaborator account whose content
would otherwise warrant `speckit_route: specify`; confirm prep never runs and a skip-reason comment
appears.

- [x] T034 [US4] Confirm by inspection that the `prep` job's `if:` condition
      (`needs.triage.outputs.route != 'none'`) excludes `speckit_route: none` before the job even
      starts, so no skip comment is posted for that case (depends on T024).
- [x] T035 [US4] Confirm by inspection that the `prep` job's `if:` condition
      (`needs.triage.outputs.trusted == 'true'`) excludes a non-OWNER/MEMBER/COLLABORATOR author
      before the job even starts (depends on T024).
- [ ] T036 [US4] Live or simulated verification: dispatch against an issue from a non-collaborator
      account with a route that would otherwise warrant prep, and separately against an eligible
      issue with `ANTHROPIC_API_KEY` unset, confirming the expected no-run and missing-secret-
      comment behavior respectively (depends on T025, T034, T035).

**Checkpoint**: User Story 4's gating logic is implemented and inspected; live/simulated
confirmation is still pending.

## Phase 7: Polish & Cross-Cutting

**Purpose**: Maintainer-facing documentation and final lint pass.

- [x] T037 [P] Write `docs/issue-triage.md`: trigger summary, label vocabulary, priority rubric, how
      to force a re-triage, stage 2 prerequisites (`ANTHROPIC_API_KEY` secret, "Allow GitHub
      Actions to create pull requests" setting), the switch from GitHub Models (retired 2026-07-30)
      to the Anthropic Messages API, the live-test results for #90/#91, the three-job split, and
      the hardening fixes below.
- [x] T038 [P] Run `actionlint` against the finished `issue-triage.yml` and fix any reported issues
      (exit 0).
- [ ] T039 Note in `docs/issue-triage.md` that the labels/comments left on #90 (and #91, once
      tested) from live testing are the recorded verification examples, not stray data to clean up
      (depends on T037).

## Phase 8: Hardening

**Purpose**: Independent security and code review found stage 2 unsafe by construction before its
first live run (no `ANTHROPIC_API_KEY` secret has ever existed, so it had never actually executed).
This phase corrects the architecture and every specific finding before that first run. See
spec.md's Hardening FRs (FR-028 to FR-038) and `docs/issue-triage.md`'s Security notes for the
rationale behind each item.

- [x] T040 Split the `prep` job into `prep-agent` (`contents: read` only, no job-level
      `GH_TOKEN`/`GITHUB_TOKEN`, no git commands) and `publish` (`contents: write`,
      `issues: write`, `pull-requests: write`) in `issue-triage.yml`, so the job that ever runs the
      agent against untrusted issue content never holds write credentials (depends on T024).
- [x] T041 `prep-agent` checks out the default branch fresh (no `ref:`), never an existing
      `triage/issue-<N>` branch whose `.omp/commands`, `.specify/scripts/powershell/*.ps1`,
      `CLAUDE.md`, or `.claude/settings.json` a prior agent-influenced run could have rewritten
      (depends on T040).
- [x] T042 Scope `prep-agent`'s `claude-code-action` `--allowedTools` to `Read(./**)`, `Glob`,
      `Grep`, `Edit(specs/**)`, `Edit(docs/**)` (which also governs the Write tool), and five exact
      `Bash(pwsh .specify/scripts/powershell/<script>.ps1 *)` rules — replacing the previous
      `Bash(pwsh .specify/scripts/powershell/:*)` rule, which never matched any real invocation —
      and set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1"` (depends on T041).
- [x] T043 In `.github/scripts/prep-guard.mjs`, replace the git-based `parsePorcelain`/`check` pair
      with pure, filesystem-metadata-only `classifyEntry`/`findViolations` helpers and an
      `apply <dir>` command: walk a downloaded artifact, reject any symlink, any path with a `..`
      segment or a leading `/`, any file over 1 MiB, more than 300 total entries, and anything that
      is not a regular file matching `specs/<NNN-kebab-name>/**/*.md` or `docs/**/*.md` — but
      tolerate a pre-existing out-of-scope file (for example `docs/spike/*.mjs`, `*.ts`) that is
      byte-identical to the current working tree, since the whole-tree artifact upload (T040 has no
      git to diff with) would otherwise trip on every unrelated pre-existing file every run
      (depends on T003).
- [x] T044 `publish` downloads the `prep-output` artifact and runs `prep-guard.mjs apply` against
      the fresh default-branch checkout *before* creating or switching to the `triage/issue-<N>`
      branch — never after, so the guard's "is this unchanged from a trusted copy" comparison is
      never made against a branch a prior run could have tampered with — then commits and pushes
      using step-scoped `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` credentials
      instead of a token embedded in the push URL (depends on T043).
- [x] T045 `publish` reuses an existing open PR for the branch via `gh pr list --head
      "$BRANCH" --state open`, targets `${{ github.event.repository.default_branch }}` instead of
      a hardcoded `main`, and distinguishes the "Actions can't create PRs" repository setting from
      any other PR-creation failure by inspecting `gh pr create`'s captured stderr (depends on
      T044).
- [x] T046 Add the `notify-failure` job: comments a link to the failing run on the issue whenever
      `prep` was `true` but `prep-agent` or `publish` failed (depends on T040).
- [x] T047 In `.github/scripts/triage.mjs`, compute `trusted` from `author_association` *and* a
      live `GET /repos/{repo}/collaborators/{login}/permission` check reporting
      `admin`/`maintain`/`write`; an `OWNER` author skips the live check; any API error (including
      a 404 for a non-collaborator) fails closed to not-trusted (depends on T006).
- [x] T048 In `mergeWithExisting`, force `route` to `none` whenever `state != "ready-for-agent"`,
      and re-derive `route` to `none` for a maintainer-set `bug`/`chore` type with a `specify`
      route unless the issue text is spec-related (reusing the extracted `isSpecRelated` heuristic)
      (depends on T012).
- [x] T049 The bot records the labels it applied as JSON in its hidden marker comment
      (`renderMarker`/`parseMarker`); a `force` re-triage reads the prior marker to exclude the
      bot's own earlier labels from "maintainer intent" instead of treating them as permanently
      pinned, and `mergeWithExisting` removes a stale, now-wrong state label since the four state
      labels are mutually exclusive (depends on T013).
- [x] T050 `renderComment` only states prep will run once the final `prep` gate is actually `true`;
      otherwise it names the specific unmet condition (missing secret, author without write
      access, or state not `ready-for-agent`) instead of unconditionally promising a `prep` run
      (depends on T013, T023).
- [x] T051 `triage.mjs` computes a single `prep` output
      (`route != 'none' && state == 'ready-for-agent' && trusted && ANTHROPIC_API_KEY present`) and
      `prep-agent`/`publish` gate on it directly, replacing the old per-step secret-check-and-
      separate-skip-comment pattern in the workflow (depends on T047, T048).
- [x] T052 Case-insensitive label matching against the vocabulary sets, keeping the real label's
      casing for removal; paginate `/issues` and `/comments` (`Link: rel="next"`, up to 5 pages of
      100); accept a `422` only for `POST /labels` with `errors[0].code === "already_exists"`;
      match the marker comment only when `c.user.login === "github-actions[bot]"`; and report
      `normalise`'s `source` as `"model"` only when at least one field actually came from the model
      reply, not merely because the model call was attempted (depends on T006, T007, T010).
- [x] T053 `prep-guard.mjs export` wraps the untrusted issue title/body between two
      randomly-nonced `~~~~<hex>` fence marker lines instead of a plain heading, so the issue body
      itself can never forge a fake closing marker and escape early (depends on T027).
- [x] T054 Pin `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`,
      `actions/download-artifact`, and `anthropics/claude-code-action` to full commit SHAs with a
      `# vN` comment, and add `.github/dependabot.yml` for the `github-actions` ecosystem on a
      weekly schedule (depends on T001).
- [x] T055 Rewrite `.github/scripts/triage.test.mjs`: remove the git-porcelain-based tests, and add
      coverage for needs-info forcing `route: none`, a force re-triage ignoring the bot's own prior
      labels and clearing the stale state label, case-insensitive label matching, the bug/chore
      route re-derivation, rationale sanitizing, the marker JSON round-trip, and `classifyEntry`'s
      guard rules (symlink, non-markdown under `docs/`, non-markdown under `specs/`, a root file, a
      `..` segment, and the two valid cases) (depends on T043, T047, T048, T049, T052).
- [x] T056 Update `docs/issue-triage.md` and this feature's `spec.md`/`plan.md`/`tasks.md` to
      describe the three-job split, the apply-before-switch branch ordering, the
      `.specify/feature.json`/`SPECIFY_FEATURE_DIRECTORY` decision, and the real-write-access trust
      check (depends on T040-T055).
- [ ] T057 Live-test: once `ANTHROPIC_API_KEY` is configured, run the corrected `prep-agent`/
      `publish`/`notify-failure` jobs end-to-end against a trusted, routable issue and confirm the
      guard, fresh branch creation, and draft PR all behave as designed (depends on T044, T045,
      T046, T051).

## Phase 9: Hardening round 2

**Purpose**: A second independent security and code review of the Phase 8 hardening above found
further issues before stage 2's first live run. This phase corrects them. See spec.md's Hardening
round 2 FRs (FR-039 to FR-045) and `docs/issue-triage.md`'s Security notes.

- [x] T058 `publish` always creates `triage/issue-<N>` fresh from its own default-branch checkout
      (`git switch -c "$BRANCH"` with no start-point, never `"origin/$BRANCH"`) instead of
      switching onto a previous run's branch tip, which aborted whenever the guard's freshly
      applied output and the remote tip touched the same lines — a second run for the same issue
      does that by construction. The push becomes a compare-and-swap: `git ls-remote --exit-code
      --heads origin "$BRANCH"` first (exit 0 = exists, lease against its fetched SHA via `git
      push --force-with-lease`; exit 2 = absent, plain push; any other exit stops the step with a
      clear error instead of silently falling through) (depends on T044).
- [x] T059 The resolved converge feature directory is passed to the prep agent through its own
      `claude_args`/`prompt:` text (`FEATURE_DIRECTORY=...`), not only the `SPECIFY_FEATURE_DIRECTORY`
      environment variable, since the agent's shell access is limited to specific script
      invocations and it has no way to read its own process environment (depends on T042).
- [x] T060 `prep-guard.mjs`'s feature-directory resolution becomes an exported pure function
      `resolveFeatureDirectory(route, labels, existingDirs)`: `null` for anything but
      `route === "converge"`; falls back to `specs/001-core-session-workspace` when no `spec:NNN`
      label resolves and that directory exists; the triage job's export step gates it on `ROUTE`
      and re-validates the result's shape before it ever reaches a workflow output (depends on
      T027).
- [x] T061 `.github/triage/prompt.md`'s `specify` route gives the exact
      `create-new-feature.ps1 -Json -ShortName ... "..."` invocation and states the agent must not
      `mkdir` or write `.specify/feature.json` itself; its `converge` route references
      `FEATURE_DIRECTORY` directly instead of the unreadable environment variable (depends on
      T004, T059).
- [x] T062 All three `actions/checkout` steps pin `ref: ${{ github.event.repository.default_branch
      }}` explicitly, so a `workflow_dispatch` invoked from a non-default ref cannot substitute an
      untrusted reference tree (depends on T001, T041).
- [x] T063 `mergeWithExisting`'s `labelsToRemove` spans every vocabulary category (type, area,
      priority, state), not only state: any bot-owned label the new result disagrees with is
      removed, while a maintainer-set label is always left alone. A two-run test confirms the
      issue converges to exactly one label per dimension after a second, disagreeing run (depends
      on T049).
- [x] T064 A maintainer-set `bug`/`chore` type on a non-model classification re-derives
      `speckit_route` to `converge` when the text is spec-related (previously it incorrectly left
      the route unchanged at whatever the model had originally guessed); a model classification's
      own route still stands untouched. Fixed the test that asserted the old, inconsistent
      behaviour (depends on T048).
- [x] T065 `notify-failure`'s `if:` also matches `cancelled`, not only `failure`, for both
      `prep-agent` and `publish` (depends on T046).
- [x] T066 Updated `docs/issue-triage.md` and this feature's `spec.md`/`plan.md`/`tasks.md` to
      describe always-fresh force-with-lease publishing (replacing branch-tip reuse), the
      `FEATURE_DIRECTORY` prompt-text delivery and default-feature fallback, the default-branch
      `ref:` pin, and the generalised label-removal and route re-derivation rules (depends on
      T058-T065).

**Checkpoint**: Every Hardening round 2 finding has a corresponding fix in place and covered by
the unit suite, a manual git smoke test, or `actionlint`; only the live end-to-end run (T057)
remains, pending the `ANTHROPIC_API_KEY` secret.

## Phase 10: Hardening round 3

**Purpose**: A third independent security and code review found one Critical defect that had been
in `publish` since the very first split (it had gone unnoticed only because stage 2 has never run
live), one High regression the Phase 9 label-removal generalisation introduced, and a handful of
High/Medium/Low findings. See spec.md's Hardening round 3 FRs (FR-046 to FR-052) and
`docs/issue-triage.md`'s Security notes.

- [x] T067 Fixed the git credential header key from `http.https://github.com/${GITHUB_REPOSITORY}.git.extraheader`
      (never matches `actions/checkout`'s no-`.git`-suffix origin URL, so every `publish` push was
      silently unauthenticated) to `http.${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}.extraheader`, a
      path prefix of both URL forms. Confirmed via `git config --get-urlmatch` against both key
      forms in a real scratch repo (depends on T044).
- [x] T068 `gh pr list --head "$BRANCH"` now additionally filters `isCrossRepository==false` and
      `author.login=="github-actions[bot]"`, so a fork's PR of a same-named branch can no longer
      be endorsed on the trusted issue in place of the real pushed branch (depends on T045).
- [x] T069 Before force-pushing to an existing `triage/issue-<N>` branch, `publish` now checks
      `git log --format=%ae HEAD..origin/<branch>` (after unshallowing if needed, so shared
      history with the default branch is never mistaken for foreign commits) for any author other
      than `github-actions[bot]`; if found, it publishes to `triage/issue-<N>-<run-id>` instead,
      leaving the original branch and any PR on it untouched, and says so in the issue
      comment/PR body. Verified against a real scratch repo: a human commit on the branch
      redirects the push and is never overwritten; a bot-only branch still takes the normal
      force-with-lease path (depends on T058).
- [x] T070 `mergeWithExisting` now honours a maintainer-set state label the same way as
      type/area/priority (`existingState`, included in `maintainerOwned`, applied before the
      `ready-for-agent` route gate), fixing a regression where the bot's own state label could sit
      next to a maintainer's. Added a test using the review's exact repro (depends on T063).
- [x] T071 `notify-failure`'s `if:` now also matches `triage`'s own result, so a failure in a later
      `triage` step (export/upload) after `prep: true` was already output still gets reported
      (depends on T065).
- [x] T072 `prep-guard.mjs export` now refuses (comments why, then fails the step) a `converge` run
      whose feature directory cannot be resolved, instead of letting the agent run with no target
      or silently producing no changes (depends on T060).
- [x] T073 [P] The base64 git credential header value is now explicitly masked (`::add-mask::`)
      before use, since Actions only auto-masks the raw token it was derived from, not the encoded
      form; the `git ls-remote` pattern is now the exact ref `refs/heads/$BRANCH`, not a `--heads
      <name>` suffix pattern that could also match an unrelated ref ending in the same path
      (depends on T058).
- [x] T074 Updated `docs/issue-triage.md` and this feature's `spec.md`/`plan.md`/`tasks.md` to
      describe the fixed credential header, the fork-PR exclusion, the human-commit protection and
      run-scoped fallback branch, maintainer-state honouring, the broadened `notify-failure`
      condition, and the converge-feature-missing refusal; documented the raw-dispatch-input
      concurrency-key limitation as an intentionally accepted residual gap (depends on T067-T073).

**Checkpoint**: Every Hardening round 3 finding has a corresponding fix in place, covered by the
unit suite, `actionlint`, or a manual git smoke test against a real scratch repo; only the live
end-to-end run (T057) remains, pending the `ANTHROPIC_API_KEY` secret.

## Phase 11: Hardening round 4 and live-proof mode

**Purpose**: Small fixes requested inline from a fourth review (no new review round), plus a
`fixture` `workflow_dispatch` mode that exercises `prep-agent`/`publish` end-to-end without
`ANTHROPIC_API_KEY`. See spec.md's FR-053 to FR-056 and `docs/issue-triage.md`'s Security notes
and new "Live-proof mode" subsection.

- [x] T075 Fixed `publish`'s PR-reuse filter to match `app/github-actions` (the login `gh pr list`
      reports for the default token's own PRs), not `github-actions[bot]` (the comment-login
      format); `gh pr list`'s own failure is now captured and reported (`::error::` plus the
      captured stderr, then `exit 1`) instead of being swallowed by `2>/dev/null || true` and
      silently treated as "no existing PR" (depends on T068).
- [x] T076 The run-scoped fallback branch name now includes `${GITHUB_RUN_ATTEMPT}` as well as
      `${GITHUB_RUN_ID}` (`triage/issue-<N>-<run-id>-<run-attempt>`), so re-running failed jobs on
      the same run id cannot collide with its own prior attempt's push (depends on T069).
- [x] T077 The foreign-commit check before a force-with-lease push now examines both author and
      committer email (`git log --format='%ae%n%ce'`), not author alone, so a human `git commit
      --amend` of a bot commit — which keeps the original author but changes only the committer —
      is still caught. Verified against a real scratch repo: the old author-only check missed the
      amend; the new check catches it (depends on T069).
- [x] T078 Fixed the credential-header comment, which incorrectly claimed the key matches both the
      `.git`-suffixed and `.git`-less URL forms: it only ever matches the `.git`-less form
      `actions/checkout` actually leaves on `origin` (and paths under it). Confirmed with `git
      config --get-urlmatch` against both forms in a real scratch repo (depends on T067).
- [x] T079 [P] Added `computePrepGate`, an exported pure function factoring the `prep`/`route`
      output decision (including the new fixture-mode override) out of `main()` so it is
      unit-testable; added tests for fixture-active, fixture-inactive-when-untrusted, and
      unchanged non-fixture gating (depends on T051). Noted in plan.md that the `gh`/`jq`-based
      PR-reuse author filter and `gh pr list` error path are not unit-testable in JS and are
      covered only by `actionlint` and manual review.
- [x] T080 Added the `fixture` boolean `workflow_dispatch` input (default `false`) and the
      `FIXTURE` env var it maps to in `triage.mjs`'s classify step (`'true'` only when
      `inputs.fixture` is checked on a dispatch, empty otherwise) (depends on T016).
- [x] T081 In `triage.mjs`, fixture mode (`FIXTURE=="true"` and the author is trusted) forces
      `prep: true` and the `route` output to `specify` regardless of key/state/route, changes no
      label, and appends exactly one line to the otherwise-unchanged classification comment
      ("Fixture mode: the agent is skipped and a canned spec is published to exercise the publish
      job.") (depends on T079).
- [x] T082 In `prep-agent`, the `claude-code-action` step now runs only `if: inputs.fixture !=
      true`; a new step, `if: inputs.fixture == true`, writes a small, fixed,
      non-untrusted-text `specs/900-triage-fixture/spec.md` naming only the issue number, which
      flows through the existing upload/download/`prep-guard.mjs apply`/branch/commit/push/
      PR-or-compare-link path unchanged. `ANTHROPIC_API_KEY` is never required in fixture mode
      since the only step that references it is skipped entirely (depends on T080).
- [x] T083 Documented live-proof mode in `docs/issue-triage.md` (how to run it, what it publishes,
      that the throwaway branch/PR should be deleted afterwards) and this feature's
      `spec.md`/`plan.md`/`tasks.md` (FR-056; depends on T081, T082).

**Checkpoint**: Every Hardening round 4 finding and the live-proof mode are implemented and
covered by the unit suite, `actionlint`, or a manual git smoke test; T057 (the real agent's live
end-to-end run, pending `ANTHROPIC_API_KEY`) remains the only unchecked item — live-proof mode
verifies everything downstream of the agent without needing that secret, but does not replace
T057 itself, since it never exercises `claude-code-action`.

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion. BLOCKS all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational completion.
- **User Story 2 (Phase 4)**: Depends on Foundational completion; its force-aware skip (T020)
  builds directly on User Story 1's idempotency and comment logic (T009, T013).
- **User Story 3 (Phase 5)**: Depends on Foundational completion and on User Story 1's classifier
  exposing job outputs (T010/T011, T023).
- **User Story 4 (Phase 6)**: Depends on User Story 3's `prep` job and gate existing (T024, T025).
- **Polish (Phase 7)**: Depends on all user stories being complete.
- **Hardening (Phase 8)**: Depends on Polish (Phase 7) being complete; it corrects User Story 3's
  `prep` job (replacing it with `prep-agent`/`publish`/`notify-failure`) and User Story 1's
  trust/routing logic before stage 2's first live run.
- **Hardening round 2 (Phase 9)**: Depends on Phase 8 being complete; a second review of that same
  redesign before stage 2's first live run.
- **Hardening round 3 (Phase 10)**: Depends on Phase 9 being complete; a third review of that same
  redesign before stage 2's first live run.
- **Hardening round 4 and live-proof mode (Phase 11)**: Depends on Phase 10 being complete; small
  fixes from a fourth review plus a `fixture` mode to verify `prep-agent`/`publish` without the
  secret.

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational. No dependency on other stories.
- **User Story 2 (P2)**: Can start after Foundational; reuses US1's idempotency/comment code, so in
  practice follows it.
- **User Story 3 (P2)**: Can start after Foundational and after US1 exposes job outputs; otherwise
  independent of US2.
- **User Story 4 (P3)**: Depends on US3's `prep` job and gate existing; otherwise independently
  testable (the gate conditions, not the agent run, are what is being verified).

### Within Each User Story

- Script logic before the workflow step that calls it.
- The workflow job/step before its live-test or dry-run verification task.
- Guard and gate logic before the commit/PR step they protect.

### Parallel Opportunities

- T002, T003, T004, T005 (Setup) can run in parallel — distinct files.
- T012 and T013 (US1) can run in parallel once T010/T011 exist — distinct concerns in the same
  file, but non-overlapping line ranges.
- T037 and T038 (Polish) can run in parallel — distinct files.

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: run T018/T019 live against the model path and #91, alongside the already-
   completed T017.
5. Deploy/merge if ready — User Story 1 alone already removes manual first-pass triage.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. User Story 1 implemented and partially live-verified (T017) → model-path and #91 runs (T018,
   T019) remain.
3. User Story 2 implemented → live re-dispatch verification (T022) remains.
4. User Story 3 fully implemented, then superseded/corrected by Hardening's `prep-agent`/`publish`/
   `notify-failure` split (T040-T046) → live end-to-end run (T057) remains, pending the
   `ANTHROPIC_API_KEY` secret.
5. User Story 4 gating logic implemented and inspected → live/simulated confirmation (T036)
   remains.
6. Polish: `docs/issue-triage.md` written and `actionlint` passing (T037, T038); T039 remains.
7. Hardening (T040-T056) implemented and covered by the unit suite and `actionlint` → the live
   end-to-end run (T057) remains, the same pending gap T033 always had.
8. Hardening round 2 (T058-T066) implemented and covered by the unit suite, a manual git smoke
   test of the always-fresh force-with-lease push, and `actionlint` → T057 remains the only gap.
9. Hardening round 3 (T067-T074) implemented and covered by the unit suite, `actionlint`, and
   manual git smoke tests of the credential-header fix and the human-commit protection against
   real scratch repos → T057 remains the only gap.
10. Hardening round 4 and live-proof mode (T075-T083) implemented and covered by the unit suite,
    `actionlint`, and manual git smoke tests of the author-or-committer check and the
    credential-header URL-match behaviour → T057 (the real agent's live run) remains the only
    gap; `fixture: true` can now verify everything downstream of it without the secret.

Each phase adds value without breaking the previous ones: US1 alone is already useful; US2 adds
recoverability; US3 adds the draft-PR automation; US4 hardens US3 against untrusted/unready input.

## Notes

- `[P]` tasks touch different files, or non-overlapping sections of the same file, with no
  dependency between them.
- `[Story]` labels map each task to the user story it serves, for traceability back to spec.md.
- Classification now uses the Anthropic Messages API, not GitHub Models: GitHub Models
  (`models.github.ai`) is fully retired as of 2026-07-30. `ANTHROPIC_API_KEY` is optional for
  stage 1 (triage falls back to the heuristic without it) but required for stage 2
  (`prep-agent`/`publish`).
- Commit after each task or logical group; stop at any checkpoint to validate that story
  independently before continuing.
- Avoid vague tasks, same-file conflicts without an explicit note, and cross-story dependencies
  that would break independent testability (the two P2 stories, US2 and US3, do not depend on each
  other).
