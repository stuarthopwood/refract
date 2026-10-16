// Shared icon+colour table for every status glyph in the chat (issue #570 decision 3): one
// shape and colour per matching state, consumed by `toolStatus.tsx`'s `StatusIcon` (tool rows
// and groups) and `subagentStatus.tsx`'s `SubagentStatusGlyphIcons` (`SubagentRow`, Stage group
// and chain rows, the Subagent panel tree). #563 landed first and chose these icon/colour pairs
// (`subagentStatus.tsx`'s own `SubagentStatusGlyphIcons`); #570 folds the tool-row copy of the
// SAME pairs into this one table instead of a second hand-written JSX map, so the two can never
// quietly drift apart from each other again (gate round 1, G909Code Medium).
//
// Keyed by a shape, not by either module's own status union, since the two unions differ
// (`RowStatus` has `interrupted`, `SubagentRowStatus` has `cancelled` instead): `neutral-done`,
// `neutral-muted`, and `cancelled` all render fully neutral (no colour, "failure loud, success
// quiet", `docs/PLAN.md` #768) but keep three DISTINCT icon shapes (a filled check-circle, an
// unplug, and a stop-circle respectively) so colour is never the only cue (T080, WCAG 2.1 AA)
// even among several neutral states.
import { CheckCircle2Icon, CircleStopIcon, LoaderCircleIcon, UnplugIcon, XCircleIcon, type LucideIcon } from 'lucide-react'

export type StatusGlyphKey = 'running' | 'neutral-done' | 'error' | 'neutral-muted' | 'cancelled'

export const STATUS_GLYPH: Record<StatusGlyphKey, { Icon: LucideIcon; className: string }> = {
  running: { Icon: LoaderCircleIcon, className: 'animate-spin text-state-working' },
  'neutral-done': { Icon: CheckCircle2Icon, className: 'text-state-idle' },
  error: { Icon: XCircleIcon, className: 'text-severity-error' },
  'neutral-muted': { Icon: UnplugIcon, className: 'text-muted-foreground' },
  cancelled: { Icon: CircleStopIcon, className: 'text-muted-foreground' }
}
