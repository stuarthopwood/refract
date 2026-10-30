import * as React from 'react'
import type { TranscriptItem } from '../../../shared/model'
import { FileLinkButton } from './Markdown'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'
import { DiffView } from './DiffView'
import { ToolCallDialog } from './ToolCallDialog'
import { ToolIcon } from '@/components/ToolIcon'
import { formatDuration, type RowStatus } from './toolStatus'
import { resolveToolDisplay, toolRowLabel } from './toolDisplay'
import { hasIntent, joinAriaParts, toolAriaHead, toolRowMeta, toolRowSummary, useShowToolNames } from './toolRowParts'
import { commandRowText, sanitizeLines } from './formatToolCommand'
import { callMeta, editStatForItem, diffStatAriaText, joinMetaParts } from './toolRowLabels'
import type { ToolGroup } from './groupToolItems'
import { SpineList, SpineItem, SPINE_HOST_CONTENT_CLASS } from './SpineList'
import { ToolRowKebab, ToolRowMenu } from './ToolRowMenu'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

interface ToolCallBodyProps {
  item: ToolItem
  dialogOpen: boolean
  onDialogOpenChange: (open: boolean) => void
}

const QUIET_SUMMARY_MAX_CHARS = 200
const ATTRIBUTION_PREFIX_MAX_CHARS = 40

function quietSummary(output: string | undefined): string | undefined {
  if (!output || output.includes('\n') || output.length > QUIET_SUMMARY_MAX_CHARS) return undefined
  return output
}

const WALL_TIME_LINE = /^Wall time: \d+(?:\.\d+)? seconds$/
const EXIT_CODE_LINE = /^Command exited with code (-?\d+)$/
const TIMEOUT_LINE = /^Command timed out after (\d+) seconds$/
const TIMEOUT_BRACKETED = /\[Command timed out after (\d+) seconds\]/

function errorLine(item: ToolItem): string {
  const raw = item.output
  let lines = raw ? sanitizeLines(raw) : []
  let fallback: string | undefined
  if (item.tool === 'bash') {
    const wallTimeIndex = lines.findLastIndex((line) => WALL_TIME_LINE.test(line))
    if (wallTimeIndex !== -1) {
      for (const line of lines.slice(wallTimeIndex)) {
        const exitMatch = line.match(EXIT_CODE_LINE)
        if (exitMatch) {
          fallback = `Exited with code ${exitMatch[1]}`
          break
        }
        const timeoutMatch = line.match(TIMEOUT_LINE)
        if (timeoutMatch) {
          fallback = `Command timed out after ${timeoutMatch[1]} seconds`
          break
        }
      }
      lines = lines.slice(0, wallTimeIndex)
    }
    if (!fallback && raw) {
      const bracketedTimeout = raw.match(TIMEOUT_BRACKETED)
      if (bracketedTimeout) fallback = `Command timed out after ${bracketedTimeout[1]} seconds`
    }
    if (!fallback) {
      const details = item.details as { exitCode?: number } | undefined
      if (typeof details?.exitCode === 'number') fallback = `Exited with code ${details.exitCode}`
    }
    if (lines.length > 0 && lines[lines.length - 1] === '(no output)') lines = lines.slice(0, -1)
  }
  if (lines.length === 0) return fallback ?? 'Failed.'
  const line = item.tool === 'bash' ? lines[lines.length - 1]! : lines[0]!
  return line.length > QUIET_SUMMARY_MAX_CHARS ? `${line.slice(0, QUIET_SUMMARY_MAX_CHARS)}…` : line
}

function ToolCallBody({ item, dialogOpen, onDialogOpenChange }: ToolCallBodyProps) {
  const isDone = item.status === 'done'
  const summary = isDone && item.tool !== 'bash' ? quietSummary(item.output) : undefined
  const writeLineCount = item.write
    ? item.write.content === ''
      ? 0
      : item.write.content.split('\n').length - (item.write.content.endsWith('\n') ? 1 : 0)
    : 0

  return (
    <>
      {item.edit && <DiffView path={item.edit.path} oldText={item.edit.oldText} newText={item.edit.newText} capped />}
      {isDone && item.write && (
        <p className="text-xs text-muted-foreground">
          Wrote {writeLineCount} {writeLineCount === 1 ? 'line' : 'lines'} to <FileLinkButton path={item.write.path} />
        </p>
      )}
      {isDone && !item.write && summary && (
        <p className="[overflow-wrap:anywhere] text-xs text-muted-foreground">{summary}</p>
      )}
      <ToolCallDialog item={item} open={dialogOpen} onOpenChange={onDialogOpenChange} />
    </>
  )
}

interface ToolCallRowProps {
  item: ToolItem
  summaryWrap?: boolean
  dialogOpen: boolean
  onDialogOpenChange: (open: boolean) => void
  defaultOpen?: boolean
}

function ToolCallRow({ item, summaryWrap, dialogOpen, onDialogOpenChange, defaultOpen }: ToolCallRowProps) {
  const showToolNames = useShowToolNames()
  const [open, setOpen] = React.useState(defaultOpen ?? false)
  const display = resolveToolDisplay(item.tool, item.target)
  const rawId = showToolNames ? display.rawId : undefined
  const label = toolRowLabel(item.tool, item.target, item.intent, item.status)
  const target = commandRowText(item)
  const failed = item.status === 'error'
  const memberDuration = item.status !== 'running' && item.durationMs != null ? formatDuration(item.durationMs) : undefined
  const memberAriaLabel = joinAriaParts([
    toolAriaHead(item.status, display.entryTool, hasIntent(item.intent), label, rawId, target),
    diffStatAriaText(editStatForItem(item)),
    memberDuration
  ])
  return (
    <ToolRowMenu item={item} open={open} onOpenChange={setOpen}>
    <CollapsedLine
      icon={<ToolIcon icon={display.icon} tone={failed ? 'error' : 'muted'} />}
      iconTooltip={display.rawId}
      label={label}
      labelClassName={failed ? 'text-severity-error' : undefined}
      summary={toolRowSummary(rawId, target)}
      summaryWrap={summaryWrap}
      wrapWhenOpen
      meta={toolRowMeta(item.status, callMeta(item))}
      triggerAriaLabel={memberAriaLabel}
      detail={item.status === 'error' ? errorLine(item) : undefined}
      open={open}
      onOpenChange={setOpen}
      action={<ToolRowKebab item={item} open={open} onOpenChange={setOpen} />}
      contentClassName={LABEL_COLUMN_CONTENT_CLASS}
    >
      <ToolCallBody item={item} dialogOpen={dialogOpen} onDialogOpenChange={onDialogOpenChange} />
    </CollapsedLine>
    </ToolRowMenu>
  )
}

interface ToolGroupRowProps {
  group: ToolGroup
  summaryWrap?: boolean
  shimmer?: boolean
}

export function ToolGroupRow({ group, summaryWrap, shimmer }: ToolGroupRowProps) {
  const [open, setOpen] = React.useState(false)
  const [openDialogItemIdState, setOpenDialogItemId] = React.useState<string | null>(null)
  const openDialogItemId =
    openDialogItemIdState != null && group.items.some((item) => item.id === openDialogItemIdState) ? openDialogItemIdState : null
  const solo = group.items.length === 1
  const failedCount = group.items.filter((item) => item.status === 'error').length
  const interruptedCount = group.items.filter((item) => item.status === 'interrupted').length
  const cancelledCount = group.items.filter((item) => item.status === 'cancelled').length
  const lastFailedItem = failedCount > 0 ? [...group.items].reverse().find((item) => item.status === 'error') : undefined
  const status: RowStatus = group.items.some((item) => item.status === 'running')
    ? 'running'
    : failedCount > 0
      ? 'error'
      : interruptedCount > 0
        ? 'interrupted'
        : cancelledCount > 0
          ? 'cancelled'
          : 'done'
  const isRunning = status === 'running'
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
  const last = group.items[group.items.length - 1]!
  const skillName = solo ? last.skill?.name : undefined
  const verbPhase: RowStatus = solo ? status : isRunning ? 'running' : 'done'
  const first = group.items[0]!
  const display = resolveToolDisplay(first.tool, first.target)
  const rawId = useShowToolNames() ? display.rawId : undefined
  const toolLabel = toolRowLabel(first.tool, first.target, solo ? last.intent : undefined, verbPhase)
  const visibleLabel = solo ? toolLabel : `${toolLabel} \u00d7${group.items.length}`
  const failed = status === 'error'
  const summary = toolRowSummary(rawId, skillName !== undefined ? <bdi>{skillName}</bdi> : solo ? commandRowText(last) : undefined)
  const totalDurationMs = group.items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0)
  const allHaveDuration = group.items.every((item) => item.durationMs != null)
  const totalDuration = !isRunning && allHaveDuration ? formatDuration(totalDurationMs) : undefined
  const meta = toolRowMeta(
    status,
    solo
      ? callMeta(last)
      : joinMetaParts([
          failedCount > 0 ? <span className="text-severity-error">{failedCount} failed</span> : undefined,
          interruptedCount > 0 ? <span>{interruptedCount} interrupted</span> : undefined,
          cancelledCount > 0 ? <span>{cancelledCount} stopped</span> : undefined,
          totalDuration
        ])
  )

  const soloSummaryText = skillName !== undefined ? skillName : commandRowText(last)
  const soloDurationText = last.status !== 'running' && last.durationMs != null ? formatDuration(last.durationMs) : undefined
  const triggerAriaLabel = solo
    ? joinAriaParts([
        toolAriaHead(status, display.entryTool, hasIntent(last.intent), toolLabel, rawId, soloSummaryText),
        diffStatAriaText(editStatForItem(last)),
        soloDurationText
      ])
    : joinAriaParts([
        toolAriaHead(verbPhase, display.entryTool, false, toolLabel, rawId, undefined),
        `${group.items.length} calls`,
        failedCount > 0 ? `${failedCount} failed` : undefined,
        interruptedCount > 0 ? `${interruptedCount} interrupted` : undefined,
        cancelledCount > 0 ? `${cancelledCount} stopped` : undefined,
        totalDuration
      ])

  return (
    <ToolRowMenu item={solo ? last : undefined} open={open} onOpenChange={setOpen}>
    <CollapsedLine
      icon={<ToolIcon icon={display.icon} tone={failed ? 'error' : 'muted'} />}
      iconTooltip={display.rawId}
      label={visibleLabel}
      open={open}
      onOpenChange={setOpen}
      labelShimmer={shimmer && isRunning}
      labelClassName={failed ? 'text-severity-error' : undefined}
      summary={summary}
      summaryWrap={summaryWrap}
      wrapWhenOpen
      meta={meta}
      triggerAriaLabel={triggerAriaLabel}
      detail={
        lastFailedItem
          ? solo
            ? errorLine(lastFailedItem)
            : (() => {
                const failingCommandText = sanitizeLines(commandRowText(lastFailedItem))[0]
                const truncatedPrefix =
                  failingCommandText && failingCommandText.length > ATTRIBUTION_PREFIX_MAX_CHARS
                    ? `${failingCommandText.slice(0, ATTRIBUTION_PREFIX_MAX_CHARS)}…`
                    : failingCommandText
                return truncatedPrefix ? (
                  <>
                    <bdi className="inline-block max-w-[40%] truncate align-bottom text-muted-foreground">{truncatedPrefix}:</bdi>{' '}
                    {errorLine(lastFailedItem)}
                  </>
                ) : (
                  errorLine(lastFailedItem)
                )
              })()
          : undefined
      }
      hideDetailWhenOpen={!solo}
      action={<ToolRowKebab item={solo ? last : undefined} open={open} onOpenChange={setOpen} />}
      contentClassName={solo ? LABEL_COLUMN_CONTENT_CLASS : SPINE_HOST_CONTENT_CLASS}
    >
      {solo ? (
        <ToolCallBody
          item={last}
          dialogOpen={openDialogItemId === last.id}
          onDialogOpenChange={(open) => setOpenDialogItemId(open ? last.id : null)}
        />
      ) : (
        <SpineList gap="member">
          {group.items.map((item) => (
            <SpineItem key={item.id} isNew={isRunning && !seenIds.has(item.id)}>
              <ToolCallRow
                item={item}
                summaryWrap={summaryWrap}
                dialogOpen={openDialogItemId === item.id}
                onDialogOpenChange={(open) => setOpenDialogItemId(open ? item.id : null)}
                defaultOpen={openDialogItemId === item.id}
              />
            </SpineItem>
          ))}
        </SpineList>
      )}
    </CollapsedLine>
    </ToolRowMenu>
  )
}
