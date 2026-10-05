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

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sees Refract's own mark quietly anchored in the workspace (Priority: P1)

A developer opens Refract and, without changing any setting, notices a very faint version of the
brand mark sitting in the bottom-right corner of the chat area — visible in the gaps around the
transcript and composer, and prominently in the "Select a Session or create one" empty state, but
never loud enough to compete with the chat itself. It never moves, never animates, and is exactly
as present whether one Session or two (a split chat pane, spec 005) is open.

**Why this priority**: This is the entire visible feature Stuart asked for. Without this story
there is nothing to toggle in Story 2, and nothing for Stories 3 and 4 to prove stays out of the
way.

**Independent Test**: Launch Refract with default settings, open a Session, and confirm a faint
version of the brand mark is anchored to the bottom-right corner of the chat area. Resize the
window and confirm it stays anchored to that corner at a proportionate size. Open a split chat
pane and confirm there is still exactly one mark, not two.

**Acceptance Scenarios**:

1. **Given** a fresh install with no setting ever changed, **When** the developer opens a Session,
   **Then** a faint, single-colour version of the brand mark shows anchored to the bottom-right
   corner of the chat area.
2. **Given** the chat area is showing the "Select a Session or create one" empty state, **When**
   the developer looks at it, **Then** the mark is visible there too — the empty state is not a
   special case.
3. **Given** the mark is showing, **When** the developer resizes or maximizes the window, **Then**
   the mark's size scales smoothly within its own fixed minimum and maximum, always anchored to
   the same corner, with no animation and no layout shift of any real content.
4. **Given** a split chat pane (spec 005) is open, **When** the developer looks at the chat area,
   **Then** there is exactly one mark for the whole chat area, not one per pane.
5. **Given** the Subagent panel (spec 004) opens or closes, or the session list is hidden or
   shown, **When** the developer looks at the chat area, **Then** the mark's position and size are
   unaffected by either panel's state, because it is anchored to the chat area's own corner, not
   the window's.

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
chat pane repeatedly; at every point, confirm exactly one mark is showing, anchored to the chat
area's own bottom-right corner.

**Acceptance Scenarios**:

1. **Given** the Subagent panel is collapsed to zero width (its default), **When** the developer
   opens it, **Then** the mark's position and size, anchored to the chat area, are unaffected by
   the Subagent panel's own width.
2. **Given** a single chat pane, **When** the developer opens a second pane in a split (spec 005),
   **Then** the one existing mark is not joined by a second one, and its anchored corner is still
   the chat area's own bottom-right corner (which now sits inside the visual bounds of whichever
   pane occupies that corner).
3. **Given** the window is narrower than the chat area's minimum pane width (360px, spec 005
   research.md Decision 6), **When** the developer looks at the chat area, **Then** the mark
   still fits inside it at its minimum size without visibly overflowing or clipping mid-shape.

---

### Edge Cases

- A Session row's details card, a tooltip, a dropdown menu, or any other popover opens over the
  area where the mark sits: it is a later, opaque element and simply paints over the mark, the
  same as it already paints over the plain background today — no special case is needed.
- The chat area is narrower than the mark's own minimum size plus its edge offset (96px + 24px =
  120px): does not occur in practice, since the chat pane's own existing 360px minimum width (spec
  005) is always comfortably larger; the mark's own small wrapper clips at its edges rather than
  overflowing if this is ever violated.
- A future built-in theme preset is added (spec 007): the mark needs no new per-theme asset or
  colour, since it already reads the existing `--muted-foreground` token every `.theme-*` block
  already defines.
- The developer has Windows reduced-motion on: moot, since the mark never animates in the first
  place (no transition plays when the switch toggles it on or off either).
- A hand-edited `settings.json` sets the watermark key to a non-boolean value: treated as the
  documented default (on), the same lazy-correction-on-read pattern already used for `theme` and
  `split` (spec 007, spec 005).
- The Settings screen itself: the real mark is never shown on Settings' own background (nor on the
  Readiness/first-run screen or the future Manage sessions screen) — see FR-010 for the full
  reasoning; the switch's effect is instead checkable there via a small, dedicated preview.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The mark MUST be anchored to the bottom-right corner of the chat area (the centre
  region hosting one or two `ChatPane`s, spec 001/spec 005) — not the whole window, not the
  session list, and not the Subagent panel.
- **FR-002**: The mark MUST render from the existing `src/renderer/assets/brand/refract-hero.svg`
  asset (prerequisite); this spec MUST NOT introduce a second, separately authored or recoloured
  copy of the artwork.
- **FR-003**: The mark MUST render as a single-colour silhouette derived from the active theme's
  own muted/secondary tone, not the artwork's full multi-hue palette, so it reads as a tonal
  watermark and needs no per-theme recolouring work.
- **FR-004**: The mark's faintness MUST be driven by one named, tunable opacity constant with a
  single declared home in the stylesheet, not a value repeated at each call site.
- **FR-005**: The mark's size MUST scale with the chat area's own dimensions between a fixed
  minimum and a fixed maximum, keeping its own square aspect ratio (matching the artwork's own
  tightened viewBox) rather than being stretched.
- **FR-006**: The mark MUST sit a fixed, consistent distance in from both the right and bottom
  edges of the chat area, scaling with neither the mark's own size nor the window size.
- **FR-007**: The mark MUST NOT be duplicated when a split chat pane (spec 005) is open: exactly
  one instance exists for the whole chat area regardless of how many panes it currently shows.
- **FR-008**: The mark's position and size MUST be unaffected by the Subagent panel's open/closed
  state, the session list's shown/hidden state, or the status bar, since none of those are part of
  the chat area the mark is anchored to.
- **FR-009**: The mark MUST NOT render above any real content: every actual chat surface (the
  transcript, the message box, the empty-state placeholder's own content, any popover or dialog)
  MUST continue to paint over it exactly as it would over a plain background.
- **FR-010**: The mark MUST NOT render on the Settings screen, the Readiness (first-run) screen, or
  the (not yet built) Manage sessions screen: each of these replaces the chat area entirely with
  its own task-focused content, and the Readiness screen already carries a large, non-faint
  version of the same mark in its brand header — a second, faint corner copy there would be
  redundant rather than additive.
- **FR-011**: The mark MUST NOT intercept pointer events: a click, drag, or text selection that
  visually overlaps it MUST reach the real content or empty background beneath it unchanged.
- **FR-012**: The mark MUST be excluded from the accessibility tree (hidden from assistive
  technology) and MUST NOT be reachable by keyboard Tab navigation.
- **FR-013**: The mark MUST NOT be shown while Windows High Contrast (the `forced-colors` media
  feature) is active, regardless of the Settings switch's state.
- **FR-014**: At the mark's documented opacity, every themed text and non-text UI element in the
  chat area MUST continue to meet WCAG 2.2 AA contrast (at least 4.5:1 for body text, at least
  3:1 for large text and non-text parts) in every built-in theme preset (spec 007).
- **FR-015**: A new setting, on by default, MUST control whether the mark shows at all; its key,
  type, and default MUST be recorded in data-model.md and extend the existing `settings.json`
  Settings row (spec 001/004/005/007's pattern), not a new file.
- **FR-016**: The setting's control MUST live in the Settings screen's Appearance section (spec
  007), as a switch with a label and a one-line description, matching the Session readout toggles'
  layout convention (spec 004) rather than the Appearance section's separate theme-picker
  Save/Cancel flow.
- **FR-017**: Changing the switch MUST apply immediately, live, to every open Session's chat area,
  with no restart and no separate Save/Cancel step.
- **FR-018**: The switch's state MUST be checkable from inside the Appearance section itself,
  through a small dedicated preview that reflects the current state immediately when the switch
  changes, without the developer needing to leave Settings.
- **FR-019**: The setting MUST persist across restarts through the existing settings store, and an
  existing `settings.json` written before this spec (with no watermark key at all) MUST be treated
  as the documented default (on), the same migration pattern already used for `sessionReadout`
  (spec 004) and `theme` (spec 007).
- **FR-020**: A stored value for the setting that is not a boolean MUST be treated as the
  documented default (on) on read, the same lazy-correction pattern already used for an
  unrecognised `theme` value (spec 007 FR-013).
- **FR-021**: The mark MUST cost nothing at runtime beyond its one-time paint: no animation, no
  per-frame JavaScript, no remote request, and no new npm dependency; it MUST pass the existing
  Content Security Policy (`img-src 'self' data:`, `src/renderer/index.html`) unchanged, the same
  way the existing hero asset already does.

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

- **Anchor region**: the chat area, not the whole window or the main content area including the
  session list/Subagent panel (research.md decision 1) — the status bar and both side panels are
  opaque, so anchoring anywhere else would place the mark somewhere nothing ever reveals it.
- **Hidden on full-screen views**: Settings, Readiness, and the future Manage sessions screen never
  show the real mark (FR-010); the Settings-screen "previewable" requirement is met by a small
  dedicated preview element instead of the real corner mark, because Settings' own two-column
  layout (a `nav` plus a content pane, `SettingsScreen.tsx`) has little genuinely empty background
  for a corner mark to occupy, and consistency with the other full-screen views matters more than
  this one screen also showing the real effect.
- **Single-colour, not full-colour**: the mark is a tonal silhouette derived from
  `--muted-foreground`, not the artwork's own teal/amber/violet palette (research.md decision 4) —
  chosen for one analytic, theme-agnostic contrast proof and to avoid a second asset or a
  per-theme recolour table.
- **Toggle applies live, no Save/Cancel**: unlike spec 007's theme picker (which previews and
  requires a commit step because switching the whole app's theme is a bigger, harder-to-mentally-
  undo action), this is a simple, already-instantly-reversible on/off switch, so it follows the
  Session readout toggles' live-apply convention (spec 004) instead.
- **Default on**: Stuart's phrasing ("which can be toggled off") implies the mark is present unless
  the developer turns it off, not opt-in.
- **Concrete starting numbers** (size clamp, edge offset, opacity) are deliberate, documented
  starting values with a single named home each, not an open question — tunable later without
  redesigning the feature; the opacity in particular is confirmed against WCAG AA during the Polish
  task (plan.md), not merely asserted.
- **Depends on the prerequisite brand-asset change** (branch `brand-icon-v2`, not yet merged into
  `main` as of this spec) landing first: `src/renderer/assets/brand/refract-hero.svg` and
  `build/icon.ico`. This spec does not redo that work.
- **Depends on, and extends**, spec 004's Settings screen and spec 007's Appearance section and
  theme tokens (`--muted-foreground`, the `.theme-*` blocks) — both already built on `main` in this
  checkout, so there is no sequencing risk the way spec 007 once had waiting on spec 004.
- **Windows 11 only**, consistent with the constitution; "Windows High Contrast" means the
  `forced-colors` CSS media feature, the same mechanism Windows' own High Contrast mode drives in
  Chromium/Electron.
- **No automated tests**: Refract is a prototype (constitution, Development Workflow); every story
  is verified by running the app per quickstart.md.
