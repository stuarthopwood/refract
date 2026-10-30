import * as React from 'react'
import type { TranscriptItem } from '../../../shared/model'
import { cn } from '@/lib/utils'
import { InlineDisclosure } from '@/components/InlineDisclosure'
import { ToolIcon } from '@/components/ToolIcon'
import { resolveToolDisplay } from './toolDisplay'
import {
  chatRowStatus,
  isSubagentSuccessStatus,
  SUBAGENT_STATUS_LABEL,
  SUBAGENT_SUCCESS_TEXT_CLASS,
  SubagentStatusGlyph
} from '../subagents/subagentStatus'
import { CodeBlock, inferOutputBlock } from './Markdown'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'
import { formatElapsed } from './formatElapsed'
import { extractResultSummary } from './stageMeta'
import { SubagentGoalPreview } from './SubagentGoalPreview'

type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

interface SubagentRowProps {
  item: SubagentItem
  // Issue #1077: true shows this row's own goal (`item.task`'s first lines, clamped to 3 lines)
  // above the toggle.
  showGoal: boolean
}

// The goal (when `showGoal`), then a "See input & output" toggle (`InlineDisclosure`, ADR 0003,
// `MermaidBlock`'s "Show source" shape) -- split out so `StageGroupRow` reuses it for its own
// solo-of-the-turn case without `SubagentRow`'s own `CollapsedLine` wrapper (#563, H2/H3: never
// switch element type between solo and multi members).
export function SubagentBody({ item, showGoal }: SubagentRowProps) {
  const taskBlock = React.useMemo(() => inferOutputBlock(item.task), [item.task])
  const resultBlock = React.useMemo(() => (item.result != null ? inferOutputBlock(item.result) : null), [item.result])
  const [open, setOpen] = React.useState(false)
  const contentId = React.useId()
  const hasResult = item.result != null
  const label = (
    <>
      {open ? 'Hide' : 'See'} input{hasResult ? ' & output' : ''}
      <span className="sr-only"> for {item.name}</span>
    </>
  )
  return (
    <div className="space-y-1">
      {showGoal && <SubagentGoalPreview task={item.task} />}
      <InlineDisclosure open={open} onOpenChange={setOpen} contentId={contentId} label={label}>
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Prompt</div>
          <div className="max-h-64 overflow-auto rounded-lg">
            <CodeBlock code={taskBlock.code} lang={taskBlock.lang} wrap />
          </div>
        </div>
        {resultBlock != null && (
          <div>
            <div className="mb-1 text-xs text-muted-foreground">Result</div>
            <div className="max-h-64 overflow-auto rounded-lg">
              <CodeBlock code={resultBlock.code} lang={resultBlock.lang} wrap />
            </div>
          </div>
        )}
      </InlineDisclosure>
    </div>
  )
}

// One collapsed line per subagent a batch `task` call started (docs/DESIGN.md "Chat"): never
// grouped by `groupToolItems`, identity is the stable `item.id` (so a later activation can
// reopen the same subagent's full transcript panel, spec 004).
export function SubagentRow({ item, showGoal }: SubagentRowProps) {
  const status = chatRowStatus(item.status)
  const duration =
    item.status !== 'running' && item.durationMs != null ? (
      <span className="tabular-nums">{formatElapsed(item.durationMs)}</span>
    ) : undefined
  const meta = (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <SubagentStatusGlyph status={status} />
      {status !== 'finished' && <span aria-hidden="true">{SUBAGENT_STATUS_LABEL[status]}</span>}
      {duration}
    </span>
  )
  const resultSummary = item.result != null ? extractResultSummary(item.result) : undefined
  return (
    // #565 decision 10: this row is always a `SpineList` member (its only caller,
    // `SubagentChainRow.tsx`'s non-solo branch), so its own expanded body starts at the same label
    // column `ToolCallRow`'s member body does -- one geometry for every Spine member.
    <CollapsedLine
      icon={<ToolIcon icon={resolveToolDisplay('task').icon} />}
      label={item.name}
      labelClassName={cn(isSubagentSuccessStatus(status) && SUBAGENT_SUCCESS_TEXT_CLASS)}
      summary={resultSummary}
      meta={meta}
      contentClassName={LABEL_COLUMN_CONTENT_CLASS}
    >
      <SubagentBody item={item} showGoal={showGoal} />
    </CollapsedLine>
  )
}
