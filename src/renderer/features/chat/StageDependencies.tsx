// "Uses:" lists a Stage's real `agent://<id>` dependencies on earlier Stages; `applyDependencies` already
// drops unmatched or non-earlier references. Shared by the chain Stage rows and the Subagent panel (ADR 0003).
import * as React from 'react'
import { cn } from '@/lib/utils'
import { EMPTY_READOUT_ENTRY, useReadoutStore } from '@/state'
import { openHostedPanel } from '../right-pane/hosted-panel-actions'
import type { StageDependency } from './groupSubagentStages'
import { mutedLinkClassName } from './Markdown'

/** Groups `dependencies` by earlier Stage in first-seen order, so "Uses: A, B (Stage 1), C (Stage 2)" never interleaves. */
function groupByStage(dependencies: StageDependency[]): Array<{ stageIndex: number; deps: StageDependency[] }> {
  const groups: Array<{ stageIndex: number; deps: StageDependency[] }> = []
  for (const dep of dependencies) {
    const group = groups.find((g) => g.stageIndex === dep.stageIndex)
    if (group) group.deps.push(dep)
    else groups.push({ stageIndex: dep.stageIndex, deps: [dep] })
  }
  return groups
}

/** One Stage's "Uses:" line; an agent is a link button only when the live list knows the exact match (`toolCallId`+`specIndex`), else plain text.
 * The label indent is the caller's choice (`className`). */
export function StageUsesLine({
  dependencies,
  sessionId,
  className
}: {
  dependencies: StageDependency[]
  sessionId: string | null
  className?: string
}) {
  // Stable singleton: a fresh `?? []` each render would look like a changed snapshot to zustand v5.
  const subagents = useReadoutStore((s) => (sessionId ? (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).subagents : EMPTY_READOUT_ENTRY.subagents))
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
                        // `SubagentSummary.id` is name-based; this selects exactly the matched agent.
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
