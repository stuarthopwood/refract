import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SubagentSummary } from '../../../../shared/model'
import { formatElapsed } from '../formatElapsed'
import { STATUS_GLYPH } from '../statusGlyph'
import { deriveSubagentSettledPhrase, type SubagentCount } from './subagentDerive'

const MAX_ROWS = 6

export function AgentsCard({
  subagents,
  counts,
  onOpenPanel
}: {
  subagents: SubagentSummary[]
  counts: SubagentCount
  onOpenPanel: () => void
}) {
  const running = subagents.filter((agent) => agent.status === 'running')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (running.length === 0) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running.length])
  const settledPhrase = deriveSubagentSettledPhrase(counts)
  const { Icon: RunningIcon, className: runningIconClass } = STATUS_GLYPH.running
  const shown = running.slice(0, MAX_ROWS)
  const moreCount = running.length - shown.length

  return (
    <div className="w-64" aria-label="Running subagents">
      <div data-slot="agents-card-header" className="text-xs text-foreground">{running.length} running</div>
      {shown.length > 0 && (
        <ul className="mt-2 max-h-[min(16rem,40vh)] space-y-2 overflow-y-auto">
          {shown.map((agent) => (
            <li key={agent.id} className="flex items-start gap-2 text-xs">
              <RunningIcon aria-hidden className={cn('mt-1 size-4 shrink-0', runningIconClass)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  {/* Gate round 1 fix 6: the agent's own NAME leads (never falls back to the
                      task text the way `nameOrTask` does), the one-line summary follows below
                      in muted text -- truncated, never a multi-line wrap. */}
                  <span data-slot="agents-card-name" className="truncate">{agent.name ?? agent.nameOrTask}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{formatElapsed(now - agent.startedAt)}</span>
                </div>
                {/* Decision record: "inert text" -- a plain span, never a live region or a focusable row. */}
                <span className="block truncate text-muted-foreground">{agent.taskSummary ?? agent.nameOrTask}</span>
              </div>
            </li>
          ))}
          {moreCount > 0 && <li className="text-muted-foreground">and {moreCount} more</li>}
        </ul>
      )}
      {settledPhrase && (
        <div data-slot="agents-card-settled" className={cn('text-xs text-muted-foreground', shown.length > 0 ? 'mt-2' : 'mt-1')}>
          {settledPhrase}
        </div>
      )}
      {/* Gate round 1 fix 1 (CRITICAL/HIGH): `variant="link"`'s own `text-primary` read 2.92:1
          to 3.46:1 against the popover background in Obsidian/Nordic Frost/Cyber Amber at this
          12px size, short of the 4.5:1 body-text floor -- `text-foreground` (an EXISTING checked
          pair, `popover-foreground / popover`) plus a permanent (not hover-only) underline reads
          clearly as a link without introducing a new colour this card alone would need checked. */}
      <Button type="button" variant="link" size="sm" className="mt-2 h-auto p-0 text-xs text-foreground underline underline-offset-4" onClick={onOpenPanel}>
        Open subagents panel
      </Button>
    </div>
  )
}
