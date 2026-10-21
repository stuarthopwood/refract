// Issue #700/#701 slice (b), decision record item 1: the Agents hover-focus card -- "running
// agents with a one-line task summary (first sentence of `task`, about 100 characters, inert
// text), elapsed time, quiet finished and failed counts, a link to the Subagents panel (click
// still opens it)". Shown inside `ReadoutChips.tsx`'s `SubagentsChip`'s own Popover; the pill's
// own click still opens the panel directly (unchanged), this card's own link is a second,
// equivalent way in while the card happens to already be open.
import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SubagentSummary } from '../../../../shared/model'
import { formatElapsed } from '../formatElapsed'
import { deriveSubagentSettledPhrase, type SubagentCount } from './subagentDerive'

export function AgentsCard({
  subagents,
  counts,
  onOpenPanel
}: {
  subagents: SubagentSummary[]
  counts: SubagentCount
  onOpenPanel: (event: MouseEvent<HTMLButtonElement>) => void
}) {
  const running = subagents.filter((agent) => agent.status === 'running')
  const [now, setNow] = useState(() => Date.now())
  // Ticks once a second, same cadence `TurnTimeChip` uses for the status line's own elapsed
  // figure -- only while the card is actually mounted (Popover content, open or closing), and
  // only while there is a running agent whose elapsed time would otherwise go stale.
  useEffect(() => {
    if (running.length === 0) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running.length])
  const settledPhrase = deriveSubagentSettledPhrase(counts)

  return (
    <div className="w-64">
      {running.length > 0 && (
        <ul className="space-y-1.5">
          {running.map((agent) => (
            <li key={agent.id} className="flex items-start justify-between gap-2 text-xs">
              {/* Decision record: "inert text" -- a plain span, never a live region or a focusable row. */}
              <span className="min-w-0 flex-1 break-words">{agent.taskSummary ?? agent.nameOrTask}</span>
              <span className="shrink-0 text-muted-foreground">{formatElapsed(now - agent.startedAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {settledPhrase && <div className={cn('text-xs text-muted-foreground', running.length > 0 && 'mt-2')}>{settledPhrase}</div>}
      <Button type="button" variant="link" size="sm" className="mt-2 h-auto p-0 text-xs" onClick={onOpenPanel}>
        Open subagents panel
      </Button>
    </div>
  )
}
