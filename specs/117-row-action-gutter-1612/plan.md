# Implementation Plan: Transcript row action gutter

**Spec**: [spec.md](spec.md) | **Issue**: #1612 | **Route**: specify (spec 117; 114-116 are on origin/main)

## Summary
One layout change in `CollapsedLine`'s expandable branch plus removal of two caller offsets. No new IPC, no new props, no new tests (prototyping rule). A live driver proves the geometry.

## Grounding (read from origin/main 491b93cb)
- `CollapsedLine.tsx` expandable branch: `<div class="flex items-start gap-1">` holding the `flex-1` `CollapsibleTrigger` (row + chevron, `hover:bg-muted`) and `{action}` as a sibling. Hence a row with an action is `24px + gap-1` narrower.
- `action` callers: `ToolRow.tsx` (two, `ToolRowKebab`), `SubagentChainRow.tsx` (`ChainShowPanelButton`). `triggerClassName` has one caller: the chain card (`hover:bg-row-hover-bg`).
- `ToolRowKebab` -> `TranscriptKebab` (`lazy` placeholder button, then a `DropdownMenu`), `className` carries `translate-y-0.5`, `opacity-0` plus `group-hover/tool-row`/`group-focus-within/tool-row` reveal classes (`group/tool-row` is on `TranscriptMenu`, an ancestor of the whole row, so it still resolves after the move).
- Precedent: `RowKebabMenu` (#1632) lays the kebab `absolute` inside a `group/row relative [--ghost-hover-bg:var(--row-action-hover-bg)]` wrapper and keys hover on `group-hover/row:`.
- No row currently has a dedicated "failed" background: failure is the red label, icon and the error line. The "failed-row tint" in the issue is therefore the hover fill over a failed row; no new tint is invented.

## Design decisions
1. **Header wrapper** becomes `group/line relative flex items-start [--ghost-hover-bg:var(--row-action-hover-bg)]` (drops `gap-1`: the action no longer takes flow space).
2. **Gutter**: a `<span aria-hidden className="w-6 shrink-0" />` as the trigger's last child, after the chevron. Width = `icon-xs` (`size-6`); the trigger's `gap-2` supplies the "plus the gap". Reserved for every expandable row, action or not.
3. **Action placement**: `<span className="absolute right-2 top-0.5 flex">{action}</span>` inside the wrapper, after the trigger (DOM and tab order unchanged). `right-2` equals the trigger's `px-2`, so the action lands exactly on the gutter; `top-0.5` centres a 24px button on the 28px first line (replaces the callers' `translate-y-0.5`). Absolute positioning means the `…` appearing cannot move the chevron.
4. **Hover fill**: trigger `hover:bg-muted` becomes `group-hover/line:bg-muted`, so it also holds while the pointer is on the action (a non-descendant of the trigger). The chain's `triggerClassName` switches to `group-hover/line:bg-row-hover-bg` (tailwind-merge resolves the pair). Focus ring stays on the trigger.
5. **Callers**: remove `translate-y-0.5` from `ToolRowKebab` and `mr-1 translate-y-0.5` from `ChainShowPanelButton`.
6. **Non-expandable branch**: untouched.
7. **Docs**: `docs/design/components.md` gets a `CollapsedLine` action-gutter paragraph next to the existing `iconTooltip` one; `product-chat.md` baseline bullet gains a sentence; CHANGELOG Unreleased; PLAN row "in review".
8. **Driver**: `scripts/verify-tauri-1612.mjs` seeds a mixed transcript through the recorded-frame fake omp (same mechanism as `pnpm verify:tauri`) and measures with CDP; it is only syntax-checked here.

## Files to touch
- `src/renderer/features/chat/CollapsedLine.tsx`, `ToolRowMenu.tsx`, `SubagentChainRow.tsx`
- `docs/design/components.md`, `docs/design/product-chat.md`, `docs/PLAN.md`, `CHANGELOG.md`
- `scripts/verify-tauri-1612.mjs`, possibly a fixture tape under `scripts/fixtures/omp-frames/`
- `specs/117-row-action-gutter-1612/*`

## Risks
- Light themes: ghost hover (`hover:bg-muted`) equals the row fill; same limitation accepted for list rows in #1632.
- Narrow Subagents panel loses 32px of summary width; summaries already truncate or wrap.
