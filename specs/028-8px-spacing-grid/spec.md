# Feature Specification: 8px spacing grid with a 4px half-step

**Feature Branch**: `8px-grid-spacing`
**Status**: Draft
**Input**: Issue #1252 (UI polish, `p1`). It supersedes the "Spacing grid" rule decided in #474 (2026-10-08) and the 28px control sizes. Decisions: the 2026-10-27 grill recorded in the issue body, and the 2026-10-27 pickup grill below. Numbered 028 so it cannot clash with 026 or 027 (#1246).

## Clarifications

### Session 2026-10-27 (issue grill, Stuart)

- Allowed spacing steps are 4, 8, 16, 24, 32, 40 and 48 px (Tailwind `1`, `2`, `4`, `6`, `8`, `10`, `12`), plus `0`. 4px only for tight icon-to-text gaps and inline chip padding.
- Scope: padding, margin, gap, control heights and icon box sizes.
- Control heights: `sm` and `icon-sm` go from 28px to 24px, so the ladder is 24 (`xs`/`sm`) and 32 (`default`). `lg`/`icon-lg` stay outside the system.
- Icon boxes are 8, 16, 24 or 32 px: 14px glyphs become 16px; 12px and 20px go to the nearest step by use.
- Off-scale values map to the nearest allowed step by context: 6 to 4 or 8, 10 to 8, 2 to 4 or 0, 12 to 8 or 16, 20 to 16 or 24.
- A `check:spacing` script runs in `ci:local`, with a small allowlist file.

### Session 2026-10-27 (pickup grill, Stuart present)

- Q: Delivery shape? -> A: One PR for the whole story, built in primitives-first commits (the issue's per-area slices become commits, not PRs).
- Q: What does `check:spacing` fail on? -> A: Off-scale padding, margin, gap and space-x/y utilities (including negative margins) and arbitrary `[Npx]`/`[Nrem]` values inside those utilities, in `src/renderer`. Sizing utilities (`size-*`, `w-*`, `h-*`) are handled by the primitives and are not gated. Exceptions live in an allowlist file.
- Clarify pass (`/speckit.clarify`): no further ambiguity that changes the implementation. Rounding for each off-scale use is decided at the call site by context (FR-003); a use that cannot move without breaking alignment goes on the allowlist with a reason.

## User Scenarios and Testing

### User Story 1 - Consistent rhythm across the app (P1)

A developer opens any screen and spacing between and inside elements follows one grid.

**Acceptance Scenarios**:

1. **Given** any file in `src/renderer`, **When** `pnpm check:spacing` runs, **Then** it passes with no off-scale padding, margin, gap or arbitrary pixel spacing except allowlisted ones.
2. **Given** an off-scale class such as `p-1.5` or `gap-3` is introduced, **Then** `check:spacing` fails and names the file and line.
3. **Given** the transcript, **Then** turns are 24px apart and bookkeeping rows 4px apart, as before.

### User Story 2 - Denser, consistent controls (P1)

**Acceptance Scenarios**:

1. **Given** a `sm` or `icon-sm` button, **Then** it is 24px high.
2. **Given** any icon in a button or row, **Then** its box is 8, 16, 24 or 32 px.
3. **Given** a virtualised or fixed-row-height list, **Then** rows still align after `sm` shrinks.

### User Story 3 - Docs match the rule (P2)

**Acceptance Scenarios**:

1. **Given** `docs/design/foundations-typography-spacing.md` and `docs/design/components.md`, **Then** they state the 8px grid, the 24/32 ladder and the icon steps, and no longer mention the 4px grid or 28px sizes.

## Requirements

- **FR-001**: Every padding, margin, gap and space-x/y value in `src/renderer` uses 0, 4, 8, 16, 24, 32, 40 or 48 px.
- **FR-002**: `Button` `sm` is `h-6` and `icon-sm` is `size-6`; default glyph size is `size-4` (16px) for `default`, `sm`, `icon` and `icon-sm`, and `xs`/`icon-xs` use 16px too unless a denser use needs 8px; `lg`/`icon-lg` are unchanged.
- **FR-003**: Off-scale values are mapped by context: 6 to 4 or 8, 10 to 8, 2 to 4 or 0, 12 to 8 or 16, 20 to 16 or 24. Shared components are fixed in the shared component, not at call sites (ADR 0003).
- **FR-004**: Icon boxes (`size-*` on icons) are 8, 16, 24 or 32 px; `size-3`, `size-3.5` and `size-5` on icons move to the nearest step by use.
- **FR-005**: `scripts/check-spacing.mjs` implements the gate, exposed as `pnpm check:spacing`, run by `pnpm ci:local`, with `scripts/spacing-allowlist.json` for justified exceptions.
- **FR-006**: The design docs and `CONTEXT.md` ("Spacing grid") are rewritten; `docs/PLAN.md` row status is updated.
- **FR-007**: Composer overlay mirror layers keep their `box-shadow` technique, never real padding.
- **FR-008**: No horizontal overflow at 320px pane width, and 400% zoom still reflows. Targets keep the WCAG 2.5.8 24px circle clear of neighbours.
- **FR-009**: No file grows past the 600-line cap; no new tests (prototyping phase); existing tests keep passing.

## Success Criteria

- `pnpm ci:local` is green including `check:spacing`.
- A live check shows key screens (sidebar, chat, composer, settings, right pane, a dialog) in every theme with consistent spacing and no overlap or clipping.

## Out of scope

Typography (#1246), component sizes that are not padding (panel header 40px, composer bar 48px, avatars; only rechecked), `lg`/`icon-lg`.
