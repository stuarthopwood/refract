import type { ElementType, ReactNode } from 'react'
import { useEnterOnSwitch } from './useEnterOnSwitch'

interface ValueCrossfadeProps {
  /** The displayed value; the label crossfades (100ms, opacity only) when it changes, never on mount. */
  value: string
  children?: ReactNode
  className?: string
  as?: ElementType
}

/** Shared label for model, reasoning and Approval mode pills (#678, spec 058). */
export function ValueCrossfade({ value, children, className, as: Tag = 'span' }: ValueCrossfadeProps) {
  const ref = useEnterOnSwitch<HTMLElement>(value, 'crossfade')
  return (
    <Tag ref={ref} className={className}>
      {children ?? value}
    </Tag>
  )
}
