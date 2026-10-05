# Feature Specification: Brand spinner

**Feature Branch**: `spec-011-brand-spinner`

**Created**: 2026-10-05

**Status**: Draft

**Input**: Stuart's request (2026-10-05), about the redesigned app mark: "we can use [the SVG] for
spinners, and a faint bg anchored to the bottom right corner which can be toggled off in
settings." This spec covers the first half only — using the mark as Refract's busy/spinner
indicator. The second half (the background watermark) is spec 012.

**Prerequisite**: the redesigned mark, `build/refract-icon-v2.svg` (512x512, isometric, a violet
cube core with three arms — teal upper-left, amber upper-right, violet lower pillar, each drawn as
three shaded faces), and its derived in-app copy, `src/renderer/assets/brand/refract-hero.svg`,
are delivered by a separate, already-in-flight change and are not yet present in this worktree
(confirmed: only `build/refract-icon.ico`/`refract-hero.png` and
`src/renderer/assets/brand/refract-hero.png` exist today). This spec references those paths and
depends on them landing first; it does not redo that artwork.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The working indicator is the brand mark (Priority: P1)

A developer watches the session list, a chat header, or a session's details card while its agent
is running. Today each shows a plain spinning circle (`LoaderCircleIcon`, animated via
`animate-spin`) for the "working" state. After this feature, all three show the same thing: the
redesigned brand mark, animating to read as busy, in the exact place the plain spinner used to be
— nothing else about the row changes.

**Why this priority**: this is the entire feature Stuart asked for ("we can use it for spinners").
Every other requirement in this spec exists only to make this one swap legible, cheap, and
accessible; without it there is nothing to build.

**Independent Test**: start an agent running in a Session, and look at its row in the session
list, its chat header, and its hover/focus details card. Confirm all three show the brand mark,
not a generic circular spinner, and that switching the Session to idle, needs-you, or stopped
still shows today's existing hollow circle, bell, or square — unchanged.

**Acceptance Scenarios**:

1. **Given** a Session whose status is `working`, **When** the developer looks at its row in the
   session list, **Then** the state icon is the brand mark, animating, in the same position and at
   the same size the plain spinning circle used to occupy.
2. **Given** the same working Session, **When** the developer looks at its chat header or opens its
   details card, **Then** both show the identical brand mark — the same shared component, not a
   separate look-alike drawn locally in either place.
3. **Given** a working Session's status changes to `idle`, `needs-you`, or `stopped`, **When** the
   developer looks at any of the three surfaces above, **Then** it shows today's unchanged icon for
   that state (hollow circle, bell, or square) and the brand mark is gone.
4. **Given** several Sessions are working at once in the session list, **When** the developer looks
   at the list, **Then** every one of their brand-mark spinners animates in the same phase as the
   others (no two drift out of sync with each other over time).
5. **Given** a screen reader is in use, **When** the developer reaches a working Session's state
   icon, **Then** it is not announced itself (it is decorative), and the row's existing "Working"
   text is announced exactly as it is today — no accessible name or announcement regresses.

---

### User Story 2 - The mark stays legible, calm, and cheap wherever it spins (Priority: P2)

The brand mark has fine internal shading that only reads at a reasonable size. The places it
actually spins today are small (16px). This story is about making sure the mark still reads as
"the brand, spinning" at that size, settles to a calm, non-distracting still image when the
developer's OS asks for reduced motion, and costs nothing extra to render even with many Sessions
working at once.

**Why this priority**: User Story 1 can ship something that merely looks like a spinning logo;
this story is what keeps it from being an illegible smear at 16px, a motion-sickness risk for a
developer who has turned on reduced motion, or a performance regression with a busy session list —
all real risks the plain `LoaderCircleIcon` it replaces never had.

**Independent Test**: inspect the spinner at the one size it is used at today (16px); turn on
Windows' reduced-motion setting and confirm every visible instance goes static while the
surrounding "Working" text is unaffected; open twenty Sessions at once, start all their agents, and
confirm the session list keeps scrolling smoothly.

**Acceptance Scenarios**:

1. **Given** the brand mark renders at the 16px size `StateIcon` uses today, **When** the developer
   looks at it, **Then** it reads clearly as a recognisable, simplified version of the mark rather
   than a blurred cluster of fine lines.
2. **Given** the developer turns on the Windows "Show animations" (reduced motion) setting,
   **When** they look at any working Session's state icon, **Then** it is static — no moving parts
   — while the row's sr-only "Working" text is still present and unchanged.
3. **Given** twenty or more Sessions are all `working` at once in the session list, **When** the
   developer scrolls the list, **Then** scrolling stays smooth, with no stutter attributable to the
   spinners.
4. **Given** any built-in theme preset is active (spec 007's Dark or Dark (high contrast)),
   **When** the developer looks at a working Session's state icon, **Then** the brand mark's
   colours are identical in both — unaffected by which preset is active.

---

### Edge Cases

- A Session's status flips away from `working` mid-animation: the brand mark unmounts cleanly, the
  correct icon for the new state appears in its place, with no stray animation frame left running
  (the same clean swap `StateIcon`'s `switch` already does today).
- A developer who has never opened Settings, and has no reduced-motion preference set either way:
  the mark animates normally; there is no separate in-app toggle for this motion, only the existing
  OS-level signal `globals.css` already reads for every other animation in the app.
- Minimising Refract or moving it to the background: the animation is pure CSS with no running
  JavaScript timer, so it carries no cost to watch for or clean up while hidden.
- More than twenty Sessions working at once (fifty, or more): the same compositor-only, shared-clock
  design that satisfies the twenty-Session check (User Story 2) does not get more expensive per
  instance, since every instance shares one CSS keyframe definition and animates independently of
  React re-renders.
- A future surface that needs a large, full-screen rendering of the spinner (none exists in the
  app today): the component supports a size large enough for that case, built and checked once
  during implementation, but this spec ships no such surface (Assumptions).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `StateIcon`'s `working` case (`src/renderer/features/sessions/sessionDisplay.tsx`)
  MUST render the brand mark's spinner instead of `LoaderCircleIcon`/`animate-spin`; the `idle`,
  `needs-you`, and `stopped` cases MUST be unchanged.
- **FR-002**: The brand mark spinner MUST appear identically — the same shared component, not a
  separately drawn look-alike — everywhere `StateIcon` is already rendered: the session list row
  (`SessionList.tsx`), the chat header (`ChatHeader.tsx`), and the session details card
  (`SessionDetailsCard.tsx`), matching `docs/DESIGN.md`'s "Shared status icon" rule that no surface
  draws its own icon for a state `StateIcon` already covers.
- **FR-003**: Refract MUST NOT change any other existing spinner or busy indicator: the tool-call
  running spinner (`ToolRow.tsx`), the streaming-Thinking-row spinner (`Transcript.tsx`), the
  subagent-running spinner (`SubagentPanel.tsx`), the per-repository "creating a session" spinner
  (`SessionList.tsx`), either of the readiness-checklist spinners (`Readiness.tsx`), the toast
  loading spinner (`sonner.tsx`), or the "Starting the agent…" pulsing dot (`ChatPane.tsx`) —
  research.md records the reason for each.
- **FR-004**: The brand mark spinner MUST be an inline React SVG component — no raster image, no
  new npm dependency, and no remote network request — and MUST render under the app's existing
  Content-Security-Policy (`default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data:`).
- **FR-005**: The spinner's animation MUST be implemented using only CSS `transform` and `opacity`
  changes; it MUST NOT use `filter`, `box-shadow`, or any other non-compositor-friendly property to
  produce its motion.
- **FR-006**: Below a legibility floor of 24px, the spinner MUST render a simplified variant with
  no internal facet subdivision (flat, single-tone colour per arm); at 24px or above it MUST render
  the full, faceted mark. The component's only shipped call site (FR-001) is 16px and therefore
  always renders the simplified variant.
- **FR-007**: Every concurrently-mounted instance of the spinner MUST derive its animation's phase
  from one shared time origin, so that any number of instances visible at the same time animate in
  phase with each other rather than drifting independently.
- **FR-008**: While the OS "reduced motion" preference is on, every instance of the spinner MUST
  stop animating and show a static rest-state rendering, through the same existing
  `prefers-reduced-motion: reduce` mechanism in `src/renderer/styles/globals.css` that already
  disables every other animation in the app — no new, component-specific reduced-motion check.
- **FR-009**: The spinner MUST carry `aria-hidden` and no accessible name of its own; the "working"
  busy state MUST continue to be conveyed exactly as it is today, by each call site's existing
  `sr-only` "Working" text (`STATUS_LABEL`) and surrounding semantics, with no regression to any
  existing accessible name or announcement.
- **FR-010**: The spinner MUST use its own fixed brand colours (the teal, amber, and violet arms and
  violet core from `build/refract-icon-v2.svg`) rather than colours derived from the active theme,
  and MUST render identically under every built-in theme preset (spec 007).
- **FR-011**: The spinner component MUST accept an explicit pixel size and MUST support both the
  size used by its shipped call site (16px) and a larger size (at or above the 24px legibility
  floor) suitable for a future full-screen or empty-state loading surface; this spec ships no call
  site that uses the larger size.
- **FR-012**: Replacing `StateIcon`'s `working` icon MUST NOT change `StateIcon`'s props, its
  callers, or the rendering of the three other states.
- **FR-013**: With twenty or more Sessions simultaneously `working` in the session list, the
  spinners' animation MUST NOT cause a perceptible drop in session-list scrolling smoothness or
  input responsiveness.

### Key Entities

- **Brand mark spinner**: the shared, decorative, animating rendering of the redesigned app mark
  used for the "working" session state; one component, two render variants (simplified below the
  legibility floor, full at or above it), colours fixed regardless of theme.
- **Legibility floor**: the pixel threshold (24px) below which the mark's fine internal facets are
  dropped in favour of a flat, single-tone-per-arm silhouette, because they are not recognisable at
  smaller sizes.
- **Shared animation clock**: the mechanism that keeps every mounted spinner instance's motion in
  phase with every other, so a session list full of working Sessions reads as one calm, synchronised
  pattern rather than many independently-drifting spinners.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A repository-wide search for `animate-spin` finds it only in the files FR-003 names
  as deliberately kept; `sessionDisplay.tsx`'s `working` case no longer contains it.
- **SC-002**: The working-state icon is the same component instance type in the session list, the
  chat header, and the session details card — confirmed by reading each call site, not by visual
  comparison alone.
- **SC-003**: At the 16px size the spinner is actually used at, a developer looking at a working
  Session can tell its state icon is animating within 1 second.
- **SC-004**: With the OS reduced-motion preference on, every visible spinner instance shows zero
  animated frames, while the Session's sr-only "Working" text is still present, 100% of the time.
- **SC-005**: With twenty concurrent working Sessions visible in the session list, scrolling the
  list shows no stutter perceptible to the eye, and every visible spinner shares the same animation
  phase at any instant sampled.
- **SC-006**: The spinner's rendered colours are pixel-identical under the Dark and Dark (high
  contrast) presets.

## Assumptions

- Legibility floor set at 24px: the only two sizes any existing spinner is used at today are 14px
  and 16px (research.md's inventory), both below the range the brief itself flags as too small for
  the mark's fine facets (12px to 16px); 24px is set with a clear margin above the largest size
  actually found, rather than a boundary that happens to still include 16px.
- Motion is a staggered, three-arm opacity/lift cascade (each arm briefly brightens and lifts in
  turn — teal, then amber, then violet, repeating), never a rotation of the whole mark: the mark is
  asymmetric and has a fixed "up" orientation, so spinning it as a rigid body would periodically
  show it sideways or upside down, which a rotationally-symmetric ring icon never had to worry
  about; a per-arm cascade keeps the mark right-way-up at all times while still reading as "busy".
- Fixed brand colours, not theme-derived: Refract is dark-only (spec 007), so there is no
  light-background contrast risk to design around, and the entire point of this feature is brand
  recognition, which a per-theme recolouring would work against.
- The spinner is decorative only (`aria-hidden`), so no icon-level colour-contrast requirement
  applies to it the way spec 007 FR-008/FR-009 apply to the other three state icons: the
  information it would otherwise carry is already carried by each call site's existing sr-only text.
- The larger (24px+) size has no shipped call site in this spec, because no full-screen or
  empty-state loading surface exists in the app today for it to go on; it is specified and verified
  during implementation behind a temporary, unshipped harness only (plan.md), the same "build and
  check behind a temporary route, never ship it" approach spec 007 used for `AppearanceSection`
  before spec 004's Settings screen existed.
- `docs/DESIGN.md`'s existing "Shared status icon" bullet names session list, chat header, status
  bar, and tooltips as the four surfaces rendering through `StateIcon`. Reading `StatusBar.tsx`
  directly shows it renders only a low-memory notice and an omp-version notice today — no
  per-session state icon at all, and no tooltip surface renders one either. This is a pre-existing
  mismatch between that doc bullet and the shipped code that this spec inherits, not one it
  introduces; this spec's actual, grep-confirmed `StateIcon` call sites are exactly three
  (`ChatHeader.tsx`, `SessionDetailsCard.tsx`, `SessionList.tsx`), and this spec does not attempt to
  add a fourth or otherwise correct that unrelated documentation drift.
- No new Settings, persistence, or IPC surface: the spinner is a stateless, decorative renderer
  component; nothing about it is user-configurable (unlike spec 012's watermark toggle).
- Windows 11 is the only supported platform and Refract remains a no-automated-tests prototype,
  consistent with the constitution.
- This spec depends on the prerequisite brand assets (above) landing first, and on spec 007 (the
  theme presets it must render unchanged under) and `docs/DESIGN.md`'s "Shared status icon" rule
  (amended here to name the brand mark as the `working` rendering, research.md).
