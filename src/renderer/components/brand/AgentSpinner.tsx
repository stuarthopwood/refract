import { useId, useState } from 'react'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { useHolidayStore, useSettingsStore } from '@/state'
import { HOLIDAY_CONTENT } from '@/features/holidays/holidayContent'

/** Below this size (px) the halo's blur filter is dropped. */
export const LEGIBILITY_FLOOR_PX = 28

export interface AgentSpinnerProps {
  /** Below `LEGIBILITY_FLOOR_PX` the halo's blur filter is dropped; the geometry and sequence are otherwise identical. */
  size: 16 | 20 | 24 | 32 | 48
  /** Merged with the component's own classes -- layout utilities only (for example `shrink-0`). */
  className?: string
  /** `'export'`/`'blue'` are fixed literals outside the token system, so they are not wired into that script as gates. */
  palette?: 'brand' | 'export' | 'blue'
}

const VIEW_BOX = '-110 -110 220 220'

const CYCLE_MS = 10000

/** The halo's own gradient `stop-opacity` is fixed, never animated. */
/** In season, with the setting not `'off'`, swaps the default split/rotate/merge core for the active holiday's own icon. */
export function AgentSpinner({ size, className, palette = 'brand' }: AgentSpinnerProps) {
  const uid = useId().replace(/:/g, '')
  const [delay] = useState(() => `-${Date.now() % CYCLE_MS}ms`)
  const holidayTouches = useSettingsStore((s) => s.settings.holidayTouches)
  const holiday = useHolidayStore((s) => s.activeHoliday)
  const holidayEntry = holidayTouches !== 'off' && holiday ? HOLIDAY_CONTENT[holiday] : null
  const cycleStyle = {
    '--agent-spinner-cycle': `${CYCLE_MS}ms`,
    '--agent-spinner-delay': delay
  } as CSSProperties
  if (holidayEntry) {
    const HolidayIcon = holidayEntry.icon
    return (
      <HolidayIcon
        aria-hidden
        focusable={false}
        width={size}
        height={size}
        strokeWidth={2}
        className={cn('agent-spinner agent-spinner-holiday', className)}
        data-palette={palette}
        style={cycleStyle}
      />
    )
  }
  return (
    <svg
      aria-hidden
      focusable={false}
      width={size}
      height={size}
      viewBox={VIEW_BOX}
      className={cn('agent-spinner', className)}
      data-palette={palette}
      style={cycleStyle}
    >
      <AgentSpinnerCore uid={uid} blurred={size >= LEGIBILITY_FLOOR_PX} />
    </svg>
  )
}

const CORE_SLOT_ANGLES_DEG = [0, 120, 240] as const

/** Each of the three slots renders a soft radial-gradient halo plus a solid disc on top, both children of one `transform`-only animated group. */
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
                r="77"
                fill={`url(#${haloGradientId})`}
                style={blurred ? { filter: `url(#${haloBlurId})` } : undefined}
              />
              <circle className="agent-spinner-core-disc" r="55" fill="var(--agent-spinner-core)" />
            </g>
          </g>
        ))}
      </g>
    </>
  )
}
