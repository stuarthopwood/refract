// Issue #1048 (Holiday touches, "Ambient loops (Full only)"): the decorative motion layer
// painted behind a ChatPane's normal-flow content, in the exact same spot `BrandWatermark.tsx`'s
// own 'live' variant mounts (`-z-10`, `isolate` ancestor) -- see that file's header comment for
// why painting BEHIND content is what makes "never over text or controls" and "never under the
// composer's input area" true by construction, with no extra z-index/pointer-events bookkeeping
// here. Renders null for every holiday the issue's own "Ambient loops" section does not name an
// effect for (Star Wars Day, Pi Day -- `HolidayContent.hasAmbientLoop`), for `holidayTouches !==
// 'full'` (Artwork only/Off), and once a Halloween-only effect set shrinks to "only Halloween
// has one" for now (the other three loop-eligible holidays -- Bonfire Night, Christmas, New
// Year -- are tracked as this issue's own follow-up, PLAN.md).
//
// Pause rules (decision 3, WCAG 2.2.2): hidden/unfocused window and 60s no-input idle are both
// JS-driven (`data-paused`, frozen via `animation-play-state` in `globals.css`) since neither
// condition is expressible in plain CSS; OS reduced motion and Windows forced-colors are both
// plain `@media` rules in that same CSS (no JS needed, and they fire even before this effect's
// first tick).
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useHolidayStore, useSettingsStore } from '@/state'
import { HOLIDAY_CONTENT } from './holidayContent'

export function HolidayAmbientLoop() {
  const holidayTouches = useSettingsStore((s) => s.settings.holidayTouches)
  const holiday = useHolidayStore((s) => s.activeHoliday)
  const idleTimeoutMs = useHolidayStore((s) => s.idleTimeoutMs)
  const [paused, setPaused] = useState(false)
  const idleTimerRef = useRef<number | undefined>(undefined)

  const active = holidayTouches === 'full' && holiday !== null && HOLIDAY_CONTENT[holiday].hasAmbientLoop

  useEffect(() => {
    if (!active) return
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
    window.addEventListener('keydown', handleActivity)
    window.addEventListener('blur', handleBlur)
    window.addEventListener('focus', handleActivity)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.clearTimeout(idleTimerRef.current)
      window.removeEventListener('pointerdown', handleActivity)
      window.removeEventListener('keydown', handleActivity)
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener('focus', handleActivity)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [active, idleTimeoutMs])

  if (!active || !holiday) return null

  return (
    <div aria-hidden className={cn('holiday-ambient-loop', `holiday-ambient-loop--${holiday}`)} data-paused={paused || undefined}>
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
 * hand-drawn path, not a lucide icon: lucide has no bat glyph, and this one shape is reused
 * three times with only its CSS position/timing varied (`:nth-child` in `globals.css`). */
function BatSilhouette() {
  return (
    <svg className="holiday-ambient-loop-bat" width="28" height="16" viewBox="0 0 28 16" fill="currentColor" focusable={false}>
      <path d="M14 8c-2-4-6-7-14-7 3 3 5 5 6 7-1 2-3 4-6 7 8 0 12-3 14-7Zm0 0c2-4 6-7 14-7-3 3-5 5-6 7 1 2 3 4 6 7-8 0-12-3-14-7Z" />
    </svg>
  )
}
