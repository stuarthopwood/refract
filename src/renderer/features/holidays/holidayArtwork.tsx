// Issue #1048 (slice 2): the ambient-loop pieces and their one-off flights for Bonfire Night
// (sparks), Christmas (snow) and New Year (confetti). Plain inline SVG in `currentColor`, styled
// by the same `.holiday-ambient-loop-bat` rule Halloween's bats use (theme token, per-theme
// artwork opacity), so no new colour exists. Each piece sits still until `HolidayAmbientLoop`
// flies one for 4s every 90-180s via a single `Element.animate()` call.
import type { ReactNode } from 'react'
import type { HolidayId } from '../../../shared/holidays'

type LoopHolidayId = 'halloween' | 'bonfire-night' | 'christmas' | 'new-year'

const FLIGHTS: Record<LoopHolidayId, Keyframe[]> = {
  halloween: [
    { transform: 'translate(0px, 0px)', offset: 0 },
    { transform: 'translate(60px, -24px)', offset: 0.33 },
    { transform: 'translate(120px, 6px)', offset: 0.5 },
    { transform: 'translate(60px, -10px)', offset: 0.75 },
    { transform: 'translate(0px, 0px)', offset: 1 }
  ],
  // A spark rises and returns.
  'bonfire-night': [
    { transform: 'translate(0px, 0px)', offset: 0 },
    { transform: 'translate(10px, -50px)', offset: 0.5 },
    { transform: 'translate(-6px, -90px)', offset: 0.75 },
    { transform: 'translate(0px, 0px)', offset: 1 }
  ],
  // A flake drifts down and returns.
  christmas: [
    { transform: 'translate(0px, 0px)', offset: 0 },
    { transform: 'translate(14px, 50px)', offset: 0.35 },
    { transform: 'translate(-10px, 90px)', offset: 0.6 },
    { transform: 'translate(0px, 0px)', offset: 1 }
  ],
  // A piece of confetti tumbles sideways and returns.
  'new-year': [
    { transform: 'translate(0px, 0px) rotate(0deg)', offset: 0 },
    { transform: 'translate(40px, 24px) rotate(120deg)', offset: 0.4 },
    { transform: 'translate(80px, 10px) rotate(240deg)', offset: 0.7 },
    { transform: 'translate(0px, 0px) rotate(360deg)', offset: 1 }
  ]
}

export function flightKeyframes(holiday: HolidayId): Keyframe[] | null {
  return holiday in FLIGHTS ? FLIGHTS[holiday as LoopHolidayId] : null
}

const TRANSLATE_RE = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/

/** Clamps each frame's translation so the piece (at rest in `piece`) stays fully inside `bounds`; flight paths are fixed offsets, so a piece near an edge would otherwise clip (#1377). */
export function clampFlightToBounds(keyframes: Keyframe[], piece: DOMRect, bounds: DOMRect): Keyframe[] {
  const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max))
  return keyframes.map((frame) => {
    if (typeof frame.transform !== 'string') return frame
    return {
      ...frame,
      transform: frame.transform.replace(TRANSLATE_RE, (_m, x: string, y: string) => {
        const cx = clamp(Number(x), bounds.left - piece.left, bounds.right - piece.right)
        const cy = clamp(Number(y), bounds.top - piece.top, bounds.bottom - piece.bottom)
        return `translate(${cx}px, ${cy}px)`
      })
    }
  })
}

function Spark() {
  return (
    <svg className="holiday-ambient-loop-bat" width="20" height="20" viewBox="0 0 20 20" fill="currentColor" focusable={false}>
      <path d="M10 0 L12 8 L20 10 L12 12 L10 20 L8 12 L0 10 L8 8 Z" />
    </svg>
  )
}

function Snowflake() {
  return (
    <svg
      className="holiday-ambient-loop-bat"
      width="22"
      height="22"
      viewBox="0 0 22 22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      focusable={false}
    >
      <path d="M11 2 V20 M3.2 6.5 L18.8 15.5 M18.8 6.5 L3.2 15.5 M8.5 3.5 L11 6 L13.5 3.5 M8.5 18.5 L11 16 L13.5 18.5" />
    </svg>
  )
}

function Confetti() {
  return (
    <svg className="holiday-ambient-loop-bat" width="20" height="20" viewBox="0 0 20 20" fill="currentColor" focusable={false}>
      <rect x="3" y="7" width="14" height="6" rx="1" />
    </svg>
  )
}

const PIECE: Partial<Record<HolidayId, () => ReactNode>> = {
  'bonfire-night': () => <Spark />,
  christmas: () => <Snowflake />,
  'new-year': () => <Confetti />
}

/** Three wrappers placed by the `:nth-child` rules in `globals.css`; `null` when the holiday's
 * loop pieces are the bats (drawn in `HolidayAmbientLoop.tsx`) or it has no loop. */
export function LoopPieces({ holiday }: { holiday: HolidayId }) {
  const piece = PIECE[holiday]
  if (!piece) return null
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} className="holiday-ambient-loop-bat-wrap">
          {piece()}
        </div>
      ))}
    </>
  )
}
