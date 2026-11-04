import * as React from 'react'
import { useSettingsStore } from '@/state'
import { cn } from '@/lib/utils'
import { InlineCode } from '@/components/ui/inline-code'
import { SummaryWrapContext } from './CollapsedLine'
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

// Chip look shared by both modes. Ligatures stay off so `--flag` never fuses with its neighbour
// (globals.css turns them on for every `code`); the inset ring keeps the chip visible when a hovered
// or open row paints the same `--md-code-bg` behind it.
const TARGET_CHIP_CLASS = 'text-tool-row-fg ring-1 ring-inset ring-divider [font-variant-ligatures:none]'
// Collapsed: an inline-block whose text ends in its own ellipsis so the right edge stays drawn.
const TARGET_COLLAPSED_CLASS = 'inline-block min-w-0 max-w-full truncate py-1 align-top leading-3'
// Wrapping: flows inline, keeps its fill per line (box-decoration-clone) and sits on the row's 20px
// pitch, so it must not be an overflow-hidden inline-block (its baseline would be the bottom edge).
const TARGET_WRAPPED_CLASS = 'inline overflow-visible text-clip whitespace-pre-wrap break-words py-0 align-baseline leading-[inherit]'

// A tool target (path, command, code or search pattern) as a muted inline-code chip. It takes the
// wrapped look inside a wrapping `CollapsedLine` summary, or wherever `inline` is set (text already
// shortened by the caller, e.g. a failure attribution in the detail line).
export function ToolTarget({ className, inline, children }: { className?: string; inline?: boolean; children: React.ReactNode }) {
  const wrapped = React.useContext(SummaryWrapContext) || inline === true
  return (
    <InlineCode data-slot="tool-target" className={cn(TARGET_CHIP_CLASS, wrapped ? TARGET_WRAPPED_CLASS : TARGET_COLLAPSED_CLASS, className)}>
      {children}
    </InlineCode>
  )
}

// The chip for a non-empty target text; a non-code target (a skill name) stays out of the chip.
export function toolTargetChip(text: string | undefined): React.ReactNode | undefined {
  return text ? <ToolTarget>{text}</ToolTarget> : undefined
}

// While wrapping, the raw id and target flow as one run of text. Collapsed, the id is its own flex
// item beside the chip, so the chip's ellipsis is clipped by the chip rather than the whole summary.
function RawIdSummary({ rawId, children }: { rawId: string; children: React.ReactNode }) {
  const wrapped = React.useContext(SummaryWrapContext)
  const id = (
    <span data-slot="tool-raw-id" className={wrapped ? undefined : 'shrink-0'}>
      {rawId}
    </span>
  )
  if (wrapped) {
    return (
      <>
        {id}
        {children !== undefined && <> {children}</>}
      </>
    )
  }
  return (
    <span className="flex min-w-0 items-start gap-1">
      {id}
      {children}
    </span>
  )
}

// FR-010, FR-006: the summary slot reads the raw tool id (only while the setting is on, muted like
// the target), then the target (already a chip, or plain for a skill name).
export function toolRowSummary(rawId: string | undefined, target: React.ReactNode): React.ReactNode | undefined {
  const hasTarget = target !== undefined && target !== null && target !== ''
  if (rawId === undefined) return hasTarget ? target : undefined
  return <RawIdSummary rawId={rawId}>{hasTarget ? target : undefined}</RawIdSummary>
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
