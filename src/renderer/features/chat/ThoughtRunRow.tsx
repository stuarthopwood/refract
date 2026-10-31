import * as React from 'react'
import { BrainIcon, Loader2Icon } from 'lucide-react'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'
import { Markdown } from './Markdown'
import { SpineList, SpineItem, SPINE_HOST_CONTENT_CLASS } from './SpineList'
import { formatElapsed } from './formatElapsed'
import type { ThoughtRun } from './groupToolItems'
import { toolVerb } from './toolVerbs'

type ThinkingItem = ThoughtRun['items'][number]

function formatThinkingSeconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}`
}

const THINKING_PREVIEW_CHARS = 120

function thoughtIcon(streaming: boolean) {
  return streaming ? (
    <Loader2Icon className="size-4 shrink-0 animate-spin text-thinking-row-active-fg" />
  ) : (
    <BrainIcon className="size-4 shrink-0 text-thinking-row-fg" />
  )
}

function thoughtLabel(item: ThinkingItem): string {
  const duration = item.startedAt != null && item.endedAt != null ? item.endedAt - item.startedAt : undefined
  return item.streaming ? toolVerb('thinking', 'running') : duration != null ? `Thought for ${formatThinkingSeconds(duration)}s` : 'Thought'
}

function ThoughtItemRow({ item, defaultOpen }: { item: ThinkingItem; defaultOpen?: boolean }) {
  return (
    <CollapsedLine
      icon={thoughtIcon(item.streaming)}
      label={thoughtLabel(item)}
      summary={item.streaming ? item.text.slice(-THINKING_PREVIEW_CHARS) : undefined}
      defaultOpen={defaultOpen}
      contentClassName={LABEL_COLUMN_CONTENT_CLASS}
    >
      <Markdown id={item.id} text={item.text} streaming={item.streaming} className="text-thinking-row-fg" />
    </CollapsedLine>
  )
}

function unionDurationMs(items: readonly ThinkingItem[]): number | undefined {
  const intervals: [number, number][] = []
  for (const item of items) {
    if (item.startedAt == null || item.endedAt == null) return undefined
    intervals.push([item.startedAt, item.endedAt])
  }
  intervals.sort((a, b) => a[0] - b[0])
  let total = 0
  let [curStart, curEnd] = intervals[0]!
  for (const [start, end] of intervals.slice(1)) {
    if (start > curEnd) {
      total += curEnd - curStart
      curStart = start
      curEnd = end
    } else if (end > curEnd) {
      curEnd = end
    }
  }
  return total + (curEnd - curStart)
}

/** Props for {@link ThoughtRunRow}. */
export interface ThoughtRunRowProps {
  group: ThoughtRun
  /** #1210: this is the transcript's one newest running row, so its label shimmers while it runs. */
  shimmer?: boolean
}

/** Collapsible row summarising a run of consecutive thought items. */
export function ThoughtRunRow({ group, shimmer }: ThoughtRunRowProps) {
  const solo = group.items.length === 1
  const isRunning = group.items.some((item) => item.streaming)
  const allFinished = !isRunning

  const [open, setOpen] = React.useState(false)
  const growthRef = React.useRef<{ firstMemberId: string; firstMemberDefaultOpen: boolean } | null>(null)
  if (growthRef.current === null && group.items.length > 1) {
    growthRef.current = { firstMemberId: group.items[0]!.id, firstMemberDefaultOpen: open }
  }
  React.useEffect(() => {
    if (growthRef.current) growthRef.current.firstMemberDefaultOpen = false
  }, [group.items.length])

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

  const soloItem = group.items[0]!
  const soloLabel = thoughtLabel(soloItem)

  const durationMs = allFinished ? unionDurationMs(group.items) : undefined
  const stepCount = group.items.length
  const liveMember = group.items.findLast((item) => item.streaming)
  const metaStepsText = `${stepCount} steps`
  const totalText = durationMs != null ? formatElapsed(Math.max(1000, durationMs)) : undefined

  const meta = allFinished ? (
    <>
      {metaStepsText}
      {totalText != null && (
        <>
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, </span>
          {totalText}
        </>
      )}
    </>
  ) : (
    metaStepsText
  )

  const triggerAriaLabel = allFinished
    ? [toolVerb('thinking', 'done'), metaStepsText, totalText].filter((part): part is string => !!part).join(', ')
    : undefined

  return (
    <CollapsedLine
      icon={solo ? thoughtIcon(soloItem.streaming) : thoughtIcon(!allFinished)}
      label={solo ? soloLabel : toolVerb('thinking', allFinished ? 'done' : 'running')}
      labelShimmer={shimmer && isRunning}
      summary={
        solo
          ? soloItem.streaming
            ? soloItem.text.slice(-THINKING_PREVIEW_CHARS)
            : undefined
          : allFinished
            ? undefined
            : liveMember?.text.slice(-THINKING_PREVIEW_CHARS)
      }
      meta={solo ? undefined : meta}
      open={open}
      onOpenChange={setOpen}
      triggerAriaLabel={solo ? undefined : triggerAriaLabel}
      contentClassName={solo ? LABEL_COLUMN_CONTENT_CLASS : SPINE_HOST_CONTENT_CLASS}
    >
      {solo ? (
        <Markdown id={soloItem.id} text={soloItem.text} streaming={soloItem.streaming} className="text-thinking-row-fg" />
      ) : (
        <SpineList gap="member">
          {group.items.map((item) => (
            <SpineItem key={item.id} isNew={isRunning && !seenIds.has(item.id)}>
              <ThoughtItemRow
                item={item}
                defaultOpen={growthRef.current?.firstMemberId === item.id && growthRef.current.firstMemberDefaultOpen}
              />
            </SpineItem>
          ))}
        </SpineList>
      )}
    </CollapsedLine>
  )
}
