import * as React from 'react'
import { InfoIcon, OctagonAlertIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TranscriptItem } from '../../../shared/model'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'

type NoticeLevel = Extract<TranscriptItem, { kind: 'notice' }>['level']

const NOTICE_ICON = {
  info: InfoIcon,
  warning: TriangleAlertIcon,
  // Octagon matches the severity table in components.md and the Toaster.
  error: OctagonAlertIcon
} as const satisfies Record<NoticeLevel, unknown>

const NOTICE_CLASS = {
  info: 'text-notice-info-fg',
  warning: 'text-notice-warning-fg',
  error: 'text-notice-error-fg'
} as const satisfies Record<NoticeLevel, string>

// Non-colour severity cue for screen readers; the icon is aria-hidden.
const NOTICE_LABEL = {
  info: 'Info:',
  warning: 'Warning:',
  error: 'Error:'
} as const satisfies Record<NoticeLevel, string>

// Longer notices (or any with a line break) render expandable, e.g. OMP's one-line MCP tool list.
const LONG_NOTICE_CHARS = 160

interface NoticeRowProps {
  level: NoticeLevel
  text: string
}

// A muted one-line notice; a long one expands to the full text, capped at about 12 lines.
export function NoticeRow({ level, text: rawText }: NoticeRowProps) {
  // Guards against a malformed producer sending a non-string, which would crash the pane on `.length`.
  const text = typeof rawText === 'string' ? rawText : JSON.stringify(rawText)
  const Icon = NOTICE_ICON[level]
  const isLong = text.length > LONG_NOTICE_CHARS || text.includes('\n')
  const icon = (
    <>
      <Icon className={cn('size-4 shrink-0', NOTICE_CLASS[level])} />
      <span className="sr-only">{NOTICE_LABEL[level]}</span>
    </>
  )

  if (!isLong) {
    return (
      <CollapsedLine
        icon={icon}
        summary={text}
        summaryClassName={NOTICE_CLASS[level]}
        summaryWrap
      />
    )
  }

  return (
    <CollapsedLine
      icon={icon}
      summary={text}
      summaryClassName={NOTICE_CLASS[level]}
      contentClassName={LABEL_COLUMN_CONTENT_CLASS}
    >
      <div className="max-h-60 overflow-y-auto text-xs whitespace-pre-wrap text-notice-info-fg [overflow-wrap:anywhere]">{text}</div>
    </CollapsedLine>
  )
}
