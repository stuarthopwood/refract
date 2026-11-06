# Spec 051: Issues page (#504)

A cross-Project GitHub issues browser and a separate "GitHub" block in the session list.

## Clarifications

Decided (Skippy, delegated by Stuart 2026-10-29); also recorded on #504.

- Backend is Rust only: `issues.list` and `issues.view` over the existing `gh` integration (argv arrays, validated inputs). Reason: Constitution Principle V.
- Layout reuses the Pull requests split (`ListDetailSplit`), `ScreenHeader`, shared `FilterTabs` and `SearchField`. Reason: ADR 0003.
- Tabs are All, Assigned to me, Authored by me, Mentions me. State, Project and Label live in the Filters panel; search applies on Enter.
- Per-Project failures show as a collapsed "N projects skipped" disclosure; the list is replaced only when every Project fails with gh-unavailable or rate-limited.
- Issue titles, bodies and labels are untrusted: rendered as text or sanitised markdown, never raw HTML.
- Refresh is explicit; no polling.

Amended 2026-11-06 for #1740 (Skippy, delegated by Stuart; Stuart's decisions as given to the lane).

- A row shows at most two labels; the "+N" overflow is a sibling control, not text inside the row's select button, because a button cannot nest another focusable control. The row becomes a container holding the title `<button data-issue-row>`; the container carries the hover and selected fill and the kebab inset, and the button's stretched hit area still covers the whole row.
- "+N" is a keyboard-focusable pill built on `Badge`, in the shared `LabelOverflow` component (`components/LabelOverflow.tsx`) so other label lists can reuse it. On hover and on keyboard focus its `Tooltip` lists every hidden label, one per line, each with its `ColourDot`.
- The accessible name stays the full list, for example "2 more labels: enhancement, p1". A row with two or fewer labels renders no overflow control and is unchanged.
- Labels stay untrusted text; the tooltip renders them as plain text.

## Functional requirements

- FR-001: The session list shows a "GitHub" group with Pull requests and Issues above the Project groups.
- FR-002: The Issues view lists issues from every selected Project, deduped by owner/repo, newest update first.
- FR-003: Filters: tab, State, Project (multi-select), Label, search.
- FR-004: Rows show title, number, state, Project, assignee, comment count, updated time, and up to two labels plus "+N". "+N" is a focusable pill (reachable with Tab, with visible hover and focus states) whose tooltip lists every hidden label with its colour dot, and whose accessible name lists their names.
- FR-005: The detail pane shows the issue with a sanitised body, Open on GitHub, Copy link and New issue (existing Report an issue dialog).
- FR-006: Inputs reaching `gh` are validated; returned URLs are checked against `https://github.com/owner/repo/issues/N`.

## Deferred from v1

Start a Session from an issue (no authorAssociation in `gh issue list`), comments timeline, Sort select, cross-Project Pull requests (#874), Home (#869).
