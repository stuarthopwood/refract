import { useId, useState } from 'react'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { useHolidayStore, useSettingsStore } from '@/state'
import { HOLIDAY_CONTENT } from '@/features/holidays/holidayContent'

/** Below this size (px) the halo's blur filter is dropped (issue #612 step 2e: "no blur filter
 * on the small variant") -- everything else about the mark (geometry, sequence, palette) is
 * identical at every size on the ladder, so there is no longer a separate Simplified/Full render
 * function; `blurred={size >= LEGIBILITY_FLOOR_PX}` is the one thing this threshold still
 * gates. */
export const LEGIBILITY_FLOOR_PX = 28

export interface AgentSpinnerProps {
  /** Pixel size: the fixed ladder 16, 20, 24, 32, 48 -- the same ladder `BrandSpinner` used, so
   * every existing call site's size choice carries over unchanged. Below `LEGIBILITY_FLOOR_PX`
   * the halo's blur filter is dropped; the geometry and sequence are otherwise identical. */
  size: 16 | 20 | 24 | 32 | 48
  /** Merged with the component's own classes -- layout utilities only (for example `shrink-0`). */
  className?: string
  /** Colour. `'brand'` (default): **follows the active theme** -- `--agent-spinner-core` is a
   * Layer 3 component token declared once per theme block in `globals.css` (`.theme-dark`,
   * `.theme-obsidian`, `.theme-dark-high-contrast`, `.theme-nordic-frost`, `.theme-cyber-amber`),
   * today the same brand violet (`#9A68E4`, lightened from the removed `BrandSpinner`'s original
   * `#864DD6` by round 5's A11y remediation -- see below) in every theme (Stuart's #616 review
   * round 4 decision: "same brand violet in every theme for now"); a custom theme file (#458)
   * may recolour it per-theme later. `'export'` and `'blue'` remain fixed, NON-theme-derived
   * overrides, set directly on
   * this element (so they win over the inherited theme value regardless of selector
   * specificity): `'export'` is Stuart's SVGator source export's own violet (`#D347FF`, issue
   * #612 "Colours"); `'blue'` is the electric blue from his own reference screenshot of the
   * target core look (glowing blue discs on black, `#2A7FFF`), added after his live review of
   * PR #616. `'brand'`'s own `--agent-spinner-core` is checked against `--sidebar`,
   * `--sidebar-accent` (the session list row, selected or hovered -- the icon is the only
   * visible status cue there), `--card`, `--popover` (the session details hover card) and
   * `--background` (every surface the mark actually renders on) by
   * `scripts/check-theme-contrast.mjs`'s `PAIRS` list, a real gate in every theme.
   * Quality-gate remediation (A11y HIGH, round 5): the original `#864DD6` measured under 3:1
   * against `--sidebar-accent` in every theme; `#9A68E4` fixes it with margin everywhere
   * (3.31-4.05:1 across all five built-in presets, #551 added Nordic Frost/Cyber Amber to this
   * range) while every already-passing surface stays passing (it only gets lighter).
   * `'export'`/`'blue'` are fixed literals outside the token system, so they are not wired into
   * that script as gates -- their own ratios against all five surfaces (sidebar, sidebar-accent,
   * card, popover, background), re-checked across all five themes for #551: all >=3.3:1,
   * comfortably clearing the 3:1 floor in every theme. */
  palette?: 'brand' | 'export' | 'blue'
}

/** The viewBox, re-cropped (issue #612 PR #616, Stuart's third review round: "scale up the whole
 * mark ... re-crop the viewBox if needed" after the outer ring/orbit layers were removed). Tight
 * around the new core's own worst-case extent -- the 86% -> 91% merge-snap segment's own spring
 * `cubic-bezier(.34,1.56,.64,1)` timing-function overshoot (it peaks at progress ~1.10-1.12, not
 * 1.0, mid-segment, not at either keyframe's own value): ~98.3 units unblurred, ~107.3 with the
 * Full variant's blurred halo's ~9-unit tail -- plus a margin, rounded up to a clean 110 (matches
 * the box this component shipped with before the re-crop, which is coincidence: that number was
 * derived from the old ring layer's own extent, this one from the new core's). See
 * `AgentSpinnerCore`'s own comment for the full worst-case table across every keyframe. */
const VIEW_BOX = '-110 -110 220 220'

/** Loop length. Originally 3000ms (matching the SVGator export's own timeline); 6000ms after the
 * first core redesign; **10000ms** after Stuart's "slow it down by about 40%" (PR #616, third
 * review round) -- the single named constant to change for a different speed. Also set inline
 * as the `--agent-spinner-cycle` custom property below, which drives `animation-duration` for
 * both `agent-spinner-core-split` and `agent-spinner-core-rotate` via `var()` (quality-gate
 * remediation, round 5: previously a separate `10s` literal in `globals.css` had to be kept in
 * sync with this constant by hand; deriving both from one source removes that duplication).
 * `Date.now() % CYCLE_MS` below computes a phase offset into the same period the CSS actually
 * animates over. The named percentage stops documented in `globals.css` stay exactly the same
 * proportions regardless of this value, by construction (CSS `%` keyframes always do). */
const CYCLE_MS = 10000

/** The agent-working spinner (issue #612, replaces `BrandSpinner`/spec 011): a split/rotate/merge
 * triangle of glowing discs, built as a from-scratch, static recreation -- no SVGator runtime (the
 * exported `<script src="https://cdn.svgator.com/...">` loader is forbidden outright by
 * `.specify/memory/constitution.md`'s "App windows MUST NOT load remote content"; this component
 * is 100% static markup plus local CSS, no network, no `dangerouslySetInnerHTML`).
 *
 * **History** (all three rounds happened within PR #616, issue #612):
 * 1. First shipped as a hand-ported recreation of Stuart's SVGator export: concentric glow rings,
 *    a `d: path()` core shape morph plus `filter: hue-rotate()`, and a bright orbiting arc/dot
 *    cue added on top (the export's own big shapes were circles -- rotating a circle is
 *    invisible, the same defect Stuart rejected `BrandSpinner` for).
 * 2. Stuart liked the spinner overall but found the core "weird"; the `d: path()` morph and
 *    `hue-rotate` were replaced entirely with the split/rotate/merge sequence below, specified
 *    from his own reference screenshot (three glowing discs in a triangle) -- this component's
 *    own design from this point on, not a port of anything in the SVGator export.
 * 3. Having seen the three-circle version, Stuart asked to remove the outer ring and orbiting
 *    arc/dot entirely (the triangle's own rotation is now the one visible-spin cue), shrink each
 *    disc and widen the gap between them when split, re-crop the viewBox so the mark fills more
 *    of it now that the rings are gone, and slow the loop from 6000ms to 10000ms. Every rotation/
 *    gradient-ring/orbit element from rounds 1-2 is gone outright (clean cutover, not hidden or
 *    disabled) -- `AgentSpinnerCore` below is the entire mark.
 *
 * Every property animated is `transform` (`translateY`, `scale`, `rotate`) -- no `d` path morph,
 * no `filter` on the core. The halo's own gradient `stop-opacity` is fixed, never animated.
 * Quality-gate remediation (Code LOW, round 5): `transform` animations on these SVG child
 * elements still repaint on the main thread each frame (not compositor-only the way a `<div>`'s
 * CSS `transform` can be) -- the same cost class the old `BrandSpinner`'s SVG opacity cascade
 * already was, not a regression, but "stay cheap" overstated it as free.
 *
 * Every mounted instance computes its own `animation-delay` once, at mount, as a negative offset
 * into the shared cycle (`-(Date.now() % CYCLE_MS)ms`) -- the same phase-locking technique
 * `BrandSpinner` used, so any number of concurrently-mounted instances land on the same point in
 * the cycle as every other, with no running timer and no per-frame React work.
 *
 * Always `aria-hidden`/`focusable={false}`, never an interactive element, no accessible name of
 * its own -- the "Working" announcement stays entirely owned by each call site's existing
 * `sr-only` `STATUS_LABEL` text (`sessionDisplay.tsx`), unchanged from `BrandSpinner`'s own
 * contract. */
/** Issue #1048 (Holiday touches, decision 5): in season, with the setting not `'off'`, swaps
 * the default split/rotate/merge core for the active holiday's own icon (`HOLIDAY_CONTENT`) --
 * "only its shape changes": same `size`, same `--agent-spinner-core` colour token (`data-palette`
 * still wins via the SAME `.agent-spinner[data-palette=...]` CSS rules, since this keeps the
 * `agent-spinner` class too), same `CYCLE_MS`/phase-locked delay (`.agent-spinner-holiday` in
 * `globals.css` reads both custom properties exactly like `.agent-spinner-core-rotator` does),
 * `aria-hidden`, and no accessible name of its own -- the caller's existing `sr-only`
 * `STATUS_LABEL` text is untouched either way, since this component never rendered one. */
export function AgentSpinner({ size, className, palette = 'brand' }: AgentSpinnerProps) {
  // Older React `useId()` formats contained colons (invalid, unescaped, in a `url(#...)`
  // reference); stripped defensively so every mounted instance's gradient/filter id stays
  // collision-free and url-safe regardless of the installed React version's own id format.
  const uid = useId().replace(/:/g, '')
  // Computed once per instance via the lazy initializer -- not an effect, not a listener, and
  // never recomputed on re-render, matching BrandSpinner's own shared-clock technique.
  const [delay] = useState(() => `-${Date.now() % CYCLE_MS}ms`)
  const holidayTouches = useSettingsStore((s) => s.settings.holidayTouches)
  const holiday = useHolidayStore((s) => s.activeHoliday)
  const holidayEntry = holidayTouches !== 'off' && holiday ? HOLIDAY_CONTENT[holiday] : null
  const cycleStyle = {
    // Both custom properties set from this one constant (quality-gate remediation, Code
    // LOW, round 5): previously `--agent-spinner-cycle` was a separate `10s` literal in
    // globals.css that had to be kept in sync with `CYCLE_MS` by hand; deriving both from
    // the same constant here removes that duplication entirely.
    '--agent-spinner-cycle': `${CYCLE_MS}ms`,
    '--agent-spinner-delay': delay
  } as CSSProperties
  if (holidayEntry) {
    const HolidayIcon = holidayEntry.icon
    return (
      <HolidayIcon
        aria-hidden
        focusable={false}
        width={size}
        height={size}
        strokeWidth={2}
        className={cn('agent-spinner agent-spinner-holiday', className)}
        data-palette={palette}
        style={cycleStyle}
      />
    )
  }
  return (
    <svg
      aria-hidden
      focusable={false}
      width={size}
      height={size}
      viewBox={VIEW_BOX}
      className={cn('agent-spinner', className)}
      data-palette={palette}
      style={cycleStyle}
    >
      <AgentSpinnerCore uid={uid} blurred={size >= LEGIBILITY_FLOOR_PX} />
    </svg>
  )
}

/** The three disc positions, 120deg apart, one pointing straight up (so the rendered triangle
 * matches Stuart's reference screenshot: one disc on top, two along the bottom). Each slot is a
 * static rotation (never animated itself); `.agent-spinner-core-rotator` in `globals.css`
 * animates the whole triangle's orientation, and `.agent-spinner-core-disc-group` animates each
 * disc's own distance from centre and size -- see `AgentSpinnerCore` below. */
const CORE_SLOT_ANGLES_DEG = [0, 120, 240] as const

/** The whole mark (issue #612, PR #616 third review round: the outer ring and orbiting arc/dot
 * are gone -- the triangle's own rotation is now the one visible-spin cue). Shared by every size
 * on the ladder -- same geometry, same sequence everywhere; `blurred` is the one difference
 * (dropped below `LEGIBILITY_FLOOR_PX`, "no blur filter on the small variant").
 *
 * Each of the three slots renders a soft radial-gradient halo plus a solid disc on top, both
 * children of one `transform`-only animated group (`.agent-spinner-core-disc-group`), so a single
 * loop drives `translateY` (distance from centre) and `scale` (disc size) together: at distance 0
 * / scale 1 the three discs sit exactly on top of each other and read as one solid circle (the
 * rest frame and the `prefers-reduced-motion` frame); splitting moves them outward while shrinking
 * them, so the merged circle and the three split discs read as "the same amount of light,
 * rearranged" rather than one shrinking into nothing. The disc's own `r="55"` is the merged-rest
 * radius; the halo's own `r="77"` is deliberately smaller relative to the disc than before
 * (previously ~1.96x, now ~1.4x) specifically to keep the worst-case extent (and so the viewBox)
 * small enough that the split disc still clears the 16px legibility floor -- see the worst-case
 * table below.
 *
 * **Sizing (PR #616 third review round -- smaller discs, bigger gap, checked against the 16px
 * floor)**: split disc radius 23 units (`scale(0.418...)` on the `r="55"` base, down from the
 * previous round's 26.5), split distance 56 units (up from 30) -- centre-to-centre distance
 * between neighbouring discs at 120deg apart is `56 * sqrt(3) ~= 97`, so the edge-to-edge gap is
 * `97 - 2*23 = 51` units, about 1.1x a disc's own diameter (46 units) -- "a clear gap of at least
 * about 1 disc diameter", as asked. At the rendered sizes this ships at, in the `-110..110`
 * viewBox (220 units wide): 16px -> `2*23*(16/220) ~= 3.35px` diameter, 20px -> `~4.18px`, 24px ->
 * `~5.02px` -- all clear the "~3px across" floor Stuart set, growing with size as expected.
 *
 * **Worst-case extent across every keyframe** (distance + halo radius x scale, used to size
 * `VIEW_BOX`): rest/merge-settle (0%, 8%, 94%, 100%) `0 + 77*1 = 77`; grow (12%) `0 + 77*1.06 =
 * 81.6`; split-overshoot (17%) `68 + 77*0.36 = 95.7`; split-settle (22%-80%) `56 + 77*0.418 =
 * 88.2`; merge-anticipation (86%) `68 + 77*0.38 = 97.3` at the KEYFRAME values themselves.
 * Quality-gate remediation (Code/Verif LOW, round 5): that table omits the spring
 * `cubic-bezier(.34,1.56,.64,1)` timing-function's own overshoot mid-segment -- it peaks at
 * progress ~1.10-1.12, not 1.0, so the real worst case is reached WITHIN the 86% -> 91%
 * segment, not at either endpoint: distance `-68 + 73*1.10 ~= 12.3`, scale `0.38 + 0.67*1.10 ~=
 * 1.117`, extent `12.3 + 77*1.117 ~= 98.3`. The Full variant's blurred halo adds a further ~3sigma
 * (~9 units at `stdDeviation="3"`) visible tail on top of that, `~98.3 + 9 ~= 107.3` -- still
 * comfortably inside the 110-unit half-box above, but with a tighter margin than the unblurred
 * 97.3 figure alone suggested. */
function AgentSpinnerCore({ uid, blurred }: { uid: string; blurred: boolean }) {
  const haloGradientId = `agent-spinner-core-halo-gradient-${uid}`
  const haloBlurId = `agent-spinner-core-halo-blur-${uid}`
  return (
    <>
      <defs>
        <radialGradient id={haloGradientId}>
          <stop offset="0%" stopOpacity="0.9" style={{ stopColor: 'var(--agent-spinner-core)' }} />
          <stop offset="45%" stopOpacity="0.35" style={{ stopColor: 'var(--agent-spinner-core)' }} />
          <stop offset="100%" stopOpacity="0" style={{ stopColor: 'var(--agent-spinner-core)' }} />
        </radialGradient>
        {blurred ? (
          <filter id={haloBlurId} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        ) : null}
      </defs>
      <g className="agent-spinner-core-rotator">
        {CORE_SLOT_ANGLES_DEG.map((angle, i) => (
          <g
            key={angle}
            className={`agent-spinner-core-slot agent-spinner-core-slot-${i}`}
            style={{ '--agent-spinner-slot-angle': `${angle}deg` } as CSSProperties}
          >
            <g className="agent-spinner-core-disc-group">
              <circle
                className="agent-spinner-core-halo"
                r="77"
                fill={`url(#${haloGradientId})`}
                style={blurred ? { filter: `url(#${haloBlurId})` } : undefined}
              />
              <circle className="agent-spinner-core-disc" r="55" fill="var(--agent-spinner-core)" />
            </g>
          </g>
        ))}
      </g>
    </>
  )
}
