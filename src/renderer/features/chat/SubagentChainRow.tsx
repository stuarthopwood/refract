// A Stage is a run of subagent items sharing a messageId with nothing between them but a hidden-tool
// failure notice (grouping in groupSubagentStages.ts). StageGroupRow renders one in place;
// SubagentChainRow renders once per turn, at the end, when there are two or more Stages.
import * as React from 'react'
import { BotIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { openHostedPanel } from '../right-pane/hosted-panel-actions'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'
import { ChainStageLine } from './ChainStageLine'
import { SpineList, SpineItem, SPINE_HOST_CONTENT_CLASS } from './SpineList'
import { StageContextBrief } from './StageContextBrief'
import { StageUsesLine } from './StageDependencies'
import { stageRowDomId } from './stageJump'
import { SubagentBody, SubagentRow } from './SubagentRow'
import { SubagentGoalPreview } from './SubagentGoalPreview'
import { formatElapsed } from './formatElapsed'
import { stageHeading, extractContextLabel, extractResultSummary, stageRollupText } from './stageMeta'
import { joinMetaParts } from './toolRowLabels'
import type { StageGroup } from './groupSubagentStages'
import { useStickyDisclosure } from './useStickyDisclosure'
import {
  chatRowStatus,
  SUBAGENT_ERROR_TEXT_CLASS,
  SUBAGENT_STATUS_LABEL,
  SubagentStatusGlyph,
  subagentStatusTextClass,
  summarizeSubagentStatuses,
  type SubagentRowStatus
} from '../subagents/subagentStatus'

import { overallStatus, stageSettleSummary, stageRunningSummary, stageTimeRange, type SubagentItem } from './subagentChainStatus'

// Cancelled is always its own word, never folded into "failed".
function rollupPhrase(counts: Record<SubagentRowStatus, number>): string {
  const parts: string[] = []
  if (counts.running > 0) parts.push(`${counts.running} running`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`)
  if (counts.exited > 0) parts.push(`${counts.exited} exited`)
  if (counts.parked > 0) parts.push(`${counts.parked} parked`)
  return parts.join(', ')
}

/** One Stage rendered in place; always a `CollapsedLine` so the row never switches element type as agents stream in. */
export function StageGroupRow({ group, sessionId, shimmer }: { group: StageGroup; sessionId: string | null; shimmer?: boolean }) {
  const statuses = group.items.map((item) => chatRowStatus(item.status))
  const counts = summarizeSubagentStatuses(statuses)
  const status = overallStatus(counts)
  const isRunning = status === 'running'
  const total = group.items.length
  const labelColorClass = subagentStatusTextClass(counts)

  // Only members mounting while the Stage is live fade in; seeded during render so a settled reopen never flashes an invisible frame.
  const seenIdsRef = React.useRef<Set<string> | null>(null)
  if (seenIdsRef.current === null) {
    const seen = new Set<string>()
    if (!isRunning) for (const item of group.items) seen.add(item.id)
    seenIdsRef.current = seen
  }
  const seenIds = seenIdsRef.current
  React.useEffect(() => {
    for (const item of group.items) seenIds.add(item.id)
  }, [group.items, seenIds])
  // Once a turn has 2+ Stages (live `group.totalStages`), running alone no longer auto-opens a Stage; the per-turn chain row carries the
  // live overview. A failed/cancelled/exited member opens it at once (raw counts, not overall status). The sticky latch below keeps
  // an already-open Stage open; a fresh mount of a multi-Stage turn starts closed. (#1000)
  const hasBadMember = counts.failed > 0 || counts.cancelled > 0 || counts.exited > 0
  const isMultiStageTurn = group.totalStages > 1
  const isOpenByDefault = total > 1 && (isMultiStageTurn ? hasBadMember : isRunning || hasBadMember)
  // Upward-only: auto-opens while running/failed/cancelled/exited, but only the user's own toggle closes it (keeps focus on the trigger, WCAG 2.4.3). (#991)
  const { open, onOpenChange } = useStickyDisclosure(sessionId, group.id, isOpenByDefault)

  // When a 2nd agent joins, the solo SubagentBody unmounts and focus falls to <body> synchronously, so focus-inside is tracked via
  // focusin/focusout on a wrapper that survives the swap and redirected to the trigger. Pre-wrapping the solo body in a
  // SpineList was rejected: it adds a permanent rail to every solo Stage. (#1001)
  // A callback ref is needed because the content is not mounted while collapsed, so a one-time effect would never attach the listeners.
  const memberContentNodeRef = React.useRef<HTMLDivElement | null>(null)
  const triggerRef = React.useRef<HTMLElement>(null)
  const focusWasInsideRef = React.useRef(false)
  const prevTotalRef = React.useRef(total)

  const handleMemberContentFocusIn = React.useCallback(() => {
    focusWasInsideRef.current = true
  }, [])
  const handleMemberContentFocusOut = React.useCallback((event: FocusEvent) => {
    // A window blur fires focusout but leaves the target as activeElement; keep the flag so a later join still redirects focus.
    if (event.target === document.activeElement) return
    // Clear the flag only when focus genuinely left the whole container; internal moves also fire focusout on the old target.
    const lost = event.target as Element | null
    requestAnimationFrame(() => {
      if (!lost || !lost.isConnected) return
      const container = memberContentNodeRef.current
      if (container && container.contains(document.activeElement)) return
      focusWasInsideRef.current = false
    })
  }, [])
  const memberContentRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      const prevEl = memberContentNodeRef.current
      if (prevEl) {
        prevEl.removeEventListener('focusin', handleMemberContentFocusIn)
        prevEl.removeEventListener('focusout', handleMemberContentFocusOut)
      }
      memberContentNodeRef.current = el
      if (el) {
        el.addEventListener('focusin', handleMemberContentFocusIn)
        el.addEventListener('focusout', handleMemberContentFocusOut)
      }
    },
    [handleMemberContentFocusIn, handleMemberContentFocusOut]
  )

  React.useLayoutEffect(() => {
    const prevTotal = prevTotalRef.current
    prevTotalRef.current = total
    if (prevTotal !== 1 || total <= 1 || !focusWasInsideRef.current) return
    focusWasInsideRef.current = false
    if (document.activeElement === document.body || document.activeElement === null) {
      triggerRef.current?.focus({ preventScroll: true })
    }
  }, [total])

  const { startedAt, endedAt } = stageTimeRange(group.items)
  const durationMs = startedAt != null && endedAt != null ? endedAt - startedAt : undefined
  const summaryText = isRunning ? stageRunningSummary(counts, total) : stageSettleSummary(group)
  const startTimeText =
    startedAt != null ? new Date(startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : undefined
  // A solo Stage with a captured context shows the context as its label, so its one agent's name goes in the summary slot.
  const soloContextLabel = total === 1 && group.context ? extractContextLabel(group.context) : null
  const soloAgentName = soloContextLabel ? group.items[0]!.name : undefined
  // A failed/cancelled/exited solo Stage shows its reason next to its goal, not only behind the toggle. (#1077)
  const soloItem = total === 1 ? group.items[0]! : undefined
  const soloStatus = soloItem ? chatRowStatus(soloItem.status) : undefined
  const soloIsUnsettledBad = soloStatus === 'failed' || soloStatus === 'cancelled' || soloStatus === 'exited'
  const soloFailureReason = soloItem && soloIsUnsettledBad && soloItem.result != null ? extractResultSummary(soloItem.result) : undefined
  // `context` is stamped only on a call's spec-index-0 item, so correlate by toolCallId: a member's goal is suppressed when any item of its call has a context. (#1077)
  const toolCallIdsWithContext = new Set(group.items.filter((item) => item.context).map((item) => item.toolCallId))
  // Status word and start time are each a narrow-hideable unit with their separator inside the hideable span (below @max-[32rem]),
  // so the label gives up space last; the settled wording already states failures, so the status word shows only while running.
  const meta = (
    <span aria-hidden="true" className="flex min-w-0 shrink items-center gap-1 whitespace-nowrap text-xs leading-5 text-muted-foreground">
      {joinMetaParts([<span key="summary" className="min-w-0 truncate" title={summaryText}>{summaryText}</span>])}
      {durationMs != null && (
        // Hides at @max-[20rem], after the status/start-time spans, so the duration is the last optional part to go.
        <span className="@max-[20rem]:hidden">
          <span> · </span>
          <span className="tabular-nums">{formatElapsed(durationMs)}</span>
        </span>
      )}
      {isRunning && (
        <span className="@max-[32rem]:hidden">
          <span> · </span>
          {SUBAGENT_STATUS_LABEL[status]}
        </span>
      )}
      {startTimeText != null && (
        <span className="@max-[32rem]:hidden">
          <span> · </span>
          <span className="tabular-nums">{`started ${startTimeText}`}</span>
        </span>
      )}
    </span>
  )
  const stageLabel = stageHeading(group.stageIndex, group.label)
  // The heading's speech form already says "Stage N", so the count clause is just "of M".
  const triggerAriaLabel = `${stageHeading(group.stageIndex, group.label, true)}, of ${group.totalStages}${soloAgentName ? `, ${soloAgentName}` : ''}, ${summaryText}${isRunning ? `, ${SUBAGENT_STATUS_LABEL[status]}` : ''}${durationMs != null ? `, ${formatElapsed(durationMs)}` : ''}${startTimeText != null ? `, started ${startTimeText}` : ''}`
  // A one-agent Stage's content already carries `pl-8`, so the brief/Uses lines take only `pr-2` there.
  const columnClassName = total > 1 ? cn(LABEL_COLUMN_CONTENT_CLASS, 'pr-2') : 'pr-2'

  return (
    <CollapsedLine
      ref={triggerRef}
      id={stageRowDomId(sessionId, group.id)}
      icon={<SubagentStatusGlyph status={status} />}
      label={stageLabel}
      labelShimmer={shimmer && isRunning}
      labelClassName={cn('min-w-16', labelColorClass)}
      summary={soloAgentName}
      summaryFixedWidth={soloAgentName !== undefined}
      meta={meta}
      metaClassName="min-w-0 shrink"
      open={open}
      onOpenChange={onOpenChange}
      triggerAriaLabel={triggerAriaLabel}
      contentClassName={total > 1 ? SPINE_HOST_CONTENT_CLASS : LABEL_COLUMN_CONTENT_CLASS}
    >
      {/* aria-live="off": inside the transcript's role="log", so the brief/Uses line is not announced as a log addition. */}
      <div aria-live="off" className="space-y-1">
        {group.context && <StageContextBrief id={`${group.id}-context`} context={group.context} className={columnClassName} />}
        {/* A context-less solo Stage's goal renders here, before "Uses:", matching the context-bearing order. */}
        {!group.context && soloItem && (
          <div className={columnClassName}>
            <SubagentGoalPreview task={soloItem.task} />
          </div>
        )}
        {soloFailureReason != null && (
          <p className={cn(columnClassName, 'text-xs', soloStatus === 'failed' ? SUBAGENT_ERROR_TEXT_CLASS : 'text-muted-foreground')}>
            {soloFailureReason}
          </p>
        )}
        <StageUsesLine dependencies={group.dependencies} sessionId={sessionId} className={columnClassName} />
        {/* Scoped to the member content that swaps element type on a 1-to-2 transition, so focus tracking ignores the brief/Uses line. (#1001) */}
        {/* A member's goal is suppressed only when its own call had a context; a solo body never shows it (rendered above). (#1077) */}
        <div ref={memberContentRef}>
          {total > 1 ? (
            <SpineList gap="member">
              {group.items.map((item) => (
                <SpineItem key={item.id} isNew={isRunning && !seenIds.has(item.id)}>
                  <SubagentRow item={item} showGoal={!toolCallIdsWithContext.has(item.toolCallId)} />
                </SpineItem>
              ))}
            </SpineList>
          ) : (
            <SubagentBody item={group.items[0]!} showGoal={false} />
          )}
        </div>
      </div>
    </CollapsedLine>
  )
}

/** A ghost icon-only button opening the subagents panel, sibling of the chain's disclosure trigger. */
function ChainShowPanelButton({ sessionId }: { sessionId: string | null }) {
  if (!sessionId) return null
  return (
    <Tooltip>
      {/* aria-describedby={undefined}: aria-label is already the full description. */}
      <TooltipTrigger asChild aria-describedby={undefined}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Show subagents panel"
          onClick={(event) => openHostedPanel('subagents', sessionId, { opener: event.currentTarget })}
        >
          <BotIcon aria-hidden className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Show subagents panel</TooltipContent>
    </Tooltip>
  )
}

/** The per-turn summary, shown only for two or more Stages; `mt-6` matches `TurnTotalLine`'s turn rhythm. */
export function SubagentChainRow({ stages, sessionId }: { stages: StageGroup[]; sessionId: string | null }) {
  // Stages mounting while the chain is live fade in; seeded during render, and before the early return (hooks rule).
  const seenStageIdsRef = React.useRef<Set<string> | null>(null)
  const allItems = stages.flatMap((stage) => stage.items)
  const statuses = allItems.map((item) => chatRowStatus(item.status))
  const counts = summarizeSubagentStatuses(statuses)
  const status = overallStatus(counts)
  const isRunning = status === 'running'

  if (seenStageIdsRef.current === null) {
    const seen = new Set<string>()
    if (!isRunning) for (const stage of stages) seen.add(stage.id)
    seenStageIdsRef.current = seen
  }
  const seenStageIds = seenStageIdsRef.current
  React.useEffect(() => {
    for (const stage of stages) seenStageIds.add(stage.id)
  }, [stages, seenStageIds])

  // Hooks must precede the early return; tick once a second only while the chain is rendered and running.
  const [, forceTick] = React.useReducer((count: number) => count + 1, 0)
  React.useEffect(() => {
    if (!isRunning || stages.length < 2) return
    const interval = setInterval(forceTick, 1000)
    return () => clearInterval(interval)
  }, [isRunning, stages.length])

  // Fully controlled so a Stage failing after first mount still opens the row; sync upward only, never auto-close an untouched row.
  const isUnsettled = counts.running > 0 || counts.failed > 0 || counts.cancelled > 0 || counts.exited > 0
  // `turnKey` is undefined only with no Stages, where useStickyDisclosure falls back to local state.
  const turnKey = stages[0]?.id
  const toggleRowId = turnKey ? `chain:${turnKey}` : null
  const { open, onOpenChange } = useStickyDisclosure(sessionId, toggleRowId, isUnsettled)

  if (stages.length < 2) return null

  const { startedAt, endedAt } = stageTimeRange(allItems)
  // Wall-clock from the first Stage's start; aria-hidden while running so a screen reader reads only the settled value.
  const durationMs = startedAt == null ? undefined : isRunning ? Date.now() - startedAt : endedAt != null ? endedAt - startedAt : undefined
  const rollup = rollupPhrase(counts)
  const summary = `${stages.length} stages, ${allItems.length} agent${allItems.length === 1 ? '' : 's'}${rollup ? `, ${rollup}` : ''}`
  // The visible status word lives in `meta`; triggerAriaLabel restates it, so `meta` is aria-hidden.
  const statusVisible = status !== 'finished'
  const meta = (
    <span aria-hidden="true" className="flex min-w-0 shrink items-center gap-1 text-xs text-muted-foreground">
      {statusVisible && (
        <span className="min-w-0 truncate" title={SUBAGENT_STATUS_LABEL[status]}>
          {SUBAGENT_STATUS_LABEL[status]}
        </span>
      )}
      {durationMs != null && (
        // The separator is bundled in the hideable span so hiding the duration never leaves a dangling "·".
        <span className="@max-[20rem]:hidden whitespace-nowrap">
          {statusVisible && <span> · </span>}
          <span className="tabular-nums">{formatElapsed(durationMs)}</span>
        </span>
      )}
    </span>
  )

  return (
    <CollapsedLine
      icon={<SubagentStatusGlyph status={status} />}
      label="Subagents"
      summary={summary}
      summaryWrap
      meta={meta}
      metaClassName="min-w-0 shrink"
      open={open}
      onOpenChange={onOpenChange}
      className="-mx-1 mt-6 rounded-lg bg-card p-1 ring-1 ring-divider"
      triggerClassName="hover:bg-transparent"
      contentClassName={SPINE_HOST_CONTENT_CLASS}
      // The ticking duration is omitted from the accessible name while running so it does not change every second.
      triggerAriaLabel={`Subagents, ${summary}${status !== 'finished' ? `, ${SUBAGENT_STATUS_LABEL[status]}` : ''}${!isRunning && durationMs != null ? `, ${formatElapsed(durationMs)}` : ''}`}
      action={<ChainShowPanelButton sessionId={sessionId} />}
    >
      <SpineList gap="stage">
        {stages.map((stage) => (
          <SpineItem key={stage.id} isNew={!seenStageIds.has(stage.id) && isRunning}>
            <ChainStageLine stage={stage} sessionId={sessionId} />
          </SpineItem>
        ))}
      </SpineList>
    </CollapsedLine>
  )
}
