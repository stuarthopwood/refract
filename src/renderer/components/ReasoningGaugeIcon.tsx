// Issue #924: a gauge icon whose needle moves with the reasoning level, replacing the fixed
// lucide `GaugeIcon` the composer's Reasoning picker (`ComposerPickers.tsx`) and the Session
// details card (`SessionDetailsCard.tsx`) both used to show unconditionally. The arc path below
// (`M3.34 19a10 10 0 1 1 17.32 0`) is lucide-react's own `gauge` icon geometry verbatim (a 240deg
// major arc, radius 10, centred at (12, 14)) -- only the needle is redrawn, so the glyph still
// reads as "the lucide gauge icon" at a glance, matching `docs/design/foundations-icons.md`'s
// "use lucide's stroke style" rule (#924's own decision) without a second, unrelated face shape.
//
// The needle sweeps evenly across the arc's own two endpoints: `off` points at the arc's left
// tip (150deg), `max` at its right tip (390deg, i.e. 30deg mod 360 -- past a full turn, since the
// arc's own major-arc geometry spans 240deg from 150deg), `medium` sits exactly upright (270deg,
// straight up) as the issue's own decision requires, and the remaining four levels fall at even
// 40deg steps between. `inherit` has no step of its own -- issue #924's own decision is to draw
// it "at the resolved level omp reports", but no field exists, separate from
// `Session.lastThinkingLevel` itself, to read that resolved level independently. Gate round 1
// fix (M3, Decided, Skippy, delegated by Stuart 2026-10-18, posted on #924): a prior draft of
// this comment claimed OMP always resolves `inherit` to a real level before echoing it back, so
// this component would never actually see the literal string -- WRONG, confirmed against
// `thinking_level.rs:138,152`: Refract's own Rust code explicitly stores the literal string
// `"inherit"` into `last_thinking_level` whenever a Default request succeeds with no echoed
// level back from OMP. So this component genuinely can, and does, receive the literal string
// `'inherit'` -- it draws centred not because that case is rare, but because `'inherit'` is
// simply absent from `LEVELS` below (the 7 NAMED levels only), so it falls through the same
// "unrecognised level" branch any other unknown string would, landing on `MEDIUM_INDEX`. A
// `null`/`undefined` level (no model or level known yet, "Reasoning not reported") takes the
// identical fallback.
//
// Decorative in every case (`aria-hidden`, `docs/design/foundations-icons.md` "Metadata
// iconography" -- the level itself is already in the trigger's visible/accessible text in both
// callers): no colour change, matching the issue's own Accessibility section. `data-slot=
// "reasoning-gauge"` is a stable structural hook (`ReadoutChip.tsx`'s own established pattern)
// for `scripts/verify-925-924-polish.mjs` to find this icon by, in both callers, never by the
// shared `viewBox="0 0 24 24"` alone (ambiguous against any other SVG the same size).
import type { ThinkingLevel } from '../../shared/ipc-model'
import { THINKING_LEVELS } from '@/lib/modelDisplay'

// Gate round 1 fix (M2): derived from the SAME `THINKING_LEVELS` the Reasoning picker's own menu
// lists (`modelDisplay.ts`), minus `inherit` (which has no step of its own, see above) -- a
// second hand-maintained copy of this list could silently drift from the picker's real menu.
const LEVELS: readonly ThinkingLevel[] = THINKING_LEVELS.filter((lvl): lvl is Exclude<ThinkingLevel, 'inherit'> => lvl !== 'inherit')
const ARC_START_DEG = 150
const ARC_SWEEP_DEG = 240
const CENTER_X = 12
const CENTER_Y = 14
// Matches lucide's own needle length (`m12 14 4-4`, a 4-by-4 offset from the centre): `Math.hypot(4, 4)`.
const NEEDLE_LENGTH = Math.hypot(4, 4)
// `medium` is the 4th of 7 steps (index 3) -- the centre of the run, and this component's own
// fallback angle for `inherit` and any unrecognised/missing level.
const MEDIUM_INDEX = LEVELS.indexOf('medium')

// `level` is a loose `string` (not the narrower `ThinkingLevel` union): `Session.lastThinkingLevel`
// itself is typed that way throughout the codebase (`model.ts`, matching `THINKING_LEVEL_LABEL`'s
// own `Record<string, string>` in `modelDisplay.ts`) precisely because OMP's `get_state` is never
// validated against the closed set on the way IN -- an unrecognised future value must still
// render (centred here) rather than throw or disappear.
function needleAngleDeg(level: string | null | undefined): number {
  const index = level ? (LEVELS as readonly string[]).indexOf(level) : -1
  const stepIndex = index === -1 ? MEDIUM_INDEX : index
  return ARC_START_DEG + (stepIndex * ARC_SWEEP_DEG) / (LEVELS.length - 1)
}

export function ReasoningGaugeIcon({ level, className }: { level?: string | null; className?: string }) {
  const angleRad = (needleAngleDeg(level) * Math.PI) / 180
  const needleX = CENTER_X + NEEDLE_LENGTH * Math.cos(angleRad)
  const needleY = CENTER_Y + NEEDLE_LENGTH * Math.sin(angleRad)
  return (
    <svg
      aria-hidden
      data-slot="reasoning-gauge"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={`M${CENTER_X} ${CENTER_Y}L${needleX.toFixed(2)} ${needleY.toFixed(2)}`} />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </svg>
  )
}
