# Feature Specification: Brand watermark

**Feature Branch**: `spec-012-brand-watermark`

**Created**: 2026-10-05

**Status**: Draft

**Input**: Stuart's request (2026-10-05): "we can use [the new brand SVG] for spinners, and a
faint bg anchored to the bottom right corner which can be toggled off in settings." This spec
covers the second half only — the faint background mark. The spinner use (spec 011) is a
separate, independent feature.

## Prerequisite

The new brand artwork lands in a separate change (branch `brand-icon-v2`, not yet merged into
`main` as of this spec): `build/refract-icon-v2.svg` (the 512×512 source of truth) and its in-app
derived copy, `src/renderer/assets/brand/refract-hero.svg` — identical paths, viewBox tightened
from the full canvas to the artwork (`viewBox="96 122 320 320"`, a perfect square) so the mark
fills its box with no dead padding. `build/icon.ico` is the new Windows app icon built from the
same source. This spec treats both files as an already-delivered dependency and does not re-author
them, recolour them, or create a second copy for its own use: the watermark reuses
`refract-hero.svg` verbatim, the same file the Readiness screen's header and the left nav header
already import.

## Clarifications

### Session 2026-10-05

- Q: Stuart said "a faint bg anchored to the bottom right corner" — bottom-right corner of what
  region? -> A: Not answered directly by Stuart; resolved here as a Decision (research.md decision
  1) rather than left open, per the planning brief's "make the conservative, standard choice"
  instruction. The chat area (the centre region that hosts one or two `ChatPane`s), not the whole
  window: the status bar (`StatusBar.tsx`) is an opaque `bg-card` footer outside the main content
  area, and the session list and Subagent panel are themselves opaque panels with their own
  background — anchoring to the whole window would place the mark where nothing shows it, since
  every other region already paints its own solid background over it.
- Q: Full colour brand art, or a tonal treatment? -> A: Resolved here as a Decision (research.md
  decision 4): a single-colour silhouette derived from the active theme's own muted-foreground
  token, not the mark's full teal/amber/violet palette, so one WCAG contrast proof covers every
  built-in theme preset (including any added later) without re-deriving multi-hue blending maths
  each time, and so the decorative mark reads as a quiet tonal watermark rather than a second,
  competing illustration next to the real UI.

### Session 2026-10-06 (design review follow-up)

- Q: Stuart's "bottom right corner" — the whole chat panel's corner, including the composer, or
  something narrower? -> A: Narrower, and this corrects the first draft rather than restating it:
  the composer (`MessageInput.tsx`) is a normal-flow, opaque block at the bottom of every
  `ChatPane` (`bg-composer-background`, DESIGN.md "Composer tone"), not an overlay —
  `ChatPane.tsx` renders its transcript container (`flex-1`) and the composer as plain flex
  siblings, so anchoring the mark to the outer panel's own bottom-right corner put it directly
  behind that opaque field, worse as the message box grows (up to ~8 lines, DESIGN.md "Message
  box"). The mark now anchors to the bottom-right corner of the **reading area** (the scrollable
  transcript region, which sits directly above the composer) instead: "bottom-right corner" is
  read as the bottom-right corner of the part of the chat the developer actually reads, not
  literally the panel's last pixel — the composer is UI chrome to type into, not reading
  material, the same way the chat header above it was never "the chat area" either (research.md
  decisions 1, 8).
- Q: With a split chat pane (two reading areas), which one carries the mark? -> A: The right-most
  pane's reading area (the second pane in a true two-pane split), never both and never the
  left/first pane — resolved as a Decision (research.md decision 8), matching "one watermark, not
  one per pane" from the original brief.
- Q: Is `prefers-reduced-transparency: reduce` a real, supported CSS feature in this app's pinned
  Electron, or a best-effort guess? -> A: Real and verified, not a guess: a throwaway Electron
  probe (research.md decision 11) confirmed Chromium 152 (bundled in the pinned Electron 44.5.1)
  recognises the media feature and evaluates it rather than silently ignoring it. FR-014 is
  written as a hard requirement, not a best-effort rule.
- Q: Are the design review's own contrast numbers (roughly 5.93:1/11.8:1 at opacity 0.06, ceiling
  0.08) correct? -> A: No — recomputed directly from the real token values in `globals.css` using
  the same OKLab/gamma-correct alpha-compositing math `scripts/check-theme-contrast.mjs` already
  uses (research.md decision 5). The real margins are considerably larger than the review
  estimated (roughly 7.2:1/13.8:1 at 0.06, for the tighter Dark preset), and the opacity's
  documented ceiling is set from that real arithmetic, not the review's unverified guess.

### Session 2026-11-04 (issue #1647, grilled by Stuart, none deferred)

- Q: Does the holiday glyph come back to transcript panes? -> A: Yes. This reverses #1256's
  `allowHoliday={false}` ruling (and spec 109 FR-1 for the preview); the overlap concern drops
  with the lower opacity (FR-023, FR-024).
- Q: How faint? -> A: About 1.3:1 against the theme background for both the plain mark and the
  holiday glyph, down from about 1.6:1 (#1298). Measured per theme with the #1233 method
  (sRGB-gamma composite, WCAG luminance) and recorded in the CSS comments (FR-024).
- Q: Is the single-colour rule (research decision 4) kept? -> A: No. The plain mark becomes an
  inline SVG whose facets are greys matched to each brand colour's OKLCH lightness, chroma 0,
  as CSS variables a theme can tune (FR-025). The 1.3:1 target is measured on the mean facet
  grey; the lightest and darkest facets are recorded as the range.
- Q: Any open question? -> A: None; answered from the issue and `docs/design/product-look-and-feel.md`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sees Refract's own mark quietly anchored in the workspace (Priority: P1)

A developer opens Refract and, without changing any setting, notices a very faint version of the
brand mark anchored to the bottom-right corner of the reading area — the scrollable transcript
region directly above the composer — never covered by the composer no matter how tall it grows,
and prominently visible in the "Select a Session or create one" empty state too. It never moves,
never animates, and is exactly as present whether one Session or two (a split chat pane, spec 005)
is open, belonging to the right-most pane's reading area when there are two.

**Why this priority**: This is the entire visible feature Stuart asked for. Without this story
there is nothing to toggle in Story 2, and nothing for Stories 3 and 4 to prove stays out of the
way.

**Independent Test**: Launch Refract with default settings, open a Session, and confirm a faint
version of the brand mark is anchored to the bottom-right corner of the transcript (reading)
area, never covered by the composer. Grow the message box to several lines and confirm the mark
stays fully clear of it. Resize the window and confirm it stays anchored to that corner at a
proportionate size. Open a split chat pane and confirm there is still exactly one mark, belonging
to the right pane, not two.

**Acceptance Scenarios**:

1. **Given** a fresh install with no setting ever changed, **When** the developer opens a Session,
   **Then** a faint, single-colour version of the brand mark shows anchored to the bottom-right
   corner of the transcript (reading) area, never covered by the composer.
2. **Given** the chat area is showing the "Select a Session or create one" empty state, **When**
   the developer looks at it, **Then** the mark is visible there too — the empty state is not a
   special case.
3. **Given** the mark is showing, **When** the developer grows the message box by typing several
   lines, up to its ~8-line maximum, **Then** the mark's own position does not change and no part
   of it becomes covered by the composer, because the reading area's own bottom edge — where the
   mark is anchored — is always exactly the composer's top edge, at every composer height.
4. **Given** the mark is showing, **When** the developer resizes or maximizes the window, **Then**
   the mark's size scales smoothly within its own fixed minimum and maximum, always anchored to
   the same corner, with no animation and no layout shift of any real content.
5. **Given** a split chat pane (spec 005) is open, **When** the developer looks at the chat area,
   **Then** there is exactly one mark, anchored to the right-most pane's reading area, not one per
   pane and never the left pane's.
6. **Given** the Subagent panel (spec 004) opens or closes, or the session list is hidden or
   shown, **When** the developer looks at the chat area, **Then** the mark's anchored corner is
   unaffected by either panel's state (though its clamped size still responds to how much width
   the reading area itself has left, the same as any other content inside it).
7. **Given** Bonfire Night (or any holiday) is in season and Holiday touches is not Off, **When**
   the developer opens a Session, **Then** the corner watermark is the holiday glyph, and so is
   the Appearance preview (#1647, FR-023).
8. **Given** the mark is the plain mark, **When** the developer looks at it, **Then** the teal,
   orange and violet faces read as distinct greys that keep the mark's 3D shape, at about 1.3:1
   against the background (#1647, FR-024, FR-025).

---

### User Story 2 - Turns the watermark off, or back on, in Settings (Priority: P1)

A developer who finds the mark distracting opens Settings, finds the control in the Appearance
section, and switches it off; the chat area's background goes back to plain, immediately, with no
restart. The choice survives closing and reopening Refract. The developer can see the effect of
the switch from inside Settings itself, without needing to leave the screen to check.

**Why this priority**: Stuart's own request named the toggle specifically ("which can be toggled
off in settings") — it is as core to the request as the mark's existence, and ranks with Story 1
because an always-on decorative background with no way to disable it is not what was asked for.

**Independent Test**: Open Settings, find the watermark switch in the Appearance section, confirm
it already reflects the current state, switch it off, confirm a preview in Settings shows the
effect immediately, leave Settings and confirm the chat area's mark is gone, restart Refract and
confirm it is still off, then switch it back on and confirm the mark returns.

**Acceptance Scenarios**:

1. **Given** the Settings screen's Appearance section, **When** the developer looks at it,
   **Then** it shows a switch, a label, and a one-line description for the background mark,
   following the same layout as the existing Session readout toggles.
2. **Given** the switch, **When** the developer turns it off, **Then** the real mark in the chat
   area disappears immediately, without closing or reopening Settings and without restarting
   Refract.
3. **Given** the switch has just been turned off or on, **When** the developer looks at the
   Appearance section without leaving it, **Then** a small preview reflects the new state
   immediately, so the effect is checkable from inside Settings.
4. **Given** the switch was turned off, **When** Refract is closed and reopened, **Then** it opens
   with the mark still off.
5. **Given** an existing `settings.json` written before this spec (no watermark key at all), **When**
   Refract reads it, **Then** it behaves exactly as if the setting were on — the documented
   default — not as off, missing, or an error.

---

### User Story 3 - The mark never interferes with reading, clicking, or selecting (Priority: P2)

Whatever is happening in the chat area — clicking a tool row, selecting and copying transcript
text, dragging to resize a pane, tabbing through controls, or reading with a screen reader or in
Windows High Contrast mode — the mark takes no part in any of it. It is never clicked, never
focused, never announced, never selected as text, and never a Windows High Contrast colour
surprise.

**Why this priority**: A decorative element that accidentally intercepts a click or a text
selection, or announces itself to assistive technology, is a regression masquerading as a feature;
this depends on Story 1 existing to have something to test against, which is why it ranks after it.

**Independent Test**: With the mark showing, click and drag to select transcript text that visually
overlaps where the mark sits; confirm the selection behaves exactly as it would with the mark off.
Tab through every control in the chat area and confirm the mark is never a stop. Turn on a screen
reader and confirm it is never announced. Turn on Windows High Contrast mode and confirm the mark
is not shown.

**Acceptance Scenarios**:

1. **Given** the mark is showing, **When** the developer clicks or drags anywhere inside its visual
   bounds, **Then** the click or drag reaches whatever real content is there (or the empty-state
   background), never the mark.
2. **Given** the mark is showing, **When** the developer selects transcript text that visually
   overlaps it, **Then** the selection is unaffected — the mark is never included in, nor
   interrupts, the selected range.
3. **Given** the mark is showing, **When** the developer tabs through the chat area's controls,
   **Then** the mark is never a stop, and a screen reader never announces it.
4. **Given** Windows High Contrast (forced-colors) mode is on, **When** the developer looks at the
   chat area, **Then** the mark is not shown at all, regardless of the Settings switch.
5. **Given** any built-in theme preset is active, **When** the mark is showing at its full
   documented opacity, **Then** no text or non-text UI element anywhere in the chat area drops
   below WCAG 2.2 AA contrast (4.5:1 text, 3:1 non-text/large text) because of it.

---

### User Story 4 - The mark stays consistent as the layout changes (Priority: P3)

As the developer resizes panes, opens and closes the Subagent panel, hides and shows the session
list, and switches between a single pane and a split chat, the mark never duplicates, never jumps
to a different corner mid-session, and never briefly shows in the wrong place during a resize.

**Why this priority**: This is a polish guarantee on top of Story 1's basic placement — real, but
lower priority than the mark existing, the toggle working, or it staying inert, since a momentary
layout artifact during a drag is a much smaller problem than any of those.

**Independent Test**: With a Session open, drag the session-list/chat/Subagent-panel dividers
through their full range, open and close the Subagent panel repeatedly, and open and close a split
chat pane repeatedly; at every point, confirm exactly one mark is showing, anchored to the
right-most (or single) pane's reading area.

**Acceptance Scenarios**:

1. **Given** the Subagent panel is collapsed to zero width (its default), **When** the developer
   opens it, **Then** the mark's anchored corner is unaffected by the Subagent panel's own width,
   though its clamped size still responds to the reading area's own available width.
2. **Given** a single chat pane, **When** the developer opens a second pane in a split (spec 005),
   **Then** the one existing mark is not joined by a second one: it belongs to the right pane's
   reading area, and the left pane never grows a copy of its own.
3. **Given** the window is narrower than the chat area's minimum pane width (360px, spec 005
   research.md Decision 6), **When** the developer looks at the reading area, **Then** the mark
   still fits inside it at its minimum size without visibly overflowing or clipping mid-shape.

---

### Edge Cases

- A Session row's details card, a tooltip, a dropdown menu, or any other popover opens over the
  area where the mark sits: it is a later, opaque element and simply paints over the mark, the
  same as it already paints over the plain background today — no special case is needed.
- The message box grows from empty to its ~8-line maximum while the mark is showing: no special
  handling is needed beyond FR-007's structural guarantee — the transcript (reading) area is a
  `flex-1` sibling of the composer, so its own bottom edge (where the mark is anchored) is always
  exactly the composer's current top edge, whatever that currently is.
- The reading area is narrower than the mark's own minimum size plus its edge offset (96px + 24px
  = 120px): does not occur in practice, since the chat pane's own existing 360px minimum width
  (spec 005) is always comfortably larger; the mark's own small wrapper clips at its edges rather
  than overflowing if this is ever violated.
- A future built-in theme preset is added (spec 007): the mark needs no new per-theme asset or
  colour, since it already reads the existing `--muted-foreground` token every `.theme-*` block
  already defines.
- The developer has Windows reduced-motion on: moot, since the mark never animates in the first
  place (no transition plays when the switch toggles it on or off either) — this is a distinct OS
  setting from "reduce transparency" (FR-014), which does hide the mark outright.
- A hand-edited `settings.json` sets the watermark key to a non-boolean value: treated as the
  documented default (on), the same lazy-correction-on-read pattern already used for `theme` and
  `split` (spec 007, spec 005).
- The Settings screen itself: the real mark is never shown on Settings' own background (nor on the
  Readiness/first-run screen or the future Manage sessions screen) — see FR-011 for the full
  reasoning; the switch's effect is instead checkable there via a small, dedicated preview.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The mark MUST be anchored to the bottom-right corner of the reading area — the
  scrollable transcript region above the composer — within the one eligible pane (FR-008), never
  to the composer itself, the whole chat `ResizablePanel`, the session list, or the Subagent
  panel.
- **FR-002**: The mark MUST render from the existing `src/renderer/assets/brand/refract-hero.svg`
  asset (prerequisite); this spec MUST NOT introduce a second, separately authored or recoloured
  copy of the artwork.
- **FR-003**: The mark MUST render as a single-colour silhouette derived from the active theme's
  own muted/secondary tone, not the artwork's full multi-hue palette, so it reads as a tonal
  watermark and needs no per-theme recolouring work.
  *Amended 2026-11-04 (#1647): the silhouette is now per-facet greys of the brand colours, see
  FR-025. FR-002's "no second copy" is met by an inline SVG with identical paths, not a recolour.*
- **FR-004**: The mark's faintness MUST be driven by one named, tunable opacity constant with a
  single declared home in the stylesheet, not a value repeated at each call site; its starting
  value and the upper bound later tuning should not exceed are both set from a real, measured WCAG
  contrast computation against the real token values (research.md), never asserted without one.
- **FR-005**: The mark's size MUST scale with the reading area's own dimensions between a fixed
  minimum and a fixed maximum, keeping its own square aspect ratio (matching the artwork's own
  tightened viewBox) rather than being stretched.
- **FR-006**: The mark MUST sit a fixed, consistent distance in from the right and bottom edges of
  its own reading area (never the composer, and never the whole chat panel), scaling with neither
  the mark's own size nor the window size.
- **FR-007**: At no composer height — including the message box grown to its ~8-line maximum
  (docs/DESIGN.md "Message box") — MUST any part of the mark be covered by the composer: the
  reading area's own bottom edge is always exactly the composer's current top edge, so the fixed
  inset of FR-006 keeps the mark clear by construction, not by a value that tracks the composer's
  height.
- **FR-008**: The mark MUST NOT be duplicated when a split chat pane (spec 005) is open: exactly
  one instance exists, belonging to the reading area of whichever pane is the right-most one
  currently shown (the second pane in a true two-pane split) — or the single pane shown when there
  is only one, including when the narrow-window rule (spec 005 research.md Decision 6) collapses a
  split down to one visible pane. The left/first pane of a true split never hosts a copy.
- **FR-009**: The mark's anchored corner MUST be unaffected by the Subagent panel's open/closed
  state, the session list's shown/hidden state, or the status bar — none of those are part of the
  reading area the mark is anchored to, though the reading area's own available width (and so the
  mark's clamped size) does still respond to how much of the chat `ResizablePanel` those panels
  leave it, the same as any other content inside it.
- **FR-010**: The mark MUST NOT render above any real content: every actual chat surface (the
  transcript, the message box, the empty-state placeholder's own content, any popover or dialog)
  MUST continue to paint over it exactly as it would over a plain background.
- **FR-011**: The mark MUST NOT render on the Settings screen, the Readiness (first-run) screen, or
  the (not yet built) Manage sessions screen: each of these replaces the chat area entirely with
  its own task-focused content, and the Readiness screen already carries a large, non-faint
  version of the same mark in its brand header — a second, faint corner copy there would be
  redundant rather than additive.
- **FR-012**: The mark MUST NOT intercept pointer events: a click, drag, or text selection that
  visually overlaps it MUST reach the real content or empty background beneath it unchanged.
- **FR-013**: The mark MUST be excluded from the accessibility tree (hidden from assistive
  technology) and MUST NOT be reachable by keyboard Tab navigation.
- **FR-014**: The mark MUST NOT be shown while Windows High Contrast (the `forced-colors: active`
  media feature) or the OS "reduce transparency" setting (`prefers-reduced-transparency: reduce`)
  is active, regardless of the Settings switch's state; both are real, recognised CSS media
  features in this app's pinned Electron/Chromium (confirmed live, research.md decision 11), not
  best-effort guesses.
- **FR-015**: At the mark's documented opacity, every themed text and non-text UI element in the
  reading area MUST continue to meet WCAG 2.2 AA contrast (at least 4.5:1 for body text, at least
  3:1 for large text and non-text parts) in every built-in theme preset (spec 007), measured and
  recorded in research.md, not merely asserted.
- **FR-016**: A new setting, on by default, MUST control whether the mark shows at all; its key,
  type, and default MUST be recorded in data-model.md and extend the existing `settings.json`
  Settings row (spec 001/004/005/007's pattern), not a new file.
- **FR-017**: The setting's control MUST live in the Settings screen's Appearance section (spec
  007), in its own visually distinct sub-section — separated from the theme picker's Save/Cancel
  row by a divider and its own heading — so its live-apply behaviour is never mistaken for
  something Save/Cancel governs; the visible label MUST read "Background watermark", with a
  one-line, jargon-free description, matching the Session readout toggles' layout convention
  (spec 004).
- **FR-018**: Changing the switch MUST apply immediately, live, to every open Session's chat area,
  with no restart and no separate Save/Cancel step.
- **FR-019**: The switch's state MUST be checkable from inside the Appearance section itself,
  through a small dedicated preview that reflects the current state immediately when the switch
  changes, without the developer needing to leave Settings.
- **FR-020**: The setting MUST persist across restarts through the existing settings store, and an
  existing `settings.json` written before this spec (with no watermark key at all) MUST be treated
  as the documented default (on), the same migration pattern already used for `sessionReadout`
  (spec 004) and `theme` (spec 007).
- **FR-021**: A stored value for the setting that is not a boolean MUST be treated as the
  documented default (on) on read, the same lazy-correction pattern already used for an
  unrecognised `theme` value (spec 007 FR-013).
- **FR-022**: The mark MUST cost nothing at runtime beyond its one-time paint: no animation, no
  per-frame JavaScript, no remote request, and no new npm dependency; it MUST pass the existing
  Content Security Policy (`img-src 'self' data:`, `src/renderer/index.html`) unchanged, the same
  way the existing hero asset already does.
- **FR-023** (#1647): In season, with Holiday touches not Off and the watermark switch on, the live
  watermark in a transcript pane and the Appearance preview MUST show the holiday glyph, the same
  as the empty state. This reverses #1256's `allowHoliday={false}` ruling; `BrandWatermark` no
  longer takes an `allowHoliday` prop.
- **FR-024** (#1647): Both the plain mark and the holiday glyph MUST read at about **1.3:1**
  against the theme background (was about 1.6:1, #1298). `--watermark-opacity` and
  `--holiday-artwork-opacity` are tuned per theme to that target, and each measured ratio is
  recorded in the CSS comment beside the value. The marks are decorative and exempt from WCAG
  1.4.11; muted transcript text over the mark keeps the 4.5:1 floor of FR-015.
- **FR-025** (#1647): The plain mark MUST render as an inline SVG (the same paths as
  `refract-hero.svg`, a shared component in `src/renderer/components/brand/`), not a CSS mask.
  Each facet's fill is a grey with the OKLCH lightness of its brand colour and chroma 0, exposed
  as a CSS custom property so a theme can tune it; the whole mark keeps `--watermark-opacity`.
  The Settings preview reuses the same component.
- **FR-026** (#1647): Both marks MUST stay hidden under `forced-colors: active` and
  `prefers-reduced-transparency: reduce`, `aria-hidden`, `pointer-events: none` (FR-012 to FR-014
  unchanged).

### Key Entities

- **Watermark setting**: the app-wide, persisted boolean controlling whether the mark shows at
  all; defaults to on; read at startup and applied live to every open Session's chat area, the
  same app-wide (not per-Session) scope as `theme` and `sessionReadout`.
- **Watermark mark**: the single-colour, non-interactive visual element itself — one instance per
  chat area regardless of pane count, anchored to its bottom-right corner, sized between a fixed
  minimum and maximum, built from the shared `refract-hero.svg` asset.
- **Watermark preview**: a small, separate rendering of the mark inside the Appearance section,
  reflecting the setting's current state live, so the setting is previewable without showing the
  real mark on the Settings screen itself.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the mark at its documented opacity, every WCAG 2.2 AA text/non-text contrast
  pair already verified by spec 007's contrast check continues to pass, in every built-in theme
  preset, measured by extending that same script.
- **SC-002**: Turning the switch off or on changes the chat area's visible state and the
  Appearance section's preview within the same render pass — no perceptible delay, no restart.
- **SC-003**: The setting's value survives a full Refract restart 100% of the time, including when
  the switch was last left off.
- **SC-004**: A click, drag-select, or Tab traversal anywhere the mark visually occupies behaves
  identically whether the mark is on or off, 100% of the time.
- **SC-005**: Across every state of the session list (shown/hidden), the Subagent panel
  (open/closed), and the chat area (single pane/split), exactly one mark instance exists whenever
  the setting is on, and zero whenever it is off or a full-screen view (Settings/Readiness/Manage
  sessions) is showing.
- **SC-006**: Toggling the switch, resizing the window, and switching between every built-in theme
  preset produce no measurable layout shift (no real control moves or resizes because of the
  mark).

## Assumptions

- **Anchor region**: the reading area (the scrollable transcript region above the composer) of
  whichever pane is eligible, not the whole window, not the composer, and not the outer chat
  `ResizablePanel` as a whole (research.md decisions 1, 8, corrected after design review from an
  earlier draft that anchored to the outer panel and so sat behind the opaque composer). The
  status bar and both side panels are opaque, so anchoring any wider than the reading area would
  either place the mark somewhere nothing reveals it, or behind the composer specifically.
- **One eligible pane, the right-most**: for a split chat pane (spec 005), the mark belongs to the
  second (right) pane's reading area only, never the first/left pane and never both (research.md
  decision 8) — the single pane shown when there is only one (including the narrow-window
  collapse) is trivially "the eligible pane."
- **Hidden on full-screen views**: Settings, Readiness, and the future Manage sessions screen never
  show the real mark (FR-011); the Settings-screen "previewable" requirement is met by a small
  dedicated preview element instead of the real corner mark, because Settings' own two-column
  layout (a `nav` plus a content pane, `SettingsScreen.tsx`) has little genuinely empty background
  for a corner mark to occupy, and consistency with the other full-screen views matters more than
  this one screen also showing the real effect.
- **Single-colour, not full-colour, kept as the default but reversible**: the mark is a tonal
  silhouette derived from `--muted-foreground`, not the artwork's own teal/amber/violet palette
  (research.md decision 4) — chosen for one analytic, theme-agnostic contrast proof and to avoid a
  second asset or a per-theme recolour table. A full-colour treatment is a small, reversible change
  (the same `refract-hero.svg` as a `background-image` at the same opacity, instead of a
  `mask-image`) with a two-line trade-off: brand expression (the real teal/amber/violet mark,
  recognisably "Refract") versus a single, theme-agnostic contrast proof (research.md decision 4)
  that would instead need re-deriving per hue, per theme. Flagged here, not built, so Stuart can
  flip it without a redesign.
- **Toggle applies live, no Save/Cancel**: unlike spec 007's theme picker (which previews and
  requires a commit step because switching the whole app's theme is a bigger, harder-to-mentally-
  undo action), this is a simple, already-instantly-reversible on/off switch, so it follows the
  Session readout toggles' live-apply convention (spec 004) instead.
- **Default on**: Stuart's phrasing ("which can be toggled off") implies the mark is present unless
  the developer turns it off, not opt-in.
- **Concrete starting numbers** (size clamp, edge offset, opacity) are deliberate, documented
  starting values with a single named home each, not an open question — tunable later without
  redesigning the feature. The opacity specifically is set from a real, measured WCAG contrast
  computation against the real token values (research.md decision 5), not merely asserted: at the
  documented starting value the real margin is roughly 7.2:1/13.8:1 (muted-foreground/chat-
  foreground on the tighter Dark preset), and WCAG contrast does not become the binding constraint
  until well past the documented ceiling — the ceiling itself is chosen with headroom to spare,
  not at the edge of failure.
- **Depends on the prerequisite brand-asset change** (branch `brand-icon-v2`, not yet merged into
  `main` as of this spec) landing first: `src/renderer/assets/brand/refract-hero.svg` and
  `build/icon.ico`. This spec does not redo that work.
- **Depends on, and extends**, spec 004's Settings screen and spec 007's Appearance section and
  theme tokens (`--muted-foreground`, the `.theme-*` blocks) — both already built on `main` in this
  checkout, so there is no sequencing risk the way spec 007 once had waiting on spec 004.
- **Windows 11 only**, consistent with the constitution; "Windows High Contrast" means the
  `forced-colors` CSS media feature, and "reduce transparency" means the `prefers-reduced-
  transparency` CSS media feature — both the mechanisms the corresponding Windows 11 settings
  drive in Chromium/Electron, both confirmed recognised at this app's pinned Electron/Chromium
  version (research.md decision 11), not assumed.
- **No automated tests**: Refract is a prototype (constitution, Development Workflow); every story
  is verified by running the app per quickstart.md.
