# Spec 106: Design sweep leftovers (#1470)

Status: in progress. Follows spec 077 (#579). Decisions: issue #1470 comment "Decided (Skippy, delegated by Stuart 2026-10-31)".

## Requirements

- FR-1: `--surface-subtle` (derived from `--row-hover-bg`) paints every resting surface: user bubble, dialog, alert-dialog and card footers, markdown table headers, the ChatWidthPicker preview tile. Hover keeps `row-hover-bg`. Built-in themes look unchanged.
- FR-2: `theme-contrast-pairs.mjs`, `focused-badge-contrast.mjs` and `check-theme-contrast.mjs` measure the current user-bubble and footer fill (muted at 50%), not `accent/50`.
- FR-3: No opacity modifiers remain in `button.tsx`, `badge.tsx`, `switch.tsx`, `ChatWidthPicker.tsx`; each uses a token in `globals.css`. The alpha baseline ratchets down.
- FR-4: `input.tsx` and `textarea.tsx` have one disabled background (`bg-field-hover-bg`).
- FR-5: Every overflow trigger is named "More actions" or "More actions for <item>".
- FR-6: The `SessionRow` action strip is 24 px (`h-6`) to match its buttons.
- FR-7: The AttachmentStrip image Remove button sits at `-top-2 -right-2` with `gap-4` and `p-4`, so it never covers a neighbour. The strip is capped at `max-h-32` (two thumbnail rows) and scrolls beyond that, replacing spec 009 research.md Decision 9 strip growth.
- FR-8: `check-alpha-modifiers` also counts `placeholder-`, `inset-ring-`, `ring-offset-`, `drop-shadow-`, `text-shadow-` and arbitrary or decimal opacities; remaining blind spots are listed in the script header.
- FR-9: `verify-tauri-077.mjs` covers all five theme presets.
- FR-10: `SessionList.tsx` clear-filter button drops the classes `Button` already sets.

## Already on main

- High-contrast offsets in `AdvisoryRow.tsx` and `GitChangesPanel.tsx`: `INSET_FOCUS_OUTLINE_CLASS` (#1494).
- Custom-theme allow-list: `row-hover-bg` is not listed either, so `--surface-subtle` needs no entry.

## Won't fix

- One Tooltip per session row actions trigger (perf, accepted).

## Out of scope

Lane #1499 owns `check-literal-colours.mjs`, `comment-density-scan.mjs`, `verify-tauri-083.mjs`, the literal-colour baseline and `ProjectColorPopover.tsx`. No new tests (prototyping phase).

## Acceptance

`pnpm ci:local` passes; `scripts/verify-tauri-106.mjs` passes on a built debug exe.
