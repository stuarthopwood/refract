# Spec 100: UI polish follow-ups of spec 088 (issue #1501)

Status: in progress. Source: follow-ups from the spec 088 UI polish gate, decisions in the "Decided (Skippy, delegated by Stuart 2026-10-31)" comment on #1501. Closes #1501.

## Requirements

- FR-1 PR and Issue detail headers: the title block grows with a 200px minimum and the action row wraps, so Merge and `#number` are not clipped in a narrow window.
- FR-2 The PR header shows the review reason and the merge reason as visible lines (`data-review-reason`, `data-merge-reason`, prefixed "Review:" and "Merge:"); the tooltips stay. Review and Merge use `aria-disabled` with `aria-describedby` pointing at the line, so assistive tech reads the reason.
- FR-3 `FILTER_PICKER_CLASS` lives in `ui/select.tsx` and `IssueList`, `ProjectListPane` and `ManageSessionsToolbar` import it.
- FR-4 `COMPOSER_FOCUS_CLASS` and `COMPOSER_BUTTON_FOCUS_CLASS` move to `components/ui/composerFocus.ts`; all importers are updated. `CopyButton` uses the button focus class.
- FR-5 `IconButton` with `asChild` does not forward `type="button"` onto the child.
- FR-6 `SelectContent` defaults to `align="start"`; `NewSessionDialog` drops its `sideOffset`; the Select trigger focus ring uses `--field-ring-width` like Input.
- FR-7 A focused field with `aria-invalid` keeps its destructive border on Input, Textarea and the Select trigger.
- FR-8 `docs/design/components.md` names a real `ghost-destructive` use.
- FR-9 `scripts/verify-tauri-100.mjs` supersedes `verify-tauri-088.mjs` (kept as history, not run): Merge outline class, New session on the draft header, visible "Review:" and "Merge:" lines, invalid focused Input, Textarea and Select trigger, and an env allow-list for the launched app.
- FR-10 A blocked Merge always has visible reason text (a generic fallback when GitHub gives none).

## Already handled or skipped

- "Assigned to me" tab: `FilterTabs` already scrolls horizontally with a fade.
- Text-request answer box label: already labelled "Answer" and "Question" in `RequestCard`.
- `aria-invalid` audit: all nine call sites render visible associated error text.
- `PullRequestActions.tsx` extraction: skipped, as the issue says.
- Text-request Cancel live drive: skipped, no harness.

## Out of scope

New automated tests (prototyping phase). `AskCard.tsx`, `ComposerContextMenu`, `ContextUsageReadout`, `install_on_quit.rs`, `stepToMessage.ts` (skipped, owned by lane #1503).

## Acceptance

`scripts/verify-tauri-100.mjs` passes in the built app; `pnpm ci:local` passes.
