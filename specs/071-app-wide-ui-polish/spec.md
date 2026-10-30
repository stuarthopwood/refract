# spec 071: App-wide UI polish (#1399, #1395, #1387, #1385)

Four renderer-only changes in one batch. No Rust, no IPC change.

## Clarifications

### Session 2026-10-30 (self-grill, Skippy delegated by Stuart; each issue already carries Stuart's grill answers)

- Q: Where does the ghost select look live? [Decided] One `SELECT_TRIGGER_CLASS` in `components/ui/select.tsx`, used by `SelectTrigger` and `MultiSelectChecklist` (a plain button, no outline `Button`). The `size` prop is removed; its only `sm` user was the Appearance holiday picker.
- Q: Dropdown width? [Decided] Panels are at least their trigger wide and never under 9rem (`SELECT_PANEL_MIN_WIDTH_CLASS`, `POPOVER_PANEL_MIN_WIDTH_CLASS`); items share `SELECT_ITEM_BOX_CLASS`. Fixed `w-*` classes on pickers are dropped, except the Filters panel's `FILTER_PICKER_CLASS` (spec 067) and form fields that fill their row.
- Q: Field border colour? [Decided, ui-architect-v3 flagged it] `--field-border` is `--divider` (Stuart asked for a soft border); this is a recorded 1.4.11 departure in `accessibility.md`, like the quiet composer. Dark HC uses `--border` and a 2px ring (`--field-ring-width`).
- Q: Ghost trigger in Dark HC? [Decided, ui-architect-v3] Keeps an edge through `--ghost-edge` (`--border`); transparent elsewhere. Keyboard focus ring is 2px `--ring`.
- Q: `--titlebar` tokens and `titleBarOverlay`? [Decided, ui-architect-v3] Keep: `check:theme-contrast` requires the overlay metadata. A follow-up fixes the swatch-drift measurement.
- Q: Menu bar over the transparent band? [Decided, ui-architect-v3] `AppMenuBar` takes `bg-sidebar` and `text-sidebar-foreground`.
- Q: Approve/Deny order? [Decided, ui-architect-v3] Deny (outline) left of Approve (filled, rightmost).
- Q: Holiday ghost? [Decided] `HolidayAccessory` is decorative (`aria-hidden`) and sits before the avatar in the profile row.

## Functional requirements

- FR-1 (#1399): Every select-type trigger is a 32 px ghost with a 16 px chevron; panels and items match as above.
- FR-2 (#1395): `Input` and `Textarea` have no fill, a `--field-border` edge and no focus halo; Browse buttons are `ghost`.
- FR-3 (#1387): `CardFooter` right-aligns; the primary is rightmost and the only filled button. The comment box has ghost-destructive Close pull request then Post comment. New `ghost-destructive` button variant.
- FR-4 (#1385): `.titlebar-surface` is transparent (Dark HC keeps a hairline); the logo row and `TITLE_BAR_OVERLAY_HEIGHT` spacer are gone; the Add project divider is inset.

## Success criteria

- SC-1: Each change is visible in the built app (screenshots in the session files folder).
- SC-2: `pnpm ci:local` and `pnpm check:ui-text` pass.
- SC-3: No new tests (rapid-prototyping phase).
