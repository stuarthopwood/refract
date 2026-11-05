# Spec 109: Brand watermark follow-ups (issue #1369)

Status: in progress. Source: #406 gate leftovers (PR #1365), decisions in the "Decided (Skippy, delegated by Stuart 2026-10-31)" comment on #1369. Closes #1369.

## Requirements

- FR-1 The Settings watermark preview passes `allowHoliday={false}`, so it matches the session pane (#1256); the row description no longer promises a seasonal glyph. _Superseded by #1647 (spec 012 FR-023): `allowHoliday` is gone and the preview shows the holiday glyph in season._
- FR-2 The Appearance section separates the Decoration sub-section from the groups above with a divider (spec 012 FR-017).
- FR-3 The Background watermark row is a `SettingSwitchRow` (ADR 0003).
- FR-4 `--watermark-opacity` has one `:root` default in `globals.css`; a theme overrides it only where its background needs another value (spec 012 FR-004).
- FR-5 `check-theme-contrast` reads each theme scope's `--watermark-opacity`, falling back to `:root`.
- FR-6 The stale 0.06 note in `specs/012-brand-watermark/tasks.md` is corrected.
- FR-7 At 620px the chat header chips truncate instead of overlapping (ui-architect-v3 ruling; truncation preferred over hiding).
- FR-8 `verify-406-watermark.mjs` presses real Tab keys through the Appearance switch and checks the accessibility tree.
- FR-9 The dead `EmptyChatState.tsx` is deleted after a grep proves nothing mounts it.

## Out of scope

New automated tests (prototyping phase); Lane AS's composer context menu work (#1383).

## Acceptance

`pnpm ci:local` green and `verify-406-watermark.mjs` reports PASS from the pushed HEAD.
