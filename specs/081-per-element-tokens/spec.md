# spec 081: Per-element tokens and theme-file leftovers (#1472, #1479; #458 slice 4)

Builds on spec 078 (custom theme files). Slices 5 and 6 of #458 are #1473 and #1474.

## User stories

1. As a theme author, I can recolour one UI element (a tool row, a notice, the approval card, a button variant, the status bar, a tooltip, a session row) in a theme file without touching the roles it shares with other elements.
2. As a user of custom themes, the Appearance screen behaves predictably when imports, removals and refreshes fail (#1479).

## Functional requirements

- FR-1: New component tokens, each defaulting to a semantic role so the default look is unchanged: `tool-row-fg`, `tool-row-error-fg`, `thinking-row-fg`, `thinking-row-active-fg`, `notice-info-fg`, `notice-warning-fg`, `notice-error-fg`, `approval-card-bg`, `approval-card-fg`, `approval-card-border`, `composer-control-fg`, `composer-control-hover-bg`, `composer-control-hover-fg`, `composer-control-open-bg`, `composer-control-open-fg`, `button-secondary-bg`, `button-secondary-fg`, `button-secondary-hover-bg`, `button-destructive-bg`, `button-destructive-fg`, `button-destructive-hover-bg`, `button-outline-bg`, `button-outline-border`, `button-outline-fg`, `button-outline-hover-bg`, `status-bar-bg`, `status-bar-fg`, `status-pill-attention-bg`, `status-pill-attention-fg`, `status-pill-attention-border`, `status-pill-attention-hover-bg`, `tooltip-bg`, `tooltip-fg`, `tooltip-border`, `session-row-fg`, `session-row-meta-fg`, `session-row-hover-bg`, `session-row-selected-bg`, `session-row-selected-fg`.
- FR-2: Every token is in `src/shared/theme-tokens.json`, has a Tailwind colour entry, and is declared once (on `:root` and the five `.theme-*` classes).
- FR-3: The listed components use the tokens (no remaining role class for that part): `ToolRow`, `ToolIcon`, `ThoughtRunRow`, `NoticeRow`, the approval `Card` in `RequestCard`, composer picker triggers (`pickerShared`), `Button` variants secondary, destructive and outline, `StatusBar` and its attention pill, `Tooltip`, `SessionRow`.
- FR-4: `check:theme-contrast` resolves `:root` defaults and checks one pair per new fg/bg token; the renderer contrast warning list gains about 10 representative pairs.
- FR-5 (#1479): the leftover items listed in #1479 are fixed, except the three recorded as skipped on that issue.

## Success criteria

- `pnpm ci:local` passes; no new tests; no file grows past its baseline.
- Live check: each built-in theme and a custom theme that recolours the new elements render, with screenshots.
