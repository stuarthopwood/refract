# Implementation Plan: Issue triage automation

**Branch**: `002-issue-triage-automation` | **Date**: 2026-10-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-issue-triage-automation/spec.md`

## Summary

Add a single-job GitHub Actions workflow, entirely outside the Electron app, that triages every
issue and tells whoever picks it up which Spec Kit commands to run. `triage.mjs` reads the issue
via the REST API, classifies it by trying GitHub Copilot CLI first (when `COPILOT_GITHUB_TOKEN`
is configured), then the Anthropic Messages API (when `ANTHROPIC_API_KEY` is configured),
stopping at the first provider that succeeds and falling back to a deterministic keyword
heuristic — which never sets `area` or `pickup_notes` — when neither is configured or both fail.
Every classification records which `provider` produced it, shown in the comment header. The
comment's model-derived free text (`rationale`, `pickup_notes`) is rendered inside a clearly
headed "Model summary" block, separate from and before the deterministic "Spec Kit pickup plan"
that follows it — the plan itself contains no model text, only closed-vocabulary route/type/state
and a resolved feature directory. The plan lists the exact ordered `/speckit.*` commands for a
`specify` or `converge` route (prefixed, for `ready-for-human`, to say it applies once the human
decision is made — except `ready-for-human` + route `none`, which gets its own single "no Spec Kit
steps" line instead of a contradictory prefix-plus-type-hint), a one-line hint by type when the
route is `none`, or a short "not ready yet" note (no commands) when the state is `needs-info` or
`needs-triage`. A `force` re-triage uses a hidden JSON marker recording the bot's own previously
applied labels to tell them apart from a maintainer's, so it can correct its own earlier guess
across every dimension without ever touching a label a maintainer set. The job holds only
`contents: read` and `issues: write` — no agent runs with write access, no artifact is produced,
no branch or pull request is ever created; the Copilot CLI itself runs sandboxed (no shell, every
tool kind denied, a minimal subprocess environment).

## Technical Context

**Language/Version**: Node.js 22, as the `ubuntu-latest` GitHub-hosted runner's expected toolchain
(pinned explicitly via `actions/setup-node@v4` rather than relying on the runner image's default).

**Primary Dependencies**: None at runtime for the script's own logic — `.github/scripts/triage.mjs`
is a zero-npm-dependency ESM script using Node's built-in `fetch` and `node:child_process`
(`execFile`, never a shell). It optionally spawns the external `copilot` CLI binary (installed via
`npm install -g @github/copilot` in a workflow step, gated on `COPILOT_GITHUB_TOKEN` being set) —
that binary is a runtime dependency only in that gated path, never otherwise. `actionlint` is a
dev-time-only workflow linter, not a runtime dependency. `actions/checkout` and
`actions/setup-node` are pinned to full commit SHAs, kept current via `.github/dependabot.yml`.

**Storage**: N/A. All state lives in GitHub itself (issue labels and the single triage comment).
Nothing is persisted beyond a run; no artifact, branch, or pull request is ever created.

**Testing**: `actionlint` against `issue-triage.yml` (exit 0); `node --test
.github/scripts/triage.test.mjs` (47 deterministic unit tests covering the classifier, the
maintainer/bot-label merge logic across all four label dimensions, the marker JSON helpers,
rationale/pickup-note sanitising, `resolveFeatureDirectory`, the Spec Kit pickup plan's rendering
for every route/state/type combination including the `ready-for-human`+`none` fix,
`buildCopilotArgs` (the Copilot CLI argv, built without a shell), and `classifyWithFallback`'s
Copilot→Anthropic→heuristic ordering and fallthrough via injected fakes). Live `workflow_dispatch`
dispatch of the heuristic path against throwaway issues #90 and #91, and a force re-dispatch of
#90, are already verified; the Anthropic path needs `ANTHROPIC_API_KEY` and the Copilot path needs
`COPILOT_GITHUB_TOKEN`, neither of which exists yet as a repository secret, so both model paths
(and the real `copilot` binary itself, which was never invoked — only its argv-building and the
provider fallthrough logic were exercised) remain unverified live.

**Target Platform**: GitHub Actions `ubuntu-latest` hosted runner.

**Project Type**: CI/CD automation under `.github/`, outside the Electron application; no changes
to `src/`.

**Performance Goals**: The job completes classification, labeling, and commenting within a single
workflow run, well inside GitHub Actions' default job timeout. There is no near-real-time
requirement, since issue creation is already asynchronous from a contributor's perspective.

**Constraints**: `triage.mjs` MUST stay zero-npm-dependency for its own logic. Untrusted issue
title/body text MUST NEVER be interpolated into a `run:` shell step. The job MUST run with only
`contents: read`, `issues: write` — no `models: read` (GitHub Models is retired), no
`contents: write`, no `pull-requests: write`, and no third-party agent Action of any kind. The
Copilot CLI call MUST use `execFile` (never a shell), MUST explicitly deny every tool kind, and
MUST run with a minimal subprocess environment that excludes `GITHUB_TOKEN`/`ANTHROPIC_API_KEY`.

**Scale/Scope**: Single private repository; one issue per run; no concurrent-run concerns beyond
GitHub Actions' default per-ref concurrency behavior.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.* Constitution v1.7.0.

| Principle | Status | How the design meets it |
|---|---|---|
| I. OMP Is the Engine, Refract Is the Host | N/A | This feature has no Electron process and drives no `omp` child process, and (after this redesign) no agent process of any kind. |
| II. RPC Wire Contract | N/A | No RPC is involved. The job calls the GitHub REST API and the Anthropic Messages API directly. |
| III. Session and Process Lifecycle | N/A | There is no `omp` process, worktree, or session registry. The only "session" is the ephemeral GitHub Actions job runner, which GitHub itself manages. |
| IV. Evidence Before Design | Pass | Live `workflow_dispatch` runs against throwaway issues #90 and #91 (and a force re-dispatch of #90) verified the classification/labeling/commenting behaviour before this redesign; the Spec Kit pickup plan is deterministic and fully covered by the unit suite. |
| V. Electron Security Baseline | N/A | No `BrowserWindow` or renderer is involved. The analogous risk this principle addresses — untrusted content crossing a trust boundary unsafely — is handled by FR-023 (issue text is read over the REST API and passed to the classifier as data, never interpolated into a `run:` shell step) and FR-026/FR-030 (model-derived free text is rendered in a clearly untrusted "Model summary" block, never in the deterministic pickup plan, and the trust model for whoever picks the plan up is documented). |

Development Workflow (constitution §Development Workflow):

- "Features flow through Spec Kit": met — this plan, its spec, and its tasks are produced through
  Spec Kit, even though the feature's implementation is CI configuration rather than app code.
- "automated tests not required... verified by running the app and exercising the changed path":
  adapted — there is no app to run. The equivalent verification is the live `workflow_dispatch`
  runs noted above, plus `actionlint` and the unit test suite for everything the live runs did not
  exercise (the model path, and the Spec Kit pickup plan's deterministic rendering).
- "Typecheck and production build MUST pass before a change lands on main": N/A for this feature's
  files — `.github/scripts/*.mjs` and `.github/workflows/*.yml` fall outside both
  `tsconfig.node.json`'s and `tsconfig.web.json`'s `include` globs and outside the `electron-vite
  build` script, so this gate does not cover them. The script is kept zero-dependency precisely to
  avoid needing a second build step.

## Project Structure

### Documentation (this feature)

```text
specs/002-issue-triage-automation/
├── spec.md              # Feature specification (this plan's input)
├── plan.md              # This file
└── tasks.md             # Task list
```

`research.md`, `data-model.md`, `quickstart.md`, and `contracts/` are intentionally not produced:
the design was decided before planning (see Summary, and the spec's Key Entities section, which
covers the only data shape involved — the Classification fields), so there is no open research
question or API contract to document beyond what spec.md and this plan already capture.

### Source Code (repository root)

```text
.github/
├── workflows/
│   └── issue-triage.yml       # single `triage` job: checkout, setup-node, tests, optional copilot install, classify
├── scripts/
│   ├── triage.mjs             # classify, label, resolve the pickup plan, post the comment
│   └── triage.test.mjs        # unit tests for triage.mjs's pure helpers
└── dependabot.yml             # weekly github-actions ecosystem updates

docs/
└── issue-triage.md            # maintainer-facing reference: triggers, labels, pickup plan, setup
```

**Structure Decision**: Everything lives under `.github/` (workflow, script) plus one maintainer
doc under `docs/`. No `src/` directory is touched, no new project/package is created, and no
option from the template's single-project/web-app/mobile-app layouts applies — this is CI
configuration alongside, not inside, the existing Electron project.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

None. Every non-"Pass" row above is a scope mismatch (the principle targets the Electron/OMP
application, which this feature does not touch), not a violation requiring justification.
