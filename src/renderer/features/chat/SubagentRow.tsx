import * as React from 'react'
import type { TranscriptItem } from '../../../shared/model'
import { cn } from '@/lib/utils'
import { InlineDisclosure } from '@/components/InlineDisclosure'
import { ToolIcon } from '@/components/ToolIcon'
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
  /** Issue #1077: true shows this row's own goal (`item.task`'s first lines, clamped to 3
   * lines) above the toggle. Required (item 10: no implicit default) -- `SubagentChainRow.tsx`
   * decides per item, correlated by `toolCallId` (a joined Stage can hold several task() calls,
   * each with its own context or none, stamped only on that call's spec-index-0 item); a
   * context-less solo Stage's own goal renders at the Stage level instead, before "Uses:"
   * (item 7), so `false` for it. */
  showGoal: boolean
}

// `SubagentGoalPreview` (own file, gate round 1 fix, item 7/file-size): the goal paragraph
// alone, exported so `StageGroupRow` can render a context-less solo Stage's own goal before
// "Uses:", not nested inside `SubagentBody`. The goal (when `showGoal`), then a "See input &
// output" toggle (`InlineDisclosure`, ADR 0003, `MermaidBlock`'s "Show source" shape) -- split
// out so `StageGroupRow` reuses it for its own solo-of-the-turn case without `SubagentRow`'s
// own `CollapsedLine` wrapper (#563, H2/H3: never switch element type between solo and multi
// members). Never stays mounted while collapsed, so re-expanding always starts fresh.
export function SubagentBody({ item, showGoal }: SubagentRowProps) {
  const taskBlock = React.useMemo(() => inferOutputBlock(item.task), [item.task])
  const resultBlock = React.useMemo(() => (item.result != null ? inferOutputBlock(item.result) : null), [item.result])
  const [open, setOpen] = React.useState(false)
  const contentId = React.useId()
  const hasResult = item.result != null
  // Gate round 1 fix (item 9): an sr-only name suffix -- every sibling link reads identical text.
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

// One collapsed line per subagent a batch `task()` call started (T078, docs/DESIGN.md "Chat"):
// never grouped by `groupToolItems` (T074), identity is the stable `item.id` (so a later
// activation can reopen the same subagent's full transcript panel, spec 004). Expanding shows
// the prompt and (once known) the result as plain text.
//
// Quality-gate remediation (H1, unanimous) and spec 023 FR-017: `icon=` is the Delegate tool
// glyph (`ToolIcon tool="task"`, Users); `SubagentStatusGlyph` sits in `meta`, ahead of the
// visible status word and the duration. The glyph's own word stays `sr-only` (the one spoken
// word); the visible word is `aria-hidden` and gated off for `finished` (decision 14: a quiet
// icon-plus-duration row, never a loud "Finished" claim).
export function SubagentRow({ item, showGoal }: SubagentRowProps) {
  const status = chatRowStatus(item.status)
  const duration =
    item.status !== 'running' && item.durationMs != null ? (
      <span className="tabular-nums">{formatElapsed(item.durationMs)}</span>
    ) : undefined
  // Gate round 2 (Low, double-word fix): the status word here duplicates `SubagentStatusGlyph`'s
  // own `sr-only` word -- `aria-hidden` keeps the visible word sighted-only.
  const meta = (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <SubagentStatusGlyph status={status} />
      {status !== 'finished' && <span aria-hidden="true">{SUBAGENT_STATUS_LABEL[status]}</span>}
      {duration}
    </span>
  )
  // Issue #941 grill item 4: a Stage expanding reveals each member's own one-line result right
  // here, with no need to ALSO expand this row individually -- `extractResultSummary` (gate
  // round 1 fix): first line, Markdown markers stripped, capped ~120 chars (a full multi-line
  // result still needs this row's own expansion, `SubagentBody` below, for the rest).
  const resultSummary = item.result != null ? extractResultSummary(item.result) : undefined
  return (
    // #565 decision 10: this row is always a `SpineList` member (its only caller,
    // `SubagentChainRow.tsx`'s non-solo branch), so its own expanded body starts at the same
    // label column `ToolCallRow`'s member body does -- one geometry for every Spine member.
    <CollapsedLine
      icon={<ToolIcon tool="task" />}
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
