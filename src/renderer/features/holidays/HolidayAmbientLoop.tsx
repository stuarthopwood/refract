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
  const containerRef = useRef<HTMLDivElement>(null)

  const active = holidayTouches === 'full' && holiday !== null && HOLIDAY_CONTENT[holiday].hasAmbientLoop

  useEffect(() => {
    if (!active) return
    // Re-checked here (not just the lazy initializer above): this effect re-runs whenever
    // `idleTimeoutMs` changes (a debug-only override arriving after the first mount), and the
    // real hidden/unfocused state could have changed in between.
    setPaused(document.hidden || !document.hasFocus())
    // Gate round 2 fix (Medium, item 5): a modal dialog/alert-dialog/sheet steals the user's
    // attention the same way a hidden/unfocused window does -- `:not([data-closed])` excludes
    // one mid-exit-animation (Radix keeps the Content mounted with `data-closed` for its own
    // `animate-out`, about to unmount), so this never re-pauses on a dialog that is already on
    // its way out.
    function isDialogOpen() {
      return !!document.querySelector(
        '[role="dialog"]:not([data-closed]), [role="alertdialog"]:not([data-closed]), [data-slot="sheet-content"]:not([data-closed])'
      )
    }
    function schedulePause() {
      window.clearTimeout(idleTimerRef.current)
      idleTimerRef.current = window.setTimeout(() => setPaused(true), idleTimeoutMs)
    }
    // Gate round 2 fix (Medium, item 4): an unfocused window under the cursor (another app on
    // top, or this window merely hovered without being the active one) must not restart the
    // loop -- `pointermove`/`wheel` fire on an unfocused-but-visible window just from the OS
    // routing hover/scroll to whatever is under the cursor, which is not "the user is reading
    // this window". `isDialogOpen()` gates it the same way: any input while a modal is open
    // targets the modal, never this ambient background.
    function handleActivity() {
      if (document.hidden || !document.hasFocus() || isDialogOpen()) return
      setPaused(false)
      schedulePause()
    }
    // Gate round 2 fix (Medium, item 4): `pointermove` fires dozens of times a second while the
    // cursor is merely resting and twitching over the window -- every one of those used to
    // reschedule the idle timer (`clearTimeout`+`setTimeout`, a real timer churn cost for no
    // behavioural benefit over one reschedule a second), so this throttles it to about 1/s; the
    // leading call still runs immediately (first movement in a quiet window still counts right
    // away), only the CHATTER during continuous movement is dropped.
    let lastPointerMoveAt = 0
    function handlePointerMove() {
      const now = Date.now()
      if (now - lastPointerMoveAt < 1000) return
      lastPointerMoveAt = now
      handleActivity()
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
    function handleDialogMutation() {
      if (isDialogOpen()) {
        setPaused(true)
        window.clearTimeout(idleTimerRef.current)
      }
    }
    schedulePause()
    handleDialogMutation()
    window.addEventListener('pointerdown', handleActivity)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('keydown', handleActivity)
    window.addEventListener('wheel', handleActivity, { passive: true })
    window.addEventListener('blur', handleBlur)
    window.addEventListener('focus', handleActivity)
    document.addEventListener('visibilitychange', handleVisibility)
    const dialogObserver = new MutationObserver(handleDialogMutation)
    // Gate round 2 fix (High, item 2 regression found during the budget rerun): `subtree: true`
    // + `attributes: true` reacted to EVERY DOM mutation anywhere in the whole app (session
    // list updates, timestamp ticks, transcript churn), not just a dialog opening -- that
    // observer callback cost alone measured 0.156s/60s above Artwork-only while genuinely idle
    // (budget 0.1s/60s), once the flights fallback had already brought the ACTIVE cost to
    // near-zero. Radix's `Dialog.Portal`/`AlertDialog.Portal`/`Sheet.Portal` all default to
    // `document.body` as their container, so a dialog opening or finally unmounting is a
    // `childList` change on body's own DIRECT children -- `childList: true` alone (no
    // `subtree`, no `attributes`) catches both without reacting to anything else in the app.
    dialogObserver.observe(document.body, { childList: true })
    return () => {
      window.clearTimeout(idleTimerRef.current)
      window.removeEventListener('pointerdown', handleActivity)
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('keydown', handleActivity)
      window.removeEventListener('wheel', handleActivity)
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener('focus', handleActivity)
      document.removeEventListener('visibilitychange', handleVisibility)
      dialogObserver.disconnect()
    }
  }, [active, idleTimeoutMs])

  // Gate round 2 fix (High, item 1 fallback): stepped CSS timing alone (26s cycle, `steps(26)`)
  // still measured about 3.2s of CPU per 60s above Artwork-only in the live budget check (budget
  // 1.0s/60s) -- three elements animating continuously for the whole window, even at ~4 ticks/s,
  // still adds up. Switched to occasional flights instead: the bats sit STATIC (no CSS animation
  // at all, see `globals.css`) almost all the time, and one randomly-chosen bat flies for about
  // 7s via a single `Element.animate()` call every 60-120s (randomised) -- `document
  // .getAnimations()` is empty between flights (no `.persist()` call, so the browser
  // auto-removes the finished Animation), and `will-change: transform` is set only for that
  // one flight's own duration, never ambiently. Gated on `!paused` (the SAME state the
  // pause-rule effect above already computes for hidden/unfocused/idle/dialog-open) and on
  // `prefers-reduced-motion` directly -- a hidden `display:none` ancestor does not stop a
  // running Web Animations API animation from consuming CPU in the background, so this must
  // check the media query itself, not rely on the CSS layer merely being invisible.
  useEffect(() => {
    if (!active || paused) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let cancelled = false
    let flightTimer: number | undefined
    let currentAnimation: Animation | undefined

    function scheduleNextFlight() {
      const delayMs = 60_000 + Math.random() * 60_000
      flightTimer = window.setTimeout(runFlight, delayMs)
    }

    function runFlight() {
      const bats = containerRef.current?.querySelectorAll<HTMLElement>('.holiday-ambient-loop-bat')
      if (!bats || bats.length === 0) {
        scheduleNextFlight()
        return
      }
      const bat = bats[Math.floor(Math.random() * bats.length)]
      if (!bat) {
        scheduleNextFlight()
        return
      }
      bat.style.willChange = 'transform'
      const animation = bat.animate(
        [{ transform: 'translate(0px, 0px)' }, { transform: 'translate(60px, -24px)', offset: 0.5 }, { transform: 'translate(120px, 6px)' }],
        { duration: 7_000, easing: 'ease-in-out', fill: 'none' }
      )
      currentAnimation = animation
      animation.onfinish = () => {
        bat.style.willChange = ''
        currentAnimation = undefined
        if (!cancelled) scheduleNextFlight()
      }
      animation.oncancel = () => {
        bat.style.willChange = ''
        currentAnimation = undefined
      }
    }

    scheduleNextFlight()
    return () => {
      cancelled = true
      window.clearTimeout(flightTimer)
      currentAnimation?.cancel()
    }
  }, [active, paused])

  if (!active || !holiday) return null

  return (
    <div aria-hidden ref={containerRef} className={cn('holiday-ambient-loop -z-10', `holiday-ambient-loop--${holiday}`)} data-paused={paused || undefined}>
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
 * control, `ChevronsDownUpIcon`). Gate round 2 fix (Medium, item 8): that redraw still read as
 * too squat/boxy at this size (32x20, a 1.6x span-to-height ratio) -- widened to 48x16 (a flat
 * 3x ratio, the "span at least 3x height, 40-48px" the ui-architect review asked for) with a
 * longer, more pronounced scalloped (3-finger) trailing edge on each wing, a round head with two
 * pointed ears, and a small oval body; reused three times with only its CSS position/timing
 * varied (`:nth-child` in `globals.css`). */
function BatSilhouette() {
  return (
    <svg className="holiday-ambient-loop-bat" width="48" height="16" viewBox="0 0 48 16" fill="currentColor" focusable={false}>
      <path d="M22 6 L2 2 L6 5 L3 7 L9 8 L5 11 L12 10 L10 9 Z" />
      <path d="M26 6 L46 2 L42 5 L45 7 L39 8 L43 11 L36 10 L38 9 Z" />
      <path d="M21.3 2 L22 0 L22.7 2 Z" />
      <path d="M25.3 2 L26 0 L26.7 2 Z" />
      <circle cx="24" cy="4" r="2.3" />
      <ellipse cx="24" cy="9" rx="1.8" ry="3.2" />
    </svg>
  )
}
