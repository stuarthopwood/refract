import * as React from 'react'
import { CheckIcon, Loader2Icon, XIcon } from 'lucide-react'
import type { TranscriptItem } from '../../../shared/model'
import { Button } from '@/components/ui/button'
import { CollapsedLine } from './CollapsedLine'
import { DiffView } from './DiffView'
import type { ToolGroup } from './groupToolItems'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>
type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

const OUTPUT_LINE_CAP = 200

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

type RowStatus = 'running' | 'done' | 'error'

// A distinct icon shape per status (never colour alone, T080/WCAG 2.1 AA): spinner, check, cross.
function StatusIcon({ status }: { status: RowStatus }) {
  const label = status === 'running' ? 'Running' : status === 'error' ? 'Failed' : 'Done'
  return (
    <>
      {status === 'running' && <Loader2Icon className="size-3.5 shrink-0 animate-spin text-state-working" />}
      {status === 'error' && <XIcon className="size-3.5 shrink-0 text-destructive" />}
      {status !== 'running' && status !== 'error' && <CheckIcon className="size-3.5 shrink-0 text-state-working" />}
      <span className="sr-only">{label}</span>
    </>
  )
}

interface ToolRowProps {
  item: ToolItem
}

// One compact row per tool call, built on the T080 baseline (docs/DESIGN.md "Chat"); expanding
// shows arguments, output, and (for `edit`/`write` results) a diff. Arguments and output are
// always plain text (constitution V).
export function ToolRow({ item }: ToolRowProps) {
  const [showAllOutput, setShowAllOutput] = React.useState(false)
  const [showAllWrite, setShowAllWrite] = React.useState(false)

  const outputLines = React.useMemo(() => item.output?.split('\n') ?? [], [item.output])
  const truncated = !showAllOutput && outputLines.length > OUTPUT_LINE_CAP
  const visibleOutput = truncated ? outputLines.slice(0, OUTPUT_LINE_CAP) : outputLines

  const writeLines = React.useMemo(() => {
    const content = item.write?.content ?? ''
    const lines = content.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines
  }, [item.write])
  const writeTruncated = !showAllWrite && writeLines.length > OUTPUT_LINE_CAP
  const visibleWrite = writeTruncated ? writeLines.slice(0, OUTPUT_LINE_CAP) : writeLines

  return (
    <CollapsedLine
      icon={<StatusIcon status={item.status} />}
      label={item.tool}
      summary={item.target}
      meta={item.status !== 'running' && item.durationMs != null ? formatDuration(item.durationMs) : undefined}
    >
      {item.edit && <DiffView path={item.edit.path} oldText={item.edit.oldText} newText={item.edit.newText} />}
      {item.write && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            Wrote {writeLines.length} {writeLines.length === 1 ? 'line' : 'lines'} to {item.write.path}
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
            <code>{visibleWrite.join('\n')}</code>
          </pre>
          {writeTruncated && (
            <Button variant="ghost" size="sm" className="mt-1" onClick={() => setShowAllWrite(true)}>
              Show all ({writeLines.length} lines)
            </Button>
          )}
        </div>
      )}
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">Arguments</div>
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">
          <code>{JSON.stringify(item.args, null, 2)}</code>
        </pre>
      </div>
      {item.output != null && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Output</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
            <code>{visibleOutput.join('\n')}</code>
          </pre>
          {truncated && (
            <Button variant="ghost" size="sm" className="mt-1" onClick={() => setShowAllOutput(true)}>
              Show all ({outputLines.length} lines)
            </Button>
          )}
        </div>
      )}
    </CollapsedLine>
  )
}

interface ToolGroupRowProps {
  group: ToolGroup
}

// A collapsed run of consecutive calls to the same tool (T074, docs/DESIGN.md "Chat"): the
// group's own status is running while any call runs, else failed when any call failed; the
// summary is the last call's target plus "+ N others" (", N failed" appended, text not colour,
// when any failed). Expanding shows each call as its own expandable `ToolRow`.
export function ToolGroupRow({ group }: ToolGroupRowProps) {
  const failedCount = group.items.filter((item) => item.status === 'error').length
  const status: RowStatus = group.items.some((item) => item.status === 'running') ? 'running' : failedCount > 0 ? 'error' : 'done'
  const last = group.items[group.items.length - 1]!
  const othersCount = group.items.length - 1
  const summary = `${last.target}  +\u00a0${othersCount}\u00a0${othersCount === 1 ? 'other' : 'others'}${failedCount > 0 ? `, ${failedCount} failed` : ''}`

  return (
    <CollapsedLine icon={<StatusIcon status={status} />} label={group.tool} summary={summary}>
      <div className="space-y-1">
        {group.items.map((item) => (
          <ToolRow key={item.id} item={item} />
        ))}
      </div>
    </CollapsedLine>
  )
}

interface SubagentRowProps {
  item: SubagentItem
}

// One collapsed line per subagent a batch `task()` call started (T078, docs/DESIGN.md "Chat"):
// never grouped by `groupToolItems` (T074), identity is the stable `item.id` (so a later
// activation can reopen the same subagent's full transcript panel, spec 004). Expanding shows
// the prompt and (once known) the result as plain text.
export function SubagentRow({ item }: SubagentRowProps) {
  return (
    <CollapsedLine
      icon={<StatusIcon status={item.status} />}
      label={item.name}
      meta={item.status !== 'running' && item.durationMs != null ? formatDuration(item.durationMs) : undefined}
    >
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">Prompt</div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
          <code>{item.task}</code>
        </pre>
      </div>
      {item.result != null && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Result</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
            <code>{item.result}</code>
          </pre>
        </div>
      )}
    </CollapsedLine>
  )
}
