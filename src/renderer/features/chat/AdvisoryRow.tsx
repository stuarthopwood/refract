import * as React from 'react'
import { InfoIcon, OctagonAlertIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from 'cn'
import type { TranscriptItem } from '../../../shared/model'
import { CollapsedLine } from './CollapsedLine'

type AdvisoryItem = Extract<TranscriptItem, { kind: 'advisory' }>

const ADVISORY_ICON = {
  blocker: OctagonAlertIcon,
  concern: TriangleAlertIcon,
  nit: InfoIcon
} as const satisfies Record<AdvisoryItem['severity'], unknown>

// Never colour alone (T080/WCAG 2.1 AA, matching `ToolRow`'s `StatusIcon`/`NoticeRow`'s own
// icon-plus-label pattern): a distinct icon shape plus the severity word below are the real cue,
// this colour just reinforces it. These tokens also meet WCAG AA contrast against the app's
// current dark-only background (docs/DESIGN.md "Look and feel"); unverified for a future light
// theme.
const ADVISORY_CLASS = {
  blocker: 'text-destructive',
  concern: 'text-state-needs-you',
  nit: 'text-muted-foreground'
} as const satisfies Record<AdvisoryItem['severity'], string>

const ADVISORY_WORD = {
  blocker: 'Blocker',
  concern: 'Concern',
  nit: 'Nit'
} as const satisfies Record<AdvisoryItem['severity'], string>

interface AdvisoryRowProps {
  item: AdvisoryItem
}

// One baseline line per `<advisory>` element OMP adds to the conversation (T085, FR-051,
// docs/DESIGN.md "Chat"): an icon shape plus the severity word (never colour alone), the advisor
// name and a "T-N" turns-ago marker when present, and a one-line preview of the note; expanding
// shows the full note and its guidance, both as plain/inert text (constitution V). Never grouped
// (`groupToolItems` only ever sees `tool` items) and never hidden.
export function AdvisoryRow({ item }: AdvisoryRowProps) {
  const Icon = ADVISORY_ICON[item.severity]
  const className = ADVISORY_CLASS[item.severity]
  const meta = [item.advisor, item.turnsAgo !== undefined ? `T-${item.turnsAgo}` : undefined].filter(Boolean).join(' \u00b7 ')
  return (
    <CollapsedLine
      icon={<Icon className={cn('size-3.5 shrink-0', className)} />}
      label={<span className={className}>{ADVISORY_WORD[item.severity]}</span>}
      summary={item.text}
      summaryClassName={className}
      meta={meta || undefined}
    >
      <div className="space-y-2">
        <div className="whitespace-pre-wrap text-sm">{item.text}</div>
        {item.guidance && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Guidance</div>
            <div className="whitespace-pre-wrap text-sm">{item.guidance}</div>
          </div>
        )}
      </div>
    </CollapsedLine>
  )
}
