# Feature Specification: App-wide design tokens (wave 1)

**Feature Branch**: `wave1-app-wide-tokens`
**Status**: Draft
**Input**: One PR for the wave 1 "App-wide tokens" bundle in `docs/PLAN.md`: #843, #1144, #1267, #1270, #1073, #1124, #1125, #682, #738 and the product items of #1065. Decisions: the 2026-10-28 wave 1 grill (a comment on each issue; glossary terms Functional circle and Chrome band in `CONTEXT.md`). Numbered 032 because 030 and 031 are taken.

## Clarifications

### Session 2026-10-28 (wave 1 grill, Stuart)

- Base `--radius` is 4 px (0.25rem). Every arbitrary `rounded-[...]` and `min(var(--radius-md), Npx)` cap is deleted. Functional circles stay round: status dots, avatars, switch, radio mark, scrollbar thumb, composer Send and Stop, the pane resize grip. Text pills and chips take the token radius (#843).
- The 8px grid (#1269) wins over #1144's 6/8/10 px: inline text tokens get 4 px, pills, badges and buttons 8 px. Remaining work: slash-command pill `box-shadow` ring to 4 px, `QueuedChipList.tsx`, `StatePill.tsx`, `ChatHeader.tsx` pills (#1144).
- Every non-white text colour (muted foreground, success, warning, error, link and accent text) renders one weight step heavier at every size: 300 to 400, 400 to 500. White body text stays 300. Markdown headings stay visibly heavier than bold body text (600 against 500). The step is applied through colour utilities, not per component (#1267).
- Right-pane tab overflow: a count tab (Git `+a -d`, Subagents running) collapses to its icon plus one compact count when the strip is tight, as one shared rule in `PanelTabBar.tsx` (#1270). `check-spacing.mjs` hardening moved to #1137.
- Settings decorative separators move to `--divider`; control outlines keep `--border` (#1073). On main the `divide-border` uses are `SettingsScreen.tsx:168`, `ModelRolesSection.tsx:520`, `ChatDisplaySection.tsx:58`, `OmpSection.tsx:33`.
- Context-menu items copy the dropdown item exactly through one shared item class constant used by both primitives (item, sub-trigger, checkbox, radio). Menu icons rest at `text-muted-foreground`; destructive colour is kept. The right-click radio item has a leading radio ring (#1124, #1065).
- Active-tab underline uses `--accent-text` on every tab bar; no divider under any tab bar; a 3:1 non-text pair is added to `theme-contrast-pairs.mjs` (#1125).
- New `--titlebar` token per theme, defaulting to the menu bar's card surface. Title bar and menu bar form one Chrome band: one surface, one soft `--divider` line under it, no line between them (#682).
- The resize grip is a functional circle: `rounded-full`, 32 px long, 4 px wide, 3:1 contrast, wider invisible hit area. Probe the root cause first (#738).
- #1065: Ask card and Merge dialog use the shared radio ring. All verify-script bullets are out of scope (#1137).

### Session 2026-10-29 (pickup, assumptions recorded without a question)

- Q: Candidate `--titlebar` values? -> A: Each theme's `--card` value, per the grill ("defaulting to the menu bar's card surface"); the native overlay colour in `src-tauri` and `src/shared/themes.ts` is set to match.
- Q: Where is the compact count tab threshold? -> A: A container-width rule in `PanelTabBar.tsx`; the exact breakpoint is chosen from the pane floor so tab width never decides the floor (FR-009).
- Q: Does #1267 touch `settings.rs`, ligature placement or font-file provenance? -> A: Only product-visible items land: stale comments and the font-sans fallbacks on `kbd.tsx` and `ChangesTab.tsx`. Ligature setting relocation, Rust settings changes and provenance notes stay out (settings is its own bundle; `settings.rs` is at the 596-line cap).
- Clarify pass: no further ambiguity that changes the implementation.

## User Scenarios and Testing

### User Story 1 - A squarer, consistent look (P1)

1. **Given** any screen, **Then** buttons, inputs, dialogs, popovers, cards, chips and pills use 2.4 to 5.6 px corners and only functional circles are fully round.
2. **Given** a search for `rounded-[` in `src/renderer/components/ui`, **Then** no arbitrary radius remains.

### User Story 2 - Heavier non-white text (P1)

1. **Given** muted, severity or accent text at any size, **Then** it renders one weight step above white body text.
2. **Given** a Markdown heading beside bold body text, **Then** the heading is visibly heavier.

### User Story 3 - Menus, tabs and dividers agree (P1)

1. **Given** a row's context menu and its dropdown menu, **Then** they render identically (padding, focus bar, icon tone, radio ring).
2. **Given** any tab bar, **Then** the active tab has an accent underline and no divider sits under the bar.
3. **Given** Settings, **Then** row and section separators are soft dividers.

### User Story 4 - A visible, draggable Chrome band (P1)

1. **Given** any screen, **Then** the 40 px top row is one `--titlebar` surface with one soft line under it and the caption buttons match.
2. **Given** the four pane borders at rest, **Then** each shows a 4 by 32 px grip at 3:1 against both neighbours.

## Requirements

- **FR-001** `--radius` is `0.25rem` and is the only radius definition; no arbitrary `rounded-[...]` in the component library.
- **FR-002** Each `rounded-full` is a documented functional circle or converted to the token radius. `docs/design/product-look-and-feel.md` and `foundations-tokens-theming.md` state the rule.
- **FR-003** The slash-command pill and inline chip draw 4 px of horizontal padding by `box-shadow` (never layout padding); pills and badges use 8 px; `StatePill`, `QueuedChipList` and `ChatHeader` pills use the shared primitives.
- **FR-004** Non-white text colours step one weight heavier through shared colour utilities; text under 14 px is never 300; headings stay heavier than bold body text.
- **FR-005** Stale comments and the two `font-sans` fallbacks named in #1267 are fixed.
- **FR-006** `dropdown-menu.tsx` and `context-menu.tsx` share one item class constant; menu icons rest muted; the context radio item shows a leading ring.
- **FR-007** The Git changes file-row menu icons rest muted.
- **FR-008** Every tab bar uses the `accent-text` underline with no divider; a 3:1 pair is in `theme-contrast-pairs.mjs`.
- **FR-009** Count tabs collapse to icon plus compact count when the strip is tight; two count tabs never overlap the close button at the 240 px pane floor.
- **FR-010** The #1270 polish items (stale comments and spec figures, `AddRepositoryDialog` gap structure, `AlertRow`, `select.tsx`, pill nits, stale design-doc references) are done or recorded as skipped with a reason.
- **FR-011** Settings decorative separators use `--divider`; control outlines keep `--border`.
- **FR-012** `--titlebar` exists in every theme; the title bar and menu bar form one Chrome band with one `--divider` line; native overlay colour matches; `check:theme-contrast` covers the pair; high contrast uses a solid edge.
- **FR-013** All four resize handles show an always-visible 4 by 32 px circular grip at 3:1 against both sides, a wider invisible hit area, and distinct hover, focus and drag states.
- **FR-014** `AskCard` and `MergeDialog` use `RADIO_RING_CLASS`; spec 008 FR-030, `components.md:64` and `radio-group.tsx` wording match the code.
- **FR-015** No file grows past its `scripts/file-size-baseline.json` entry; no new tests are added.

## Out of Scope

#1112, the verify-script bullets of #1065 and #1270 and the `check-spacing.mjs` hardening (all #1137); ligature relocation and Rust settings changes from #1267; the #684 split-focus tint (uses the `--titlebar` token later); a user-facing radius setting.

## Success Criteria

- `pnpm ci:local` passes; screenshots in light, dark and high-contrast themes of the changed surfaces.
