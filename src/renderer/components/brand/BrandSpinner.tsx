import { useState } from 'react'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

/** Below this size (px) the Full, faceted mark is illegible; the Simplified path set renders
 * instead (research.md decisions 2, 4; data-model.md "Render variant selection"). */
export const LEGIBILITY_FLOOR_PX = 24

export interface BrandSpinnerProps {
  /** Pixel size: the fixed ladder 16, 20, 24, 32, 48 -- a closed union, not an arbitrary number,
   * because each rung below `LEGIBILITY_FLOOR_PX` has its own dedicated, hand-authored path set
   * (research.md decision 4), not one set of paths merely rescaled. 16px and 20px render the
   * Simplified variant; 24px, 32px, and 48px render the Full variant (FR-011). */
  size: 16 | 20 | 24 | 32 | 48
  /** Merged with the component's own classes -- layout utilities only (for example `shrink-0`);
   * colour is always the fixed brand palette (research.md decision 7) and is never overridable
   * through this prop. */
  className?: string
}

/** The shared viewBox for both variants: the prerequisite `refract-hero.svg`'s own tightened
 * `96 122 320 320` box, already centred on the source mark's visual centroid (research.md
 * decision 13), so the rendered output's vertical centre lines up with adjacent text (FR-015)
 * without a separate positioning correction. The Simplified hulls below are designed against
 * this same box so both variants share one coordinate frame. */
const VIEW_BOX = '96 122 320 320'

/** The brand mark, animating, used for `StateIcon`'s `working` case (spec 011 FR-001, FR-002):
 * one fixed core and three arms (teal, amber, violet) that take turns brightening in a per-arm
 * `opacity` cascade -- never a physical lift, `filter`, or `box-shadow` (FR-005), and never a
 * rotation of the whole asymmetric mark. Always decorative (`aria-hidden`, no accessible name of
 * its own, FR-009): the "working" state is carried entirely by each call site's existing
 * `sr-only` `STATUS_LABEL` text. Colours are the mark's own fixed brand hex values (FR-010),
 * never theme-derived, except under Windows' forced-colors mode (globals.css, FR-014).
 *
 * Every mounted instance computes its own `animation-delay` once, at mount, as a negative offset
 * into the shared 1.2s cycle (`-(Date.now() % 1200)ms`, research.md decision 5): pure CSS from
 * then on, so any number of concurrently-mounted instances land on the same point in the cycle as
 * every other (FR-007, FR-013) with no running timer and no per-frame React work. */
export function BrandSpinner({ size, className }: BrandSpinnerProps) {
  // Computed once per instance via the lazy initializer -- not an effect, not a listener, and
  // never recomputed on re-render (data-model.md "Animation": "no React state of any kind" beyond
  // this one mount-time value).
  const [delay] = useState(() => `-${Date.now() % 1200}ms`)
  const isFull = size >= LEGIBILITY_FLOOR_PX
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox={VIEW_BOX}
      className={cn('brand-spinner', className)}
      style={{ '--brand-spinner-delay': delay } as CSSProperties}
    >
      {isFull ? <FullMark /> : <SimplifiedMark />}
    </svg>
  )
}

/** The Full, faceted variant (24px, 32px, 48px): every facet from the prerequisite source mark
 * (`build/refract-icon-v2.svg` / `src/renderer/assets/brand/refract-hero.svg`), unchanged, just
 * regrouped into the three arms plus the one fixed core (data-model.md). The eleven core facets
 * below are the source mark's own internal shading on the central block -- including the two
 * teal-toned and two amber-toned reflections -- all of which sit on the fixed core, not on either
 * arm, and so never animate. */
function FullMark() {
  return (
    <>
      <g className="brand-spinner-arm-1">
        <path d="M101.5 156.5 L137.5 136 L210.5 178 L174.5 198.5 Z" fill="#3EAC9E" />
        <path d="M101.5 156.5 L101.5 198.5 L174.5 241 L174.5 198.5 Z" fill="#1C8F8F" />
        <path d="M174.5 198.5 L210.5 178 L210.5 219.5 L174.5 241 Z" fill="#199D95" />
      </g>
      <g className="brand-spinner-arm-2">
        <path d="M301.5 178 L374.5 136 L410.5 156.5 L337.5 198.5 Z" fill="#F8A740" />
        <path d="M337.5 198.5 L410.5 156.5 L410.5 198.5 L337.5 241 Z" fill="#D9811C" />
        <path d="M301.5 178 L337.5 198.5 L337.5 241 L301.5 219.5 Z" fill="#ECA231" />
      </g>
      <g className="brand-spinner-arm-3">
        <path d="M213.5 319.5 L256 295 L298.5 319.5 L256 344 Z" fill="#A877E0" />
        <path d="M213.5 319.5 L256 344 L256 429 L213.5 404 Z" fill="#7544C9" />
        <path d="M256 344 L298.5 319.5 L298.5 404 L256 429 Z" fill="#4B278A" />
      </g>
      <g className="brand-spinner-core">
        <path d="M195 219 L256 183.5 L317 219 L256 254.5 Z" fill="#7844CD" />
        <path d="M195 219 L256 254.5 L256 325.5 L195 290 Z" fill="#52208E" />
        <path d="M256 254.5 L317 219 L317 290 L256 325.5 Z" fill="#52208E" />
        <path d="M195 219 L256 254.5 L225.5 237 Z" fill="#8041B5" />
        <path d="M195 254.5 L225.5 237 L225.5 272 L195 290 Z" fill="#4D1F8E" />
        <path d="M195 254.5 L195 219 L225.5 237 Z" fill="#45187A" />
        <path d="M195 290 L225.5 272 L256 325.5 Z" fill="#32AC9E" />
        <path d="M256 254.5 L286.5 237 L286.5 272 L256 325.5 Z" fill="#32AC9E" />
        <path d="M317 219 L286.5 237 L286.5 272 L317 290 Z" fill="#F09B29" />
        <path d="M256 325.5 L286.5 272 L317 290 Z" fill="#492484" />
        <path d="M256 254.5 L317 219 L286.5 237 Z" fill="#864DD6" />
      </g>
    </>
  )
}

/** The Simplified variant (16px, 20px): a separate, dedicated, hand-authored path set -- flat,
 * single-tone colour per arm, no internal facet subdivision (research.md decision 2) -- not the
 * Full variant's paths reused with facets hidden by a flag. Each hull below is the Full variant's
 * own arm/core silhouette (its convex outer boundary), scaled toward its own centre and nudged
 * further from the shared mark centre, so the gaps between arms and the core read as genuinely
 * widened relative to the Full mark, where every arm touches the core with no gap at all. */
function SimplifiedMark() {
  return (
    <>
      <path
        className="brand-spinner-arm-1"
        d="M103.5 153.5 L130.5 138.1 L185.2 169.6 L185.2 200.7 L158.2 216.9 L103.5 185 Z"
        fill="#199D95"
      />
      <path
        className="brand-spinner-arm-2"
        d="M326.8 169.6 L381.5 138.1 L408.5 153.5 L408.5 185 L353.8 216.9 L326.8 200.7 Z"
        fill="#ECA231"
      />
      <path
        className="brand-spinner-arm-3"
        d="M256 327.7 L287.9 346.1 L287.9 409.5 L256 428.2 L224.1 409.5 L224.1 346.1 Z"
        fill="#7544C9"
      />
      <path
        className="brand-spinner-core"
        d="M256 196.3 L306 225.4 L306 283.6 L256 312.7 L206 283.6 L206 225.4 Z"
        fill="#52208E"
      />
    </>
  )
}
