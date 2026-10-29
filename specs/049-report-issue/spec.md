# Feature Specification: Report an issue

**Feature Branch**: `report-issue-repo-header`
**Status**: Draft
**Input**: Issue #503, "Report an issue: a repository-header button and dialog for filing a GitHub issue scoped to that repository". Numbered 049.

## Clarifications

### Session 2026-10-29 (grill and clarify, Skippy delegated by Stuart; full text in the "Decided" comment on #503)

- Origin/main check: nothing shipped (no `issues.*` channel, no control). The whole v1 is built.
- Entry point (ruled by ui-architect-v3): a "Report an issue…" item in the Repository group "…" menu, not a fourth header button. Header action width constants (`GROUP_HEADER_ACTIONS_*_PX`) and the ArchivedGroup spacer are unchanged. The item is hidden unless the remote is on github.com; with no signed-in account the dialog opens with a sign-in notice.
- Dialog: Title (required, 256), collapsed "N possible duplicates" disclosure, Description (shared MarkdownEditor with Preview), Labels (searchable popover checklist, outline chips, decorative colour dot). Footer: Cancel and "Create issue" ("Creating…", then "Retry" after a failure). No title error before the first submit.
- Duplicates: debounced 400 ms, up to 5 open or closed issues, state as icon plus word, Open on GitHub link, "It's different" dismiss. Never blocks filing. Hits are untrusted text.
- Result panel replaces the form: "Issue #N created" (focused heading, `role=status`), Copy link, Report another, Close, Open on GitHub.
- Failure: always-mounted inline `role=alert` ("Error: ..."), all fields kept.
- Keyboard: Ctrl+Enter in Description files; Esc, X and Cancel share one close check; a non-empty Title or Description asks "Discard this draft?" (labels alone do not).
- Deferred (separate issues): Draft with AI, screenshots, template picker, local drafts, privacy regex warning, "Comment on this instead", Start a Session from the issue (#504), the Refract-bug profile entry, the post-file plan hook. Also deferred: a right-click and Shift+F10 menu on the Repository header.
- Security (Constitution Principle V): channels `issues.labels`, `issues.search`, `issues.create` (`src-tauri/src/ipc/issues.rs` over `github/gh_issues.rs`). The repository comes from the registry via `owner_repo_for`, never from a renderer path. User text reaches `gh` only as one `--flag=value` argv entry (title, label, search) or on stdin (body, `--body-file -`). No shell string anywhere.

## Requirements

- **FR-001** The "…" menu of a Repository whose remote is `github.com/owner/repo` shows "Report an issue…"; other remotes do not.
- **FR-002** The dialog loads the repository's labels (up to 200) and lets the user pick any number (up to 20).
- **FR-003** Typing a Title of 4 or more characters runs one debounced duplicate search; results never block submission.
- **FR-004** Submitting with an empty Title shows an inline, associated error and files nothing.
- **FR-005** Submitting calls `issues.create`; Rust validates title (one line, up to 256), body (up to 60,000) and labels (up to 20, up to 50 characters, no commas) and runs `gh issue create --repo owner/repo --title=… --label=… --body-file -` with the body on stdin.
- **FR-006** The created URL is parsed from `gh` output and accepted only for `https://github.com/owner/repo/issues/N` of the scoped repository.
- **FR-007** On failure the form keeps its content, shows the error inline, and the button reads Retry.
- **FR-008** Dismissing a dialog with a non-empty Title or Description asks for confirmation.

## Success criteria

- `pnpm ci:local` green; a live check with a fake `gh` on PATH shows the menu item, the dialog, the empty-title validation, and the recorded `gh issue create` argv and stdin. No real issue is ever filed.
- File-size baselines respected (`ipc.ts` stays at 902); no new tests (prototyping phase); existing tests pass.
