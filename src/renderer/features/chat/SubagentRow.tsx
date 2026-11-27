import * as React from 'react'
import type { TranscriptItem } from '../../../shared/model'
import { cn } from '@/lib/utils'
import { InlineDisclosure } from '@/components/InlineDisclosure'
import { ToolIcon } from '@/components/ToolIcon'
import { resolveToolDisplay } from './toolDisplay'
import { isSubagentSuccessStatus, SUBAGENT_STATUS_LABEL, SUBAGENT_SUCCESS_TEXT_CLASS, SubagentStatusGlyph } from '../subagents/subagentStatus'
import { CodeBlock, inferOutputBlock } from './Markdown'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'
import { RowTrailing } from './toolRowParts'
import { FILES_TOUCHED_LABEL, type SubAgentItem } from '../subagents/viewModel'
import { FileChipList } from '@/components/FileChip'
import { CausalBadge, causalBadgeText } from '../subagents/card/CausalBadge'
import { Heartbeat, heartbeatText } from '../subagents/card/Heartbeat'
import { SubStepList } from '../subagents/card/SubStepList'
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

// The card variant's body (#1928): name, role, what it did, provenance and files, then a live
// heartbeat and sub-steps while it runs. Every optional part renders nothing when absent, so no
// empty row or gap is left behind. `children` is the footer: the chat adds its input/output toggle,
// the panel (which has its own detail pane) adds nothing, so it needs no transcript item (#1930).
export function SubagentCardBody({ agent, children }: { agent: SubAgentItem; children?: React.ReactNode }) {
  const { status, duration, name, role, whatItDid, triggeredBy, filesTouched, liveDetail, subSteps } = agent
  const running = status === 'running'
  const hasProvenanceRow = causalBadgeText(triggeredBy) != null || (filesTouched?.length ?? 0) > 0
  const hasLive = running && (heartbeatText(liveDetail) != null || (subSteps?.length ?? 0) > 0)
  return (
    <div className={cn('min-w-0 space-y-2 rounded-lg border bg-surface-subtle p-2', running ? 'border-state-working-border' : 'border-border')}>
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="flex shrink-0 items-center gap-1">
          <SubagentStatusGlyph status={status} />
          {status !== 'finished' && <span aria-hidden="true" className="text-muted-foreground">{SUBAGENT_STATUS_LABEL[status]}</span>}
        </span>
        <span className="min-w-0 truncate font-mono text-sm font-semibold text-card-foreground">{name}</span>
        {role != null && role !== '' && <span className="min-w-0 truncate text-muted-foreground">{role}</span>}
        {!running && duration != null && <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{duration}</span>}
      </div>
      {whatItDid != null && whatItDid !== '' && (
        <p title={whatItDid} className="line-clamp-2 text-sm text-card-foreground">
          {whatItDid}
        </p>
      )}
      {hasProvenanceRow && (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <CausalBadge triggeredBy={triggeredBy} />
          <FileChipList files={filesTouched} label={FILES_TOUCHED_LABEL} />
        </div>
      )}
      {hasLive && (
        <div className="space-y-2 border-t border-divider pt-2">
          <Heartbeat liveDetail={liveDetail} />
          <SubStepList steps={subSteps} />
        </div>
      )}
      {children}
    </div>
  )
}

// One collapsed line per subagent a batch `task` call started (docs/DESIGN.md "Chat"): never
// grouped by `groupToolItems`, identity is the stable `item.id` (so a later activation can
// reopen the same subagent's full transcript panel, spec 004).
export function SubagentRow({ item, agent, showGoal, variant = 'default' }: SubagentRowProps & { agent: SubAgentItem; variant?: 'default' | 'card' }) {
  if (variant === 'card') {
    return (
      <SubagentCardBody agent={agent}>
        <SubagentBody item={item} showGoal={showGoal} />
      </SubagentCardBody>
    )
  }
  const { status, duration, whatItDid: resultSummary } = agent
  const meta = (
    <RowTrailing
      icon={<SubagentStatusGlyph status={status} />}
      lead={status !== 'finished' ? <span aria-hidden="true">{SUBAGENT_STATUS_LABEL[status]}</span> : undefined}
      duration={status !== 'running' && duration != null ? duration : undefined}
    />
  )
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
