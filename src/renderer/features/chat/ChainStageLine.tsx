import { cn } from '@/lib/utils'
import * as React from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { useSettingsStore } from '@/state'
import { IconButton } from '@/components/IconButton'
import { FadeCollapse } from '@/components/FadeCollapse'
import { StageHeader } from '../subagents/card/StageHeader'
import { stageAccessibleName, stageAgentsGridClass, stageRowModel } from '../subagents/card/stageRowModel'
import type { SubAgentItem } from '../subagents/viewModel'
import { StageUsesLine } from './StageDependencies'
import { SpineItem, SpineList } from './SpineList'
import { SubagentCardButton } from './SubagentRow'
import { rowVisibility } from './transcriptRowVisibility'
import { JumpToStageContext } from './stageJump'
import { stageHeading } from './stageMeta'
import { useStickyDisclosure } from './useStickyDisclosure'
import type { StageGroup } from './groupSubagentStages'
import type { SubagentItem } from './subagentChainStatus'

/** The Stage's own toggle key; `card:` keeps it apart from `StageGroupRow`'s bare id and the panel's `panel:` keys (FR-150 d). */
export const stageToggleRowId = (stageId: string): string => `card:${stageId}`

function ChainAgentEntry({ item, agent, sessionId, flat, stageTitle }: { item: SubagentItem; agent: SubAgentItem; sessionId: string | null; flat: boolean; stageTitle: string | null }) {
  // Rule 3 (#2318): an agent name equal to the Stage title is not repeated.
  const fallbackLabel = agent.name !== stageTitle ? agent.name : undefined
  return <SubagentCardButton item={item} agent={agent} sessionId={sessionId} flat={flat} fallbackLabel={fallbackLabel} />
}

// A labelled `role="group"` per stage: `SpineList`'s `<ol>` only gives an unlabelled "1 of 2".
// A running Stage opens and a settled one collapses on its own; the developer's own toggle wins for the Session (FR-149).
// The header and outcome always show, and the chevron is a plain button so automatic changes never move focus,
// except an auto-collapse that would strand focus in the content, which hands it to the chevron.

/** True when an auto-collapse is about to make the content inert while focus sits inside it (WCAG 2.4.3); the chevron then takes focus. */
export function shouldMoveFocusToChevron(wasExpanded: boolean, expanded: boolean, focusInsideContent: boolean): boolean {
  return wasExpanded && !expanded && focusInsideContent
}

export function ChainStageLine({ stage, sessionId }: { stage: StageGroup; sessionId: string | null }) {
  const { status } = stage.view
  const { parallelCount } = stageRowModel(stage.view)
  const { open: expanded, onOpenChange } = useStickyDisclosure(sessionId, stageToggleRowId(stage.id), status === 'running', { latch: false })
  const transcriptDisplay = useSettingsStore((s) => s.settings.transcriptDisplay)
  const jumpToStageRow = React.useContext(JumpToStageContext)
  const canJump = rowVisibility(stage, transcriptDisplay) === 'visible' && sessionId != null && jumpToStageRow != null
  const speechHeading = stageHeading(stage.stageIndex, stage.view.cleanTitle, true)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const chevronRef = React.useRef<HTMLButtonElement>(null)
  const wasExpandedRef = React.useRef(expanded)
  // A layout effect: it runs after the commit that makes `FadeCollapse` inert but before the browser drops focus to <body>.
  React.useLayoutEffect(() => {
    const wasExpanded = wasExpandedRef.current
    wasExpandedRef.current = expanded
    const active = document.activeElement
    if (shouldMoveFocusToChevron(wasExpanded, expanded, active != null && contentRef.current?.contains(active) === true)) chevronRef.current?.focus({ preventScroll: true })
  }, [expanded])
  return (
    // aria-live="off": the running Stage's outcome line changes often and must not be announced; the settle announcer speaks for it.
    <div role="group" aria-label={stageAccessibleName(stage.view)} aria-live="off" className="@container border-t border-divider text-sm first:border-t-0" data-status={status}>
      <StageHeader
        stage={stage.view}
        expanded={expanded}
        // Without a jump button the column takes focus itself, so the outcome line stays reachable.
        columnFocusable={!canJump}
        renderTitle={
          canJump
            ? ({ content }) => (
                <button
                  type="button"
                  className="-mx-1 -my-1 flex min-w-0 max-w-full cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-muted hover:underline focus-visible:outline-(length:--focus-ring-width) focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  aria-label={`Go to ${speechHeading}`}
                  onClick={() => jumpToStageRow(stage.id)}
                >
                  {content}
                </button>
              )
            : undefined
        }
        trailing={
          <IconButton
            ref={chevronRef}
            variant="ghost"
            size="icon-xs"
            aria-expanded={expanded}
            label={`${speechHeading} agents`}
            onClick={() => onOpenChange(!expanded)}
          >
            <ChevronRightIcon aria-hidden className={cn('size-4 transition-transform motion-reduce:transition-none', expanded && 'rotate-90')} />
          </IconButton>
        }
      />
      {/* pl-10 = the row's px-4 (16px), the 16px status column and its 8px gap, so "Uses:" starts under the title. */}
      <StageUsesLine dependencies={stage.view.dependencies} sessionId={sessionId} className="pl-10 pr-4" />
      <FadeCollapse show={expanded}>
        <div ref={contentRef}>
          {/* The same inset puts the agent panels under the Stage title; no rail or elbows (#2235). A single agent's guide line sits at the 40px mark (#2318, rule 6). */}
          <SpineList bare className={cn('pb-2 pr-4 pl-10', stageAgentsGridClass(parallelCount))}>
            {stage.items.map((item, index) => (
              <SpineItem key={item.id} isNew={false}>
                <ChainAgentEntry item={item} agent={stage.view.agents[index]!} sessionId={sessionId} flat={stage.items.length === 1} stageTitle={stage.view.cleanTitle} />
              </SpineItem>
            ))}
          </SpineList>
        </div>
      </FadeCollapse>
    </div>
  )
}
