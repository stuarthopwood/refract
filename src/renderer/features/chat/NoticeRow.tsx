import * as React from 'react'
import { CircleAlertIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from 'cn'
import type { TranscriptItem } from '../../../shared/model'
import { CollapsedLine } from './CollapsedLine'

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

// Non-colour cue for severity (DESIGN.md: "including for screen readers"): the icon alone is
// `aria-hidden` by default, so without this a screen reader hears every notice identically
// regardless of level. Matches the `sr-only` "Running"/"Done"/"Failed" pattern ToolRow's
// `StatusIcon` already uses.
const NOTICE_LABEL = {
  info: 'Info:',
  warning: 'Warning:',
  error: 'Error:'
} as const satisfies Record<NoticeLevel, string>

// Above this length (or any embedded line break), a notice is treated as "long" and rendered
// expandable instead of one huge inline paragraph -- OMP sends notices like every mounted MCP
// tool name as a single line of text.
const LONG_NOTICE_CHARS = 160

interface NoticeRowProps {
  level: NoticeLevel
  text: string
}

// A muted one-line notice on the T080 baseline (docs/DESIGN.md "Chat"); a short notice has
// nothing to expand, a long one (or any embedded line break) expands to the full text, capped at
// about 12 lines, so it never floods the transcript between the surrounding answers. The level's
// icon shape, not colour alone, is the non-colour cue (info/warning/error).
export function NoticeRow({ level, text }: NoticeRowProps) {
  const Icon = NOTICE_ICON[level]
  const isLong = text.length > LONG_NOTICE_CHARS || text.includes('\n')
  const icon = (
    <>
      <Icon className={cn('size-3.5 shrink-0', NOTICE_CLASS[level])} />
      <span className="sr-only">{NOTICE_LABEL[level]}</span>
    </>
  )

  if (!isLong) {
    return (
      <CollapsedLine
        icon={icon}
        summary={text}
        summaryClassName={NOTICE_CLASS[level]}
      />
    )
  }

  return (
    <CollapsedLine
      icon={icon}
      summary={text}
      summaryClassName={NOTICE_CLASS[level]}
      contentClassName="pl-7"
    >
      <div className="max-h-60 overflow-y-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap text-foreground">{text}</div>
    </CollapsedLine>
  )
}
