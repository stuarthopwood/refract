# Analysis: spec 088

Cross-check of `spec.md`, `clarifications.md`, `plan.md` and `tasks.md` before implementation.

- Coverage: FR-001..FR-015 each map to one task (T2 FR-001/002/009/012; T3 FR-003; T4 FR-004/006/013; T5 FR-005/007/008; T6 FR-010/011/013; T7 FR-014; T8 FR-015). No orphan task.
- Decisions: every ruling in `clarifications.md` Q1-Q10 appears as an FR or an explicit non-change (Q2 and Q9 are non-changes, recorded in docs and on the issues). Q11 skips stay outside every file list.
- Conflict check with Lane W (spec 086): no listed file is a theme token file, `globals.css`, `themeContrast.ts` or `theme-contrast-pairs.mjs`; no colour token is added (the invalid ring uses the existing `ring-destructive`).
- Rules check: no new tests; one shared `OpenOnGitHubButton` and `PullRequestActions` instead of one-offs; `PullRequestDetail.tsx` (350 lines) shrinks; comments stay why-only.
- Risk: Q3 popper default affects all selects. Mitigation: live check measures one open list against its trigger, and `check:hit-targets`/`check:icon-only-controls` run unchanged.
- Gap: Q8 moves Cancel into the input row only for `inputKind === 'text'`; the choice kind keeps the footer, so `CardFooter` stays imported.
- Verdict: no blocking inconsistencies; proceed to implement.
