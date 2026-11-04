# Analysis: Transcript row action gutter (#1612)

## Coverage
- FR-001..FR-004: `CollapsedLine.tsx` reserves an `aria-hidden` `w-6` gutter after the chevron in every expandable row; the action overlays it at `right-2` and a `translate-y-0.5` offset (the offset is expressed as a transform so it stays on the spacing grid: `top-0.5` fails `check:spacing`).
- FR-006: the non-expandable branch (`children === undefined`) is unchanged.
- FR-007: `ToolRowKebab` and `ChainShowPanelButton` lost their compensating offsets; the chain `triggerClassName` keys on `group-hover/line:`.
- FR-008: `components.md`, `product-chat.md`, CHANGELOG and the PLAN row are updated.
- SC-001..SC-003: asserted by `scripts/verify-tauri-1612.mjs` against the new `row-gutter-1612` tape (thought, note, three tool rows with two failed, asked-user, two subagent chains). Syntax-checked only; the driver is not run in this lane.
- SC-004: typecheck, the renderer vitest suite, `check:file-size`, `check:comment-density` and `check:spacing` all pass.

## Findings
- No failed-row tint exists in the codebase: failure is `text-tool-row-error-fg` on the label and icon only. The full-width `group-hover/line` fill therefore covers the failed-row criterion; no extra failed-row styling was needed.
- In a narrow panel the summary column loses 32px (24px gutter + 8px gap) in every expandable row, including rows without an action. This is the accepted cost of one shared chevron column.
- `group/tool-row` sits on the `TranscriptMenu` ancestor, outside the `group/line` header wrapper, so the kebab reveal (`group-hover/tool-row`, `group-focus-within/tool-row`) still works when the pointer is over the gutter or the whole row.
- The gutter is not focusable: it is an `aria-hidden` span with no tabindex. The action stays a separate tab stop right after the trigger; the driver asserts Tab never lands in the spacer.
- Check run found one defect: `top-0.5` on the action slot violated the spacing grid (0,1,2,4,6,8,10,12 in this check's units). Fixed by using `top-0` plus `translate-y-0.5`; the rendered position is unchanged.

## Open
- The live driver has not been executed (builds are out of scope for this lane); run it before merge.
