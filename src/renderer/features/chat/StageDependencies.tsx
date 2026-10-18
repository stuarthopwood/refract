// "Uses:" -- issue #941 grill item 5: a Stage's real `agent://<id>` dependencies on an earlier
// Stage's agent, never a guess (`groupSubagentStages.ts`'s own `applyDependencies` already
// dropped every reference that matched nothing or pointed at the Stage's own agents or a later
// one, and resolves a repeated name to the LATEST earlier Stage that started it). Shared by the
// Subagent chain's Stage rows (`SubagentChainRow.tsx`) and, in a later PR, the Subagent panel's
// own Stage node (ADR 0003: one component, not two copies).
import * as React from 'react'
import { cn } from '@/lib/utils'
import { EMPTY_READOUT_ENTRY, useReadoutStore } from '@/state'
import { openHostedPanel } from '../right-pane/hosted-panel-actions'
import type { StageDependency } from './groupSubagentStages'
import { mutedLinkClassName } from './Markdown'

/** Groups `dependencies` by the earlier Stage they belong to, preserving first-seen Stage
 * order, so "Uses: G923Code, G923Arch (Stage 1), Story559 (Stage 2)" never interleaves two
 * Stages' own agent ids inside one parenthesis. */
function groupByStage(dependencies: StageDependency[]): Array<{ stageIndex: number; deps: StageDependency[] }> {
  const groups: Array<{ stageIndex: number; deps: StageDependency[] }> = []
  for (const dep of dependencies) {
    const group = groups.find((g) => g.stageIndex === dep.stageIndex)
    if (group) group.deps.push(dep)
    else groups.push({ stageIndex: dep.stageIndex, deps: [dep] })
  }
  return groups
}

/** One Stage's own "Uses:" line (issue #941 grill item 5): each referenced agent is a real,
 * link-styled button (`mutedLinkClassName`, `Markdown.tsx`'s own muted-surface link treatment,
 * so it reads as a link at rest, not only on hover) when the live Subagent list still knows the
 * EXACT matched agent (correlated by `toolCallId`+`specIndex`, not name alone -- gate round 1
 * fix: a repeated agent name across Stages must open the one `applyDependencies` actually
 * resolved to, never whichever same-named row the tracker happens to match first), else plain
 * text (decision 7's own "unbuilt actions are hidden, not disabled" pattern). Renders nothing
 * when `dependencies` is empty (the common case: most Stages have none). Gate round 2 fix (item
 * 4): the label-column indent is the CALLER's own choice (`className`), never hardcoded here --
 * a one-agent Stage's `CollapsibleContent` already supplies it, `ChainStageLine`'s own terse row
 * needs none at all (`basis-full` instead, item 6). */
export function StageUsesLine({
  dependencies,
  sessionId,
  className
}: {
  dependencies: StageDependency[]
  sessionId: string | null
  className?: string
}) {
  // Rules of Hooks: the store read runs unconditionally, before the empty-list early return.
  const subagents = useReadoutStore((s) => (sessionId ? (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).subagents : []))
  if (dependencies.length === 0) return null
  const groups = groupByStage(dependencies)
  return (
    <div className={cn(className, 'flex flex-wrap items-baseline gap-x-1 text-xs text-muted-foreground')}>
      <span className="shrink-0">Uses:</span>
      {groups.map((group, groupIndex) => (
        <span key={group.stageIndex}>
          {group.deps.map((dep, depIndex) => {
            const match = subagents.find((s) => s.toolCallId === dep.toolCallId && s.specIndex === dep.specIndex)
            return (
              <React.Fragment key={dep.agentId}>
                {match && sessionId ? (
                  <button
                    type="button"
                    className={mutedLinkClassName}
                    aria-label={`${dep.agentId}, open in Subagents panel`}
                    onClick={(event) =>
                      openHostedPanel('subagents', sessionId, {
                        selectSubagentId: match.id,
                        // Gate round 3 fix (item 4): disambiguates two same-named agents
                        // (`SubagentSummary.id` is name-based) so exactly the matched one --
                        // not whichever same-named row the tracker finds first -- is selected
                        // and focused in the panel.
                        selectSubagentKey: `${match.toolCallId}:${match.specIndex}`,
                        opener: event.currentTarget
                      })
                    }
                  >
                    {dep.agentId}
                  </button>
                ) : (
                  dep.agentId
                )}
                {depIndex < group.deps.length - 1 ? ', ' : ''}
              </React.Fragment>
            )
          })}
          {` (Stage ${group.stageIndex})`}
          {groupIndex < groups.length - 1 ? ', ' : ''}
        </span>
      ))}
    </div>
  )
}
