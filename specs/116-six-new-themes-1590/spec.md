# Feature Specification: Six new themes (3 light, 3 dark accents)

**Feature Branch**: `feat/1590-six-themes`
**Created**: 2026-11-04
**Status**: Draft
**Input**: GitHub issue #1590 (grilled 2026-11-02, all resolved). Route: specify.

## Clarifications

### Session 2026-11-04 (from grill)

Answers come from the issue body's "Grilled 2026-11-02" block and "Intended behaviour" section; no new questions were put to Stuart.

- Q: How many themes, and which? -> A: Six (from grill). Three light: **Light** (neutral), **Light (warm paper)**, **Light (high contrast)**. Three dark with distinct accents: teal (Solarized-style), purple (Dracula-style), warm (Gruvbox-style).
- Q: Names? -> A: Original names, no trademarked theme names (from grill). The implementer proposes them on the PR; proposed set below (FR-001).
- Q: What must each theme pass? -> A: `pnpm check:theme-contrast` and the #553 display-profile audit (TN washout, VA black crush), and each appears in Settings > Appearance and the Theme menu with its two-colour swatch (#1070, #1466) (from grill).
- Q: Do light themes change the native chrome? -> A: Yes. Picking a light theme sets `color-scheme: light` so native scrollbars, form controls and Tauri window chrome follow (from grill).
- Q: Which surfaces must read on light? -> A: Code blocks, Mermaid, diffs, role colours, severity colours and the active indicator, via the derived tokens (#1474), not per-component overrides (from grill).
- Q: High-contrast light rules? -> A: Same as Dark (high contrast): no text opacity softening (#1074 exemption), 7:1 body text (from grill).
- Q: Hard-coded dark assumptions? -> A: Sweep with `git grep` (`oklch` literals, `dark:` variants, literal colours), fix through tokens, list findings on the PR (from grill).
- Q: Evidence? -> A: Per-theme CDP screenshots (#1381 helper) of Chat, Pull requests, Settings and Usage, posted on the PR (from grill).
- Q: Dark/High-contrast open questions? -> A: None (from grill).

## User Scenarios & Testing

### User Story 1 - Pick a light theme (Priority: P1)
A user who works in daylight opens Settings > Appearance (or the Theme menu), picks Light, Light (warm paper) or Light (high contrast), and the whole app, including native scrollbars and inputs, switches to a light palette.

**Independent Test**: Select each light theme over CDP; `getComputedStyle(documentElement).colorScheme === 'light'`, body background is light, chat, code blocks, diffs and Mermaid are legible.

**Acceptance Scenarios**:
1. **Given** any theme, **When** the user selects a light theme, **Then** the `theme-<id>` class applies, `color-scheme: light` is set and the choice persists across restart.
2. **Given** Light (high contrast), **Then** body text is at least 7:1 and text-softening opacity is not applied.
3. **Given** a light theme, **Then** syntax highlighting, Mermaid, diff add/remove, role, severity and active-indicator colours meet their thresholds on the light surfaces.

### User Story 2 - Pick a new dark accent theme (Priority: P1)
A user picks the teal, purple or warm dark theme and gets a distinct accent family with the same surface ladder discipline as existing dark themes.

**Acceptance Scenarios**:
1. **Given** one of the three new dark themes selected, **Then** `color-scheme: dark`, accent-derived tokens (primary, send, links, focus) follow the theme's accent hue and every PAIRS entry passes.

### User Story 3 - Discover and preview themes (Priority: P2)
Each new theme appears in Settings > Appearance and the Theme menu in picker order, with a two-colour swatch (background, primary) matching its tokens.

**Acceptance Scenarios**:
1. **Given** the picker, **Then** all 11 built-in themes are listed, each with a swatch whose colours equal the theme's `--background` and primary.

### Edge Cases
- Stored settings with an unknown theme id still fall back as today; the Rust `ThemeId` enum accepts the six new ids (round-trip in settings.json).
- Custom themes (file themes with `base`) can pick a new theme as base; `base` lookup must work for light ones.
- Light theme + translucent tokens (`white at alpha` text, ghost edges, `--composer-background`): alpha tokens that assume a white-on-dark base must be re-based on a dark ink colour in light themes.
- Existing five themes remain byte-identical.
- 600-line file cap: six more token blocks cannot live in the current stylesheet if it would exceed the cap or the baseline.

## Requirements

### Functional Requirements
- **FR-001**: Add six built-in themes, proposed ids/names: `light` "Light", `light-warm-paper` "Light (warm paper)", `light-high-contrast` "Light (high contrast)", `lagoon` "Lagoon" (teal), `amethyst` "Amethyst" (purple), `hearth` "Hearth" (warm). Original names; none uses Solarized, Dracula or Gruvbox.
- **FR-002**: Each theme has a `.theme-<id>` token block covering the full token set (#550 ladder, #1074 text, #1474 derived tokens), with `color-scheme: light` for the three light themes and `dark` for the rest.
- **FR-003**: Registered in `src/shared/themes.ts` (id, name, two-colour swatch, `syntaxTheme`) and the Rust `ThemeId` enum so they persist.
- **FR-004**: All themes pass `pnpm check:theme-contrast` (PAIRS; new ids added to any `onlyThemes`/`informationalThemes` lists they belong in), the Mermaid/markdown/composer-selection contrast checks and `theme-swatch-drift`.
- **FR-005**: The #553 display-profile audit (`scripts/check-display-profiles.mjs`) reports no newly failing pair for TN washout and VA black crush on any new theme. Its step pairs assume lighter-than-canvas surfaces; light themes need the direction handled (see plan).
- **FR-006**: Light (high contrast) follows Dark (high contrast): no alpha text softening, 7:1 body text.
- **FR-007**: Body text >= 4.5:1 (7:1 in HC), focus ring >= 3:1 against every surface it touches, in every new theme.
- **FR-008**: Hard-coded dark assumptions found by `git grep` are fixed through tokens and listed on the PR.
- **FR-009**: Light themes select a light Shiki theme and a light Mermaid variable set via the derived tokens.
- **FR-010**: Docs updated (`docs/design/foundations-tokens-theming.md`, `accessibility.md`, `product-look-and-feel.md`, CHANGELOG, PLAN.md row).

### Key Entities
- **Theme**: id, name, swatch pair, syntax theme, `color-scheme`, token block.
- **ThemeId**: serialised kebab-case id stored in settings (Rust enum + TS union).

## Success Criteria
- **SC-001**: `pnpm check:theme-contrast` reports every PAIRS entry passing across 11 themes.
- **SC-002**: `check-display-profiles.mjs` shows 0 newly failing offenders for the six new themes.
- **SC-003**: Six screenshot sets (Chat, Pull requests, Settings, Usage) on the PR.
- **SC-004**: `node scripts/ci-local.mjs` passes; no file-size baseline raised.

## Assumptions
- No new automated tests are written (prototyping rule); existing tests that enumerate themes are updated to stay green. Contrast scripts are the verification.
- The #1381 per-theme CDP screenshot helper is used as named in the issue; its exact path is confirmed in T001.
