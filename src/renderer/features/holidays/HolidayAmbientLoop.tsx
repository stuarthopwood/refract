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
// Gate round 3 fix (High, item 2, FR-008 regression): mounted exactly ONCE per window, but
// SCOPED to its own pane's transcript container (`ChatPane.tsx`'s `showAmbientLoop` prop, true
// only for `paneIndex === 0`), never spanning the whole chat panel -- round 2's App.tsx-level
// hoist fixed "one instance, not one per ChatPane" but accidentally let the layer paint UNDER
// the composer too (the composer is a separate sibling only within a `ChatPane`, not within the
// outer panel round 2 hoisted into). `EmptyChatState.tsx` (no session open at all, no composer
// in that branch) keeps its own separate mount.
//
// Pause rules (decision 3, WCAG 2.2.2): hidden/unfocused window, no-input idle, and a modal
// dialog/menu/select open are all JS-driven (`data-paused`) since none is expressible in plain
// CSS; OS reduced motion and Windows forced-colors are both plain `@media` rules in `globals.css`
// for the whole layer, PLUS a live `matchMedia` listener here (gate round 3 fix, Medium, item 5)
// that cancels any in-flight animation -- a `display:none` ancestor does not stop a running Web
// Animations API animation from consuming CPU in the background, so hiding the layer alone is
// not enough. `paused`'s initial value is computed from the REAL `document.hidden`/
// `document.hasFocus()` state, both at the lazy initializer and again at the top of the effect --
// a mount that happens to land on an already-hidden/unfocused window must start paused, not wait
// for the next blur/visibilitychange event to notice. `wheel` and `pointermove` both count as
// activity (gate round 3 fix, Medium, item 6: both throttled to about 1/s, not just
// `pointermove`) -- a reader scrolling with no clicks or keystrokes must not be treated as idle.
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useHolidayStore, useSettingsStore } from '@/state'
import { OVERLAY_OPEN_SELECTOR } from '@/lib/overlayOpenSelector'
import { HOLIDAY_CONTENT } from './holidayContent'

/** Gate round 3 fix (High, item 1): the real flight gap is randomised 60-120s, so a 60s
 * CPU-budget sample almost never contains one -- `REFRACT_HOLIDAY_FLIGHT_INTERVAL_MS` (debug
 * build only, surfaced via `debug.getOverrides().flightIntervalMs`) overrides that gap to a
 * short fixed value so a live check's own sample window reliably contains several. Render-gated
 * by its own callers, the same `showWatermark`-boolean pattern `BrandWatermark.tsx` already
 * uses -- `ChatPane.tsx`'s own `showAmbientLoop` prop (true only for `paneIndex === 0`, gate
 * round 3 fix, High, item 2) and `EmptyChatState.tsx`'s unconditional mount (no composer in
 * that branch, so no pane-scoping question applies there). */
export function HolidayAmbientLoop() {
  const holidayTouches = useSettingsStore((s) => s.settings.holidayTouches)
  const holiday = useHolidayStore((s) => s.activeHoliday)
  const idleTimeoutMs = useHolidayStore((s) => s.idleTimeoutMs)
  const flightIntervalMsOverride = useHolidayStore((s) => s.flightIntervalMs)
  const [paused, setPaused] = useState(() => document.hidden || !document.hasFocus())
  const [motionReducedOrForcedColors, setMotionReducedOrForcedColors] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce), (forced-colors: active)').matches
  )
  const [flightCount, setFlightCount] = useState(0)
  const idleTimerRef = useRef<number | undefined>(undefined)
  const containerRef = useRef<HTMLDivElement>(null)
  const dialogOpenRef = useRef(false)

  const active = holidayTouches === 'full' && holiday !== null && HOLIDAY_CONTENT[holiday].hasAmbientLoop

  // Gate round 3 fix (Medium, item 5): a single reactive `matchMedia` listener -- the emulated
  // media the live check toggles mid-session (`Emulation.setEmulatedMedia`) must cancel an
  // already-running flight immediately, not just block the NEXT one from being scheduled.
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce), (forced-colors: active)')
    function handleChange() {
      setMotionReducedOrForcedColors(media.matches)
    }
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    if (!active) return
    // Re-checked here (not just the lazy initializer above): this effect re-runs whenever
    // `idleTimeoutMs` changes (a debug-only override arriving after the first mount), and the
    // real hidden/unfocused state could have changed in between.
    setPaused(document.hidden || !document.hasFocus())
    // Gate round 3 fix (Medium, item 6): the shared `OVERLAY_OPEN_SELECTOR` (`App.tsx`'s own
    // window-wide keyboard chords already use it to the same end) covers every Radix overlay
    // that steals the user's attention -- dialog, alert-dialog, menu, select-content -- not just
    // a true modal dialog/sheet (Sheet is itself built on the Dialog primitive, so its own
    // `role="dialog"` is already covered). Cached in a ref, refreshed only by the mutation
    // observer below, so `handleActivity` (which can fire many times a second via
    // `pointermove`/`wheel`) never re-queries the DOM itself.
    function updateDialogOpenCache() {
      dialogOpenRef.current = !!document.querySelector(OVERLAY_OPEN_SELECTOR)
    }
    function schedulePause() {
      window.clearTimeout(idleTimerRef.current)
      idleTimerRef.current = window.setTimeout(() => setPaused(true), idleTimeoutMs)
    }
    // An unfocused window under the cursor (another app on top, or this window merely hovered
    // without being the active one) must not restart the loop -- `pointermove`/`wheel` fire on
    // an unfocused-but-visible window just from the OS routing hover/scroll to whatever is under
    // the cursor, which is not "the user is reading this window". The cached overlay-open flag
    // gates it the same way: any input while one is open targets the overlay, never this
    // ambient background.
    function handleActivity() {
      if (document.hidden || !document.hasFocus() || dialogOpenRef.current) return
      setPaused(false)
      schedulePause()
    }
    // `pointermove`/`wheel` both fire dozens of times a second while the cursor is merely
    // resting/twitching or the wheel is spinning -- every one of those used to reschedule the
    // idle timer (`clearTimeout`+`setTimeout`, a real timer churn cost for no behavioural
    // benefit over one reschedule a second), so both throttle to about 1/s; the leading call
    // still runs immediately (first movement/scroll in a quiet window still counts right away),
    // only the CHATTER during continuous movement is dropped.
    let lastPointerMoveAt = 0
    function handlePointerMove() {
      const now = Date.now()
      if (now - lastPointerMoveAt < 1000) return
      lastPointerMoveAt = now
      handleActivity()
    }
    let lastWheelAt = 0
    function handleWheel() {
      const now = Date.now()
      if (now - lastWheelAt < 1000) return
      lastWheelAt = now
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
      updateDialogOpenCache()
      if (dialogOpenRef.current) {
        setPaused(true)
        window.clearTimeout(idleTimerRef.current)
      }
    }
    schedulePause()
    handleDialogMutation()
    window.addEventListener('pointerdown', handleActivity)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('keydown', handleActivity)
    window.addEventListener('wheel', handleWheel, { passive: true })
    window.addEventListener('blur', handleBlur)
    window.addEventListener('focus', handleActivity)
    document.addEventListener('visibilitychange', handleVisibility)
    const dialogObserver = new MutationObserver(handleDialogMutation)
    // Radix's `Dialog.Portal`/`AlertDialog.Portal`/`Sheet.Portal`/`DropdownMenu.Portal`/
    // `Select.Portal` all default to `document.body` as their container, so any of
    // `OVERLAY_OPEN_SELECTOR` opening or finally unmounting is a `childList` change on body's
    // own DIRECT children -- `childList: true` alone (no `subtree`, no `attributes`) catches all
    // of them without reacting to anything else in the app (gate round 2 fix, High: `subtree`
    // + `attributes` measured 0.156s/60s of CPU while genuinely idle, over budget, from reacting
    // to the whole app's own DOM churn).
    dialogObserver.observe(document.body, { childList: true })
    return () => {
      window.clearTimeout(idleTimerRef.current)
      window.removeEventListener('pointerdown', handleActivity)
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('keydown', handleActivity)
      window.removeEventListener('wheel', handleWheel)
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener('focus', handleActivity)
      document.removeEventListener('visibilitychange', handleVisibility)
      dialogObserver.disconnect()
    }
  }, [active, idleTimeoutMs])

  // Gate round 2 fix (High, item 1 fallback): a continuous CSS animation (even `steps()`-timed)
  // measured about 3.2s of CPU per 60s above Artwork-only in the live budget check (budget
  // 1.0s/60s) -- three elements animating for the whole window, however cheaply each tick costs,
  // adds up over a sustained 60s. The bats sit STATIC (no CSS animation at all, see
  // `globals.css`) almost all the time; one randomly-chosen bat flies for about 7s via a single
  // `Element.animate()` call every 60-120s (randomised in production; `flightIntervalMsOverride`
  // replaces that gap with a short fixed value in a debug build only, so a live check's own 60s
  // sample reliably contains several flights to measure). Gate round 3 fix (Medium, item 4): the
  // flight is now a round trip back to `translate(0,0)` -- the round 2 version ended at
  // `translate(120px, 6px)` with `fill: 'none'`, so the bat SNAPPED 120px back to its resting
  // spot the instant the animation finished, a visible pop the component's own "gentle drift,
  // never a flicker" promise forbids. `document.getAnimations()` is empty between flights (no
  // `.persist()` call, so the browser auto-removes the finished Animation), and
  // `will-change: transform` is set only for that one flight's own duration, never ambiently.
  // Gated on `!paused` (the SAME state the pause-rule effect above already computes for
  // hidden/unfocused/idle/dialog-open) and on `motionReducedOrForcedColors` (gate round 3 fix,
  // Medium, item 5: now a REACTIVE media-query listener above, not a one-shot check at mount --
  // a hidden `display:none` ancestor does not stop a running Web Animations API animation from
  // consuming CPU in the background, so toggling the media mid-flight must cancel it, not just
  // block the next one).
  useEffect(() => {
    if (!active || paused || motionReducedOrForcedColors) return
    let cancelled = false
    let flightTimer: number | undefined
    let currentAnimation: Animation | undefined

    function scheduleNextFlight() {
      const delayMs = flightIntervalMsOverride !== null ? flightIntervalMsOverride : 60_000 + Math.random() * 60_000
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
      setFlightCount((count) => count + 1)
      bat.style.willChange = 'transform'
      const animation = bat.animate(
        [
          { transform: 'translate(0px, 0px)', offset: 0 },
          { transform: 'translate(60px, -24px)', offset: 0.33 },
          { transform: 'translate(120px, 6px)', offset: 0.5 },
          { transform: 'translate(60px, -10px)', offset: 0.75 },
          { transform: 'translate(0px, 0px)', offset: 1 }
        ],
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
  }, [active, paused, motionReducedOrForcedColors, flightIntervalMsOverride])

  if (!active || !holiday) return null

  return (
    <div
      aria-hidden
      ref={containerRef}
      className={cn('holiday-ambient-loop -z-10', `holiday-ambient-loop--${holiday}`)}
      data-paused={paused || undefined}
      data-flight-count={flightCount}
    >
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
 * hand-drawn shapes, not a lucide icon: lucide has no bat glyph. Gate round 3 fix (High, item 3,
 * third round on this item): the round 1/2 redraws still read as two arrowheads pointing in at a
 * bar -- each wing narrowed FROM its tip TO the body, the opposite of a real bat wing (widest at
 * the body, tapering to the tip), and the "scallops" were straight `L` segments, not curves. Now
 * curved paths (`ui-architect-v3` review, `agent://Gate1053UI3.VisualReview`): each wing attaches
 * along the body's full height and arches up to a raised tip, with curved scalloped trailing
 * edges; ears raised clear of the head circle so they render at this opacity; 48x16 viewBox (a
 * flat 3x span-to-height ratio, the "span at least 3x height, 40-48px" the review asked for),
 * reused three times with only its CSS position/timing varied (`:nth-child` in `globals.css`). */
function BatSilhouette() {
  return (
    <svg className="holiday-ambient-loop-bat" width="48" height="16" viewBox="0 0 48 16" fill="currentColor" focusable={false}>
      <path d="M22 5 C17 1 9 1 1 4 C4 5 5 7 5 9 C7 7.5 9 7.5 11 9.5 C12.5 8 15 8 17 10.5 C18.5 9 20.5 9.5 22 11 Z" />
      <path d="M26 5 C31 1 39 1 47 4 C44 5 43 7 43 9 C41 7.5 39 7.5 37 9.5 C35.5 8 33 8 31 10.5 C29.5 9 27.5 9.5 26 11 Z" />
      <path d="M21.6 4 L22.2 0.5 L23.4 3 Z" />
      <path d="M26.4 4 L25.8 0.5 L24.6 3 Z" />
      <circle cx="24" cy="5" r="2.5" />
      <ellipse cx="24" cy="9.5" rx="2.2" ry="3.5" />
    </svg>
  )
}
