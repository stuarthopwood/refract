import * as React from 'react'
import { BookOpenIcon } from 'lucide-react'
import type { TranscriptItem } from '../../../shared/model'
import { CollapsedLine } from './CollapsedLine'
import { Markdown } from './Markdown'

type SkillPromptItem = Extract<TranscriptItem, { kind: 'skill-prompt' }>

interface SkillPromptRowProps {
  item: SkillPromptItem
}

// A user-invoked `/skill:<name>` custom message (issue #547): a quiet row naming the skill, its
// arguments and line count when present, with the injected skill text collapsed behind an
// explicit expand (`CollapsedLine`'s own `Collapsible`, uncontrolled and closed by default --
// never auto-shown, since a real sample ran to about 3,900 characters). Expanded text renders as
// sanitised Markdown (constitution V: it is skill prose, not trusted markup), the same component
// every other expandable row in the transcript uses. Same icon family as the "Using skill" tool
// row (#543) so both read as skill events; unlike that row there is no running/done/failed status
// to show (a custom message, not a tool call), so the icon names the event itself instead.
export function SkillPromptRow({ item }: SkillPromptRowProps) {
  const summaryParts = [item.args, item.lineCount != null ? `${item.lineCount} line${item.lineCount === 1 ? '' : 's'}` : undefined].filter(
    (part): part is string => part !== undefined
  )
  return (
    <CollapsedLine
      icon={<BookOpenIcon className="size-4 shrink-0 text-muted-foreground" />}
      label="Skill invoked"
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
