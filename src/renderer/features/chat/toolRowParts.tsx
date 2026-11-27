import * as React from 'react'
import { useSettingsStore } from '@/state'
import { DEFAULT_TRANSCRIPT_DISPLAY, isToolTargets, type ToolTargets } from '../../../shared/transcriptDisplay'
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

// #1758: "Tool targets" (`transcriptDisplay.toolTargets`): hide the target, show it in the row's tooltip, or show it in the row.
export function useToolTargets(): ToolTargets {
  return useSettingsStore((state) => {
    const value = state.settings.transcriptDisplay?.toolTargets
    return isToolTargets(value) ? value : DEFAULT_TRANSCRIPT_DISPLAY.toolTargets
  })
}

// The row summary's target chip (Show only) and the row tooltip text (the raw tool id, plus the full target on Hover). Hide and
// Hover keep the target out of the row, but the accessible name still carries it (`toolAriaHead`). `tooltipInName` is true when
// that name already says the whole Hover tooltip (the target, and the raw id while it is shown), so the tooltip is not read twice.
export function toolTargetDisplay(
  mode: ToolTargets,
  rawId: string,
  target: string | undefined,
  rawIdInName: boolean
): { chip: React.ReactNode | undefined; tooltip: string; tooltipInName: boolean } {
  const hoverTarget = mode === 'hover' && !!target
  return {
    chip: mode === 'show' ? toolTargetChip(target) : undefined,
    tooltip: hoverTarget ? `${rawId}: ${target}` : rawId,
    tooltipInName: hoverTarget && rawIdInName
  }
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

// One duration column for every row that ends in a status icon (#2189). Wide enough for "39.8s" and "1m 32s"; a longer
// value widens it rather than overlapping the icon. Right-aligned, so the icon to its left sits in one x on every row.
const DURATION_COLUMN_CLASS = 'inline-block min-w-[6ch] shrink-0 whitespace-nowrap text-right tabular-nums'

export function DurationColumn({ className, children, ...rest }: React.ComponentProps<'span'>) {
  return (
    <span data-slot="row-duration" className={cn(DURATION_COLUMN_CLASS, className)} {...rest}>
      {children}
    </span>
  )
}

// FR-001, FR-010, #2189: the trailing slot every status-bearing row shares: optional text (a group's "2 steps", a subagent's
// status word) left of the icon, then the status icon, then the fixed duration column. A row with no duration keeps the empty
// column, so only the duration sits between the icon and the chevron and every icon lines up.
export function RowTrailing({ icon, lead, duration }: { icon: React.ReactNode; lead?: React.ReactNode; duration?: React.ReactNode }) {
  return (
    <span className="inline-flex h-5 items-center gap-1 align-top">
      {lead}
      {icon}
      <DurationColumn>
        {duration !== undefined && (
          <>
            <span className="sr-only">, </span>
            {duration}
          </>
        )}
      </DurationColumn>
    </span>
  )
}

export function toolRowMeta(status: RowStatus, lead: React.ReactNode | undefined, duration: string | undefined): React.ReactNode {
  return <RowTrailing icon={<StatusIcon status={status} />} lead={lead} duration={duration} />
}

// FR-015: spec 022's status prefix (only where the label cannot carry the status), the label, the
// raw id while the setting is on, then the target. A running call's intent already reads as its
// own progress, so it takes no "Running" prefix. FR-140: a call's full intent stands in for its
// brief label, so it is part of the accessible name and never hover-only.
export function toolAriaHead(
  status: RowStatus,
  entryTool: string,
  intent: string | undefined,
  label: string,
  rawId: string | undefined,
  target: string | undefined
): string {
  const intentShown = hasIntent(intent)
  const prefix = intentShown && status === 'running' ? undefined : toolAriaPrefix(status, entryTool)
  return [prefix, intentShown ? intent?.trim() : label, rawId, target].filter(Boolean).join(' ')
}

// FR-140: the row shows the brief label, so the expanded row carries the full intent when it says more.
export function fullIntentLine(intent: string | undefined, label: string): string | undefined {
  const full = intent?.trim()
  return full && full !== label ? full : undefined
}

export function joinAriaParts(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => !!part).join(', ')
}
