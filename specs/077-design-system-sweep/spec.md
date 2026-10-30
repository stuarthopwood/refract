# spec 077: Design system sweep (#579)

Brings controls and surfaces in line with the #474 rules. Split into slices; this lane delivers A to C, the rest are child issues of #579. Slice plan and rulings: https://github.com/stuarthopwood/refract/issues/579#issuecomment-6535153658

## Slice A: icon-only controls carry a tooltip
- New `components/IconButton.tsx`: `label` is both `aria-label` and tooltip text; optional `shortcut` Kbd; default `ghost` / `icon-sm`.
- Tooltip provider open delay 400 ms. Dialog and sheet Close, sidebar trigger, focus-move, attachment remove, history, scroll-to-end, actions ellipses use it.
- Skipped: unused `MessageScrollerButton`, non-tabbable `SidebarRail`, `aria-hidden` outline toggle.

## Slice B: hit targets
- Manage sessions row actions drop the 32 px `icon` size for `icon-xs` (24 px) via IconButton.

## Slice C: translucent tokens
- Nine tokens in `globals.css` replace Tailwind opacity modifiers (`--row-hover-bg`, `--focus-glow`, `--elevated-edge`, `--scrim-bg`, `--invalid-ring`, `--primary-hover-bg`, `--destructive-hover-bg`, `--field-bg`, `--field-hover-bg`).
- `pnpm check:alpha-modifiers` blocks new modifiers; the remaining ones are baselined per file.

## Clarifications (delegated decisions, ui-architect-v3 ruling)
- Tooltip text equals aria-label; merging /30 to /50 and /90 to /80 shifts pixels slightly and is accepted; `.dark` is always set, so tokens carry one value.
- Deliberate `dark:` overrides stay.

## Out of scope
Menus and Profile swatches, raw spacing and the 40 px header, lint scripts and the design checklist: child issues.
