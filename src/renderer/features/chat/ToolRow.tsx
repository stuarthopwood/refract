import * as React from 'react'
import { CheckIcon, ChevronRightIcon, Loader2Icon, XIcon } from 'lucide-react'
import { cn } from 'cn'
import type { TranscriptItem } from '../../../shared/model'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'
import { DiffView } from './DiffView'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

const OUTPUT_LINE_CAP = 200

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function StatusIcon({ status }: { status: ToolItem['status'] }) {
  if (status === 'running') return <Loader2Icon className="size-3.5 shrink-0 animate-spin text-state-working" />
  if (status === 'error') return <XIcon className="size-3.5 shrink-0 text-destructive" />
  return <CheckIcon className="size-3.5 shrink-0 text-state-working" />
}

interface ToolRowProps {
  item: ToolItem
}

// One compact row per tool call (docs/DESIGN.md "Chat"); expanding shows arguments, output, and
// (for `edit`/`write` results) a diff. Arguments and output are always plain text (constitution V).
export function ToolRow({ item }: ToolRowProps) {
  const [open, setOpen] = React.useState(false)
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
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border border-transparent hover:border-border">
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted">
        <StatusIcon status={item.status} />
        <span className="shrink-0 font-medium">{item.tool}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={item.target}>
          {item.target}
        </span>
        {item.status !== 'running' && item.durationMs != null && (
          <span className="shrink-0 text-xs text-muted-foreground">{formatDuration(item.durationMs)}</span>
        )}
        <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 px-2 pb-2 pt-1">
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
      </CollapsibleContent>
    </Collapsible>
  )
}
