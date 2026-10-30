# Spec 070: Issue label filters, Session usage panel, Advisor roster warning (#1400, #1402, #1409)

Three p1 items in one branch. Each issue's own text is the requirement; this file records the grill outcomes and the choices the issues left open. Decisions are also posted on each issue as `Decided (Skippy, delegated by Stuart 2026-10-30)` comments.

## Clarifications

### Session 2026-10-30 (self-grill against CONTEXT.md, docs/adr and the code; Stuart is away)

- Q: #1400, new pill component or extend Badge? A: extend `components/ui/badge.tsx` with `onDismiss` and `dismissLabel`; the dismiss control is an icon-only Button with a tooltip. [ui-architect-v3 ruling]
- Q: #1400, shared overlay, and do `SessionStartNotice`/`PausedBody` move onto it? A: new `components/ui/loading-overlay.tsx` used by the Issues list only; the two existing files are untouched (other lanes edit them) and a follow-up moves them. [ui-architect-v3 ruling]
- Q: #1400, overlay on a first, empty load? A: no, only when rows already exist; an empty first load keeps the existing loading line. [ui-architect-v3 ruling]
- Q: #1402, recent calls length? A: 10, "Show more" adds 10. [ui-architect-v3 ruling]
- Q: #1402, vertical headlines and sparkline? A: `layout="stacked"` on `HeadlineCards`; `compact` on `SpendChart` (shared `Sparkline`, no day/hour tabs). [ui-architect-v3 ruling]
- Q: #1402, where is "Open in Usage"? A: a text link in the panel footer. [ui-architect-v3 ruling]
- Q: #1402, billing-period start when the issue says `resetsAt` minus one period? A: one calendar month before `copilot.resetsAt`; if `resetsAt` or the entitlement is unknown, hide the share and show a short reason.
- Q: #1409, where is the Settings warning? A: the `note` slot of `SettingRow` on the Advisor row. The Session notice uses `PaneBanner` in warning tone with Open file and Copy path. [ui-architect-v3 ruling]
- Q: #1409, Usage caption placement? A: a muted caption under each advisor call whose model differs from the Advisor role. [ui-architect-v3 ruling]
- Q: #1409, allowlist? A: `scripts/advisor-roster-allowlist.json`, an empty array by default; entries are repo-relative paths.

## Functional requirements

- FR-1 (#1400): Label is a `MultiSelectChecklist` with the label colour dot; summary "Any label", the name, or "N labels". Several ticked labels match any of them (`label:"a","b"` in `--search`, appended after `clean_search_query`; `--label` is dropped).
- FR-2 (#1400): one dismissible pill per ticked label beneath the pickers (name "Remove label filter <name>"); no row when none is ticked. Dismiss deselects and refreshes.
- FR-3 (#1400): while fetching with rows present, the list is blurred, not interactive, with a centred "Loading" card; announced politely once; no blur transition under reduced motion.
- FR-4 (#1402): a hosted right-pane panel "Session usage" (`session-usage`, `GaugeIcon`) scoped to the focused Session's directory (separator-bounded descendant match on `session_file`, subagents included), whole lifetime, live while visible, with the contents and empty states listed in the issue.
- FR-5 (#1402): `UsageFilters.sessionDir` applied in the Rust queries; the panel keeps its own per-Session state and never writes `useUsageStore`.
- FR-6 (#1409): at Session launch Refract finds `WATCHDOG.yml`/`.yaml` (also in `.omp/`) in the OMP agent directory and from the Session cwd up to the repo root; the Advisor row and a one-time Session notice show the warning with Open file and Copy path; the roster is never deleted.
- FR-7 (#1409): advisor calls in Usage whose model differs from the Advisor role carry the caption "Advisor (WATCHDOG.yml roster)".
- FR-8 (#1409): `pnpm check:advisor-roster`, wired into `ci:local`, fails on a non-allowlisted committed roster.

## Success criteria

- `pnpm ci:local` passes; live screenshots show each changed surface.
