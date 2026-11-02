# Spec 111: Option buttons and tabs, one look app-wide (issue #1302)

Status: gate passed, awaiting merge. Grill outcomes: the decision block at the top of #1302 (Stuart, 2026-11-02). Closes #1302. Specify route hand-authored (no slash prompts in this lane); clarify, plan and analyze are folded into the decisions below.

## Requirements

- FR-1 `TabsTrigger` (`ui/tabs.tsx`) and `ToggleGroupItem` (`ui/toggle-group.tsx`) own the one selected look: foreground text and a 2px `bg-accent-text` bar inset 8px at the bottom, no fill. Resting items are `text-muted-foreground`; hover is foreground text with no fill.
- FR-2 `TabsList` is transparent; toggle groups have no outline box and no dividers, and render as a plain row with a gap.
- FR-3 Forced-colours mode swaps the bar for a `Highlight` border on both primitives; a transparent resting border stops a 1px shift.
- FR-4 `SELECTED_SEGMENT_CLASS` and `TAB_ACTIVE_UNDERLINE_CLASS` (`ui/tab-classes.ts`) are deleted, with every per-site selected-state or resting-state className copy (FilterTabs, PullRequestDetail, AskCard, the six toggle-group sites). `PanelTabBar` is a hand-rolled tablist and reuses the exported `TAB_LOOK_CLASS`; it drops `font-semibold` so tab widths do not jump.
- FR-5 `ThemePicker` and `ChatWidthPicker` keep the #1122 selected-row bar.
- FR-6 `docs/design/product-look-and-feel.md` and `components.md` state the one look.

## Out of scope

New tests (prototyping phase) and the composer working-mode menu files.

## Acceptance

`pnpm ci:local` green and `verify-tauri-111.mjs` reports PASS from the pushed HEAD.
