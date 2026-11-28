// The panel's presentation: one disclosure group per Session, its agents as rows, its successful finishes as one line (#490).
// Selection and focus stay in SubagentPanel; this only draws rows and reports what the pointer did.
import { memo, useEffect, useState } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { FileChipList } from '@/components/FileChip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { INSET_FOCUS_OUTLINE_CLASS } from '@/components/ui/focus-classes'
import { cn } from '@/lib/utils'
import { ICON_SLOT_CLASS } from '../chat/CollapsedLine'
import { STATUS_GLYPH } from '../chat/statusGlyph'
import { ResultMarkdown } from './card/ResultMarkdown'
import { agentElapsedText, agentsStatusText, finishedText, runningText, type AgentRow, type FinishedRow, type GroupRows } from './subagentPanelRows'
import { SubagentStatusIcon } from './subagentStatus'
import { FILES_TOUCHED_LABEL, type SubAgentItem } from './viewModel'

/** The running total as a polite live region, which doubles as the empty state; it is also where focus lands when a pruned row took it (#1085). */
export function AgentsStatusLine({ totalRunning }: { totalRunning: number }) {
  return (
    <p role="status" aria-live="polite" data-panel-heading tabIndex={-1} className="px-2 py-1 text-sm text-muted-foreground focus-visible:outline-solid focus-visible:outline-(length:--focus-ring-width) focus-visible:outline-ring">
      {agentsStatusText(totalRunning)}
    </p>
  )
}

interface RowHandlers {
  rowRef: (key: string, element: HTMLElement | null) => void
  onSelect: (sessionId: string, row: AgentRow) => void
  onToggle: (sessionId: string) => void
}

/** A running agent ticks each second on its own clock, so only this text re-renders, not the list around it. */
function AgentElapsed({ summary }: { summary: AgentRow['summary'] }) {
  const running = summary.status === 'running'
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [running])
  const text = agentElapsedText(summary, now)
  return text ? <span className="shrink-0 tabular-nums text-muted-foreground">{text}</span> : null
}

type AgentItemProps = { row: AgentRow; sessionId: string; selected: boolean } & Pick<RowHandlers, 'rowRef' | 'onSelect'>

const AgentItem = memo(function AgentItem({ row, sessionId, selected, rowRef, onSelect }: AgentItemProps) {
  const { summary } = row
  return (
    <li>
      <button
        ref={(element) => rowRef(row.key, element)}
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(sessionId, row)}
        className={cn('relative flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-surface-hover aria-[current=true]:bg-accent forced-colors:aria-[current=true]:border forced-colors:aria-[current=true]:border-[Highlight]', INSET_FOCUS_OUTLINE_CLASS)}
      >
        {selected && <ActiveIndicatorBar />}
        <span className="flex shrink-0 items-center gap-1 text-xs">
          <SubagentStatusIcon status={summary.status} />
        </span>
        <span className="min-w-0 flex-1 truncate" title={summary.name ?? summary.nameOrTask}>
          {summary.name ?? summary.nameOrTask}
          {summary.background && (
            <>
              {' '}
              <span className="ml-2 text-xs text-muted-foreground">Background</span>
            </>
          )}
        </span>
        <AgentElapsed summary={summary} />
      </button>
    </li>
  )
})

function FinishedItem({ row }: { row: FinishedRow }) {
  const { Icon, className } = STATUS_GLYPH['success-done']
  return (
    <li className="flex min-h-9 items-center gap-2 px-2 py-1 text-sm text-muted-foreground">
      <span aria-hidden="true" className={ICON_SLOT_CLASS}>
        <Icon className={cn('size-4 shrink-0', className)} />
      </span>
      {finishedText(row.count)}
    </li>
  )
}

type GroupProps = { group: GroupRows; collapsed: boolean; selectedKey: string | null } & RowHandlers

/** The `data-agents-group` anchor is stable per Session so a later task can scroll to the group. A plain div, not a named section, so a group is not a region landmark. */
export const AgentsGroupSection = memo(function AgentsGroupSection({ group, collapsed, selectedKey, rowRef, onSelect, onToggle }: GroupProps) {
  return (
    <Collapsible data-agents-group={group.sessionId} open={!collapsed} onOpenChange={() => onToggle(group.sessionId)} className="flex flex-col">
      <h3 className="m-0 text-sm font-medium">
        <CollapsibleTrigger
          ref={(element) => rowRef(group.key, element)}
          className={cn('group/trigger flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-surface-hover', INSET_FOCUS_OUTLINE_CLASS)}
        >
          <ChevronRightIcon aria-hidden className="size-4 shrink-0 transition-transform group-data-[state=open]/trigger:rotate-90 motion-reduce:transition-none" />
          <span className="min-w-0 flex-1 truncate">
            {group.name}
            {group.repositoryName && (
              <>
                {' '}
                <span className="ml-2 text-xs font-normal text-muted-foreground">{group.repositoryName}</span>
              </>
            )}
          </span>
          <span className="shrink-0 text-xs font-normal text-muted-foreground">{runningText(group.running)}</span>
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent asChild>
        <ul className="m-0 flex list-none flex-col gap-1 p-0 pl-4">
          {group.rows.map((row) =>
            row.kind === 'agent' ? <AgentItem key={row.key} row={row} sessionId={group.sessionId} selected={row.key === selectedKey} rowRef={rowRef} onSelect={onSelect} /> : <FinishedItem key={row.key} row={row} />
          )}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
})

/** The selected agent's whole outcome and every file it touched, which the row's single line leaves out. */
export function AgentDetailSummary({ agent }: { agent: SubAgentItem }) {
  const outcome = agent.whatItDid?.trim()
  const files = agent.filesTouched ?? []
  if (!outcome && files.length === 0) return null
  return (
    <section aria-label={`${agent.name} details`} className="space-y-1 px-1">
      {outcome && <ResultMarkdown text={outcome} interactive className="break-words text-sm text-card-foreground" />}
      <FileChipList files={files} label={FILES_TOUCHED_LABEL} limit={files.length} />
    </section>
  )
}
