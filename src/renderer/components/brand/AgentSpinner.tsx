import { useId, useState } from 'react'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

/** Below this size (px) the Full variant's gradients/filters/blend-modes/masks would cost more
 * than they are worth and would not read cleanly at small sizes; the Simplified variant renders
 * instead -- flat shapes, `transform`/`opacity` only, same palette, same visible orbit cue
 * (issue #612). Chosen higher than `BrandSpinner`'s old 24px floor (now removed) because this
 * mark's Full variant leans on gradients/filters that are the first things to look muddy at
 * in-between sizes. */
export const LEGIBILITY_FLOOR_PX = 28

export interface AgentSpinnerProps {
  /** Pixel size: the fixed ladder 16, 20, 24, 32, 48 -- the same ladder `BrandSpinner` used, so
   * every existing call site's size choice carries over unchanged. 16/20/24px render the
   * Simplified variant; 32/48px render the Full variant (`LEGIBILITY_FLOOR_PX`). */
  size: 16 | 20 | 24 | 32 | 48
  /** Merged with the component's own classes -- layout utilities only (for example `shrink-0`). */
  className?: string
  /** Colour palette. `'brand'` (default): Refract's own mark colours, reused verbatim from the
   * removed `BrandSpinner` (teal/amber/violet, themselves drawn from `build/refract-icon-v2.svg`)
   * -- chosen as the shipped default because it is Refract's own unambiguous brand palette,
   * already proven against the contrast floor below. `'export'`: Stuart's SVGator source export's
   * own colours (magenta/blue/red/violet/white), kept available as the documented one-line swap
   * (issue #612 "Colours"). Both are fixed values, never theme-derived -- same reasoning
   * `BrandSpinner`'s research.md decision 7 gave: the mark's identity is its specific palette. */
  palette?: 'brand' | 'export'
}

/** A tight square crop centred on the mark (issue #612 step 2b). The SVGator export's own
 * viewBox was `-300 -340 600 400` with the mark centred near (10,-140) at an outer ring radius of
 * about 136 (its `matrix(.68 0 0 .68 10 -140)` inner group). This component is a hand-ported
 * recreation, not a literal path copy (see the file-level deviations note below), so rather than
 * preserving that off-centre coordinate frame it is redrawn centred on (0,0) with the same
 * proportions, radius 100, plus a 10% margin for the glow layers and the orbiting cue -- a
 * 220x220 square. */
const VIEW_BOX = '-110 -110 220 220'

/** Loop length, matching the SVGator export's own timeline (reproduced in the trailing JSON
 * comment of the source export) exactly. */
const CYCLE_MS = 3000

/** The export's own cubic-bezier easing (`"e": [.42, 0, .58, 1]` on nearly every keyframe in the
 * source JSON) is applied in `globals.css` to every secondary cue (glow opacity, the core's shape
 * morph and hue-rotate); the orbiting cue deliberately uses `linear` instead -- see `FullMark`/
 * `SimplifiedMark` below and `globals.css`'s `.agent-spinner-rotator` comment. */

/** The agent-working spinner (issue #612, replaces `BrandSpinner`/spec 011): an inline, static
 * recreation of Stuart's SVGator export -- concentric glow rings, a colour-shifting core, and a
 * ring of bright orbiting cues -- with the SVGator runtime removed entirely (the exported
 * `<script src="https://cdn.svgator.com/...">` loader is forbidden outright by
 * `.specify/memory/constitution.md`'s "App windows MUST NOT load remote content"; this component
 * is 100% static markup plus local CSS, no network, no `dangerouslySetInnerHTML`).
 *
 * **Deviations from the export** (documented here and in the PR body, issue #612):
 * 1. **Visible spin, the actual defect this replaces `BrandSpinner` for.** The export's own big
 *    shapes are circles (rotating a circle is invisible) and its orbiting dot/dashed arc are tiny
 *    at the sizes this ships at -- the same defect Stuart rejected `BrandSpinner`'s subtle
 *    opacity-cascade for. `.agent-spinner-rotator` below is a dedicated, deliberately-asymmetric
 *    arc-plus-dot group that completes one full visible rotation every loop, added on top of (not
 *    instead of) the export's own colour/shape cues.
 * 2. **No SVGator runtime** (constitution security baseline, above) -- every rotation/scale/
 *    opacity/colour-shift beat the export's trailing JSON describes is reproduced as plain CSS
 *    `@keyframes`, `animation-delay`, this cubic-bezier easing, and (Full variant only) CSS
 *    `filter: hue-rotate()` and a CSS `d: path(...)` shape morph on the core -- not a 1:1 port of
 *    every one of the export's dozens of named groups/gradients/masks, which would be
 *    reconstructing SVGator's own renderer rather than hand-authoring a maintainable component.
 * 3. **Gradient-radius keyframe approximated, not reproduced.** The export animates one radial
 *    gradient's own `r` attribute over the loop (`fill radial gradient radius 'rd'` in its JSON).
 *    CSS cannot animate an SVG radial gradient's radius attribute directly without JavaScript, so
 *    `.agent-spinner-glow-2` below approximates the same breathing-halo effect by CSS
 *    `transform: scale()` plus `opacity` on a second, larger glow layer instead -- the visual
 *    read (a halo that swells and recedes) is the same; the mechanism is not.
 * 4. **Square-cropped, re-centred coordinate frame** (see `VIEW_BOX` above), not the export's own
 *    off-centre `(10,-140)` frame.
 * 5. **Size-gated Full/Simplified variants plus `forced-colors` support** are new: the export has
 *    neither (it is a single, fixed-size, un-size-gated SVGator player output).
 *
 * Every mounted instance computes its own `animation-delay` once, at mount, as a negative offset
 * into the shared cycle (`-(Date.now() % 3000)ms`) -- the same phase-locking technique
 * `BrandSpinner` used, so any number of concurrently-mounted instances land on the same point in
 * the cycle as every other, with no running timer and no per-frame React work.
 *
 * Always `aria-hidden`/`focusable={false}`, never an interactive element, no accessible name of
 * its own -- the "Working" announcement stays entirely owned by each call site's existing
 * `sr-only` `STATUS_LABEL` text (`sessionDisplay.tsx`), unchanged from `BrandSpinner`'s own
 * contract. */
export function AgentSpinner({ size, className, palette = 'brand' }: AgentSpinnerProps) {
  // React's useId() includes colons, invalid in a raw SVG id/url(#...) reference -- stripped so
  // every mounted instance still gets its own collision-free gradient/filter/mask ids.
  const uid = useId().replace(/:/g, '')
  // Computed once per instance via the lazy initializer -- not an effect, not a listener, and
  // never recomputed on re-render, matching BrandSpinner's own shared-clock technique.
  const [delay] = useState(() => `-${Date.now() % CYCLE_MS}ms`)
  const isFull = size >= LEGIBILITY_FLOOR_PX
  return (
    <svg
      aria-hidden
      focusable={false}
      width={size}
      height={size}
      viewBox={VIEW_BOX}
      className={cn('agent-spinner', className)}
      data-palette={palette}
      style={{ '--agent-spinner-delay': delay } as CSSProperties}
    >
      {isFull ? <FullMark uid={uid} /> : <SimplifiedMark />}
    </svg>
  )
}

/** The rest-frame diamond (also the Simplified variant's only core shape, and the Full variant's
 * `d: path()` morph's 0%/100% frame -- chosen as the calm reduced-motion rest frame,
 * `globals.css`'s `agent-spinner-core-morph` keyframes). Four cubic segments, not four straight
 * lines, so its command list matches the mid-cycle peak shape authored in `globals.css` exactly
 * (`d: path()` interpolation requires the same command sequence on every keyframe); the peak
 * shape itself lives only in CSS (it is never read from React), so it is not duplicated here. */
const CORE_REST_D =
  'M0,-56 C14,-56 20,-20 40,0 C20,20 14,56 0,56 C-14,56 -20,20 -40,0 C-20,-20 -14,-56 0,-56 Z'

/** The Full variant (32px, 48px): layered glow rings (gradients, a blur filter, a luminance mask
 * fading the outer edge, `mix-blend-mode: screen`), a colour-shifting core (`filter:
 * hue-rotate()` plus the `d: path()` morph above), and the bright orbiting arc-and-dot cue
 * (deviation 1). Every id below is namespaced with the instance's own `uid` so any number of
 * mounted instances never collide. */
function FullMark({ uid }: { uid: string }) {
  const ringGradientId = `agent-spinner-ring-gradient-${uid}`
  const maskId = `agent-spinner-fade-mask-${uid}`
  const maskGradientId = `agent-spinner-fade-mask-gradient-${uid}`
  const blurId = `agent-spinner-blur-${uid}`
  return (
    <>
      <defs>
        <linearGradient id={ringGradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" style={{ stopColor: 'var(--agent-spinner-ring)' }} />
          <stop offset="100%" style={{ stopColor: 'var(--agent-spinner-ring-2)' }} />
        </linearGradient>
        <radialGradient id={maskGradientId}>
          <stop offset="0%" stopColor="#fff" />
          <stop offset="70%" stopColor="#fff" />
          <stop offset="100%" stopColor="#000" />
        </radialGradient>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="-110" y="-110" width="220" height="220">
          <rect x="-110" y="-110" width="220" height="220" fill={`url(#${maskGradientId})`} />
        </mask>
        <filter id={blurId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.5" />
        </filter>
      </defs>
      {/* Glow ring 1: the export's own layered translucent rings, screened together. */}
      <g
        className="agent-spinner-glow"
        mask={`url(#${maskId})`}
        style={{ mixBlendMode: 'screen', filter: `url(#${blurId})` }}
      >
        <circle r="82" fill="none" stroke={`url(#${ringGradientId})`} strokeWidth="10" />
      </g>
      {/* Glow ring 2: approximates the export's animated gradient-radius keyframe by scaling a
       * second, larger glow layer instead of animating an SVG gradient attribute (deviation 3). */}
      <g className="agent-spinner-glow-2" style={{ mixBlendMode: 'screen' }}>
        <circle r="60" fill="none" stroke="var(--agent-spinner-glow)" strokeWidth="14" />
      </g>
      {/* The colour-shifting core: shape morph (`d: path()`) and `filter: hue-rotate()`, the two
       * effects CSS can drive without JavaScript, approximating the export's own per-facet morph
       * and hue-rotate keyframes (deviation 2). */}
      <path
        className="agent-spinner-core agent-spinner-core-full"
        d={CORE_REST_D}
        fill="var(--agent-spinner-core)"
      />
      {/* The visible orbiting cue (deviation 1): a bright arc with a brighter leading dot,
       * rotating a full turn every loop at constant (linear) speed -- deliberately not the eased
       * eased curve the rest of this component uses, because constant angular velocity reads as
       * mechanical "spinning" far more clearly than an eased one. */}
      <g className="agent-spinner-rotator">
        <circle
          r="92"
          fill="none"
          stroke="var(--agent-spinner-orbit)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray="34 544"
          opacity="0.9"
        />
        <circle cx="0" cy="-92" r="7" fill="var(--agent-spinner-orbit)" />
      </g>
    </>
  )
}

/** The Simplified variant (16px, 20px, 24px): flat shapes only -- no gradients, filters, masks or
 * `mix-blend-mode` -- animating only `transform` and `opacity`, so any number of concurrently
 * mounted instances stay cheap (issue #612 step 2e). Keeps the same palette and the same visible
 * orbiting cue as `FullMark`; drops the hue-rotate/shape-morph core (Full variant only) and the
 * layered gradient glow rings, replacing them with one flat ring and one flat core shape. */
function SimplifiedMark() {
  return (
    <>
      <circle
        className="agent-spinner-ring"
        r="78"
        fill="none"
        stroke="var(--agent-spinner-ring)"
        strokeWidth="12"
        opacity="0.55"
      />
      <path
        className="agent-spinner-core agent-spinner-core-simple"
        d={CORE_REST_D}
        fill="var(--agent-spinner-core)"
      />
      {/* One bright dot, no arc (fewer shapes than FullMark's rotator, per issue #612 step 2e) --
       * still a full, constant-speed rotation every loop, so the visible-spin cue survives at
       * every Simplified size. */}
      <g className="agent-spinner-rotator agent-spinner-rotator-simple">
        <circle cx="0" cy="-88" r="9" fill="var(--agent-spinner-orbit)" />
      </g>
    </>
  )
}
