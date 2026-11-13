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
- The accessible name starts with the visible text, for example "+2 more labels" (WCAG 2.5.3); the tooltip, exposed through `aria-describedby`, lists the names. A row with two or fewer labels renders no overflow control and is unchanged.
- Labels stay untrusted text; the tooltip renders them as plain text.

Amended 2026-11-13 for #1873 (Skippy, delegated by Stuart; "Decided" comment on the issue: the "+N" text uses the accent colour).

- The "+N" chip looks like text, not a command button: no border in rest, hover or focus (the outline-variant border and `hover:border-ring` are removed), text in the accent colour (`text-accent-text`). Because it has no border or fill, keyboard focus shows a 2px inset outline instead. The change lives in the shared `LabelOverflow` (through a new borderless `plain` variant of `Badge`), so every surface using it, today only `IssueRow`, gets the same treatment.
- The chip sits on the row's hover and selected fills, where `accent-text` measured 4.00:1 (Dark) and 4.28:1 (Obsidian) against the 4.5:1 floor (the TODO(#579) gap). So `--accent-text` (and the `--mermaid-accent` it must match) is lightened in those two themes, and `accent-text` on `surface-hover` and on `accent` become enforced pairs in `scripts/theme-contrast-pairs.mjs`.
- The accessible name now lists the hidden labels, for example "+3 more labels: a, b, c" (singular "+1 more label: a"); it still starts with the visible text (WCAG 2.5.3). This supersedes the "+2 more labels" example above; the tooltip stays for sighted pointer and keyboard users.
- The split into shown and hidden labels, and the name, are pure helpers in `components/overflowLabels.ts` with unit tests; `IssueRow` uses the split so the cap of two lives in one place.

## Functional requirements

- FR-001: The session list shows a "GitHub" group with Pull requests and Issues above the Project groups.
- FR-002: The Issues view lists issues from every selected Project, deduped by owner/repo, newest update first.
- FR-003: Filters: tab, State, Project (multi-select), Label, search.
- FR-004: Rows show title, number, state, Project, assignee, comment count, updated time, and up to two labels plus "+N". "+N" is a focusable, borderless accent-text chip (reachable with Tab; no border in any state, a focus outline instead) whose tooltip lists every hidden label with its colour dot, and whose accessible name is the visible "+N" followed by the hidden label names.
- FR-005: The detail pane shows the issue with a sanitised body, Open on GitHub, Copy link and New issue (existing Report an issue dialog).
- FR-006: Inputs reaching `gh` are validated; returned URLs are checked against `https://github.com/owner/repo/issues/N`.

## Deferred from v1

Start a Session from an issue (no authorAssociation in `gh issue list`), comments timeline, Sort select, cross-Project Pull requests (#874), Home (#869).
