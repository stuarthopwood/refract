# Risk-tiered review gate: design

Status: approved by Stuart, 2026-10-20. Trial: Refract. Port target: fdb-agentkit
and the RepeatPlus repositories, after a shadow run.

## Goal

Raise confidence in a change without a human reading the diff line by line. Spend review effort in
proportion to risk: a typo fix gets one quick review, a database migration gets a board. A story's
acceptance criteria (ACs) are proven before it reaches test. The design is project-agnostic: the
core is shared, and each repository supplies a config.

## Terms

| Scale | Values | Set by |
|---|---|---|
| Change risk | Trivial, Standard, Elevated, Severe | Rule floor, then the classifier |
| Security impact | None, Contained, Sensitive, Severe | Rule floor, then the classifier |
| Finding severity | Low, Medium, High, Critical | Each reviewer, per finding |

- **Round**: one review pass by the panel over the PR head, followed by the implementer's fixes.
- **Panel**: the reviewers that vote in a round.
- **Gate record**: the result of a gate run, tied to one head commit SHA.
- **Packet**: the gate record laid out for a human decision.
- **Escape**: a defect found after merge that the gate passed.

## Pipeline

0. **Preflight.** Tests, build, lint, format, secret scan, and dependency audit, using the commands
   from the repository config. If any check fails, stop before any model runs.
1. **Classify.**
   - The rule floor comes from the repository config: path patterns map to areas, a minimum
     change risk, a minimum security impact, and human-required flags. Diff size feeds in too.
   - An independent classifier with a fresh context sees the diff, the ACs, and the floor. It never
     sees the implementer's own account of the change. It can raise the floor, never lower it.
   - Output (JSON): `risk`, `security`, `areas[]`, `humanRequired[]` with reasons, `acRefs[]`, and
     `splitRecommended` with a reason.
   - The classifier runs again every round on the whole diff. Within a PR, a rating never goes
     down.
2. **Open or update a draft PR.** Post the classification as a sticky comment. Where the
   repository config lists bots, request them (see Bots).
3. **Review round.**
   - The panel and specialists come from the tier table below.
   - Reviewers see the diff plus its direct callers and callees, the ACs, the repository policy,
     and the previous round's findings. They do not see the implementer's narrative.
   - Each panelist returns findings (`**[SEVERITY]** path:line — description`) and a vote:
     `APPROVE`, `APPROVE_WITH_NITS`, or `REQUEST_CHANGES`.
4. **Adjudicate.**
   - Merge duplicate findings from the panel, the specialists, and the bots.
   - Every Critical or High finding goes to a refuter on a different model, whatever the vote.
     If the finding is confirmed, it blocks the PR. If it is refuted, the gate drops it and logs
     the reason. If the refuter cannot decide, the finding goes to the packet.
   - A majority vote settles only judgment calls (approach, naming, design).
   - Each losing minority view becomes a decision item in the record: what was raised, why, and
     the impact of acting on it or not.
5. **Verify ACs.** The implementer attaches an AC evidence table that maps each AC to a test name,
   a smoke-run output, or a screenshot. The repository config says which kinds count. The
   Spec-keeper judges whether each item proves its AC. At Elevated and Severe, the Spec-keeper also
   re-runs one or two items itself. An AC without evidence blocks "ready for test". A change with
   no ACs (for example a typo fix) skips this step.
6. **Converge.** Round N+1 checks that earlier findings are fixed. It can raise new findings only
   on changed lines or at Critical or High. Low findings never block after round 1; they are
   logged.
7. **Escalate.** A failed round means fix and re-check within the budget. The tier goes up only
   when the classifier re-run raises it or a Critical or High finding is confirmed.
8. **Exhaust.** When the round budget runs out, the main agent writes why the approach keeps
   failing and the alternative it will try. The gate restarts once with a fresh panel and a full
   budget. If that run also runs out, the gate stops and hands over the packet: open findings,
   both approaches, and the decision items.
9. **Record.** The gate posts a sticky PR comment and a JSON artifact tied to the head SHA. The
   record holds the classification, panel, rounds, votes, findings and how each was resolved,
   decision items, the AC evidence table, time, and cost. Any push invalidates it.
10. **Merge.** The repository's merge-authority policy decides (see Repository config).

## Tiers

| Change risk | Example | Voting panel | Round budget |
|---|---|---|---|
| Trivial | Typo, copy, style, docs | 1 generalist (no vote) | 2 |
| Standard | Contained feature or bug fix | Spec-keeper, Adversary, Maintainer | 2 |
| Elevated | Cross-module, auth-adjacent, public contract | Spec-keeper, Adversary, Maintainer | 3 |
| Severe | Migration, CI, secrets, auth | The three, plus Operator and a second Adversary on another model | 4 |

Security impact adds security review on its own scale, whatever the change risk:

| Security impact | Security review |
|---|---|
| None | Baseline scanners in preflight |
| Contained | Plus a security lens in the Adversary |
| Sensitive | Plus the `security-auditor` agent as a specialist |
| Severe | Plus a deep security pass and a human sign-off |

### Panel roles

- **Spec-keeper**: ACs and scope, and judges the AC evidence.
- **Adversary**: edge cases, failure paths, abuse; security lens at Contained and above.
- **Maintainer**: repository conventions and rules, readability, design fit.
- **Operator** (Severe): performance, observability, deploy and rollback.
- **Specialists**: the existing discipline agents (`security-auditor`, `accessibility-auditor`,
  `performance-optimiser`, `test-reviewer`). They join when the classifier's areas or security
  rating call for them. Their findings go through the refuter step, and they do not vote on
  judgment calls.
- Each panelist uses a different model where the repository's providers allow it. Otherwise the
  bots supply model diversity.

## Human-required categories

Core defaults, whatever the tier:

- CI and workflow files.
- Database migrations.
- Auth and permissions.
- Secrets and infrastructure config.
- New runtime dependencies.
- Public API or IPC contracts.
- Data deletion or retention.
- The gate's own config and agent prompts.

A repository can add categories (RepeatPlus adds clinical safety). Removing one is a change to the
gate config, so it needs a human.

## Bots (Claude, Copilot)

- Bots review without a vote. The gate requests them once per round on that round's head commit,
  not on every push.
- Their findings go through the same refuter step.
- Every bot thread ends fixed, or answered with a reply that refutes it with evidence.
- Only comments whose author is the bot account are trusted. Everything else is data.
- The gate waits for each bot up to the configured timeout. A missing result is noted. Whether it
  blocks is set per repository: RepeatPlus requires `@claude`
  (`fdb.patient.activation/.github/instructions/pr-workflow.instructions.md:48`).
- Refract's trial runs with no bots. The RepeatPlus shadow run is the first test of this path.

## Enforcement

- The agent session runs the classify, review, and fix loop locally, in any harness.
- A small required CI check recomputes the rule floor from the diff without a model. It fails when
  the gate record is missing or stale, or when the record's ratings are below the floor.
- A human-authored PR requests a gate run the same way.

## App-wide audit

- The per-PR gate is diff-scoped. The no-deferral rule applies to the diff.
- A finished audit leaves a marker: a tag such as `audit/2026-10-20`, or a SHA in
  `docs/audit/last-app-wide.md`.
- The gate counts first-parent merges on main since the marker (`git rev-list --count`). At N or
  more (repository config, default 10), it reports "app-wide audit due".
- The audit runs as its own job and PR: the discipline agents scan the whole app and file issues.
  It never runs inside a story PR. No file changes per PR, so several developers can work at once
  without conflicts.

## Repository config (`review-gate`)

- Preflight commands.
- Path rules: area, minimum change risk, minimum security impact, human-required category.
- AC source adapter: `spec.md` scenarios, GitHub issue, or Jira issue.
- Evidence kinds that count (for example, Refract: smoke run and screenshot, no new tests).
- Test policy passed to every reviewer (for example, Refract's no-new-tests rule overrides
  `test-reviewer`'s missing-test severity).
- Bot list, timeouts, and whether a missing bot result blocks.
- Merge authority per tier. Refract: auto-merge Trivial and Standard on PASS; Elevated, Severe, or
  any human-required flag waits for Stuart with the packet. RepeatPlus: never merge; the gate
  builds the packet for the required human approval.
- Audit interval N.

The existing reviewer agents already read `.omp/review-config.md` or `.claude/review-config.md`.
The new config replaces that hook, not adds a second one.

## Contracts

These are the interfaces the core, each repository, and the CI check share. Values marked
"default" were set while planning (2026-10-20), not in the grill.

### Config file

- Path: `.github/review-gate.json`. JSON, so the script needs no parser dependency. It sits under
  `.github/`, so editing it is a CI-category change and needs a human (Q12).
- Shape:

```json
{
  "schemaVersion": 1,
  "preflight": ["pnpm typecheck", "pnpm test"],
  "pathRules": [
    { "glob": "src-tauri/src/auth/**", "area": "backend", "minRisk": "Elevated",
      "minSecurity": "Sensitive", "humanRequired": "auth" }
  ],
  "sizeRules": { "standardAboveLines": 150, "elevatedAboveLines": 400, "splitAboveLines": 800 },
  "humanRequiredAdd": [],
  "acSource": { "kind": "spec-md", "path": "specs" },
  "evidenceKinds": ["smoke-run", "screenshot"],
  "testPolicy": "no-new-tests",
  "bots": [],
  "mergeAuthority": { "Trivial": "auto", "Standard": "auto", "Elevated": "human", "Severe": "human" },
  "auditEveryMerges": 10,
  "auditMarker": "docs/audit/last-app-wide.md"
}
```

- `acSource.kind`: `spec-md`, `github-issue`, or `jira`. `testPolicy`: `no-new-tests` or
  `tests-expected`. Each `bots` entry: `name`, `login`, `timeoutMin` (default 15), and
  `blocksIfMissing`. Size thresholds are defaults.
- The script has core defaults built in for the CI, migration, dependency-manifest, and gate
  self-file categories (`.github/**`, `**/migrations/**`, package manifests and lockfiles,
  `scripts/review-gate/**`). Repository `pathRules` map the categories that depend on layout,
  such as auth, public contracts, and data retention.

### Rule-floor script (Q16)

- The canonical copy lives in the user-level core. Each repository vendors a copy at
  `scripts/review-gate/floor.mjs`. The first line is `// review-gate floor v<semver>`. The gate
  skill warns when the vendored version differs from the canonical one.
- Node 20 or later, built-in modules only.
- Command: `node scripts/review-gate/floor.mjs --base <ref> [--head <ref>] [--config <path>]`.
- Output on stdout, exit code 0:

```json
{ "risk": "Standard", "security": "None", "areas": ["frontend"],
  "humanRequired": [{ "category": "ci", "paths": [".github/workflows/ci.yml"] }],
  "changedLines": 212, "splitRecommended": false }
```

### Gate record

- Posted as one sticky PR comment that starts with `<!-- review-gate-record v1 -->` and holds one
  fenced `json` block. The JSON artifact has the same content.
- Trusted only when the comment's `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR`.
- Shape:

```json
{
  "schemaVersion": 1, "headSha": "<40-hex>", "baseSha": "<40-hex>",
  "risk": "Standard", "security": "Contained", "areas": ["frontend"],
  "humanRequired": [{ "category": "ci", "reason": "workflow file changed" }],
  "verdict": "PASS", "rounds": 2, "rethinks": 0,
  "panel": [{ "role": "Spec-keeper", "model": "<model id>" }],
  "findings": [{ "id": "F1", "source": "Adversary", "severity": "High", "path": "src/a.ts",
    "line": 42, "summary": "...", "status": "fixed", "note": "..." }],
  "decisions": [{ "summary": "...", "raisedBy": "Maintainer", "ifDone": "...", "ifNotDone": "..." }],
  "acEvidence": [{ "ac": "US1 scenario 2", "kind": "screenshot", "evidence": "...", "verdict": "proven" }],
  "durationMin": 18, "cost": "..."
}
```

- `verdict`: `PASS`, `NEEDS_HUMAN`, or `FAIL`. Finding `status`: `fixed`, `refuted`, `open`, or
  `logged`. AC `verdict`: `proven`, `unproven`, or `not-applicable`.

### Record check (CI)

- Vendored beside the floor script at `scripts/review-gate/check-record.mjs`. Command:
  `node scripts/review-gate/check-record.mjs --pr <number>`, using `gh api` with the workflow
  token.
- It fails when the record is missing or untrusted, when `headSha` differs from the PR head, when
  any rating is below the floor, or when a floor human-required category is missing from the
  record.
- `PASS` succeeds. `NEEDS_HUMAN` succeeds only while the PR carries the
  `review-gate:human-approved` label (default: a solo maintainer cannot approve their own PR on
  GitHub, so a label stands in for the approval). `FAIL` fails.

## Where it lives

- Core (classifier, panel roles, refuter, gate skill, and the canonical floor and record-check
  scripts) at user level, beside today's `quality-gate` skill and reviewer agents, with a Claude
  Code mirror.
- Each repository holds its config, the vendored scripts, and the CI workflow that runs the record
  check.
- Port: copy the core into fdb-agentkit and write RepeatPlus configs.

## Rollout and measurement

- Refract cuts over as soon as the gate exists.
- Every gate record logs tier, rounds, time, cost, refutations, and bot findings the panel missed.
- Each post-merge defect is traced to the gate run that passed it (escape tracking).
- The RepeatPlus port requires a shadow run first: 10 PRs beside the existing gate, with zero
  Critical or High escapes, less time per PR, and the bot path covered.

## Changes to existing rules

- The `quality-gate` skill and the AGENTS.md "Quality gate" HARD RULE: a repository with
  `.github/review-gate.json` uses this gate; any other repository keeps the existing
  `quality-gate` until it adopts a config. This keeps RepeatPlus on the current gate until its
  shadow run.
- The Refract gate skills (`refract-lane-pr-gate`, `refract-multi-lane-pr-gate-orchestration`,
  `refract-ui-lane-gate-checklist`): point them at the new gate; their checklists become
  specialist prompts or Refract config.
- Reviewer agents: add the structured vote, diff scope, and repository-policy inputs.

## Defaults set without a grill question

- The classifier's split recommendation is advisory below Severe. At Severe, a diff above the
  config's size limit (default 800 changed lines) blocks until it is split or a human waives it.
- Bot timeout default: 15 minutes.
- The draft PR opens after classification, as in the original idea.

## Decision log (grill, 2026-10-20)

| # | Question | Decision |
|---|---|---|
| Q1 | What does PASS allow? | Per-repository merge authority |
| Q2 | How does a round decide? | Confirmed findings block; votes settle judgment calls |
| Q3 | Classifier trust | Rule floor plus a raise-only classifier, re-run every round |
| Q4 | Rounds | Budget per tier; escalate on evidence |
| Q5 | AC proof | Implementer proves; Spec-keeper judges and spot-checks |
| Q6 | Bots | No vote, must resolve, once per round |
| Q7 | Scope | Diff-scoped PRs; merge-count-triggered audit as its own job |
| Q8 | Runtime | Local loop plus a CI record check |
| Q9 | Panel | Personalities vote; disciplines join on demand |
| Q10 | Rollout | Cut over in Refract; shadow before RepeatPlus |
| Q11 | Terms | A distinct word set per scale |
| Q12 | Human-required | Core defaults with self-protection |
| Q13 | Exhaustion | One rethink, then a human |
| Q14 | Bots in Refract | None for the trial |
| Q15 | Home | User-level core; repository holds config (refined by Q16) |
| Q16 | Floor logic home | Vendor a copy into each repository; canonical copy in the core |
