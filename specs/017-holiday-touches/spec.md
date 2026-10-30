# Feature Specification: Holiday touches

**Feature dir**: `specs/017-holiday-touches/` (new, not an amendment to an existing spec)

**Why a new feature dir, not an amendment to 007/011/012**: this issue is genuinely
cross-cutting -- it touches the chat watermark (spec 012), the agent-working spinner (issue
#612, no spec of its own), the start-message pool (issue #618/#649, no spec of its own), the
sidebar logo (no spec), two separate empty states (no spec), and Settings > Appearance (spec
007). No single existing spec owns more than one of those five placements, so folding this into
any one of them would scatter half the feature's own requirements into a spec that does not
otherwise mention it. A new spec gives the whole feature (the calendar, the setting, all five
placements, the ambient loop, and the debug override) one home, the same way spec 012 itself was
split out from `docs/DESIGN.md` rather than bolted onto an unrelated spec.

**Source issue**: #1048. **Grilled** 2026-10-19 (Stuart, `/grill-with-docs`), 6 decisions, none
deferred -- see `research.md` for the decisions verbatim and their rationale.

## User Scenarios & Testing

### User Story 1 - Seasonal artwork appears automatically (Priority: P1)

As a Refract user, when the local system date falls inside a holiday window, I see small,
tasteful seasonal artwork in the chat watermark, the start messages, the sidebar logo, the empty
states, and the agent-working spinner -- without having to turn anything on.

**Why this priority**: this is the feature. Everything else (the setting, the pause rules) exists
to control this.

**Acceptance Scenarios**:

1. **Given** the system date is inside the Halloween window (24-31 Oct) and "Holiday touches" is
   `Full` (the default), **When** the app is open, **Then** all five placements show Halloween
   artwork (a Ghost glyph), and the ambient loop (drifting bats) is visible behind the chat
   reading area.
2. **Given** the system date is outside every window, **When** the app is open, **Then** nothing
   differs from a build with no holiday code at all.
3. **Given** two windows would otherwise overlap, **When** `activeHoliday` resolves "today",
   **Then** the shorter window wins (decision 4); today's six windows never actually overlap, so
   this is a defensive rule, not an observed case.

### User Story 2 - The setting controls artwork and motion separately (Priority: P1)

As a user who finds looping motion distracting (or who simply does not want seasonal decoration),
I can turn off the ambient loops while keeping the static artwork, or turn off holiday touches
entirely, from Settings > Appearance.

**Acceptance Scenarios**:

1. **Given** "Holiday touches" is set to `Artwork only`, **When** a holiday is active, **Then**
   every static placement still shows its holiday artwork, and no ambient loop renders.
2. **Given** "Holiday touches" is set to `Off`, **When** a holiday is active, **Then** none of the
   five placements differ from the non-holiday default, and no ambient loop renders.
3. **Given** the setting is changed while the app is open, **When** the change is saved, **Then**
   every open placement updates immediately (no restart, no Save/Cancel step).

### User Story 3 - The ambient loop respects motion and attention rules (Priority: P1)

As a user relying on OS reduced motion, or who has stepped away from the app, the ambient loop
never runs when it should not.

**Acceptance Scenarios**:

1. **Given** OS "reduce motion" is on, **When** a holiday is active and the setting is `Full`,
   **Then** the ambient loop does not render at all (and the holiday spinner glyph is a static,
   upright icon, not a spinning one).
2. **Given** the window is hidden or loses focus, **When** the loop was running, **Then** it
   pauses within one tick of that event and resumes on the next input once visible/focused again.
3. **Given** 60 seconds pass with no pointer or keyboard input, **When** the loop was running,
   **Then** it pauses, and resumes on the next input.
4. **Given** none of the above pause conditions are active, **When** the loop renders, **Then**
   it never flashes more than three times per second, never paints over text or a control, and
   never paints under the composer's input area.

### User Story 4 - A debug build can be checked without waiting for a real holiday (Priority: P2)

As the engineer verifying this feature, I can make a debug build believe "today" is inside a
holiday window (and shorten the 60s idle pause) without touching the system clock, and a release
build never honours either override even if the same environment variable happens to be set.

**Acceptance Scenarios**:

1. **Given** a debug build with `REFRACT_DATE_OVERRIDE=2026-10-27` set, **When** the renderer asks
   `debug.getOverrides()`, **Then** `activeHoliday` resolves Halloween for the rest of that run.
2. **Given** a release build with the same environment variable set, **When** the renderer asks
   `debug.getOverrides()`, **Then** the answer is `{ date: null, idleTimeoutMs: null }`.

### Edge Cases

- A `holidayTouches` value in a hand-edited `settings.json` that is not `full`/`artwork`/`off`
  falls back to `full` (the default), never rejected at load (matches `chatWidth`'s own
  lazy-correction posture).
- A holiday with no ambient effect (Star Wars Day, Pi Day) never renders a loop even when the
  setting is `Full` -- `HolidayContent.hasAmbientLoop` is the one gate, not a holiday-specific
  check scattered across call sites.
- The watermark's own pre-existing suppression rules (forced-colors, reduced-transparency) apply
  to the holiday watermark exactly as they already do to the plain mark.

## Requirements

- **FR-001**: The system MUST provide a pure function mapping a local `Date` to at most one
  active holiday, using exactly the six windows in decision 4 (Halloween 24-31 Oct, Bonfire Night
  1-5 Nov, Christmas 1-26 Dec, New Year 31 Dec-1 Jan, Star Wars Day 4 May, Pi Day 14 Mar).
- **FR-002**: When two windows would overlap for a given date, the system MUST resolve to the
  shorter window (by inclusive day count).
- **FR-003**: Settings > Appearance MUST offer a "Holiday touches" control, next to the
  background watermark switch, with exactly three values -- Full (default), Artwork only, Off --
  persisted the same way `watermarkEnabled`/`chatWidth` are, and applying live (no Save/Cancel).
- **FR-004**: With the setting at `Full` or `Artwork only`, in season, the system MUST show the
  active holiday's own artwork in the chat watermark, the start-message pool, the sidebar logo
  accessory, both the "No Session selected" and "No sessions yet" empty states, and the
  agent-working spinner's shape.
- **FR-005**: With the setting at `Off`, or outside every window, none of the five placements in
  FR-004 MUST differ from their non-holiday default.
- **FR-006**: With the setting at `Full`, in season, for a holiday with an ambient effect
  (Halloween, Bonfire Night, Christmas, New Year), the system MUST show a looping decorative
  layer behind the chat reading area; with the setting at `Artwork only` or `Off`, no loop MUST
  render regardless of season.
- **FR-007**: The ambient loop MUST pause when the window is hidden or unfocused, after 60
  seconds with no pointer/keyboard input (resuming on the next input), and under OS
  `prefers-reduced-motion: reduce` -- each independently, any one of the four is sufficient to
  stop it.
- **FR-008**: The ambient loop MUST never flash more than three times per second, never paint
  over text or an interactive control, never paint under the composer's input area, and never
  change layout.
- **FR-009**: Every holiday artwork colour MUST come from an existing theme token
  (`--muted-foreground`, `--agent-spinner-core`), never a new literal colour, and MUST never
  change an existing theme, state, or text colour.
- **FR-010**: The agent-working spinner's holiday glyph MUST keep the default spinner's colour,
  size, and loop duration, and MUST render as a static, upright glyph (no rotation) under OS
  reduced motion -- its sr-only "Working" announcement is owned by the existing caller and is
  unaffected either way.
- **FR-011**: The sidebar logo's accessible name ("Refract") MUST be unchanged regardless of the
  holiday accessory; the accessory itself MUST be `aria-hidden`.
- **FR-012**: Every empty-state holiday line MUST be `aria-hidden` and MUST never replace the
  empty state's own existing guidance text.
- **FR-013** (slice 2, Skippy for Stuart 2026-10-30): all six holidays MUST be switched on
  (`VERIFIED_HOLIDAYS` all `true`). Ambient loops: Bonfire Night = rising firework sparks,
  Christmas = falling snow, New Year = drifting confetti/sparkle, all inline SVG in
  `currentColor` at the existing artwork opacity, all under the FR-007/FR-008 stop rules and the
  occasional-flight CPU design Halloween's bats use. Star Wars Day and Pi Day have no loop by
  design (artwork and spinner glyph only).
- **FR-013**: A debug build MUST support an environment-variable override of "today" (date) and
  of the ambient loop's 60s idle pause (duration), read once at startup over the existing typed
  IPC bridge; a release build MUST always answer as if neither variable is set, regardless of the
  real process environment.
- **FR-014**: `docs/design/foundations-motion.md`'s "motion always carries a function" rule MUST
  carry a named exception for holiday touches (landed in the docs/plan PR, ahead of this spec).

## Key Entities

- **HolidayId**: one of `halloween` | `bonfire-night` | `christmas` | `new-year` |
  `star-wars-day` | `pi-day`.
- **HolidayTouches**: one of `full` | `artwork` | `off` (Settings field, default `full`).
- **HolidayContent**: per-holiday icon, emoji, start-message lines, empty-state line, and
  whether it has an ambient loop -- renderer-only (imports icon components), not persisted.

## Success Criteria

- **SC-001**: With a debug date override inside the Halloween window, artwork is visible in all
  five placements, in all five theme presets.
- **SC-002**: `Full` shows the ambient loop; `Artwork only` shows the same static artwork with no
  loop; `Off` shows nothing holiday-related; each applies without a reload.
- **SC-003**: The loop stops within the pause rules in FR-007, verified by CDP-emulated
  `prefers-reduced-motion` and by window blur/hide, without a sleep-based race.
- **SC-004**: Idle CPU with `Full` on is not meaningfully higher than idle CPU with `Off`
  (measured over 60s, reported in the PR, not gated on a hard numeric threshold -- the two
  numbers are compared, not independently asserted against an arbitrary ceiling).
