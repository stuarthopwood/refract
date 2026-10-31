/** Decorative motion layer painted behind a ChatPane's content (`-z-10`, so it never paints over text or controls); renders null unless the holiday has an ambient effect and touches are 'full'. */
// Mounted once per window, scoped to pane 0's transcript container so it never paints under the composer (#1048).
// Pausing (hidden/unfocused, idle, overlay open) is JS-driven via `data-paused`; reduced-motion and forced-colors are CSS plus a live `matchMedia` listener that cancels in-flight animations, since a `display:none` ancestor does not stop them using CPU.
// Wheel and pointermove count as activity so a scrolling reader is not idle.
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useActiveChatWidth, useHolidayStore, useSettingsStore } from '@/state'
import { OVERLAY_OPEN_SELECTOR } from '@/lib/overlayOpenSelector'
import { HOLIDAY_CONTENT } from './holidayContent'
import { clampFlightToBounds, flightKeyframes, LoopPieces } from './holidayArtwork'

const FLIGHT_FADE_OUT_MS = 400
// The CSS hides the layer under all three; the scheduler must not fly pieces under any of them (#1377).
const NO_MOTION_QUERY = '(prefers-reduced-motion: reduce), (forced-colors: active), (prefers-reduced-transparency: reduce)'

/** A pause mid-flight freezes the bat and fades it out, then returns it to rest; reduced-motion/forced-colors cancels outright (#1256). */
function fadeOutFlight(bat: HTMLElement, flight: Animation) {
  flight.pause()
  const fade = bat.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FLIGHT_FADE_OUT_MS, easing: 'ease-out', fill: 'forwards' })
  fade.onfinish = () => {
    flight.cancel()
    fade.cancel()
    bat.style.willChange = ''
  }
}

/** Debug-only `REFRACT_HOLIDAY_FLIGHT_INTERVAL_MS` override: the real 90-180s flight gap rarely falls inside a 60s CPU sample, so a short fixed gap makes live checks measurable. */
export function HolidayAmbientLoop({ avoidTextColumn = false }: { avoidTextColumn?: boolean } = {}) {
  const chatWidth = useActiveChatWidth()
  const holidayTouches = useSettingsStore((s) => s.settings.holidayTouches)
  const holiday = useHolidayStore((s) => s.activeHoliday)
  const idleTimeoutMs = useHolidayStore((s) => s.idleTimeoutMs)
  const flightIntervalMsOverride = useHolidayStore((s) => s.flightIntervalMs)
  const [paused, setPaused] = useState(() => document.hidden || !document.hasFocus())
  const [motionSuppressed, setMotionSuppressed] = useState(() => window.matchMedia(NO_MOTION_QUERY).matches)
  const [flightCount, setFlightCount] = useState(0)
  const idleTimerRef = useRef<number | undefined>(undefined)
  const containerRef = useRef<HTMLDivElement>(null)
  const remainingFlightDelayMsRef = useRef<number | null>(null)
  const dialogOpenRef = useRef(false)

  const active = holidayTouches === 'full' && holiday !== null && HOLIDAY_CONTENT[holiday].hasAmbientLoop

  // A reactive `matchMedia` listener so emulated media toggled mid-session cancels a running flight immediately.
  useEffect(() => {
    const media = window.matchMedia(NO_MOTION_QUERY)
    function handleChange() {
      setMotionSuppressed(media.matches)
    }
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    if (!active) return
    // Re-checked here: the effect re-runs when `idleTimeoutMs` changes, and hidden/focus state may have changed since the lazy initializer.
    setPaused(document.hidden || !document.hasFocus())
    // `OVERLAY_OPEN_SELECTOR` covers every Radix overlay that takes attention. Cached in a ref refreshed by the mutation observer, so the high-frequency `handleActivity` never queries the DOM.
    function updateDialogOpenCache() {
      dialogOpenRef.current = !!document.querySelector(OVERLAY_OPEN_SELECTOR)
    }
    function schedulePause() {
      window.clearTimeout(idleTimerRef.current)
      idleTimerRef.current = window.setTimeout(() => setPaused(true), idleTimeoutMs)
    }
    // An unfocused window gets pointermove/wheel from OS hover routing, which is not reading; input while an overlay is open targets the overlay.
    function handleActivity() {
      if (document.hidden || !document.hasFocus() || dialogOpenRef.current) return
      setPaused(false)
      schedulePause()
    }
    // Throttled to about 1/s to avoid idle-timer churn; the leading call still runs immediately.
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
    // Radix portals mount on `document.body`, so `childList` alone (no `subtree`/`attributes`) catches overlays; broader observation cost 0.156s/60s idle CPU.
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

  // A continuous CSS animation cost ~3.2s CPU/60s, so bats sit static and one flies for ~4s via a single `Element.animate()` every 90-180s (under WCAG 2.2.2's 5s).
  // The animated target is the wrapping div (not the svg root); the flight is a round trip to `translate(0,0)` so the bat never snaps back.
  // `will-change: transform` is set only for the flight's duration.
  useEffect(() => {
    if (!active) {
      remainingFlightDelayMsRef.current = null
      return
    }
    if (paused || motionSuppressed) return
    let cancelled = false
    let flightTimer: number | undefined
    let currentAnimation: Animation | undefined
    let currentBat: HTMLElement | undefined
    let timerPending = false
    let timerDelayMs = 0
    let timerStartedAt = 0

    // A pause freezes the countdown instead of discarding it, so a resumed reader still gets a flight (#1233).
    function scheduleNextFlight(resumeDelayMs?: number) {
      const delayMs =
        resumeDelayMs ?? (flightIntervalMsOverride !== null ? flightIntervalMsOverride : 90_000 + Math.random() * 90_000)
      timerDelayMs = delayMs
      timerStartedAt = Date.now()
      timerPending = true
      flightTimer = window.setTimeout(runFlight, delayMs)
    }

    function runFlight() {
      timerPending = false
      const bats = Array.from(containerRef.current?.querySelectorAll<HTMLElement>('.holiday-ambient-loop-bat-wrap') ?? []).filter(
        (el) => el.offsetParent !== null
      )
      if (bats.length === 0) {
        scheduleNextFlight()
        return
      }
      const bat = bats[Math.floor(Math.random() * bats.length)]
      if (!bat) {
        scheduleNextFlight()
        return
      }
      const baseKeyframes = holiday ? flightKeyframes(holiday) : null
      if (!baseKeyframes) {
        scheduleNextFlight()
        return
      }
      const containerEl = containerRef.current
      const keyframes = containerEl
        ? clampFlightToBounds(baseKeyframes, bat.getBoundingClientRect(), containerEl.getBoundingClientRect())
        : baseKeyframes
      setFlightCount((count) => count + 1)
      bat.style.willChange = 'transform'
      const animation = bat.animate(keyframes, { duration: 4_000, easing: 'ease-in-out', fill: 'none' })
      currentAnimation = animation
      currentBat = bat
      animation.onfinish = () => {
        bat.style.willChange = ''
        currentAnimation = undefined
        currentBat = undefined
        if (!cancelled) scheduleNextFlight()
      }
      animation.oncancel = () => {
        bat.style.willChange = ''
        currentAnimation = undefined
      }
    }

    const resumedDelayMs = remainingFlightDelayMsRef.current
    remainingFlightDelayMsRef.current = null
    scheduleNextFlight(
      resumedDelayMs === null
        ? undefined
        : flightIntervalMsOverride !== null
          ? Math.min(resumedDelayMs, flightIntervalMsOverride)
          : resumedDelayMs
    )
    return () => {
      cancelled = true
      window.clearTimeout(flightTimer)
      if (timerPending) {
        remainingFlightDelayMsRef.current = Math.max(0, timerDelayMs - (Date.now() - timerStartedAt))
      }
      if (currentAnimation && currentBat) {
        const reducedNow = window.matchMedia(NO_MOTION_QUERY).matches
        if (reducedNow || !currentBat.isConnected) currentAnimation.cancel()
        else fadeOutFlight(currentBat, currentAnimation)
      }
    }
  }, [active, holiday, paused, motionSuppressed, flightIntervalMsOverride])

  if (!active || !holiday) return null

  return (
    <div
      aria-hidden
      ref={containerRef}
      className={cn('holiday-ambient-loop -z-10', `holiday-ambient-loop--${holiday}`, avoidTextColumn && 'holiday-ambient-loop--gutters')}
      data-chat-width={chatWidth}
      data-paused={paused || undefined}
      data-flight-count={flightCount}
    >
      {holiday === 'halloween' && (
        <>
          <div className="holiday-ambient-loop-bat-wrap">
            <BatSilhouette />
          </div>
          <div className="holiday-ambient-loop-bat-wrap">
            <BatSilhouette />
          </div>
          <div className="holiday-ambient-loop-bat-wrap">
            <BatSilhouette />
          </div>
        </>
      )}
      <LoopPieces holiday={holiday} />
    </div>
  )
}

/** One drifting bat: hand-drawn curved wings (widest at the body, tapering to the tip), 48x16 viewBox, reused with only CSS position/timing varied. */
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
