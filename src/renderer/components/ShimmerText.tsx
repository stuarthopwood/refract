// The one shared status-text shimmer wrapper (ADR 0003; issue #1242, spec 004 FR-042; #1210 reuses
// it). Renders its text with the `.text-shimmer` utility (`globals.css`) only while `active`, the
// Settings > Appearance "Animated status text" switch is on, and the window is visible. Reduced
// motion and forced colours are handled in CSS. The text itself is never changed, so a screen
// reader reads it exactly as before.
import { useEffect, useState, type ReactNode } from 'react'
import { useSettingsStore } from '@/state'
import { cn } from '@/lib/utils'

function useWindowVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden)
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

export function ShimmerText({ active, className, children }: { active: boolean; className?: string; children: ReactNode }) {
  const enabled = useSettingsStore((s) => s.settings.animatedStatusText !== false)
  const visible = useWindowVisible()
  const shimmer = active && enabled && visible
  return (
    <span data-shimmer={shimmer ? 'on' : 'off'} className={cn(shimmer && 'text-shimmer', className)}>
      {children}
    </span>
  )
}
