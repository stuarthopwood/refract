# Feature Specification: Chat row density and verb emphasis

**Feature Branch**: `chat-row-density`
**Status**: Draft
**Input**: #1300 "Chat: non-agent row verb emphasis lost; add Tight / Compact / Comfy row density toggle (Compact default)". Numbered 048. No existing spec covers it, so this is the specify route. It touches the transcript rhythm of spec 040 (chat-transcript-wave3) without amending it.

## Clarifications

### Session 2026-10-29 (self-grill, Skippy delegated by Stuart; recorded on #1300, ui-architect-v3 rulings)

- Q: Already shipped? A: No. `origin/main` has no density setting and the label span in `CollapsedLine.tsx` inherits its colour.
- Q: What does "row gap" change? A: only the top margin between two consecutive bookkeeping rows (today `mt-1`). Tight `mt-1` (4px), Compact `mt-2` (8px, default), Comfy `mt-4` (16px). Every other transition (user message, agent prose, first work row after prose) keeps `mt-6` so turns stay separate; Comfy (16px) stays under that 24px turn gap. Ruling: ui-architect-v3.
- Q: What is the Note row's "extra vertical padding"? A: the `mt-6` margin a Note row gets because `mid-turn-prose` is not a bookkeeping kind. Stuart's grill says Note rows must match the other rows at the chosen density, so `mid-turn-prose` joins the bookkeeping kinds. This departs from the architect's advice to leave Notes at `mt-6`; the issue text is explicit and wins.
- Q: Verb emphasis? A: the label span of `CollapsedLine` defaults to `text-foreground`; the summary (object) stays `text-muted-foreground`. `labelClassName` still overrides (error red, subagent success tint). The Note row drops its `summaryClassName` so its summary reads muted; the expanded Markdown keeps `text-chat-foreground`.
- Q: Control? A: the shared segmented `ToggleGroup` (as Activity text), row "Chat row spacing", options Tight / Compact / Comfy, in Settings > Appearance right after the text-size group, applies live, no Save/Cancel. Ruling: ui-architect-v3.
- Q: Persistence? A: `chatRowDensity` in the Rust settings store, kebab-case `tight | compact | comfy`; absent or malformed reads `compact`. Its own child module and IPC handler, so `settings.rs` stays under 600 lines.
- Q: Accessibility? A: density changes only the margin outside the row trigger, so the `py-1` hit area and the focus ring are identical at every setting. The verb uses `--foreground`, brighter than the muted summary; the muted object text is the existing `--muted-foreground`, already contrast-checked in `theme-contrast-pairs.mjs`.
- Q: Principle V? A: no capability, CSP or network change; one new IPC request in the same shape as `settings.setStatusStyle`.
- Clarify pass (self-answered): no ambiguity left that changes the implementation.

## Requirements

- **FR-001** On every `CollapsedLine` row with a label (tool, thought, Stage, Note rows), the label uses `text-foreground` and the summary uses `text-muted-foreground`; an explicit `labelClassName` wins.
- **FR-002** The Note row's summary is muted (no `text-chat-foreground` override); its expanded text keeps `text-chat-foreground`.
- **FR-003** `mid-turn-prose` rows are bookkeeping rows, so Note rows get the density gap between other bookkeeping rows rather than `mt-6`.
- **FR-004** `Settings.chatRowDensity` (`'tight' | 'compact' | 'comfy'`, default `'compact'`) persists through `settings.setChatRowDensity`, validated in Rust, broadcast through `settings:changed`.
- **FR-005** The gap between two consecutive bookkeeping rows is `mt-1` / `mt-2` / `mt-4` for Tight / Compact / Comfy; all other gaps stay `mt-6`. Class names are written out in full.
- **FR-006** Settings > Appearance has a "Chat row spacing" row (shared `ToggleGroup`, Tight / Compact / Comfy, with label and description wired by `aria-labelledby` and `aria-describedby`); a second click on the selected segment does not clear it; it applies live.
- **FR-007** Density never changes a row's own padding, hit area or focus ring.

## Success criteria

- `pnpm ci:local` is green on the merged tree; the live check shows the three densities measured in the transcript, the verb brighter than the object on non-agent rows, and the setting surviving a restart.
- No file grows past its `scripts/file-size-baseline.json` value; new files stay under 600 lines; reusable components only (ADR 0003).
- No new tests (prototyping phase); existing tests keep passing.
