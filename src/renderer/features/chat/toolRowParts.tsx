import * as React from 'react'
import { useSettingsStore } from '@/state'
import { cn } from '@/lib/utils'
import { InlineCode } from '@/components/ui/inline-code'
import { StatusIcon, type RowStatus } from './toolStatus'
import { toolAriaPrefix } from './toolVerbs'

// Spec 023 research Decision 6: the pieces a tool row and a tool group row both assemble (the
// raw-id summary, the trailing status meta and the accessible name), kept out of `ToolRow.tsx`.

// FR-012: "Show tool names on rows" (`transcriptDisplay.toolNames`), off by default.
export function useShowToolNames(): boolean {
  return useSettingsStore((state) => state.settings.transcriptDisplay?.toolNames === true)
}

// FR-007: a non-empty intent is the label; whitespace-only counts as absent.
export function hasIntent(intent: string | undefined): boolean {
  return !!intent?.trim()
}

// A tool target (path, command, code or search pattern) as a muted inline-code chip. Truncating, it
// is an inline-block whose text ends in its own ellipsis so the right edge stays drawn; inside a
// wrapping `CollapsedLine` summary (`data-summary-wrap`) it flows inline and keeps its fill per line.
export function ToolTarget({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <InlineCode
      data-slot="tool-target"
      className={cn(
        'inline-block max-w-full truncate py-1 align-top leading-3 text-tool-row-fg',
        'group-data-[summary-wrap]/summary:inline group-data-[summary-wrap]/summary:overflow-visible group-data-[summary-wrap]/summary:whitespace-normal',
        className
      )}
    >
      {children}
    </InlineCode>
  )
}

// FR-010, FR-006: the summary slot reads the raw tool id (only while the setting is on, muted like
// the target and truncating with it, before the label does), then the target. `plain` keeps a
// non-code target (a skill name) out of the chip.
export function toolRowSummary(rawId: string | undefined, target: React.ReactNode, plain = false): React.ReactNode | undefined {
  const hasTarget = target !== undefined && target !== null && target !== ''
  const targetNode = hasTarget && !plain ? <ToolTarget>{target}</ToolTarget> : target
  if (rawId === undefined) return hasTarget ? targetNode : undefined
  return (
    <>
      <span data-slot="tool-raw-id">{rawId}</span>
      {hasTarget && (
        <>
          {' '}
          {targetNode}
        </>
      )}
    </>
  )
}

// FR-001: the status icon trails the row, ahead of the duration or counts (`rest`).
export function toolRowMeta(status: RowStatus, rest: React.ReactNode | undefined): React.ReactNode {
  return (
    <span className="inline-flex h-5 items-center gap-1 align-top">
      <StatusIcon status={status} />
      {rest}
    </span>
  )
}

// FR-015: spec 022's status prefix (only where the label cannot carry the status), the label, the
// raw id while the setting is on, then the target. A running call's intent already reads as its
// own progress, so it takes no "Running" prefix.
export function toolAriaHead(
  status: RowStatus,
  entryTool: string,
  intentShown: boolean,
  label: string,
  rawId: string | undefined,
  target: string | undefined
): string {
  const prefix = intentShown && status === 'running' ? undefined : toolAriaPrefix(status, entryTool)
  return [prefix, label, rawId, target].filter(Boolean).join(' ')
}

export function joinAriaParts(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => !!part).join(', ')
}
