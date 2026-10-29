# Plan: Report an issue

- Rust: `github/gh_issues.rs` (validators, `list_labels`, `search_issues`, `create_issue`), `ipc/issues.rs` (three handlers), registered in `ipc/mod.rs`. `gh.rs` is untouched.
- Contract: `shared/ipc-issues.ts` (types and `IssuesApi`), three `IPC_REQUESTS` keys in `ipc.ts` (condensed a doc comment to stay at the 902 baseline), bridge `issues` block, `check-parity.mjs` lane entries.
- Renderer (`features/sessions`): `ReportIssueDialog`, `IssueDuplicates` (shared `InlineDisclosure`), `IssueLabelPicker` (shared Popover, CheckboxItem, Badge, Input), `IssueCreatedPanel` (shared CopyButton), `useReportIssue` hook, `githubRemoteSlug` in `remoteDisplay.ts`, menu item in `RepositoryGroup.tsx`.
- No change to `store/settings.rs`, chat files, or the header action width constants.
