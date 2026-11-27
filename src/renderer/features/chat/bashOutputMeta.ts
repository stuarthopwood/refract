// #1749: what OMP says it did to a bash call's output. Both facts ride in the tool result's `details`
// (read live from `tool_execution_end` and from history alike): `details.meta.truncation` carries the
// middle/head/tail cut, `details.meta.limits.columnTruncated` the per-line column cap, and
// `details.meta.minimized` the minimizer's filter and sizes. The RPC `bash` result names the same
// facts flat (`elidedBytes`, `columnMax`, ...), so both spellings are read.
import type { TranscriptItem } from '../../../shared/model'
import { formatByteSize } from '@/lib/formatBytes'
import { sanitizeLines } from './formatToolCommand'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

export interface TruncatedFact {
  /** Lines / bytes OMP dropped from the output; absent when OMP did not say. */
  elidedLines?: number
  elidedBytes?: number
  /** Lines the per-line column cap cut, and the cap in bytes. */
  columnLines?: number
  columnMax?: number
}

export interface MinimizedFact {
  filter: string
  inputBytes?: number
  outputBytes?: number
}

export interface BashOutputFacts {
  truncated?: TruncatedFact
  minimized?: MinimizedFact
}

const FILTER_MAX_CHARS = 40

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function readMinimized(meta: Record<string, unknown> | undefined, details: Record<string, unknown>): MinimizedFact | undefined {
  const minimized = record(meta?.minimized) ?? record(details.minimized)
  const raw = typeof minimized?.filter === 'string' ? sanitizeLines(minimized.filter)[0] : undefined
  if (!minimized || !raw) return undefined
  const filter = raw.length > FILTER_MAX_CHARS ? `${raw.slice(0, FILTER_MAX_CHARS)}…` : raw
  return { filter, inputBytes: count(minimized.inputBytes), outputBytes: count(minimized.outputBytes) }
}

// OMP names the lines the column cap cut as an inclusive 1-based range.
function columnLinesFromRange(range: Record<string, unknown> | undefined): number | undefined {
  const first = range?.first
  const last = range?.last
  return typeof first === 'number' && typeof last === 'number' ? count(last - first + 1) : undefined
}

function readTruncated(meta: Record<string, unknown> | undefined, details: Record<string, unknown>): TruncatedFact | undefined {
  const truncation = record(meta?.truncation)
  const column = record(record(meta?.limits)?.columnTruncated)
  const totalLines = count(truncation?.totalLines)
  const outputLines = count(truncation?.outputLines)
  const totalBytes = count(truncation?.totalBytes)
  const outputBytes = count(truncation?.outputBytes)
  // A head or tail cut reports totals and what was kept; a middle cut also names what it dropped.
  const elidedLines =
    count(truncation?.elidedLines) ?? count(details.elidedLines) ?? (totalLines && outputLines ? count(totalLines - outputLines) : undefined)
  const elidedBytes =
    count(truncation?.elidedBytes) ?? count(details.elidedBytes) ?? (totalBytes && outputBytes ? count(totalBytes - outputBytes) : undefined)
  const columnLines = count(details.columnTruncatedLines) ?? columnLinesFromRange(record(column?.lines))
  const columnMax = count(column?.maxColumn) ?? count(details.columnMax)
  if (elidedLines === undefined && elidedBytes === undefined && columnLines === undefined && columnMax === undefined) return undefined
  return { elidedLines, elidedBytes, columnLines, columnMax }
}

export function bashOutputFacts(item: ToolItem): BashOutputFacts {
  if (item.tool !== 'bash') return {}
  const details = record(item.details)
  if (!details) return {}
  const meta = record(details.meta)
  const truncated = readTruncated(meta, details)
  const minimized = readMinimized(meta, details)
  return { ...(truncated && { truncated }), ...(minimized && { minimized }) }
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`
}

/** "Output truncated: 1,240 lines (88.1 KB) not shown"; the column cap adds "; 3 lines cut at 768 B". */
export function truncatedTooltip(fact: TruncatedFact): string {
  const parts: string[] = []
  const { elidedLines, elidedBytes, columnLines, columnMax } = fact
  if (elidedLines !== undefined || elidedBytes !== undefined) {
    const lines = elidedLines !== undefined ? plural(elidedLines, 'line') : undefined
    const bytes = elidedBytes !== undefined ? formatByteSize(elidedBytes) : undefined
    parts.push(`${lines && bytes ? `${lines} (${bytes})` : (lines ?? bytes)} not shown`)
  }
  if (columnLines !== undefined || columnMax !== undefined) {
    const subject = columnLines !== undefined ? plural(columnLines, 'line') : 'long lines'
    parts.push(`${subject} cut${columnMax !== undefined ? ` at ${formatByteSize(columnMax)}` : ''}`)
  }
  return `Output truncated: ${parts.join('; ')}`
}

/** "Minimized by git: 120.4 KB to 3.2 KB". */
export function minimizedTooltip(fact: MinimizedFact): string {
  const sizes = fact.inputBytes !== undefined && fact.outputBytes !== undefined ? `: ${formatByteSize(fact.inputBytes)} to ${formatByteSize(fact.outputBytes)}` : ''
  return `Minimized by ${fact.filter}${sizes}`
}

/** The row's accessible-name part for both badges (the badges themselves are hidden from assistive tech there). */
export function bashOutputAriaText(facts: BashOutputFacts): string | undefined {
  const parts = [facts.truncated && truncatedTooltip(facts.truncated), facts.minimized && minimizedTooltip(facts.minimized)].filter(
    (part): part is string => !!part
  )
  return parts.length > 0 ? parts.join(', ') : undefined
}
