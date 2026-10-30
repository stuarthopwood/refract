import { useRef, type ElementType, type ReactNode } from 'react'
import { useEnterOnSwitch } from './useEnterOnSwitch'

interface ValueCrossfadeProps {
  /** The displayed value; the label crossfades (100ms, opacity only) when it changes, never on mount. */
  value: string
  /** When this changes (for example the Session id) a new value is a context switch, not a change, and does not animate. */
  scope?: unknown
  children?: ReactNode
  className?: string
  as?: ElementType
}

/** Shared label for model, reasoning and Approval mode pills (#678, spec 058). */
export function ValueCrossfade({ value, scope, children, className, as: Tag = 'span' }: ValueCrossfadeProps) {
  const last = useRef({ value, scope, animKey: 0 })
  const prev = last.current
  if (!Object.is(prev.value, value)) {
    last.current = { value, scope, animKey: Object.is(prev.scope, scope) ? prev.animKey + 1 : prev.animKey }
  } else if (!Object.is(prev.scope, scope)) {
    last.current = { ...prev, scope }
  }
  const ref = useEnterOnSwitch<HTMLElement>(last.current.animKey, 'crossfade')
  return (
    <Tag ref={ref} className={className}>
      {children ?? value}
    </Tag>
  )
}
