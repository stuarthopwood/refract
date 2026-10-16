import * as React from 'react'
import { CircleAlertIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from 'cn'
import type { TranscriptItem } from '../../../shared/model'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'

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
export function NoticeRow({ level, text: rawText }: NoticeRowProps) {
  // Defense in depth: `text` is typed `string`, but a malformed upstream producer (e.g. a
  // structured RPC error object slipping past a type error) must never crash the whole chat
  // pane via `.length`/`.includes` on a non-string -- this is exactly the bug FINDINGS recorded
  // for `applyPromptResultNotice`, now fixed at the source, but this guard stays cheap insurance.
  const text = typeof rawText === 'string' ? rawText : JSON.stringify(rawText)
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
      // #565 decision 10/7: the label column moved from 30px to 32px when `CollapsedLine`'s
      // icon slot widened 14px -> 16px; `pl-7` (28px) becomes `pl-8` (32px) to stay aligned.
      contentClassName={LABEL_COLUMN_CONTENT_CLASS}
    >
      {/* Dimmed to `--muted-foreground` (accessibility-auditor, round 2): matches the collapsed
       * summary above and the surrounding bookkeeping rows, instead of the ambient `--foreground`
       * this previously set explicitly, which reads brighter than primary chat prose. */}
      <div className="max-h-60 overflow-y-auto text-xs whitespace-pre-wrap text-muted-foreground">{text}</div>
    </CollapsedLine>
  )
}
