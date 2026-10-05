# Research: Brand spinner

Decisions follow the format: Decision / Rationale / Alternatives considered.

## 1. Inventory of every existing spinner/busy indicator, and which are replaced

Grepped `animate-spin` across `src/renderer` (eight call sites across seven files), plus one
further busy indicator that does not match that string. For each: file, line, status it signals,
rendered size, and the replace/keep decision.

| File:line | Signals | Size | Decision |
|---|---|---|---|
| `features/sessions/sessionDisplay.tsx:33` (`StateIcon`, `working` case) | A Session's shared, app-wide status icon, rendered via `ChatHeader.tsx:49`, `SessionDetailsCard.tsx:68`, `SessionList.tsx:304` | `size-4` (16px) | **Replace.** The one component `docs/DESIGN.md`'s "Shared status icon" rule names explicitly; swapping it once cascades to every surface for free. |
| `features/chat/ToolRow.tsx:53` (`StatusIcon`, tool-call `running`) | One tool call's own running/done/error state | `size-3.5` (14px) | **Keep.** A local, one-tool-call-at-a-time indicator, not the shared Session-status component; at 14px it sits below even the legibility floor's margin. |
| `features/chat/Transcript.tsx:192` (streaming Thinking row) | The agent's reasoning is still streaming | `size-3.5` (14px) | **Keep.** Same reasoning as `ToolRow.tsx`: a local, transient, sub-floor-size indicator. |
| `features/subagents/SubagentPanel.tsx:26` (`SubagentStateIcon`, `running`) | One subagent's own run state in the Subagent panel list | `size-3.5` (14px) | **Keep.** A subagent is not a Session; `docs/DESIGN.md`'s rule is scoped to Session status, and this is its own distinct state-icon function, not `StateIcon`. |
| `features/sessions/SessionList.tsx:416` (per-repository "new session" button) | A quick-create click is in flight | `size-4` default (16px, via Button's base `[&_svg:not([class*='size-'])]:size-4`) | **Keep.** A one-off button-busy indicator for an action, not a Session's ongoing status. |
| `features/readiness/Readiness.tsx:96` (Re-check button) | A manual re-check click is in flight | `size-4` default (16px) | **Keep.** Same reasoning: a button's own in-flight state, first-run-screen-only. |
| `features/readiness/Readiness.tsx:109` (`CheckStatusIcon`, unresolved check) | One readiness check (git/omp/signed-in) has not resolved yet | `size-4` explicit (16px) | **Keep.** A first-run-only, one-off checklist row, not the Session-status surface this feature targets. |
| `components/ui/sonner.tsx:31` (Toaster's own `loading` icon) | A toast configured with `toast.promise`'s loading state | `size-4` (16px) | **Keep.** Sonner's own built-in icon slot for a library-provided toast variant, not a Refract-authored state icon. |
| `features/chat/ChatPane.tsx:388` ("Starting the agent…" banner) | A just-opened Session is cold-starting (`isOpening`) | `size-1.5` (6px) pulsing dot, `animate-pulse` — not `animate-spin` | **Keep, different motif entirely.** A tiny inline dot inside a one-line text status row, animated by opacity pulse rather than a spin; it does not even use the same CSS animation the rest of this inventory shares, and a full brand mark would not fit a 6px inline dot's role. |

**Decision**: only `sessionDisplay.tsx`'s `StateIcon` `working` case is replaced. Every other
indicator above is deliberately kept as-is.

**Rationale**: `docs/DESIGN.md`'s "Shared status icon" rule singles out exactly one component
(`StateIcon`) and exactly the surfaces that render a *Session's* live status as the one place every
such surface must funnel through; it is the single highest-visibility "the agent is working"
signal in the app, and it is already architected as one shared component, so replacing it once
is both the correct scope and the cheapest implementation. Every kept indicator is either (a) a
local, per-item, transient signal (a tool call, a streamed thinking block, a subagent, a button
click) that is not the Session-status surface the rule or Stuart's ask targets, or (b) smaller than
even the 14px/16px sizes already below the legibility floor (decision 2), where the mark's fine
facets would not read anyway, or (c) — for the "Starting the agent…" dot — not an icon-shaped
spinner at all. Swapping every one of these for brand art would also work against
`docs/DESIGN.md`'s own "Show state at a glance" principle: a spinning trademark on every tool call
and every toast is noisy at a glance, not calmer.

**Alternatives considered**: replacing every `animate-spin` site uniformly — rejected per the
reasoning above; narrowing the replacement to only the session-list row, leaving the chat header
and details card on the old `LoaderCircleIcon` — rejected, since that would violate
`docs/DESIGN.md`'s own "one shared component" rule by making `StateIcon` inconsistent with itself
depending on... nothing, since all three already call the same component; the correct fix is
inside `StateIcon`, not at any one of its three call sites.

## 2. Legibility floor: 24px, two render variants

**Decision**: below 24px the spinner renders a **Simplified** variant — a flat silhouette with no
internal facet subdivision, one solid tone per arm — instead of the full mark. At 24px and above it
renders the **Full** variant with every facet. The component's only shipped call site (16px,
decision 1) therefore always renders the Simplified variant.

**Rationale**: the two sizes any current spinner actually uses are 14px and 16px (decision 1's
table), both inside the 12px-to-16px range the brief itself identifies as too small for the mark's
fine internal shading to survive. Setting the floor at 24px gives a clear margin above the largest
size actually found, rather than drawing the line exactly at 16px and leaving no headroom.

**Alternatives considered**: a single variant at every size (always full facets) — rejected: it
would ship illegible noise at the one size that is actually used; a floor set at exactly 16px
(matching the shipped size precisely) — rejected as too tight a margin with no evidence it is the
correct boundary rather than merely the size that happens to be used today.

## 3. Motion: staggered per-arm cascade, not whole-mark rotation

**Decision**: the mark's core stays fixed at full opacity throughout (anchoring the shape so it
never looks incomplete); each of its three arms (teal, amber, violet) briefly rises in opacity and
position once per cycle, evenly spaced a third of a cycle apart, so exactly one arm is highlighted
at any instant and the highlight visibly cycles teal -> amber -> violet -> teal. Cycle length 1.2s,
ease-in-out, infinite. The whole mark's orientation never changes.

**Rationale**: the mark is an asymmetric isometric drawing with a clear "up" (the cube core with
arms reaching upper-left/upper-right/down); rotating it as one rigid body — the obvious alternative
for a circular spinner — would periodically present it sideways or upside down, which a
rotationally-symmetric ring icon (today's `LoaderCircleIcon`) never had to contend with and which
would read as broken rather than branded. A per-arm cascade keeps the mark right-way-up at every
frame while still clearly reading as "something is actively happening", and maps naturally onto the
mark's own three-arm structure (each arm literally "takes its turn").

**Alternatives considered**: rotating the whole mark 360 degrees per cycle — rejected for the
upside-down problem above; a single pulsing/breathing opacity on the whole mark at once (no
per-arm stagger) — rejected as a weaker, less "branded" motion that does not use the mark's own
three-arm shape at all and would look identical to a generic pulsing icon.

## 4. The component needs an explicit numeric `size` prop

**Decision**: the component's prop is `size: number` (pixels), not only a Tailwind utility
`className`, because it must itself decide, in JavaScript, which render variant to produce
(decision 2) — a decision a plain CSS class on the rendered element cannot drive, since there is no
reliable way for the component to read back a `size-4` Tailwind class at runtime. `className` is
still accepted and merged, for `shrink-0` and similar layout utilities, matching every sibling
icon's existing call pattern.

**Rationale**: every other icon in the inventory (decision 1) is sized purely by a Tailwind class
on a `lucide-react` icon, because none of those icons change shape by size; this component does
(decision 2), so it is the one icon-like component in the app that needs its size as real data, not
only as styling.

**Alternatives considered**: two separately-named components (`BrandSpinnerSmall`,
`BrandSpinnerLarge`) instead of one sized component — rejected as an unnecessary second public name
for what is one shape decision gated on one number; inferring the variant from the parent's
rendered pixel size via `ResizeObserver` — rejected as unneeded runtime complexity when the caller
already knows and states its own intended size.

## 5. Shared animation clock: a computed negative `animation-delay`, no running JavaScript

**Decision**: each mounted instance computes its own `animation-delay` once, at mount, as a
negative offset: the current time modulo the 1.2s cycle length, negated (`-(Date.now() % 1200)ms`).
From then on the animation runs entirely as ordinary CSS keyframes with no further JavaScript
involvement.

**Rationale**: a negative `animation-delay` is standard, long-established CSS behaviour (not an
Electron- or Windows-specific fact, so this needs no constitution-IV probe): it starts the
animation already partway through its cycle, at the point it would have reached had it begun at
time zero. Because every instance computes this offset against the same wall-clock origin
(`Date.now()`), any two instances mounted at different moments land on the same point in the cycle
as each other — this is what "shares a clock" means here, and it costs nothing beyond one cheap
calculation at mount; there is no running timer, no `requestAnimationFrame` loop, and no per-frame
React work for any number of concurrent instances, satisfying FR-013's twenty-concurrent-spinner
cost requirement for free.

**Alternatives considered**: a shared store broadcasting a rotation/phase value every animation
frame via `requestAnimationFrame`, read by every mounted instance — rejected: it adds a per-frame
JavaScript and React cost that scales with the number of mounted spinners, for a result the free
CSS-only technique already achieves; letting each instance's animation simply start at its own
mount time with no offset — rejected, since Sessions start working at different, arbitrary moments,
so uncorrected instances would never agree on phase (visibly rejected by User Story 1's Acceptance
Scenario 4 and FR-007).

## 6. Reduced motion: reuse the existing global mechanism, author keyframes for a clean rest frame

**Decision**: no new media query and no component-level reduced-motion check. The spinner's
keyframes are authored so the 0% and 100% frames are identical (every arm at rest: full opacity, no
lift) — only the frames between are different (one arm briefly dimmed-to-bright-and-back). The
existing `@media (prefers-reduced-motion: reduce)` block in `src/renderer/styles/globals.css`
(confirmed at lines 260-269: `*, *::before, *::after { animation-duration: 0.01ms !important;
animation-iteration-count: 1 !important; ... }`) already collapses this animation, along with every
other animation in the app, to one near-instant iteration.

**Rationale**: because every arm's 0%/100% frames match its own rest state, collapsing the
animation to effectively zero duration and one iteration leaves every arm exactly where it started
— the calm, fully-formed, static mark — rather than freezing mid-cascade on an arbitrary dimmed
frame. This is the same global mechanism `docs/DESIGN.md`'s "Motion" rule already documents
disabling "spinners" generally; reusing it, rather than adding a second mechanism, keeps the rule
single and true ("a `prefers-reduced-motion: reduce` media query disables animation globally").

**Alternatives considered**: a component-level `window.matchMedia('(prefers-reduced-motion:
reduce)')` check that swaps in a separately-authored static markup — rejected as a second,
redundant mechanism alongside the one that already exists and already works, and one more thing
that could drift out of sync with it.

## 7. Colour treatment: fixed brand colours, not theme-derived

**Decision**: the spinner always uses the mark's own fixed palette (teal, amber, violet arms;
violet core, from `build/refract-icon-v2.svg`), never a token that changes with the active theme
preset.

**Rationale**: Refract is dark-only (spec 007: "I don't think I want a light mode... Dark only,
dark theme presets only"), so there is no light-background contrast scenario to design the mark
against; both built-in presets (Dark, Dark (high contrast)) are dark backgrounds the fixed palette
already reads against. The entire point of this feature is brand recognition — recolouring the mark
per theme would work directly against that.

**Alternatives considered**: deriving the spinner's colours from theme tokens the way every other
themed surface does (spec 007 FR-007) — rejected: the mark's whole identity is its specific
three-colour palette, and spec 007's own theme list has no provision for a "brand" colour role to
derive from in the first place.

## 8. Accessibility: decorative only, no new announcement mechanism

**Decision**: the spinner is always `aria-hidden` and accepts no accessible-name prop. Busy state
continues to be carried entirely by whatever each call site already uses: `StateIcon`'s callers
each already render a sibling `sr-only` `STATUS_LABEL` span (`ChatHeader.tsx:50`,
`SessionDetailsCard.tsx:69` via its own text, `SessionList.tsx:305`), none of which this spec
touches.

**Rationale**: the icon the spinner replaces (`LoaderCircleIcon`) was itself already `aria-hidden`
(`sessionDisplay.tsx:33`); this spec changes what renders visually, not the accessibility contract
around it, so there is nothing to add and a real regression risk in adding a second, competing
announcement path.

**Alternatives considered**: giving the spinner its own `aria-label` ("Working") — rejected: it
would be a second, redundant source of the same text every call site's existing `sr-only` span
already provides, risking either silence (if one is ever removed, assuming the other covers it) or
duplicate announcements (if both are read together).

## 9. Component placement: a new `components/brand/` directory

**Decision**: the component lives at `src/renderer/components/brand/BrandSpinner.tsx`, a new
sibling directory to the existing `components/ui/` (shadcn-generated primitives) and
`assets/brand/` (the hero image asset).

**Rationale**: `components/ui/` holds only shadcn-generated, generic primitives (`button.tsx`,
`tooltip.tsx`, and so on) — the brand spinner is neither generic nor shadcn-sourced. It is also not
one feature's own component (unlike `features/chat/CollapsedLine.tsx`), since it is consumed from
`features/sessions/sessionDisplay.tsx` today and may be consumed from a different feature later
(Assumptions, the future large-size surface) — it needs a home that is not scoped to any one
feature directory. `components/brand/` directly mirrors the already-existing `assets/brand/`
naming for the same concept (brand-identity assets/components, as opposed to generic UI or
one-feature code).

**Alternatives considered**: `components/ui/BrandSpinner.tsx` — rejected: every sibling file there
is a lowercase-named, shadcn-generated primitive, and this component is neither;
`features/sessions/BrandSpinner.tsx` — rejected: it would misname the component's home to one
feature it merely happens to be consumed from first.

## 10. Large (forward) size: specified now, shipped nowhere in this spec

**Decision**: the component supports a size at or above the 24px legibility floor (decision 2) —
rendering the Full variant — for a future full-screen or empty-state loading surface. This spec
adds no such surface: no current screen in the app (including the first-run Readiness screen,
read directly — it never shows a full-screen loading state, only per-row 16px check spinners) has
anywhere for a large spinner to go. The large size is built and visually checked once during
implementation behind a temporary, unshipped harness, then left unused by any real call site.

**Rationale**: the brief asks for this size to be decided now so the component is ready when a
future surface needs it, without inventing a new, unrequested full-screen loading feature just to
give it a home. This mirrors spec 007 task T012's own documented approach: "build and verify it
behind a temporary standalone route for this task's own checkpoint only, never left in the shipped
navigation" (used there because its real host screen, spec 004's Settings, did not exist yet; used
here because no host surface exists at all).

**Alternatives considered**: omitting the large size entirely until a real consumer exists —
rejected: the brief explicitly asks for this size to be decided as part of this spec; shipping it
on an invented surface (for example, a large spinner added to the Readiness screen) — rejected as
unrequested scope beyond "use the mark for spinners".

## 11. `docs/DESIGN.md` amendment wording

**Decision**: the "Shared status icon" bullet's description of the `working` icon changes from "a
spinning circle for working" to naming the brand mark spinner, while keeping the rest of the
sentence ("every surface... renders through the one shared `StateIcon` component... no surface
draws its own plain filled dot, or any other shape, for a state `StateIcon` already covers")
unchanged, since that rule continues to hold exactly as written — one component, swapped once.

**Rationale**: the rule's substance (one shared component, no per-surface duplication) is not
changing; only the visual the `working` branch of that one component produces is. A tasks.md Polish
task applies this edit (matching spec 010's own stated convention: "This spec's `docs/DESIGN.md`
note is written by the implementation task that builds the feature, not by this spec-writing
pass"), not this document.

**Alternatives considered**: leaving `docs/DESIGN.md` wholly unedited — rejected: the current text
("a spinning circle for working") would become actively wrong once this spec ships.

## 12. A pre-existing `docs/DESIGN.md` inaccuracy, noted but not fixed

**Decision**: `docs/DESIGN.md`'s "Shared status icon" bullet also names "status bar" and
"tooltips" among the four surfaces rendering through `StateIcon`. Reading `StatusBar.tsx` directly
shows it renders only a low-memory notice and an omp-version notice — no per-session state icon at
all — and no tooltip in the app renders one either; the three real call sites are
`ChatHeader.tsx:49`, `SessionDetailsCard.tsx:68`, and `SessionList.tsx:304`. This spec does not
correct that wording, since fixing an unrelated, pre-existing documentation inaccuracy is outside
what this feature was asked to do.

**Rationale**: scope discipline — this spec's job is the spinner, not an audit of an unrelated
sentence's accuracy; the correction above (decision 11) only touches the clause this feature
actually changes.

**Alternatives considered**: also correcting "status bar"/"tooltips" to the real three surfaces
while already editing this bullet — rejected as unrequested scope creep past what this feature
needs, even though it is a one-line fix; left for whichever future change actually touches that
claim's accuracy.
