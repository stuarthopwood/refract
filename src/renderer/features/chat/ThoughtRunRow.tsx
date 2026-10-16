import * as React from 'react'
import { BrainIcon, Loader2Icon } from 'lucide-react'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'
import { Markdown } from './Markdown'
import { SpineList, SpineItem, SPINE_HOST_CONTENT_CLASS } from './SpineList'
import { formatElapsed } from './formatElapsed'
import type { ThoughtRun } from './groupToolItems'

type ThinkingItem = ThoughtRun['items'][number]

// Moved out of `Transcript.tsx` (issue #557): the thought-run header and its solo/member rows
// are now this file's own concern, mirroring `ToolRow.tsx`/`SubagentChainRow.tsx` housing the
// Tool group and Stage group rows for their own kinds.
function formatThinkingSeconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}`
}

// Last N characters of a still-streaming thought's own text, shown as a faint one-line preview
// (unchanged from the pre-#557 solo row, `Transcript.tsx`).
const THINKING_PREVIEW_CHARS = 120

/** One thought, exactly today's pre-#557 row (decision 7): "Thinking" with a live preview while
 * it streams, "Thought for Ns" once done, or "Thought" with no timing for a reopened history
 * item missing either bound. Used both for a run of one (no Spine, this run's own entire
 * `CollapsedLine`) and for each member of a run of two or more (one per `SpineList` `<li>`,
 * decision 11 -- the run never relabels a member "Step N"). Decision 13: the body sits at the
 * label column (`pl-8 pr-2 pb-2`, `LABEL_COLUMN_CONTENT_CLASS`) for both uses, with no
 * max-height and no nested scroll (a scroll box inside `role="log"` traps the wheel and would
 * have to be a Tab stop). */
function ThoughtItemRow({ item, defaultOpen }: { item: ThinkingItem; defaultOpen?: boolean }) {
  const duration = item.startedAt != null && item.endedAt != null ? item.endedAt - item.startedAt : undefined
  const label = item.streaming ? 'Thinking' : duration != null ? `Thought for ${formatThinkingSeconds(duration)}s` : 'Thought'
  return (
    <CollapsedLine
      icon={
        item.streaming ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-state-working" />
        ) : (
          <BrainIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )
      }
      label={label}
      summary={item.streaming ? item.text.slice(-THINKING_PREVIEW_CHARS) : undefined}
      defaultOpen={defaultOpen}
      contentClassName={LABEL_COLUMN_CONTENT_CLASS}
    >
      {/* Dimmed to `--muted-foreground` (accessibility-auditor, pre-#557 round 2): the ambient
       * `--foreground` this inherited by default reads brighter than primary chat prose's own
       * `--chat-foreground`, inverting the intended secondary/bookkeeping hierarchy. */}
      <Markdown id={item.id} text={item.text} streaming={item.streaming} className="text-muted-foreground" />
    </CollapsedLine>
  )
}

/** The union of each member's own `[startedAt, endedAt]` interval, in milliseconds (issue #557
 * decision 2): never a raw sum -- several thoughts inside one message share an end time
 * (`transcript.rs:1192-1197`), so a plain sum can overstate the total past the turn total shown
 * right below it. `undefined` when any member is missing either bound (decision 9/10: every
 * reopened-history thought lacks one, so an untimed run always falls through to this). */
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

export interface ThoughtRunRowProps {
  group: ThoughtRun
}

// A run of consecutive, non-empty thinking items (issue #557; mirrors `ToolGroupRow`/
// `StageGroupRow`'s own solo/multi switch, `groupThoughtItems.ts`): ALWAYS renders through this
// one component, a run of one identically to the solo thinking row that rendered directly in
// `Transcript.tsx` before this story (decision 7) -- so this never changes element type at this
// tree position when a second consecutive thought arrives (the same focus-loss risk
// `groupToolItems`'s own comment documents for tool calls). "Trade-offs resolved" 1: the header
// never spins itself -- a live thought is just another member inside, and the header's own
// icon/label instead swap to "Thinking" plus that member's own live preview while ANY member
// streams (decision 9), settling to "Thought process" with a step count and (once every
// member's own bounds are known) total duration once every member has finished (decision 8).
export function ThoughtRunRow({ group }: ThoughtRunRowProps) {
  const solo = group.items.length === 1
  const isRunning = group.items.some((item) => item.streaming)

  // Decision 15: a run growing from one to two keeps the header's own open state (automatic --
  // this is the SAME `CollapsedLine`, only its children switch, exactly like `ToolGroupRow`'s
  // own solo/multi swap below) but member 1's own nested row starts open ONLY if the header
  // itself was open at the moment the second thought arrived; every other member, and every
  // later mount of the list, starts collapsed. The header's own open state is lifted here (not
  // read back out of `CollapsedLine`'s internal uncontrolled state) purely so this can observe
  // it at the exact render where the run first grows past one item, mirroring `ToolGroupRow`'s
  // own lifted `openDialogItemId`.
  const [open, setOpen] = React.useState(false)
  const growthRef = React.useRef<{ firstMemberId: string; firstMemberDefaultOpen: boolean } | null>(null)
  if (growthRef.current === null && group.items.length > 1) {
    growthRef.current = { firstMemberId: group.items[0]!.id, firstMemberDefaultOpen: open }
  }

  // #565 decision 26 fade-in (mirrored by `ToolGroupRow`/`StageGroupRow`): a member that mounts
  // WHILE this run is live (any member streaming) fades in; one already present at a settled or
  // history mount never does. Seeded synchronously during render (never in an effect, so a
  // settled reopen never flashes a first invisible frame), then every currently-rendered id is
  // marked seen in an effect after paint so a row only ever fades in once.
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

  if (solo) {
    return <ThoughtItemRow item={group.items[0]!} />
  }

  const allFinished = !isRunning
  const durationMs = allFinished ? unionDurationMs(group.items) : undefined
  const stepCount = group.items.length
  const liveMember = group.items.find((item) => item.streaming)
  const metaStepsText = `${stepCount} steps`

  // Decision 8/9/10: "3 steps · 15s" once every member is finished and every member's own bounds
  // are known; "3 steps" with no time while any member streams, or whenever any member (always
  // true for reopened history) lacks either bound. Visible middot (`aria-hidden`) plus the
  // sr-only ", " that already separates it from the meta slot's own leading comma (#570/#632
  // grammar, `CollapsedLine.tsx`) -- never two bare sibling spans, which reads as one joined word.
  const meta = allFinished ? (
    <>
      {metaStepsText}
      {durationMs != null && (
        <>
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, </span>
          {formatElapsed(durationMs)}
        </>
      )}
    </>
  ) : (
    metaStepsText
  )

  // Decision 18/19: finished, timed -- "Thought process, 3 steps, 15s"; finished, untimed --
  // "Thought process, 3 steps"; explicit in both cases (the #570/#632 lesson: an explicit name
  // beats the browser's own content-based computation, which inserts its own space at every
  // sibling boundary regardless of nesting). Live -- no override: "as today" (decision 19), the
  // same content-based name the pre-#557 solo live row always relied on (label "Thinking" plus
  // the live member's own preview plus this row's own meta, each already readable in place).
  const triggerAriaLabel = allFinished
    ? [`Thought process`, metaStepsText, durationMs != null ? formatElapsed(durationMs) : undefined]
        .filter((part): part is string => !!part)
        .join(', ')
    : undefined

  return (
    <CollapsedLine
      icon={
        allFinished ? (
          <BrainIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-state-working" />
        )
      }
      label={allFinished ? 'Thought process' : 'Thinking'}
      summary={allFinished ? undefined : liveMember?.text.slice(-THINKING_PREVIEW_CHARS)}
      meta={meta}
      open={open}
      onOpenChange={setOpen}
      triggerAriaLabel={triggerAriaLabel}
      // #565 decision 8: the sole geometry in play once a `SpineList` is the content is its own
      // `ml-4`/`pt-1` -- `group.items.length` is always >= 2 here (a solo run returns early above).
      contentClassName={SPINE_HOST_CONTENT_CLASS}
    >
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
    </CollapsedLine>
  )
}
