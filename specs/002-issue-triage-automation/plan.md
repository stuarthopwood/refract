# Implementation Plan: Issue triage automation

**Branch**: `002-issue-triage-automation` | **Date**: 2026-10-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-issue-triage-automation/spec.md`

## Summary

Add a GitHub Actions workflow, entirely outside the Electron app, that triages every issue and
drafts Spec Kit work for the ones that warrant it. Stage 1 (`triage.mjs`, job `triage`) reads the
issue via the REST API, classifies it with an Anthropic Messages API call when
`ANTHROPIC_API_KEY` is configured (falling back to a deterministic keyword heuristic — which never
sets `area` — when the key is absent or the call fails), labels the issue without overriding
maintainer-set labels (distinguishing its own prior labels from a maintainer's via a hidden JSON
marker), and posts one disclosure comment that only ever promises prep will run when it actually
will. Stage 2 is split into three jobs so the agent that ever sees untrusted issue content never
holds a write-capable token: `prep-agent` (`contents: read` only, no git, no `GH_TOKEN`) runs
`anthropics/claude-code-action` against a fresh default-branch checkout, scoped to
`Read(./**)`/`Edit(specs/**)`/`Edit(docs/**)`/`Glob`/`Grep` plus five pinned Spec Kit PowerShell
script rules, and uploads the resulting `specs/`+`docs/` tree as an artifact; `publish`
(`contents: write`, `issues: write`, `pull-requests: write`) downloads that artifact, runs the
deterministic guard (`prep-guard.mjs apply`) against a fresh, known-good default-branch checkout
*before* switching branches, commits only the files that pass, pushes to `triage/issue-<N>` using a
step-scoped git credential, and opens (or reuses) a draft PR — or comments a compare link if PR
creation is disabled. A `notify-failure` job comments a link to the run if `prep-agent` or
`publish` fails. `trusted` requires both `author_association` and a live collaborator-permission
check, failing closed on error.

## Technical Context

**Language/Version**: Node.js 22, as the `ubuntu-latest` GitHub-hosted runner's expected toolchain
(pinned explicitly via `actions/setup-node@v4` rather than relying on the runner image's default).

**Primary Dependencies**: None at runtime for `.github/scripts/triage.mjs` and
`.github/scripts/prep-guard.mjs` — both are zero-npm-dependency ESM scripts using Node's built-in
`fetch` and `node:crypto` (a random nonce for the untrusted-issue export fence).
`anthropics/claude-code-action` is a third-party GitHub Action (not an npm dependency) that drives
`prep-agent`. `actionlint` is a dev-time-only workflow linter, not a runtime dependency. Every
third-party Action is pinned to a full commit SHA (FR-038), kept current via
`.github/dependabot.yml`.

**Storage**: N/A. All state lives in GitHub itself (issue labels, comments, branches, pull
requests) plus two short-lived (`retention-days: 1`) workflow artifacts (`issue-export`,
`prep-output`) that carry data between the `triage`/`prep-agent`/`publish` jobs. Nothing is
persisted beyond a run.

**Testing**: `actionlint` against `issue-triage.yml` (exit 0); `node --test
.github/scripts/triage.test.mjs` (29 deterministic unit tests covering the classifier, the
maintainer/bot-label merge logic, the marker JSON helpers, rationale sanitising, and the guard's
`classifyEntry`/`findViolations`); a manual smoke run of `prep-guard.mjs apply` against a scratch
directory simulating an unchanged pre-existing non-markdown file (silently skipped) and a modified
one (rejected). Live `workflow_dispatch` dispatch of the heuristic path against throwaway issue #90
for stage 1 (the model-path run and issue #91 are still pending). Stage 2 cannot be exercised live
until `ANTHROPIC_API_KEY` is added as a repository secret, so for now it is verified only by
`actionlint`, the unit tests, and the `prep-guard.mjs apply` smoke run — it must be correct by
construction.

**Target Platform**: GitHub Actions `ubuntu-latest` hosted runner.

**Project Type**: CI/CD automation under `.github/`, outside the Electron application; no changes
to `src/`.

**Performance Goals**: The triage job completes classification, labeling, and commenting within a
single workflow run, well inside GitHub Actions' default job timeout. There is no near-real-time
requirement, since issue creation is already asynchronous from a contributor's perspective.

**Constraints**: `triage.mjs` and `prep-guard.mjs` MUST stay zero-npm-dependency. Untrusted issue
title/body text MUST NEVER be interpolated into a `run:` shell step. Published changes MUST be
confined to regular, non-symlink, non-oversized files matching `specs/<NNN-kebab-name>/**/*.md` or
`docs/**/*.md` (FR-032), validated against the default branch's own tree, never against git state
inside a job the agent could influence. Publishing MUST commit only to `triage/issue-<N>` branches,
never to `main`. The `triage` job MUST run with only `contents: read`, `issues: write`; the
`prep-agent` job MUST run with `contents: read` only, no job-level `GH_TOKEN`/`GITHUB_TOKEN`, and
no git commands (FR-029); `publish` holds the only write-capable permissions
(`contents: write`, `issues: write`, `pull-requests: write`). No `models: read` anywhere, since
GitHub Models is retired and classification uses the Anthropic Messages API instead.

**Scale/Scope**: Single private repository; one issue per run; no concurrent-run concerns beyond
GitHub Actions' default per-ref concurrency behavior.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.* Constitution v1.7.0.

| Principle | Status | How the design meets it |
|---|---|---|
| I. OMP Is the Engine, Pinion Is the Host | N/A | This feature has no Electron process and drives no `omp` child process. Stage 2's agent is `anthropics/claude-code-action` (Claude Code), invoked directly by GitHub Actions — not the Pinion desktop app, and not OMP. |
| II. RPC Wire Contract | N/A | No RPC is involved. Stage 1 calls the GitHub REST API and the Anthropic Messages API directly; stage 2 is driven by Claude Code Action following its own prompt, not by the `rpc-ui` protocol this principle governs. |
| III. Session and Process Lifecycle | N/A | There is no `omp` process, worktree, or session registry. The only "session" is the ephemeral GitHub Actions job runner, which GitHub itself manages. |
| IV. Evidence Before Design | Pass | The underlying rule — do not design around unverified external behavior — is honored even though its examples are OMP-specific: stage 1's classification and labeling behavior was exercised live on throwaway issues #90 and #91 (see spec.md SC-006) before stage 2 was finalized. Stage 2 remains verified only by `actionlint` and a `prep-guard.mjs` dry run pending the `ANTHROPIC_API_KEY` secret; that gap is recorded here and in tasks.md rather than assumed away. |
| V. Electron Security Baseline | N/A | No `BrowserWindow` or renderer is involved. The analogous risk this principle addresses — untrusted content crossing a trust boundary unsafely — is handled by FR-020: issue text is written to a file and read as data by the prep agent, never interpolated into a `run:` shell step. |

Development Workflow (constitution §Development Workflow):

- "Features flow through Spec Kit": met — this plan, its spec, and its tasks are produced through
  Spec Kit, even though the feature's implementation is CI configuration rather than app code.
- "automated tests not required... verified by running the app and exercising the changed path":
  adapted — there is no app to run. The equivalent verification is live `workflow_dispatch` runs
  against real throwaway issues (#90, #91) for stage 1, `actionlint`, the unit test suite, and a
  manual `prep-guard.mjs apply` smoke run for stage 2, pending the secret.
- "Typecheck and production build MUST pass before a change lands on main": N/A for this feature's
  files — `.github/scripts/*.mjs` and `.github/workflows/*.yml` fall outside both
  `tsconfig.node.json`'s and `tsconfig.web.json`'s `include` globs and outside the `electron-vite
  build` script, so this gate does not cover them. The scripts are kept zero-dependency precisely
  to avoid needing a second build step.

## Project Structure

### Documentation (this feature)

```text
specs/002-issue-triage-automation/
├── spec.md              # Feature specification (this plan's input)
└── plan.md              # This file
# tasks.md is produced alongside this plan (normally a separate /speckit.tasks step)
```

`research.md`, `data-model.md`, `quickstart.md`, and `contracts/` are intentionally not produced:
the design was decided before planning (see Summary, and the spec's Key Entities section, which
covers the only data shape involved — the Classification fields), so there is no open research
question or API contract to document beyond what spec.md and this plan already capture.

### Source Code (repository root)

```text
.github/
├── workflows/
│   └── issue-triage.yml       # triggers, permissions, the triage/prep-agent/publish/notify-failure jobs
├── scripts/
│   ├── triage.mjs             # stage 1: load issue, classify, label, comment
│   ├── prep-guard.mjs         # stage 2: export (nonce-fenced issue), apply (guarded copy)
│   └── triage.test.mjs        # unit tests for both scripts' pure helpers
├── triage/
│   └── prompt.md              # brief handed to the prep agent via claude-code-action
└── dependabot.yml             # weekly github-actions ecosystem updates

docs/
└── issue-triage.md            # maintainer-facing reference: triggers, labels, prerequisites
```

**Structure Decision**: Everything lives under `.github/` (workflow, scripts, agent brief) plus one
maintainer doc under `docs/`. No `src/` directory is touched, no new project/package is created,
and no option from the template's single-project/web-app/mobile-app layouts applies — this is CI
configuration alongside, not inside, the existing Electron project.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

None. Every non-"Pass" row above is a scope mismatch (the principle targets the Electron/OMP
application, which this feature does not touch), not a violation requiring justification.
