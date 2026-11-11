import * as React from 'react'
import { BookOpenIcon } from 'lucide-react'
import type { TranscriptItem } from '../../../shared/model'
import { CollapsedLine } from './CollapsedLine'
import { Markdown } from './Markdown'

type SkillPromptItem = Extract<TranscriptItem, { kind: 'skill-prompt' }>

interface SkillPromptRowProps {
  item: SkillPromptItem
}

// `/skill:<name>` custom message row: the injected skill text stays collapsed (a sample ran ~3,900 chars) and
// renders as sanitised Markdown (constitution V). No status icon: it is a message, not a tool call (#547).
export function SkillPromptRow({ item }: SkillPromptRowProps) {
  const summaryParts = [item.args, item.lineCount != null ? `${item.lineCount} line${item.lineCount === 1 ? '' : 's'}` : undefined].filter(
    (part): part is string => part !== undefined
  )
  return (
    <CollapsedLine
      icon={<BookOpenIcon className="size-4 shrink-0 text-muted-foreground" />}
      label="Skill invoked"
      iconTooltip={item.description}
      summary={
        <>
          {/* `name` is an untrusted `/skill:<name>` remainder (#543/#547 follow-up, code
           * review round 2): wrapped in `<bdi>` so an embedded bidi control character can't
           * reorder the summary parts after it, and kept out of `label` (which doesn't
           * truncate) so a long or no-space name truncates with the rest of the summary
           * instead of overflowing the row. */}
          <bdi>{item.name}</bdi>
          {summaryParts.length > 0 ? ` \u00b7 ${summaryParts.join(' \u00b7 ')}` : null}
        </>
      }
    >
      <Markdown id={item.id} text={item.text} className="text-muted-foreground" />
    </CollapsedLine>
  )
}
