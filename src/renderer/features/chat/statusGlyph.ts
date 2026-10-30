// One icon and colour per status shape, shared by `toolStatus.tsx` and `subagentStatus.tsx` so they can't drift (#570).
import { CheckCircle2Icon, CirclePauseIcon, CircleStopIcon, LoaderCircleIcon, UnplugIcon, XCircleIcon, type LucideIcon } from 'lucide-react'

export type StatusGlyphKey = 'running' | 'neutral-done' | 'success-done' | 'error' | 'neutral-muted' | 'cancelled' | 'parked'

export const STATUS_GLYPH: Record<StatusGlyphKey, { Icon: LucideIcon; className: string }> = {
  running: { Icon: LoaderCircleIcon, className: 'animate-spin text-state-working' },
  'neutral-done': { Icon: CheckCircle2Icon, className: 'text-state-idle' },
  // Finished agents and Stages get a green check; tool rows keep `neutral-done`. (#941)
  'success-done': { Icon: CheckCircle2Icon, className: 'text-severity-success' },
  error: { Icon: XCircleIcon, className: 'text-severity-error' },
  'neutral-muted': { Icon: UnplugIcon, className: 'text-muted-foreground' },
  cancelled: { Icon: CircleStopIcon, className: 'text-muted-foreground' },
  // A parked agent finished its turn but stays alive: a pause, not a stop or a check. (#1098)
  parked: { Icon: CirclePauseIcon, className: 'text-muted-foreground' }
}
