import * as React from 'react'
import { useSettingsStore } from '@/state'
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

// FR-010, FR-006: the summary slot reads the raw tool id (only while the setting is on, muted like
// the target and truncating with it, before the label does), then the target.
export function toolRowSummary(rawId: string | undefined, target: React.ReactNode): React.ReactNode | undefined {
  const hasTarget = target !== undefined && target !== null && target !== ''
  if (rawId === undefined) return hasTarget ? target : undefined
  return (
    <>
      <span data-slot="tool-raw-id">{rawId}</span>
      {hasTarget && (
        <>
          {' '}
          {target}
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
