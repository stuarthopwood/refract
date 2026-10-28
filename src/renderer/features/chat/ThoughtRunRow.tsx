import * as React from 'react'
import { BrainIcon, Loader2Icon } from 'lucide-react'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'
import { Markdown } from './Markdown'
import { SpineList, SpineItem, SPINE_HOST_CONTENT_CLASS } from './SpineList'
import { formatElapsed } from './formatElapsed'
import type { ThoughtRun } from './groupToolItems'
import { toolVerb } from './toolVerbs'

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

// Shared by `ThoughtItemRow` and `ThoughtRunRow`'s own solo/multi header branches (code-reviewer
// gate round 2, Low: the icon JSX and the label string were each hand-duplicated at three call
// sites and had already drifted apart once during gate remediation). `thoughtIcon` takes the
// bare `streaming` flag (not a whole item) so the multi header -- which has no single item to
// ask, only `allFinished` -- can reuse it as `thoughtIcon(!allFinished)`.
function thoughtIcon(streaming: boolean) {
  return streaming ? (
    <Loader2Icon className="size-4 shrink-0 animate-spin text-state-working" />
  ) : (
    <BrainIcon className="size-4 shrink-0 text-muted-foreground" />
  )
}

function thoughtLabel(item: ThinkingItem): string {
  const duration = item.startedAt != null && item.endedAt != null ? item.endedAt - item.startedAt : undefined
  return item.streaming ? toolVerb('thinking', 'running') : duration != null ? `Thought for ${formatThinkingSeconds(duration)}s` : 'Thought'
}

/** One member's own row inside a run of two or more, sitting on a `SpineList` `<li>` (decision
 * 11 -- the run never relabels a member "Step N"): "Thinking" with a live preview while it
 * streams, "Thought for Ns" once done, or "Thought" with no timing for a reopened history item
 * missing either bound. Decision 13: the body sits at the label column (`pl-8 pr-2 pb-2`,
 * `LABEL_COLUMN_CONTENT_CLASS`), with no max-height and no nested scroll (a scroll box inside
 * `role="log"` traps the wheel and would have to be a Tab stop). A solo run (exactly one
 * thought) renders the same wording directly from `ThoughtRunRow`'s own header below instead of
 * through this component -- gate round 1 (code/a11y/architect High): this component used to
 * ALSO be the solo run's own top-level return, which switched `ThoughtRunRow`'s rendered element
 * type the moment a second thought arrived and remounted the row, losing focus and open state. */
function ThoughtItemRow({ item, defaultOpen }: { item: ThinkingItem; defaultOpen?: boolean }) {
  return (
    <CollapsedLine
      icon={thoughtIcon(item.streaming)}
      label={thoughtLabel(item)}
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

// A run of consecutive, non-empty thinking items (issue #557; mirrors `ToolGroupRow`'s own
// solo/multi switch, `ToolRow.tsx:246-421`): ALWAYS renders ONE controlled `<CollapsedLine>`,
// switching only its props and children on `solo` -- gate round 1 (code/a11y/architect High):
// an earlier revision returned `<ThoughtItemRow>` directly for a run of one and `<CollapsedLine>`
// for two or more, two different element types at this same tree position, so React unmounted
// and remounted the whole row the moment a second thought arrived (the exact focus-loss risk
// `groupToolItems.ts`'s own comment documents for tool calls): keyboard focus on a live solo
// row dropped to `<body>`, an expanded solo row snapped shut, and the lifted `open` state could
// never carry over to decide member 1's own starting state. Fixed by never branching on `solo`
// at the TOP of this component -- only the `CollapsedLine` props themselves branch, exactly like
// `ToolGroupRow`. "Trade-offs resolved" 1: the header shows the spinner and "Thinking" with the
// live member's own preview while ANY member streams (decision 9) -- a live thought is just
// another member inside; the header itself never becomes a SEPARATE spinning row of its own.
// Settles to "Thought process" with a step count and (once every member's own bounds are known)
// total duration once every member has finished (decision 8).
export function ThoughtRunRow({ group }: ThoughtRunRowProps) {
  const solo = group.items.length === 1
  const isRunning = group.items.some((item) => item.streaming)
  const allFinished = !isRunning

  // Decision 15: a run growing from one to two keeps the header's own open state (now genuinely
  // automatic -- this is the SAME `CollapsedLine` instance throughout, only its props and
  // children switch) but member 1's own nested row starts open ONLY if the header itself was
  // open at the moment the second thought arrived; every other member, and every LATER mount of
  // the list (the user collapses the header, which unmounts `CollapsibleContent` entirely since
  // it has no `forceMount`, then re-expands it), starts collapsed. The header's own open state is
  // lifted here (not read back out of `CollapsedLine`'s internal uncontrolled state) purely so
  // this can observe it at the exact render where the run first grows past one item, mirroring
  // `ToolGroupRow`'s own lifted `openDialogItemId`.
  const [open, setOpen] = React.useState(false)
  const growthRef = React.useRef<{ firstMemberId: string; firstMemberDefaultOpen: boolean } | null>(null)
  if (growthRef.current === null && group.items.length > 1) {
    growthRef.current = { firstMemberId: group.items[0]!.id, firstMemberDefaultOpen: open }
  }
  // Gate round 1 (architect Low): `defaultOpen` only matters to a component on its OWN first
  // mount (`CollapsedLine`'s `useState(defaultOpen ?? false)` initializer never re-reads a later
  // prop value), but the SpineList/member subtree genuinely unmounts and remounts on every
  // collapse-then-re-expand of the header (no `forceMount`) -- without this, `firstMemberId`'s
  // own `defaultOpen` would stay `true` forever and reopen member 1 on every later remount,
  // violating decision 15's "every later mount starts collapsed". Flips the captured flag to
  // `false` once, right after the growth render that actually used it commits (member 1's own
  // `useState` initializer has already read `true` by then); every render before the first
  // growth is a no-op (`growthRef.current` is still `null`).
  React.useEffect(() => {
    if (growthRef.current) growthRef.current.firstMemberDefaultOpen = false
  }, [group.items.length])

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

  // ---- Solo props (decision 7: exactly today's pre-#557 row) ----
  const soloItem = group.items[0]!
  const soloLabel = thoughtLabel(soloItem)

  // ---- Multi props (decisions 8-10, 18-19) ----
  const durationMs = allFinished ? unionDurationMs(group.items) : undefined
  const stepCount = group.items.length
  // Gate round 1 (a11y Medium): `streaming` is set for the WHOLE message, so every thought inside
  // a still-streaming message reads `streaming: true` at once; `find` picked the FIRST such member
  // (an already-finished-reasoning, now-stale one) instead of the one actually producing new text.
  // `findLast` instead picks the LATEST member still attributed to the live message, matching
  // decision 9 ("the live member's own preview").
  const liveMember = group.items.findLast((item) => item.streaming)
  const metaStepsText = `${stepCount} steps`
  // Gate round 1 (code/a11y/architect Medium): `formatElapsed`'s own `Math.max(0, ...)` floor let
  // the header read "0s" while every member (floored to `Math.max(1, ...)` by
  // `formatThinkingSeconds` above) read "Thought for 1s" -- several thoughts can genuinely total
  // under 500ms (Rust stamps a part's bounds from wall-clock delivery time, not reasoning time,
  // `transcript.rs:1192-1197`), but a total smaller than every one of its own members reads as
  // meaningless, not merely approximate. The same 1s floor the members already use is applied
  // here too, so the header can never show less time than any member it summarises.
  const totalText = durationMs != null ? formatElapsed(Math.max(1000, durationMs)) : undefined

  // Decision 8/9/10: "3 steps · 15s" once every member is finished and every member's own bounds
  // are known; "3 steps" with no time while any member streams, or whenever any member (always
  // true for reopened history) lacks either bound. Visible middot (`aria-hidden`) plus the
  // sr-only ", " that already separates it from the meta slot's own leading comma (#570/#632
  // grammar, `CollapsedLine.tsx`) -- never two bare sibling spans, which reads as one joined word.
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

  // Decision 18/19: finished, timed -- "Thought process, 3 steps, 15s"; finished, untimed --
  // "Thought process, 3 steps"; explicit in both cases (the #570/#632 lesson: an explicit name
  // beats the browser's own content-based computation, which inserts its own space at every
  // sibling boundary regardless of nesting). Live -- no override: "as today" (decision 19), the
  // same content-based name the pre-#557 solo live row always relied on (label "Thinking" plus
  // the live member's own preview plus this row's own meta, each already readable in place).
  const triggerAriaLabel = allFinished
    ? [toolVerb('thinking', 'done'), metaStepsText, totalText].filter((part): part is string => !!part).join(', ')
    : undefined

  return (
    <CollapsedLine
      icon={solo ? thoughtIcon(soloItem.streaming) : thoughtIcon(!allFinished)}
      label={solo ? soloLabel : toolVerb('thinking', allFinished ? 'done' : 'running')}
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
      // #565 decision 8/10: a solo body starts at the label column, exactly like every other
      // Spine host's own solo body; once a `SpineList` is the content the sole geometry in play
      // is its own `ml-4`/`pt-1`.
      contentClassName={solo ? LABEL_COLUMN_CONTENT_CLASS : SPINE_HOST_CONTENT_CLASS}
    >
      {solo ? (
        // Dimmed to `--muted-foreground` (accessibility-auditor, pre-#557 round 2): the ambient
        // `--foreground` this inherited by default reads brighter than primary chat prose's own
        // `--chat-foreground`, inverting the intended secondary/bookkeeping hierarchy.
        <Markdown id={soloItem.id} text={soloItem.text} streaming={soloItem.streaming} className="text-muted-foreground" />
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
