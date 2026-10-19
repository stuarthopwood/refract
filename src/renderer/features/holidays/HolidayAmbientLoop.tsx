// Issue #1048 (Holiday touches, "Ambient loops (Full only)"): the decorative motion layer
// painted behind a ChatPane's normal-flow content, in the exact same spot `BrandWatermark.tsx`'s
// own 'live' variant mounts (`isolate` ancestor) -- this component's own root carries `-z-10`
// itself (gate round 1 fix, High: the root used to rely on the CSS class alone, which set no
// z-index at all, so the layer could paint ON TOP of later-painted siblings depending on DOM
// order even though `pointer-events: none` already made it un-clickable) so it genuinely paints
// BEHIND text and controls, the same `-z-10` BrandWatermark.tsx's own 'live' variant carries.
// Renders null for every holiday the issue's own "Ambient loops" section does not name an effect
// for (Star Wars Day, Pi Day), for `holidayTouches !== 'full'` (Artwork only/Off), and for every
// holiday whose own effect is not yet built (`HolidayContent.hasAmbientLoop`) -- today only
// Halloween's (Bonfire Night, Christmas, New Year are tracked as this issue's own follow-up,
// PLAN.md), independent of `shared/holidays.ts::VERIFIED_HOLIDAYS` gating whether the holiday
// shows at all.
//
// Pause rules (decision 3, WCAG 2.2.2): hidden/unfocused window and no-input idle are both
// JS-driven (`data-paused`, frozen via `animation-play-state` in `globals.css`) since neither
// condition is expressible in plain CSS; OS reduced motion and Windows forced-colors are both
// plain `@media` rules in that same CSS (no JS needed, and they fire even before this effect's
// first tick). Gate round 1 fix (Medium): `paused`'s initial value is computed from the REAL
// `document.hidden`/`document.hasFocus()` state, both at the lazy initializer and again at the
// top of the effect -- a mount that happens to land on an already-hidden/unfocused window must
// start paused, not wait for the next blur/visibilitychange event to notice. Gate round 1 fix
// (Low): `wheel` and `pointermove` also count as activity (a reader scrolling with no clicks or
// keystrokes must not be treated as idle).
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useHolidayStore, useSettingsStore } from '@/state'
import { HOLIDAY_CONTENT } from './holidayContent'

export function HolidayAmbientLoop() {
  const holidayTouches = useSettingsStore((s) => s.settings.holidayTouches)
  const holiday = useHolidayStore((s) => s.activeHoliday)
  const idleTimeoutMs = useHolidayStore((s) => s.idleTimeoutMs)
  const [paused, setPaused] = useState(() => document.hidden || !document.hasFocus())
  const idleTimerRef = useRef<number | undefined>(undefined)

  const active = holidayTouches === 'full' && holiday !== null && HOLIDAY_CONTENT[holiday].hasAmbientLoop

  useEffect(() => {
    if (!active) return
    // Re-checked here (not just the lazy initializer above): this effect re-runs whenever
    // `idleTimeoutMs` changes (a debug-only override arriving after the first mount), and the
    // real hidden/unfocused state could have changed in between.
    setPaused(document.hidden || !document.hasFocus())
    function schedulePause() {
      window.clearTimeout(idleTimerRef.current)
      idleTimerRef.current = window.setTimeout(() => setPaused(true), idleTimeoutMs)
    }
    function handleActivity() {
      if (document.hidden) return
      setPaused(false)
      schedulePause()
    }
    function handleVisibility() {
      if (document.hidden) {
        setPaused(true)
        window.clearTimeout(idleTimerRef.current)
      } else {
        handleActivity()
      }
    }
    function handleBlur() {
      setPaused(true)
      window.clearTimeout(idleTimerRef.current)
    }
    schedulePause()
    window.addEventListener('pointerdown', handleActivity)
    window.addEventListener('pointermove', handleActivity)
    window.addEventListener('keydown', handleActivity)
    window.addEventListener('wheel', handleActivity, { passive: true })
    window.addEventListener('blur', handleBlur)
    window.addEventListener('focus', handleActivity)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.clearTimeout(idleTimerRef.current)
      window.removeEventListener('pointerdown', handleActivity)
      window.removeEventListener('pointermove', handleActivity)
      window.removeEventListener('keydown', handleActivity)
      window.removeEventListener('wheel', handleActivity)
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener('focus', handleActivity)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [active, idleTimeoutMs])

  if (!active || !holiday) return null

  return (
    <div aria-hidden className={cn('holiday-ambient-loop -z-10', `holiday-ambient-loop--${holiday}`)} data-paused={paused || undefined}>
      {holiday === 'halloween' && (
        <>
          <BatSilhouette />
          <BatSilhouette />
          <BatSilhouette />
        </>
      )}
    </div>
  )
}

/** One drifting bat (Halloween, "pick the calmer one" -- gentle drift, never a flicker). Plain
 * hand-drawn shapes, not a lucide icon: lucide has no bat glyph. Gate round 1 fix (Medium): the
 * original single-path silhouette read as a pair of chevrons (the sidebar's own collapse-all
 * control, `ChevronsDownUpIcon`); redrawn as a round head with two pointed ears and two
 * scalloped (3-finger) wings either side of a small oval body, reused three times with only its
 * CSS position/timing varied (`:nth-child` in `globals.css`). */
function BatSilhouette() {
  return (
    <svg className="holiday-ambient-loop-bat" width="32" height="20" viewBox="0 0 32 20" fill="currentColor" focusable={false}>
      <path d="M14 9 L5 4 L8 9 L2 9 L6 12 L1 15 L8 13 L11 15 L12 12 Z" />
      <path d="M18 9 L27 4 L24 9 L30 9 L26 12 L31 15 L24 13 L21 15 L20 12 Z" />
      <path d="M13 4 L14 1 L15 4 Z" />
      <path d="M17 4 L18 1 L19 4 Z" />
      <circle cx="16" cy="6" r="3" />
      <ellipse cx="16" cy="11" rx="2.5" ry="4" />
    </svg>
  )
}
