// The Subagents panel (spec 004 FR-017 to FR-020): the right-side pane's first occupant,
// opened by activating the Subagents chip. Lists the current turn's subagents; selecting one
// shows its live stream (text and tool calls) through the same renderers the main transcript
// uses (`groupToolItems`/`ToolGroupRow` for tool calls, `Markdown` for text).
import { CheckCircle2Icon, LoaderCircleIcon, XCircleIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useSubagentPanelStore } from '@/state'
import type { SubagentSummary } from '../../../shared/model'
import { groupToolItems, isToolGroup } from '../chat/groupToolItems'
import { ToolGroupRow } from '../chat/ToolRow'
import { Markdown } from '../chat/Markdown'

const STATE_LABEL: Record<SubagentSummary['status'], string> = {
  running: 'Running',
  finished: 'Finished',
  failed: 'Failed'
}

/** A distinct icon per state, never colour alone (docs/DESIGN.md "Look and feel"). */
function SubagentStateIcon({ status }: { status: SubagentSummary['status'] }) {
  const className = 'size-3.5 shrink-0'
  switch (status) {
    case 'running':
      return <LoaderCircleIcon aria-hidden className={cn(className, 'animate-spin text-state-working')} />
    case 'finished':
      return <CheckCircle2Icon aria-hidden className={cn(className, 'text-state-idle')} />
    case 'failed':
      return <XCircleIcon aria-hidden className={cn(className, 'text-destructive')} />
  }
}

export function SubagentPanel({ sessionId }: { sessionId: string }) {
  // Spec 005 convergence (tasks.md T030): readout-store.ts is now per-session; this panel is
  // the one shared instance, explicitly bound to whichever pane's chip last activated it
  // (research.md Decision 10), so it always reads THIS sessionId's own subagent list.
  const subagents = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).subagents)
  const selectedId = useSubagentPanelStore((s) => s.selectedId)
  const selectSubagent = useSubagentPanelStore((s) => s.selectSubagent)
  const closePanel = useSubagentPanelStore((s) => s.closePanel)
  const streams = useSubagentPanelStore((s) => s.streams)
  const selectedStream = selectedId ? (streams[selectedId] ?? []) : []
  const grouped = groupToolItems(selectedStream)

  return (
    <div id="subagent-panel" className="flex h-full flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-sm font-semibold">Subagents</span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-7"
          aria-label="Close subagents panel"
          onClick={() => closePanel()}
        >
          <XIcon aria-hidden className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <ul className="flex shrink-0 flex-col gap-0.5 border-b p-2" aria-label="Current turn's subagents">
          {subagents.map((subagent) => (
            <li key={subagent.id}>
              <button
                type="button"
                aria-current={subagent.id === selectedId ? 'true' : undefined}
                onClick={() => void selectSubagent(subagent.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                  subagent.id === selectedId ? 'bg-muted font-medium' : 'hover:bg-muted/50'
                )}
              >
                <SubagentStateIcon status={subagent.status} />
                <span className="min-w-0 flex-1 truncate">{subagent.nameOrTask}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{STATE_LABEL[subagent.status]}</span>
              </button>
            </li>
          ))}
          {subagents.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">No subagents this turn.</li>}
        </ul>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 px-3 py-2">
            {selectedId === null && <p className="px-1 py-2 text-sm text-muted-foreground">Select a subagent to see its live stream.</p>}
            {grouped.map((item) =>
              isToolGroup(item) ? (
                <ToolGroupRow key={item.id} group={item} summaryWrap />
              ) : item.kind === 'assistant-text' ? (
                <Markdown key={item.id} id={item.id} text={item.text} streaming={item.streaming} />
              ) : null
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
