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
   * own colours (magenta/blue/red/violet/white), kept available as a one-line swap (issue #612
   * "Colours"). `'blue'`: added after Stuart's live review of PR #616 -- the electric blue from
   * his own reference screenshot of the target core look (glowing blue discs on black), sampled
   * as `#1a6bff`/`#3a8dff`. All three are fixed values, never theme-derived -- same reasoning
   * `BrandSpinner`'s research.md decision 7 gave: the mark's identity is its specific palette. */
  palette?: 'brand' | 'export' | 'blue'
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

/** The agent-working spinner (issue #612, replaces `BrandSpinner`/spec 011): an inline, static
 * recreation of Stuart's SVGator export -- concentric glow rings, a split/rotate/merge core, and
 * a ring of bright orbiting cues -- with the SVGator runtime removed entirely (the exported
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
 *    `@keyframes`, `animation-delay` and the export's own cubic-bezier easing -- not a 1:1 port
 *    of every one of the export's dozens of named groups/gradients/masks, which would be
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
 * **Design revision (2026-10-09, after Stuart's live review of PR #616):** the core originally
 * shipped as a single `d: path()` shape morph (a diamond/blob pulse) plus a `filter:
 * hue-rotate()` colour cycle, both approximating facets of the SVGator export. Stuart liked the
 * spinner overall but found that core "weird"; `AgentSpinnerCore` below replaces it entirely with
 * a split/rotate/merge sequence he specified directly from a reference screenshot (three glowing
 * blue discs in a triangle), which is this component's own design from this point on, not a port
 * of anything in the SVGator export. The `d: path()` morph and the core's `filter: hue-rotate()`
 * are both gone -- every property this component now animates is `transform` or `opacity`, so any
 * number of concurrently-mounted instances stay cheap (no per-core filters or path morphs).
 * `globals.css`'s `agent-spinner-core-split`/`agent-spinner-core-rotate` keyframes carry the full
 * timeline; see their own comments for the named percentage stops.
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
      {isFull ? <FullMark uid={uid} /> : <SimplifiedMark uid={uid} />}
    </svg>
  )
}

/** The three disc positions, 120deg apart, one pointing straight up (so the rendered triangle
 * matches Stuart's reference screenshot: one disc on top, two along the bottom). Each slot is a
 * static rotation (never animated itself); `.agent-spinner-core-rotator` in `globals.css`
 * animates the whole triangle's orientation, and `.agent-spinner-core-disc-group` animates each
 * disc's own distance from centre and size -- see `AgentSpinnerCore` below. */
const CORE_SLOT_ANGLES_DEG = [0, 120, 240] as const

/** The merge/split/rotate core (issue #612, design revision above): shared by both the Full and
 * Simplified variants -- same geometry, same sequence, at every size (Stuart: "both size variants
 * ... must show the same split/rotate/reverse/merge sequence"). Each of the three slots renders a
 * soft radial-gradient halo plus a solid disc on top, both children of one `transform`-only
 * animated group, so a single loop drives translateY (distance from centre) and scale (disc size)
 * together: at distance 0 / scale 1 the three discs sit exactly on top of each other and read as
 * one solid circle (the rest frame and the `prefers-reduced-motion` frame); split moves them
 * outward while shrinking them (area roughly conserved, `scale(0.577)` approx `1/sqrt(3)`), so the
 * combined-at-rest circle and the three split discs read as "the same amount of light,
 * rearranged" rather than one shrinking into nothing.
 *
 * The halo is a deliberate, Stuart-specified exception to the Simplified variant's otherwise
 * gradient-free rule (its reference screenshot explicitly wants a soft glow at every size); the
 * Full variant additionally blurs its halo (`blurred`) for a softer edge, the one treatment that
 * stays Full-only, matching Stuart's "no blur filter on the small variant". */
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
                r="90"
                fill={`url(#${haloGradientId})`}
                style={blurred ? { filter: `url(#${haloBlurId})` } : undefined}
              />
              <circle className="agent-spinner-core-disc" r="46" fill="var(--agent-spinner-core)" />
            </g>
          </g>
        ))}
      </g>
    </>
  )
}

/** The Full variant (32px, 48px): layered glow rings (gradients, a blur filter, a luminance mask
 * fading the outer edge, `mix-blend-mode: screen`), the split/rotate/merge core above with a
 * blurred halo, and the bright orbiting arc-and-dot cue (deviation 1). Every id below is
 * namespaced with the instance's own `uid` so any number of mounted instances never collide. */
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
      <AgentSpinnerCore uid={uid} blurred />
      {/* The visible orbiting cue (deviation 1): a bright arc with a brighter leading dot,
       * rotating a full turn every loop at constant (linear) speed -- deliberately not the eased
       * curve the rest of this component uses, because constant angular velocity reads as
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

/** The Simplified variant (16px, 20px, 24px): flat ring and orbit (no gradients, filters, masks
 * or `mix-blend-mode`), but the SAME split/rotate/merge core as `FullMark` -- including its
 * gradient halo (the one deliberate exception, see `AgentSpinnerCore`'s own comment) -- just
 * without the blur filter, matching Stuart's "no blur filter on the small variant". Animates only
 * `transform` and `opacity`, so any number of concurrently mounted instances stay cheap (issue
 * #612 step 2e). */
function SimplifiedMark({ uid }: { uid: string }) {
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
      <AgentSpinnerCore uid={uid} blurred={false} />
      {/* One bright dot, no arc (fewer shapes than FullMark's rotator, per issue #612 step 2e) --
       * still a full, constant-speed rotation every loop, so the visible-spin cue survives at
       * every Simplified size. */}
      <g className="agent-spinner-rotator agent-spinner-rotator-simple">
        <circle cx="0" cy="-88" r="9" fill="var(--agent-spinner-orbit)" />
      </g>
    </>
  )
}
