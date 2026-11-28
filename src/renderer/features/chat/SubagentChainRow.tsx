// A Stage is a run of subagent items sharing a messageId with nothing between them but a hidden-tool
// failure notice (grouping in groupSubagentStages.ts). StageGroupRow renders one in place;
// SubagentChainRow renders once per turn, at the end, when there are two or more Stages.
import * as React from 'react'
import { BotIcon, ChevronRightIcon } from 'lucide-react'
import { FadeCollapse } from '@/components/FadeCollapse'
import { IconButton } from '@/components/IconButton'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { openHostedPanel } from '../right-pane/hosted-panel-actions'
import { ChainStageLine } from './ChainStageLine'
import { SpineList, SpineItem, SPINE_HOST_CONTENT_CLASS } from './SpineList'
import { StageContextBrief } from './StageContextBrief'
import { StageUsesLine } from './StageDependencies'
import { stageRowDomId } from './stageJump'
import { SubagentCardButton, openSubagentInPanel } from './SubagentRow'
import { EMPTY_READOUT_ENTRY, useReadoutStore } from '@/state'
import type { SubagentItem } from './subagentChainStatus'
import { SubagentGoalPreview } from './SubagentGoalPreview'
import { stageHeading } from './stageMeta'
import type { StageGroup } from './groupSubagentStages'
import { deriveHeader } from '../subagents/viewModel/derive'
import { StageHeader } from '../subagents/card/StageHeader'
import { SubagentsCardHeader } from '../subagents/card/SubagentsCardHeader'
import { stageAccessibleName, stageAgentsGridClass, stageRowModel } from '../subagents/card/stageRowModel'
import { useStickyDisclosure } from './useStickyDisclosure'
import { summarizeSubagentStatuses } from '../subagents/subagentStatus'
import { overallStatus } from './subagentChainStatus'

/** One Stage rendered in place, drawn with the shared `StageHeader` so a Stage looks the same on every surface. */
export function StageGroupRow({ group, sessionId }: { group: StageGroup; sessionId: string | null }) {
  const { status } = group.view
  const isRunning = status === 'running'
  const total = group.items.length
  const { counts } = group.view

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
  // an already-open Stage open; a fresh mount of a multi-Stage turn starts closed.
  const hasBadMember = counts.failed > 0 || counts.cancelled > 0 || counts.exited > 0
  const isMultiStageTurn = group.totalStages > 1
  const isOpenByDefault = total > 1 && (isMultiStageTurn ? hasBadMember : isRunning || hasBadMember)
  // Upward-only: auto-opens while running/failed/cancelled/exited, but only the user's own toggle closes it (keeps focus on the trigger, WCAG 2.4.3).
  const { open, onOpenChange } = useStickyDisclosure(sessionId, group.id, isOpenByDefault)

  // When a 2nd agent joins, the solo SubagentBody unmounts and focus falls to <body> synchronously, so focus-inside is tracked via
  // focusin/focusout on a wrapper that survives the swap and redirected to the trigger. Pre-wrapping the solo body in a
  // SpineList was rejected: it adds a permanent rail to every solo Stage.
  // A callback ref is needed because the content is not mounted while collapsed, so a one-time effect would never attach the listeners.
  const memberContentNodeRef = React.useRef<HTMLDivElement | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
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

  // The Stage header and its outcome line carry the roll-up, status and duration; no per-row "3 done" text is drawn here.
  const stageLabel = stageHeading(group.stageIndex, group.view.cleanTitle, true)
  // A failed solo Stage's reason is the header's outcome line; the body never repeats it.
  const soloItem = total === 1 ? group.items[0]! : undefined
  // The content sits at the header's 40px mark (16px padding, 16px status column, 8px gap), so the brief and the cards start under the title.
  const columnClassName = 'pl-10 pr-4'
  const { parallelCount } = stageRowModel(group.view)

  return (
    <div
      id={stageRowDomId(sessionId, group.id)}
      tabIndex={-1}
      role="group"
      aria-label={stageAccessibleName(group.view)}
      aria-live="off"
      className="@container text-sm focus-visible:outline-(length:--focus-ring-width) focus-visible:-outline-offset-2 focus-visible:outline-ring"
      data-status={status}
    >
      <StageHeader
        stage={group.view}
        expanded={open}
        columnFocusable
        trailing={
          <>
            {soloItem && <AgentShowButton item={soloItem} name={group.view.agents[0]?.name ?? soloItem.name} sessionId={sessionId} />}
            <IconButton
              ref={triggerRef}
              variant="ghost"
              size="icon-xs"
              aria-expanded={open}
              label={`${stageLabel} agents`}
              onClick={() => onOpenChange(!open)}
            >
              <ChevronRightIcon aria-hidden className={cn('size-4 transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
            </IconButton>
          </>
        }
      />
      <FadeCollapse show={open}>
        {/* aria-live="off": the brief/Uses lines are static context, so an automatic expand must not announce them. */}
        <div aria-live="off" className="space-y-1 pb-2">
          {group.context && <StageContextBrief id={`${group.id}-context`} context={group.context} className={columnClassName} />}
          {/* A context-less solo Stage's goal renders here, before "Uses:", matching the context-bearing order. */}
          {!group.context && soloItem && (
            <div className={columnClassName}>
              <SubagentGoalPreview task={soloItem.task} />
            </div>
          )}
          <StageUsesLine dependencies={group.view.dependencies} sessionId={sessionId} className={columnClassName} />
          {/* Scoped to the member content that swaps element type on a 1-to-2 transition, so focus tracking ignores the brief/Uses line. */}
          <div ref={memberContentRef} className={columnClassName}>
            {total > 1 ? (
              <SpineList gap="member" bare className={stageAgentsGridClass(parallelCount)}>
                {group.items.map((item, index) => (
                  <SpineItem key={item.id} isNew={isRunning && !seenIds.has(item.id)}>
                    {/* The card is one button, so Show sits beside it, never inside it. */}
                    <div className="flex items-start gap-1">
                      <div className="min-w-0 flex-1">
                        <SubagentCardButton item={item} agent={group.view.agents[index]!} sessionId={sessionId} />
                      </div>
                      <AgentShowButton item={item} name={group.view.agents[index]?.name ?? item.name} sessionId={sessionId} />
                    </div>
                  </SpineItem>
                ))}
              </SpineList>
            ) : (
              <SubagentCardButton item={group.items[0]!} agent={group.view.agents[0]!} sessionId={sessionId} flat stageTitle={group.view.cleanTitle} />
            )}
          </div>
        </div>
      </FadeCollapse>
    </div>
  )
}

/** A ghost icon button opening one agent in the Subagents panel. Every agent has one: before its live registry entry exists it selects the agent by key and the panel picks it up on arrival. */
function AgentShowButton({ item, name, sessionId }: { item: SubagentItem; name: string; sessionId: string | null }) {
  const subagents = useReadoutStore((s) => (sessionId ? (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).subagents : EMPTY_READOUT_ENTRY.subagents))
  if (!sessionId) return null
  const match = subagents.find((s) => s.toolCallId === item.toolCallId && s.specIndex === item.specIndex)
  return (
    <IconButton variant="ghost" size="icon-xs" label={`Show ${name} in Subagents panel`} onClick={(event) => openSubagentInPanel(sessionId, { id: match?.id, toolCallId: item.toolCallId, specIndex: item.specIndex }, event.currentTarget)}>
      <BotIcon aria-hidden className="size-4" />
    </IconButton>
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
          className="shrink-0"
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
  const header = React.useMemo(() => deriveHeader(stages.map((stage) => stage.view)), [stages])
  const counts = summarizeSubagentStatuses(stages.flatMap((stage) => stage.view.agents).map((agent) => agent.status))
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

  const { startedAt, totalDurationMs, headerStats, overallGoal } = header
  // Wall-clock from the first Stage's start while running, so the visible duration ticks; settled, the total.
  const durationMs = startedAt == null ? undefined : isRunning ? Date.now() - startedAt : totalDurationMs

  return (
    <SubagentsCardHeader
      status={status}
      headerStats={headerStats}
      stages={stages.map((stage) => stage.view)}
      goal={overallGoal}
      durationMs={durationMs}
      open={open}
      onOpenChange={onOpenChange}
      action={<ChainShowPanelButton sessionId={sessionId} />}
      className="mt-6"
      contentClassName={cn(SPINE_HOST_CONTENT_CLASS, 'pb-1')}
    >
      <SpineList gap="stage" bare>
        {stages.map((stage) => (
          <SpineItem key={stage.id} isNew={!seenStageIds.has(stage.id) && isRunning}>
            <ChainStageLine stage={stage} sessionId={sessionId} />
          </SpineItem>
        ))}
      </SpineList>
    </SubagentsCardHeader>
  )
}
