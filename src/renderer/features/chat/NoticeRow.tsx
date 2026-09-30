import * as React from 'react'
import { ChevronRightIcon, CircleAlertIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from 'cn'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { TranscriptItem } from '../../../shared/model'

type NoticeLevel = Extract<TranscriptItem, { kind: 'notice' }>['level']

const NOTICE_ICON = {
  info: InfoIcon,
  warning: TriangleAlertIcon,
  error: CircleAlertIcon
} as const satisfies Record<NoticeLevel, unknown>

const NOTICE_CLASS = {
  info: 'text-muted-foreground',
  warning: 'text-state-needs-you',
  error: 'text-destructive'
} as const satisfies Record<NoticeLevel, string>

// Above this length (or any embedded line break), a notice is treated as "long" and rendered
// expandable instead of one huge inline paragraph -- OMP sends notices like every mounted MCP
// tool name as a single line of text.
const LONG_NOTICE_CHARS = 160

interface NoticeRowProps {
  level: NoticeLevel
  text: string
}

// A muted one-line notice (docs/DESIGN.md "Chat"). Short notices stay a single clamped line; a
// long one collapses behind a "Show more" trigger, revealing the full text in a scrollable block
// capped at about 12 lines, so it never floods the transcript between the surrounding answers.
export function NoticeRow({ level, text }: NoticeRowProps) {
  const [open, setOpen] = React.useState(false)
  const Icon = NOTICE_ICON[level]
  const isLong = text.length > LONG_NOTICE_CHARS || text.includes('\n')

  if (!isLong) {
    return (
      <div className={cn('flex items-center gap-1.5 px-2 py-1 text-xs', NOTICE_CLASS[level])}>
        <Icon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{text}</span>
      </div>
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs hover:bg-muted',
          NOTICE_CLASS[level]
        )}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{text}</span>
        <span className="shrink-0 text-muted-foreground">{open ? 'Show less' : 'Show more'}</span>
        <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2 pb-2 pl-7">
        <div className="max-h-60 overflow-y-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap text-foreground">
          {text}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
