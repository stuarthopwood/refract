import * as React from 'react'
import { BotIcon, InfoIcon, OctagonAlertIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { NoticeSource, TranscriptItem } from '../../../shared/model'
import { commandOutputSummary, parseUsageOutput } from '../../../shared/usageOutput'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'
import { Markdown } from './Markdown'
import { UsageNoticeCard } from './UsageNoticeCard'
import { CONTEXT_PRESENTATION } from './contextLinePresentation'
import type { ContextLineKind } from '../../../shared/contextLines'

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

// An info notice an extension raised (#2114) uses the theme accent and the Bot icon; warning and error keep their severity styling.
const EXTENSION_INFO_CLASS = 'text-accent-text'
// The row hover fill is `--row-hover-bg` (`muted` at 50% in dark themes), so `muted` is the binding case; hover swaps the accent summary to foreground, as Stepper.tsx does.
const EXTENSION_HOVER_CLASS = 'group-hover/line:text-foreground'

interface NoticeRowProps {
  level: NoticeLevel
  text: string
  /** Set when an OMP extension raised the notice (#2114); only an info notice changes its look. */
  source?: NoticeSource
  /** True for a user-run slash command's reply (`command-output:` id): rendered as Markdown, `/usage` as a card. */
  commandOutput?: boolean
  /** Set when Refract itself sent this as a user message (#2320): its own icon and "Away Mode:" or "Refract:" in place of the severity label. */
  context?: ContextLineKind
}

// The `×N` repeat count gets its own span so the base text's ellipsis never clips it.
function LongSummary({ text }: { text: string }) {
  const match = /^(.*) (\u00d7\d+)$/s.exec(text)
  if (!match) return <>{text}</>
  return (
    <span className="flex min-w-0">
      <span className="truncate">{match[1]}</span>
      <span className="shrink-0 whitespace-pre"> {match[2]}</span>
    </span>
  )
}

// A muted one-line notice; a long one expands to the full text, capped at about 12 lines.
export function NoticeRow({ level, text: rawText, source, commandOutput = false, context }: NoticeRowProps) {
  // Guards against a malformed producer sending a non-string, which would crash the pane on `.length`.
  const text = typeof rawText === 'string' ? rawText : JSON.stringify(rawText)
  const usage = React.useMemo(() => (commandOutput ? parseUsageOutput(text) : null), [commandOutput, text])
  const markdownId = React.useId()
  const fromExtension = level === 'info' && source === 'extension'
  const Icon = context ? CONTEXT_PRESENTATION[context].icon : fromExtension ? BotIcon : NOTICE_ICON[level]
  const toneClass = fromExtension ? EXTENSION_INFO_CLASS : NOTICE_CLASS[level]
  const expandableToneClass = fromExtension ? cn(toneClass, EXTENSION_HOVER_CLASS) : toneClass
  const isLong = text.length > LONG_NOTICE_CHARS || text.includes('\n')
  const icon = (
    <>
      <Icon className={cn('size-4 shrink-0', toneClass)} />
      <span className="sr-only">{context ? CONTEXT_PRESENTATION[context].label : fromExtension ? 'Extension:' : NOTICE_LABEL[level]}</span>
    </>
  )

  if (usage) return <UsageNoticeCard report={usage} />
  if (commandOutput) {
    return (
      <CollapsedLine
        icon={icon}
        summary={commandOutputSummary(text)}
        summaryClassName={expandableToneClass}
        contentClassName={LABEL_COLUMN_CONTENT_CLASS}
      >
        <div tabIndex={0} role="region" aria-label="Command output" className="max-h-60 overflow-y-auto [overflow-wrap:anywhere]">
          <Markdown id={markdownId} text={text} variant="chat" />
        </div>
      </CollapsedLine>
    )
  }

  if (!isLong) {
    return (
      <CollapsedLine
        icon={icon}
        summary={text}
        summaryClassName={toneClass}
        summaryWrap
      />
    )
  }

  return (
    <CollapsedLine
      icon={icon}
      summary={<LongSummary text={text} />}
      summaryClassName={expandableToneClass}
      contentClassName={LABEL_COLUMN_CONTENT_CLASS}
    >
      <div tabIndex={0} role="region" aria-label="Notice text" className={cn('max-h-60 overflow-y-auto text-xs leading-chat whitespace-pre-wrap [overflow-wrap:anywhere]', fromExtension ? EXTENSION_INFO_CLASS : 'text-notice-info-fg')}>{text}</div>
    </CollapsedLine>
  )
}
