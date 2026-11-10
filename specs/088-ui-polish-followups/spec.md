# Spec 088: UI polish follow-ups from specs 071 and 067

Issues: #1449 (app-wide UI polish leftovers, spec 071) and #1443 (PR/issue detail polish leftovers, spec 067). Branch `ui-polish-follow-ups-1449-1443` (Lane Y). Decisions: the "Decided (Skippy, delegated by Stuart 2026-10-31)" comments on both issues (UI rulings by ui-architect-v3); see `clarifications.md`. No new tests (prototyping phase); existing tests must keep passing. No theme token, `globals.css` theme block, `themeContrast.ts` or `theme-contrast-pairs.mjs` file is touched (Lane W, spec 086), and no colour token is added.

## Problem

The spec 071 and 067 gates left Medium and Low findings: an empty 40px row above the right-pane tab bar, invalid fields that signal only by border colour, select lists that open over their trigger, a PR header whose actions wrap on open pull requests, an Issue header that still has a divider, two different Open on GitHub controls, a Merge button that disagrees with the docs, a draft reason hidden in a `title`, and assorted fixed widths and stale comments.

## User stories

- US-1 As a keyboard or low-vision user, an invalid field shows a thicker edge as well as a red one.
- US-2 As a user of any select, the list opens below its trigger like the checklist pickers.
- US-3 As a user of the right pane, no empty band sits above the tab bar or launcher.
- US-4 As a PR reader, the header actions stay on the title row in every state, and a draft says why New session is unavailable.
- US-5 As an Issue or PR reader, Open on GitHub and Copy link look and behave the same in both headers, and the Issue header has no divider.
- US-6 As a user answering a text Request card, Cancel sits beside Send.
- US-7 As a maintainer, docs match the code (Merge filled primary, quiet-field departure names select triggers, spacing steps) and dead code is gone.

## Functional requirements

- FR-001 `Input`, `Textarea` and `SELECT_TRIGGER_CLASS` add `aria-invalid:ring-1 aria-invalid:ring-destructive`.
- FR-002 `SelectContent` defaults `position` to `popper`; `position="popper"` overrides at call sites are dropped.
- FR-003 `WindowControlsSpacerRow.tsx` is deleted; `RightPaneShell` and `PanelTabBar` no longer render it or pass `windowControlsSpacerStyle`.
- FR-004 `components/OpenOnGitHubButton.tsx` (ghost `icon-sm` anchor + tooltip) is used by `IssueDetail` and `PullRequestDetail`; both headers show `CopyButton` labelled "Copy link".
- FR-005 The PR header title is `flex-1 min-w-0` (`line-clamp-2`); actions are `shrink-0` without wrap, in place in `PullRequestDetail.tsx` (extraction skipped). The state pill and check status sit under the title so the actions fit a narrow pane.
- FR-006 `IssueDetail` drops `border-b` from its header.
- FR-007 The PR Merge button is `variant="default"`, the only filled button in the header (the primary-button rule; amended by #1742, which supersedes the earlier `outline` decision).
- FR-008 A draft pull request shows "Draft pull requests cannot start a Session." under the header; New session drops its `title`; only one reason line shows at a time.
- FR-009 `CopyButton`'s tooltip trigger sets `aria-describedby={undefined}`.
- FR-010 `RequestCard` (text input) puts a ghost Cancel beside Send and drops the footer for that kind; choice requests keep the footer.
- FR-011 The Manage sessions project filter uses `FILTER_PICKER_CLASS`; `PerModelThresholdTable`'s trigger is `w-64 max-w-full`.
- FR-012 The `destructive-outline` button variant and its `components.md` row are removed; `MultiSelectChecklist` and `select.tsx` use single quotes and clean formatting (no dead `&& ""`).
- FR-013 The stale drag-strip comment in `App.tsx` and `IssueDetail`'s header comment are corrected.
- FR-014 `docs/design/accessibility.md` names select triggers, checklist triggers and ghost Browse in the quiet-field departure and lists the current spacing steps; `components.md` records `OpenOnGitHubButton`.
- FR-015 Live check `scripts/verify-tauri-088.mjs` screenshots each changed surface and writes `report.json` with the code `gitHead`.

## Items skipped or already done

See the decision comments on #1449 and #1443 and `clarifications.md`.

## Success criteria

- `pnpm ci:local` passes. `verify-tauri-088.mjs` passes from the committed HEAD and `report.json.gitHead` equals it.
- Six-reviewer gate: PASS from every gating reviewer after the last code change.
