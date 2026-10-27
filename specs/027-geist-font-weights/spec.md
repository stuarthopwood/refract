# Feature Specification: Geist and Geist Mono defaults with a lighter weight scale

**Feature Branch**: `geist-fonts-lighter-weights`
**Created**: 2026-10-27
**Status**: Draft
**Input**: Issue #1246: "UI polish: App wide: Geist and Geist Mono defaults, lighter weight scale (body 300)". Grilled 2026-10-27 (Stuart, grill-with-docs); all questions resolved, none deferred. Three further decisions were taken in the pickup grill (below).

## Clarifications

### Session 2026-10-27 (Stuart's issue grill; binding)

- Q: Which fonts? → A: Geist (UI) and Geist Mono (code), both bundled; the current Segoe UI Variable and Cascadia stacks stay as fallbacks.
- Q: Body weight and scale? → A: Body 300. Every weight shifts down one step: normal 300, medium 400, semibold 500, bold 600. 200 is rejected (thin strokes lower effective contrast); 300 is the floor. No Settings control for weight.
- Q: Code weight? → A: 300, to match body.
- Q: Ligatures? → A: On by default (Geist Mono's built-in `liga`), with a Settings toggle that turns them off app-wide. Font pickers (#4), custom text sizes (#842), a weight slider and stylistic sets (`ss01` to `ss11`) are out of scope. #1252 (8px grid) is out of scope and follows this issue.

### Session 2026-10-27 (pickup grill, Stuart; binding)

- Q: Literal 400 weights left by #1208 (diff headers, row labels)? → A: They follow the scale down to 300; row labels equal body weight.
- Q: Does the composer move to the Code font here, or wait for #839? → A: In scope now. The composer textarea and its mirrors (ghost text, chip overlay, command pill) use the Code font so glyph positions stay aligned.
- Q: Where does the ligatures switch live? → A: Settings > Chat, as the issue proposes.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Lighter, consistent text everywhere (Priority: P1)

A developer opens Refract in any of the five themes and sees body text in bundled Geist at weight 300; buttons, selected states and headings step up one notch from today, so the hierarchy is kept but nothing looks heavy.

**Why this priority**: This is the whole point of the issue and touches every screen.

**Independent Test**: Open a Session, Settings and the Pull requests view in each theme; compare computed `font-family` and `font-weight` of body text, a button, a page title and the Refract wordmark.

**Acceptance Scenarios**:

1. **Given** any screen, **When** body text renders, **Then** its family resolves to Geist and its weight is 300.
2. **Given** an element that used `font-normal`, `font-medium`, `font-semibold` or `font-bold`, **When** it renders, **Then** its weight is 300, 400, 500 or 600 respectively, with no per-class edits.
3. **Given** the diff header and any other literal 400 left by #1208, **When** it renders, **Then** it is 300.
4. **Given** markdown `strong`, `b` and a slash-menu matched span, **When** they render, **Then** they are at the semibold step (500), heavier than the surrounding text.
5. **Given** the Readiness brand header, **When** it renders, **Then** it keeps the Geist look, with the headline now at 600 and the tagline at 400 (the scale applies to it too).
6. **Given** the five themes, **When** they render, **Then** colours are unchanged; only family and weight differ.

### User Story 2 - Code and composer in Geist Mono (Priority: P1)

A developer reads code blocks, inline code, tool output and diffs, and types in the message box, all in Geist Mono at weight 300 with ligatures (`=>`, `===`, `!==`).

**Why this priority**: Code is half of what the transcript shows, and the composer previously used the UI font.

**Independent Test**: Type `a => b !== c` in the composer and render the same in a code block; both show ligatures at the same glyph widths, and ghost text, chips and the command pill stay aligned over the text.

**Acceptance Scenarios**:

1. **Given** a code block, inline code, tool output or diff, **When** it renders, **Then** its family resolves to Geist Mono at weight 300.
2. **Given** the composer textarea and its mirrors, **When** they render, **Then** all use the Code font at weight 300, so overlays align with the typed glyphs.
3. **Given** ligatures are on (default), **When** `=>`, `===` or `!==` renders in code, **Then** the font's `liga` ligature is used. Copying the text yields the plain characters.

### User Story 3 - Turn ligatures off (Priority: P2)

A developer who dislikes ligatures turns off "Code ligatures" in Settings > Chat; every code surface and the composer immediately show plain characters, and the choice persists across restarts.

**Why this priority**: A preference toggle on top of a default.

**Independent Test**: Toggle the switch with the keyboard; confirm code surfaces change live and the setting survives restart.

**Acceptance Scenarios**:

1. **Given** the switch, **When** it is turned off, **Then** `font-variant-ligatures: none` applies to every Code font surface at once, live, and it persists with the other settings.
2. **Given** a settings file with no ligature entry, **When** the app starts, **Then** ligatures are on.
3. **Given** the switch, **When** a keyboard or screen-reader user reaches it, **Then** it is a labelled, operable switch and its state is announced.

### Edge Cases

- Bundled font fails to load: the stack falls back to Segoe UI Variable (UI) or Cascadia (code) with no layout break beyond font substitution.
- Windows text scaling and zoom: text must not clip or reflow worse than today.
- A theme's muted text at 300 on a raised surface: contrast is re-measured with the gate and by eye.
- Geist Mono woff2 must keep the `liga` feature (subsetting can strip it); verified on the shipped file.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `--font-ui` MUST resolve to bundled Geist, then the existing Segoe stack; `--font-code` MUST resolve to bundled Geist Mono, then the existing Cascadia stack.
- **FR-002**: Geist Mono MUST ship as a variable woff2 (weight 100 to 900) beside `Geist-Variable.woff2`, with its OFL text, sourced from the official repository, with `liga` intact.
- **FR-003**: The weight scale MUST be expressed once as theme tokens (`--font-weight-normal` 300, `-medium` 400, `-semibold` 500, `-bold` 600), so the utilities shift without per-class edits; body MUST use the normal token.
- **FR-004**: Literal font weights (`diff-view.css:50`, `:56`) MUST use the scale tokens (normal).
- **FR-005**: `b` and `strong` MUST use the semibold token (a relative `bolder` from 300 would land at 400).
- **FR-006**: Code surfaces and the composer (textarea, ghost overlay, chip overlay, command pill) MUST use the Code font at the normal weight.
- **FR-007**: Ligatures MUST be on by default and controllable by a persisted boolean setting, shown as a switch in Settings > Chat, applied live app-wide through one root attribute.
- **FR-008**: The comments in `globals.css` and the "Look and feel" note in `docs/DESIGN.md` that call Geist brand-only MUST be updated; the weight scale in `docs/design/` is updated.
- **FR-009**: Contrast MUST still pass `scripts/check-theme-contrast.mjs` in every theme.
- **FR-010**: No change to colours, spacing, text sizes or any Settings control for weight or font family.

### Key Entities

- **Weight scale**: four theme tokens (normal, medium, semibold, bold) in `globals.css`.
- **Ligatures setting**: boolean `codeLigatures` in the persisted settings, absent means on.

## Success Criteria *(mandatory)*

- **SC-001**: In every theme, computed body weight is 300 and family is Geist, and code surfaces compute Geist Mono at 300.
- **SC-002**: `rg "font-weight" src/renderer` shows no literal weight outside the `@font-face` descriptor and token definitions.
- **SC-003**: Toggling the switch changes ligature rendering on all code surfaces without reload, and the value persists.
- **SC-004**: `pnpm ci:local` passes, including the contrast gate.
- **SC-005**: Screenshots of each of the five themes show no clipped or overlapping text.

## Assumptions

- Tailwind v4 `@theme` overrides of `--font-weight-*` change the weight utilities app-wide [INFERENCE from Tailwind docs; verified by the live check].
- Preflight sets `b, strong` to `bolder` [INFERENCE; verified by computed style].
- The Rust settings store takes a new boolean with the same shape as `animatedStatusText` (#1242).
