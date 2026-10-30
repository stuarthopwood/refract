# Plan 070

Touched files by issue.

- #1400: `state/issues-store.ts`, `shared/ipc-issues.ts`, `features/issues/IssueList.tsx` (+ pill row), `components/ui/badge.tsx` (`onDismiss`), new `components/ui/loading-overlay.tsx`; Rust `ipc/issues.rs`, `github/gh_issues.rs`, `github/gh_issue_list.rs`.
- #1402: `shared/ipc-usage.ts` (`sessionDir`), Rust `usage/queries*.rs`; `features/right-pane/panel-registry.ts`, `panel-order.ts`, `PanelLauncher.tsx`, `IconRail.tsx`; new `features/usage/SessionUsagePanel.tsx` and a per-Session store; `HeadlineCards.tsx` (`layout`), `SpendChart.tsx` (`compact`).
- #1409: new Rust roster detector under `omp/` plus an IPC command and the shared IPC type; launch-time notice; `features/settings/AdvisorModelRow.tsx`; `features/usage` call log caption; new `scripts/check-advisor-roster.mjs`, `scripts/advisor-roster-allowlist.json`, `package.json`, `scripts/ci-local` wiring.
- Docs: `docs/PLAN.md` rows for the three issues.

No new tests. Verification: `pnpm ci:local`, live run with screenshots.
