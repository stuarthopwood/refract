// Subagent chain row and Stage group row (issue #563 decisions 1-8, 14-21): the per-turn summary
// of serial/parallel subagent batches. A Stage is a maximal run of `subagent` items that share
// the same owning assistant message (`messageId`, gate round 2 architect addendum A) AND have
// nothing else between them in the transcript except a hidden-bookkeeping-tool failure notice
// (gate round 3, architect M5/M6: this combined rule, stated once here, is the single source of
// truth every other doc location points back to -- see `groupSubagentStages.ts` for the actual
// grouping code). `StageGroupRow` renders one Stage in place, at its real position in the log;
// `SubagentChainRow` renders once per turn, at the end, only when the turn has two or more
// Stages. Both reuse the shared `SubagentStatusIcon`/`summarizeSubagentStatuses` (issue #563
// decision 14) and the shared `SpineList` connector (issue #565, steered in while building this).
import * as React from 'react'
import { BotIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { openHostedPanel } from '../right-pane/hosted-panel-actions'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'
import { ChainStageLine } from './ChainStageLine'
import { SpineList, SpineItem, SPINE_HOST_CONTENT_CLASS } from './SpineList'
import { StageContextBrief } from './StageContextBrief'
import { StageUsesLine } from './StageDependencies'
import { stageRowDomId } from './stageJump'
import { SubagentBody, SubagentRow } from './SubagentRow'
import { SubagentGoalPreview } from './SubagentGoalPreview'
import { formatElapsed } from './formatElapsed'
import { stageHeading, extractContextLabel, extractResultSummary, stageRollupText } from './stageMeta'
import { joinMetaParts } from './toolRowLabels'
import type { StageGroup } from './groupSubagentStages'
import { useStickyDisclosure } from './useStickyDisclosure'
import {
  chatRowStatus,
  SUBAGENT_ERROR_TEXT_CLASS,
  SUBAGENT_STATUS_LABEL,
  SubagentStatusGlyph,
  subagentStatusTextClass,
  summarizeSubagentStatuses,
  type SubagentRowStatus
} from '../subagents/subagentStatus'

import { overallStatus, stageSettleSummary, stageRunningSummary, stageTimeRange, type SubagentItem } from './subagentChainStatus'

// "N running", "N failed", "N cancelled", "N exited" joined by commas, each only when non-zero
// (decisions 5/15): cancelled is always its own word, never folded into "failed". Used by
// `SubagentChainRow`'s own per-turn roll-up; `StageGroupRow`'s own roll-up (below) needs the
// "N of M finished" / mixed-outcome "finished" wording decision 5/M1 asks for instead.
function rollupPhrase(counts: Record<SubagentRowStatus, number>): string {
  const parts: string[] = []
  if (counts.running > 0) parts.push(`${counts.running} running`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`)
  if (counts.exited > 0) parts.push(`${counts.exited} exited`)
  return parts.join(', ')
}

/** One Stage, rendered in place (decision 4): ALWAYS the same `CollapsedLine` (mirrors
 * `ToolGroupRow`'s own solo path, `groupToolItems.ts`), so a Stage's row never switches React
 * element type as a second agent streams in. Gate round 1 fix (issue #941, FR-079): a one-agent
 * Stage is NO LONGER a special case that renders identically to a bare `SubagentRow` (the
 * earlier #563 "a single agent renders exactly like today's SubagentRow" rule, gate round 2
 * architect addendum B, is superseded) -- every Stage, solo or not, shows the same name/green/
 * details/"Uses:" header; the only remaining difference is the body (`SubagentBody` directly
 * for one agent, a member `SpineList` for more than one, #565 decision 13: a list mounts only
 * once a 2nd member arrives). */
export function StageGroupRow({ group, sessionId }: { group: StageGroup; sessionId: string | null }) {
  const statuses = group.items.map((item) => chatRowStatus(item.status))
  const counts = summarizeSubagentStatuses(statuses)
  const status = overallStatus(counts)
  const isRunning = status === 'running'
  const total = group.items.length
  // Issue #941/#1008: the Stage label's own text-colour half (`subagentStatus.tsx`'s
  // `subagentStatusTextClass`), alongside the icon colour `STATUS_GLYPH` already supplies.
  const labelColorClass = subagentStatusTextClass(counts)

  // #563 remediation (L4/decision 19, #565 decision 26) fade-in: a member row that mounts WHILE
  // this Stage is live (running) fades in; one present at a settled/history mount never does.
  // Seeded synchronously during render (never in an effect, so a settled reopen never flashes a
  // first invisible frame), then every currently-rendered id is marked seen in an effect after
  // paint so a row only ever fades in once.
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
  // Issue #1000 (ui-architect-v3 ruling at #999's own gate, decided 2026-10-18, FR-087 --
  // amends FR-067): once a turn has two or more Stages, a Stage row's own `running` state no
  // longer auto-opens it by itself; only a failed/cancelled/exited MEMBER still does -- and it
  // does so the instant that member settles, even while a sibling member in the SAME Stage is
  // still running (Decided, Skippy, delegated by Stuart 2026-10-18, UI architect's suggested
  // fix, gate round 1: `hasBadMember` below reads the raw counts, not the Stage's own overall
  // `status`, which stays `'running'` for as long as ANY member is unsettled and would
  // otherwise silently delay this open until the whole Stage finally settles). The per-turn
  // Subagent chain row (`SubagentChainRow` below) already carries the live running overview
  // once a turn reaches two Stages, so a Stage settling in place no longer duplicates the SAME
  // agents expanded twice over. "Two or more Stages" reads `group.totalStages` -- this turn's
  // own live-grouped Stage count SO FAR (`groupSubagentStages.ts` recomputes it on every
  // grouping pass, the same number this row's own trigger label states as "of N" below,
  // `triggerAriaLabel` -- NOT `ChainStageLine`, whose own aria-label never restates it) -- so
  // while the second Stage has not started streaming yet, the first keeps today's
  // single-Stage running auto-open (research.md decision 22 has the full rationale for reading
  // it live rather than waiting for the turn to fully settle, which the renderer can never
  // know in advance anyway). The instant a second Stage's own first item streams in, every
  // Stage in this turn (including one already auto-opened while running) is reclassified
  // multi-Stage; `useStickyDisclosure`'s own upward-only latch (below) is what then keeps an
  // already-open Stage open regardless -- no extra code needed here for that half of the rule.
  // Concretely: a turn's first Stage always runs alone (nothing else can stream in before it),
  // so in a genuinely LIVE turn it auto-opens under the single-Stage branch and then STAYS
  // open for the rest of that mount's life once later Stages arrive, via the latch -- but a
  // FRESH mount of the same turn (reopened history, a remount) renders every Stage already
  // knowing the turn's final Stage count: if that first Stage never itself had a bad member,
  // its one-and-only render computes `isOpenByDefault` under the already-multi-Stage branch,
  // which never includes `running` -- so it starts CLOSED, same as any other untouched Stage
  // in that turn. Not a regression: a fresh mount's auto-open condition is evaluated exactly
  // once, against the turn's own already-known final shape, with no earlier single-Stage
  // render to have latched anything from.
  const hasBadMember = counts.failed > 0 || counts.cancelled > 0 || counts.exited > 0
  const isMultiStageTurn = group.totalStages > 1
  const isOpenByDefault = total > 1 && (isMultiStageTurn ? hasBadMember : isRunning || hasBadMember)
  // Issue #991 items 1/2/3/4 (gate round 1: ui-architect-v3 + code-reviewer + test-reviewer,
  // unanimous): shared `useStickyDisclosure` (research.md decision 19 has the full rationale).
  // Upward-only: a Stage still auto-opens while running/failed/cancelled/exited, but once open
  // (by auto-open or the user), it never auto-closes again -- only the user's own toggle can
  // close it. This fixes item 4 and, as a side effect, the AUTO-CLOSE-driven slice of item 1's
  // a11y defect (WCAG 2.4.3): the only way this row closes now is the user's own activation of
  // its own trigger, which already holds focus. A SEPARATE, pre-existing focus-loss path --
  // flagged here in gate round 1 -- is a solo Stage's own body (`SubagentBody`) swapping for a
  // `SpineList` the instant a second agent streams into the same Stage, unmounting whatever was
  // focused inside it (fixed below, issue #1001). A manual toggle
  // survives this row's own remount (a session switch, or `Transcript.tsx`'s sr-only-stub/
  // full-row visibility swap), keyed by session + this Stage's own `group.id`.
  const { open, onOpenChange } = useStickyDisclosure(sessionId, group.id, isOpenByDefault)

  // Issue #1001 (WCAG 2.4.3), the "SEPARATE, pre-existing focus-loss path" the comment above
  // flags: a solo Stage's own `SubagentBody` unmounts the instant a second agent streams into
  // the same Stage (this row's own `total > 1` branch below swaps it for a `SpineList`) --
  // whatever was focused inside it (its own Prompt/Result code block, `ToolRow.tsx`'s
  // `CodeBlock`) is removed from the document along with it. Removing a focused node blurs it
  // to `<body>` SYNCHRONOUSLY in every real browser -- there is no later point at which the
  // just-removed element can be asked whether it held focus, so `focusWasInsideRef` below is
  // kept current the whole time via a plain `focusin`/`focusout` listener on
  // `memberContentRef` (the one wrapper that survives the swap, the SubagentBody-or-SpineList
  // slot itself below), independent of React's own render cycle. Once the transition is
  // observed (`prevTotalRef` was 1, `total` is now more than 1) and focus genuinely fell to
  // `<body>`, it is moved to this Stage's OWN trigger (`triggerRef`, this row's `CollapsedLine`
  // below) -- the one element guaranteed to survive every member-count transition, the same
  // remedy `Transcript.tsx`'s own "Scroll to end" button/viewport pair already uses for an
  // analogous removed-while-focused control. Structural alternative considered and rejected
  // (Decided, Skippy, delegated by Stuart 2026-10-19): pre-wrapping the solo body in the same
  // `SpineList`/`SpineItem` shape a joining second member would need keeps `SubagentBody` itself
  // mounted (no redirect needed at all), but it either draws the Spine's own rail/indent for
  // every solo Stage (a permanent, unrelated visual regression) or leaves the FIRST member
  // looking different from every later one forever (no `SubagentRow` chrome, unlike #563's own
  // "never switch element type between solo and multi members" rule intends) -- the structure
  // does not allow it cleanly, so this falls through to the decision's own stated fallback.
  // Gate fix (first real build-slot live-check run, falsified live): a plain `useRef` +
  // `useEffect(..., [])` attaches the `focusin`/`focusout` listeners only once, at THIS
  // component's own initial mount -- but a solo Stage starts collapsed (`isOpenByDefault` is
  // always false for one agent) and Radix does not render `CollapsibleContent` at all while
  // closed, so `memberContentRef.current` is still `null` at that first run and the listeners
  // are never attached at all once the row is later expanded. A callback ref re-fires every
  // time React actually attaches/detaches the underlying DOM node -- exactly the open/close
  // (mount/unmount) cycle this needs to survive -- so the listeners are (re)attached the
  // instant the content genuinely mounts, not merely once at this component's own first render.
  const memberContentNodeRef = React.useRef<HTMLDivElement | null>(null)
  const triggerRef = React.useRef<HTMLElement>(null)
  const focusWasInsideRef = React.useRef(false)
  const prevTotalRef = React.useRef(total)

  const handleMemberContentFocusIn = React.useCallback(() => {
    focusWasInsideRef.current = true
  }, [])
  const handleMemberContentFocusOut = React.useCallback((event: FocusEvent) => {
    // Gate round 1 fix (item 1, A11y/UI Medium): a window blur (switching to another app, or
    // the OS taking focus) fires this exact `focusout` -- `relatedTarget` null -- but NEVER
    // reassigns `document.activeElement` itself (only a real focus move does that), so the
    // just-blurred TARGET is still `document.activeElement` at the instant this fires. Checked
    // here (preferred over `document.hasFocus()`, UI's own call) and returned early, keeping
    // the flag, so a join while the user is in another app/window still redirects focus
    // correctly once they come back to this one.
    if (event.target === document.activeElement) return
    // Gate round 1 fix (item 2, Code/Test/A11y Medium), corrected after live debugging found a
    // real bug in the first cut: a click onto a non-focusable spot moves focus to `<body>` with
    // nothing left in this content to redirect -- a real, ordinary move away (the user's own
    // choice), not the removal symptom this flag exists to survive -- and must clear the flag.
    // The FIRST cut compared the new `document.activeElement` against this exact event's own
    // `lost` target, which falsified live: focus moving internally between two descendants of
    // THIS SAME container (e.g. a real Tab from a CodeBlock's own Copy button onto its Prompt
    // region, both inside `memberContentRef`) ALSO fires a `focusout` on the button being left
    // -- `lost` (the button) is still connected and no longer equals `document.activeElement`
    // (now the region), so the old check wrongly read this as "moved away" and cleared the flag
    // right before the real join, reproducing the exact bug this fix exists to prevent. Fixed:
    // ask whether `document.activeElement` is STILL somewhere inside this container (any
    // descendant, not only the exact `lost` node) -- an internal move stays inside and must
    // never clear the flag; only a genuine move OUT of the whole container does.
    const lost = event.target as Element | null
    requestAnimationFrame(() => {
      if (!lost || !lost.isConnected) return
      const container = memberContentNodeRef.current
      if (container && container.contains(document.activeElement)) return
      focusWasInsideRef.current = false
    })
  }, [])
  const memberContentRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      const prevEl = memberContentNodeRef.current
      if (prevEl) {
        prevEl.removeEventListener('focusin', handleMemberContentFocusIn)
        prevEl.removeEventListener('focusout', handleMemberContentFocusOut)
      }
      memberContentNodeRef.current = el
      if (el) {
        el.addEventListener('focusin', handleMemberContentFocusIn)
        el.addEventListener('focusout', handleMemberContentFocusOut)
      }
    },
    [handleMemberContentFocusIn, handleMemberContentFocusOut]
  )

  React.useLayoutEffect(() => {
    const prevTotal = prevTotalRef.current
    prevTotalRef.current = total
    if (prevTotal !== 1 || total <= 1 || !focusWasInsideRef.current) return
    focusWasInsideRef.current = false
    if (document.activeElement === document.body || document.activeElement === null) {
      triggerRef.current?.focus({ preventScroll: true })
    }
  }, [total])

  const { startedAt, endedAt } = stageTimeRange(group.items)
  const durationMs = startedAt != null && endedAt != null ? endedAt - startedAt : undefined
  const summaryText = isRunning ? stageRunningSummary(counts, total) : stageSettleSummary(group)
  const startTimeText =
    startedAt != null ? new Date(startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : undefined
  // Gate round 2 fix (item 1): a SOLO Stage with a captured `context` still shows the context
  // label as its header (unchanged); its one agent's own name, no longer stated anywhere once
  // `summary` moved into `meta` in round 1, comes back here specifically for this one case, as
  // `CollapsedLine`'s own `summary` slot (round 1's "counts moved out of summary" fix only ever
  // concerned the roll-up counts, not this). A solo Stage with NO context already gets the
  // agent's name AS its label (`stageMeta.ts`'s own `computeStageLabel` fix), so showing it a
  // second time here would be redundant -- gated on the context tier genuinely having produced
  // the label, not merely on `total === 1`.
  const soloContextLabel = total === 1 && group.context ? extractContextLabel(group.context) : null
  const soloAgentName = soloContextLabel ? group.items[0]!.name : undefined
  // Gate round 1 fix (issue #1077, item 6, MEDIUM): a solo Stage's own Prompt/Result now sit
  // behind a toggle, same as every other Stage -- a multi-agent member already keeps its own
  // failure reason visible unconditionally via `extractResultSummary` in its `summary` slot
  // (issue #941 grill item 4); a solo Stage had no equivalent, so a failed/cancelled/exited
  // one-agent Stage's own reason is restored here, next to its own goal, not only reachable
  // behind the toggle.
  const soloItem = total === 1 ? group.items[0]! : undefined
  const soloStatus = soloItem ? chatRowStatus(soloItem.status) : undefined
  const soloIsUnsettledBad = soloStatus === 'failed' || soloStatus === 'cancelled' || soloStatus === 'exited'
  const soloFailureReason = soloItem && soloIsUnsettledBad && soloItem.result != null ? extractResultSummary(soloItem.result) : undefined
  // Gate round 1 fix (issue #1077, item 1, HIGH): `item.context` ALONE is not reliable per
  // member -- `subagent_items.rs` stamps a task() call's own `context` argument onto that
  // call's spec-index-0 item ONLY (this file's own `flush()` comment above), so a call's 2nd+
  // member carries no `item.context` of its own even when its OWN call genuinely had one.
  // Correlated by `toolCallId` instead: a member's own goal is suppressed when ANY item sharing
  // its `toolCallId` (its own call) carries a context, not only when THIS exact item does.
  const toolCallIdsWithContext = new Set(group.items.filter((item) => item.context).map((item) => item.toolCallId))
  // Gate round 2 fix (item 5), gate round 3 fix: `joinMetaParts` (the shared `· `/sr-only-comma
  // separator every other meta slot in this codebase already uses) covers the ALWAYS-shown
  // core (the roll-up counts, then duration) -- the status word (shown only while running) and
  // the start time are each a separate, individually narrow-hideable unit instead, the
  // separator bundled INSIDE the same hideable span as its own content (gate round 3 fix:
  // `joinMetaParts` renders a part's own separator as a SEPARATE sibling before it, so hiding
  // only the content left a dangling "·" with nothing after it at a narrow width) -- hidden
  // together below `@max-[32rem]` (a container query against the chat pane's own
  // `[container-type:size]` ancestor, #554's same mechanism) so the Stage's own label -- never
  // this -- is what gives up space first; the settled "N done"/"N done, M failed" wording
  // already states failed/cancelled/exited, so a bare status word is shown only while running.
  const meta = (
    // Gate round 5 fix (issue #941, item 2, HIGH): `shrink-0` -> `min-w-0 shrink` -- this slot
    // never gave up width at 240-319px, forcing the label/chevron to absorb the whole squeeze.
    <span aria-hidden="true" className="flex min-w-0 shrink items-center gap-1 whitespace-nowrap text-xs leading-5 text-muted-foreground">
      {joinMetaParts([<span key="summary" className="min-w-0 truncate" title={summaryText}>{summaryText}</span>])}
      {durationMs != null && (
        // Gate round 4 fix (issue #941, P5, MEDIUM): previously inside the `joinMetaParts`
        // array above (`shrink-0`, no hide rule at all), so a multi-agent Stage's own meta slot
        // could never give up the duration's own width under real pressure. Pulled out into
        // the SAME standalone, separator-bundled wrapper pattern `isRunning`/`startTimeText`
        // already use below (gate round 3 fix: `joinMetaParts` renders a part's own separator
        // as a SEPARATE sibling before it, so hiding only the content would leave a dangling
        // "·" with nothing after it at a narrow width) -- hidden together with them, one step
        // earlier (`@max-[20rem]`, narrower than their own `@max-[32rem]`), so the duration is
        // the LAST of the three optional parts to give up space, not the first.
        <span className="@max-[20rem]:hidden">
          <span> · </span>
          <span className="tabular-nums">{formatElapsed(durationMs)}</span>
        </span>
      )}
      {isRunning && (
        <span className="@max-[32rem]:hidden">
          <span> · </span>
          {SUBAGENT_STATUS_LABEL[status]}
        </span>
      )}
      {startTimeText != null && (
        <span className="@max-[32rem]:hidden">
          <span> · </span>
          <span className="tabular-nums">{`started ${startTimeText}`}</span>
        </span>
      )}
    </span>
  )
  const stageLabel = stageHeading(group.stageIndex, group.label)
  // Gate round 2 fix (item 8): no repeated "Stage N" -- `stageHeading`'s own speech form already
  // states it once ("Stage 3, label"), so the stage-count clause here is just "of M", not a
  // second "stage N of M". Gate round 1's item 1 fix (the name in the accessible name) applies
  // here too: `soloAgentName` is appended when present.
  const triggerAriaLabel = `${stageHeading(group.stageIndex, group.label, true)}, of ${group.totalStages}${soloAgentName ? `, ${soloAgentName}` : ''}, ${summaryText}${isRunning ? `, ${SUBAGENT_STATUS_LABEL[status]}` : ''}${durationMs != null ? `, ${formatElapsed(durationMs)}` : ''}${startTimeText != null ? `, started ${startTimeText}` : ''}`
  // Gate round 2 fix (item 4): the label-column indent (`pl-8 pr-2`) is passed to the brief/
  // Uses line explicitly -- a one-agent Stage's `CollapsibleContent` already carries `pl-8` via
  // its own `contentClassName` below, so they take `pr-2` alone there (no second `pl-8` on top
  // of the one the parent already applies); a multi-agent Stage's own `ml-4 pt-1` supplies no
  // indent at all, so they take the full `pl-8 pr-2` themselves.
  const columnClassName = total > 1 ? cn(LABEL_COLUMN_CONTENT_CLASS, 'pr-2') : 'pr-2'

  return (
    <CollapsedLine
      ref={triggerRef}
      id={stageRowDomId(sessionId, group.id)}
      icon={<SubagentStatusGlyph status={status} />}
      label={stageLabel}
      // Gate round 5 fix (issue #941, item 1, HIGH): `min-w-16` lives HERE now, not in
      // `CollapsedLine`'s own shared base class -- every other caller (tool rows, advisory
      // rows, notices) shares that same label span and was silently widened by a floor only
      // this Stage row needed.
      labelClassName={cn('min-w-16', labelColorClass)}
      summary={soloAgentName}
      summaryFixedWidth={soloAgentName !== undefined}
      meta={meta}
      // Gate round 6 fix (issue #941, item 1, MEDIUM): `min-w-0 shrink` lives HERE now, not in
      // `CollapsedLine`'s own shared `meta` base (restored to `shrink-0`) -- every other caller
      // (tool rows, advisory rows, request cards) shares that same wrapper and was silently
      // affected by the gate-round-5 fix meant only for this row.
      metaClassName="min-w-0 shrink"
      // Gate round 2 fix (item 1): a solo Stage never auto-expands (the architect M9 rule round
      // 1 accidentally dropped by unifying the two paths) -- FR-067's "renders collapsed by
      // default" stays true for the one-agent case specifically; a multi-agent Stage keeps its
      // existing running/failed/cancelled/exited auto-open while this turn has fewer than two
      // Stages, and only failed/cancelled/exited once it has two or more (issue #1000,
      // FR-087) -- now sync'd upward only via `useStickyDisclosure` (issue #991 items 1/3/4) --
      // see the toggle block above for the full rationale.
      open={open}
      onOpenChange={onOpenChange}
      triggerAriaLabel={triggerAriaLabel}
      // #565 decision 8: a multi-agent Stage's own `SpineList` needs its `ml-4`/`pt-1`; a
      // one-agent Stage's single `SubagentBody` instead starts at the ordinary label column
      // (#565 decisions 10/13) every other Spine member's own body does.
      contentClassName={total > 1 ? SPINE_HOST_CONTENT_CLASS : LABEL_COLUMN_CONTENT_CLASS}
    >
      {/* Gate round 3 fix (item 6): a tighter `space-y-1` for this group specifically, instead
          of `CollapsibleContent`'s own ambient `space-y-2` (which still governs spacing against
          any OTHER top-level content a future caller might add alongside these three). Gate
          round 1 fix (issue #1000, item 8, A11y): `aria-live="off"` -- this renders inside
          `Transcript.tsx`'s own `role="log"` region, whose implicit live-region default would
          otherwise queue the context brief/"Uses:" line (and member status changes nested
          inside, though `SpineList`'s own `aria-live="off"` already covers that half) as their
          own log-addition announcements, matching `SpineList`/`UpNextList`'s own convention. */}
      <div aria-live="off" className="space-y-1">
        {/* Issue #941 grill item 4: the Stage's own full batch context, rendered Markdown, with
            a real expand/collapse control past about 6 lines (`StageContextBrief`); absent when
            no item in the run captured a `context` (a flat call, or history from before #941). */}
        {group.context && <StageContextBrief id={`${group.id}-context`} context={group.context} className={columnClassName} />}
        {/* Gate round 1 fix (issue #1077, item 7, MEDIUM): a context-less solo Stage's own goal
            renders HERE, at the Stage level -- the same position a context-bearing Stage's own
            `StageContextBrief` takes, before "Uses:" -- rather than nested inside `SubagentBody`
            (which would put it AFTER "Uses:", a different order than the context-bearing case). */}
        {!group.context && soloItem && (
          <div className={columnClassName}>
            <SubagentGoalPreview task={soloItem.task} />
          </div>
        )}
        {soloFailureReason != null && (
          <p className={cn(columnClassName, 'text-xs', soloStatus === 'failed' ? SUBAGENT_ERROR_TEXT_CLASS : 'text-muted-foreground')}>
            {soloFailureReason}
          </p>
        )}
        <StageUsesLine dependencies={group.dependencies} sessionId={sessionId} className={columnClassName} />
        {/* Issue #1001: a stable wrapper scoped to ONLY the member content that actually swaps
            element type on a 1-to-2 members transition -- never the context brief/Uses line
            above, which do not unmount on it -- so the focus-tracking effect above never
            redirects focus away from one of THOSE while they stay mounted. */}
        {/* Gate round 1 fix (issue #1077, item 1, HIGH): each member's own goal is suppressed
            only when its OWN call (`toolCallIdsWithContext`, correlated above) had a context --
            a joined Stage can hold several task() calls, each with its own distinct context or
            none, so one member's own goal must never depend on a SIBLING call's context. A
            solo Stage's own `SubagentBody` always passes `false`: its own goal (when it has
            one) already rendered above, never shown twice over. */}
        <div ref={memberContentRef}>
          {total > 1 ? (
            <SpineList gap="member">
              {group.items.map((item) => (
                <SpineItem key={item.id} isNew={isRunning && !seenIds.has(item.id)}>
                  <SubagentRow item={item} showGoal={!toolCallIdsWithContext.has(item.toolCallId)} />
                </SpineItem>
              ))}
            </SpineList>
          ) : (
            <SubagentBody item={group.items[0]!} showGoal={false} />
          )}
        </div>
      </div>
    </CollapsedLine>
  )
}

/** Decision 7: a ghost icon-only button opening the panel without selecting any one agent --
 * separate from each entry's own activation, so the disclosure chevron (expand/collapse this
 * row) is never overloaded with a second meaning. Lives in the chain header's own `action=` slot
 * (#563 remediation, M1/M4/M5): a sibling of the `CollapsibleTrigger`, not nested inside it. */
function ChainShowPanelButton({ sessionId }: { sessionId: string | null }) {
  if (!sessionId) return null
  return (
    <Tooltip>
      {/* `aria-describedby={undefined}` (repo convention, e.g. `PanelTabBar.tsx`'s own
       * `TabButton`): Radix sets `aria-describedby` on the trigger whenever the tooltip is open,
       * and a screen reader's accessible-description computation follows that reference into the
       * tooltip's own text regardless -- redundant here since `aria-label` is already the full
       * description. */}
      <TooltipTrigger asChild aria-describedby={undefined}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Show subagents panel"
          onClick={(event) => openHostedPanel('subagents', sessionId, { opener: event.currentTarget })}
        >
          <BotIcon aria-hidden className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Show subagents panel</TooltipContent>
    </Tooltip>
  )
}

/** The per-turn summary (decision 5), shown only for two or more Stages (FR-065) -- a single
 * Stage is already fully summarised by its own `StageGroupRow` in place. `mt-6` baked in here
 * (decision 5: "not a bookkeeping row"), the same turn-rhythm margin `TurnTotalLine` uses,
 * because this renders directly in the turn's own `React.Fragment` (like `TurnTotalLine`), not
 * inside a `MessageScrollerItem` keyed to any one `TranscriptItem`. */
export function SubagentChainRow({ stages, sessionId }: { stages: StageGroup[]; sessionId: string | null }) {
  // Decision 19/#565 decision 26 fade-in: a Stage entry that mounts WHILE the chain is live
  // (running) fades in; one present at a settled/history mount never does (same seen-set
  // pattern as `StageGroupRow`'s own member rows, lazily seeded during render, never in an
  // effect, so a settled reopen never flashes a first invisible frame). Computed unconditionally,
  // before the `stages.length < 2` early return below, since hooks can never run conditionally.
  const seenStageIdsRef = React.useRef<Set<string> | null>(null)
  const allItems = stages.flatMap((stage) => stage.items)
  const statuses = allItems.map((item) => chatRowStatus(item.status))
  const counts = summarizeSubagentStatuses(statuses)
  const status = overallStatus(counts)
  const isRunning = status === 'running'

  if (seenStageIdsRef.current === null) {
    const seen = new Set<string>()
    if (!isRunning) for (const stage of stages) seen.add(stage.id)
    seenStageIdsRef.current = seen
  }
  const seenStageIds = seenStageIdsRef.current
  React.useEffect(() => {
    for (const stage of stages) seenStageIds.add(stage.id)
  }, [stages, seenStageIds])

  // Decision 19 (gate round 2 fix): the chain's own duration must genuinely tick once a second
  // while running, matching `Transcript.tsx`'s own `TurnTotalLine` tick (`forceTick` pattern) --
  // the comment below already claimed this, but nothing re-rendered this component on its own
  // until now, so `Date.now()` was only ever read once per OTHER state change. Also before the
  // early return (hooks rule). Gate round 3 (Low): also gated on `stages.length >= 2`, since a
  // running turn with fewer Stages renders `null` below and never needs to re-render on a tick.
  const [, forceTick] = React.useReducer((count: number) => count + 1, 0)
  React.useEffect(() => {
    if (!isRunning || stages.length < 2) return
    const interval = setInterval(forceTick, 1000)
    return () => clearInterval(interval)
  }, [isRunning, stages.length])

  // Gate-fix (live build, first real build-slot run -- never exercised before now):
  // `defaultOpen` below USED TO only matter to `CollapsedLine`'s own `useState(defaultOpen ??
  // false)` AT THE INSTANT this component first mounted (pre-`useStickyDisclosure`; no caller
  // passes a bare `defaultOpen` any more). If this chain row mounted (`stages.length` first
  // reaches 2) while every agent so far was still genuinely pending/finished -- entirely
  // plausible: Stage 5's own failure may not exist yet -- that initializer captured `false` once
  // and never re-read a LATER `defaultOpen` recompute, so a Stage that failed well after this
  // row's first mount could never auto-open it (confirmed live: this fixture's own Stage 5
  // failure left the chain row closed on first render instead of Decision 6's "expanded while
  // anything is unsettled"). Fixed by going fully controlled here, auto-opening once
  // `isUnsettled` turns true, UNTIL the user explicitly toggles it (now `useStickyDisclosure`,
  // issue #991 items 1/3/4). Decision (Skippy, delegated by Stuart 2026-10-18, posted on issue
  // #941): sync UPWARD only, never auto-close -- an untouched row closing itself the instant
  // everything finishes would collapse Stage rows the user expanded mid-read and drop their
  // focus, so settling back to all-green never auto-collapses a row the user never touched
  // either.
  const isUnsettled = counts.running > 0 || counts.failed > 0 || counts.cancelled > 0 || counts.exited > 0
  // Issue #991 items 1/2/3/4 (gate round 1: ui-architect-v3 + code-reviewer + test-reviewer,
  // unanimous): shared `useStickyDisclosure`, same rationale as `StageGroupRow` above. `turnKey`
  // is `undefined` only when `stages` is empty (no Stage exists yet for this turn) --
  // `useStickyDisclosure` falls back to local-only state for that case, same as a null
  // `sessionId`. This only ever happens while `stages.length < 2` (the early return just below
  // also covers a turn with exactly one Stage, where `turnKey` IS defined but the chain row
  // still renders nothing), so there is never anything visible to toggle regardless. A
  // manual toggle survives a SESSION SWITCH -- a different Session's own row set unmounts this
  // component entirely through ordinary keyed-list reconciliation. Gate round 2 correction
  // (code-reviewer): `stages.length` dropping back below 2 is NOT a remount by itself -- React
  // keeps this exact component instance, and every hook's own state, alive when a component
  // returns `null`; it never loses anything a manual toggle would need to survive on its own.
  const turnKey = stages[0]?.id
  const toggleRowId = turnKey ? `chain:${turnKey}` : null
  const { open, onOpenChange } = useStickyDisclosure(sessionId, toggleRowId, isUnsettled)

  if (stages.length < 2) return null

  const { startedAt, endedAt } = stageTimeRange(allItems)
  // Decision 19: the chain's own duration ticks every second while running (measured wall-clock
  // from the first Stage's first start to now), and is `aria-hidden` while running (matches
  // `TurnTotalLine`'s own rule) so a screen reader only reads the final value once settled.
  const durationMs = startedAt == null ? undefined : isRunning ? Date.now() - startedAt : endedAt != null ? endedAt - startedAt : undefined
  const rollup = rollupPhrase(counts)
  const summary = `${stages.length} stages, ${allItems.length} agent${allItems.length === 1 ? '' : 's'}${rollup ? `, ${rollup}` : ''}`
  // #563 remediation (H1): `icon=` is a `CollapsedLine` icon slot, so the status word stays
  // sr-only there (`SubagentStatusGlyph`) and is rendered visibly HERE instead, in `meta`, ahead
  // of the duration -- gated off for `finished` (decision 14). `aria-hidden` (gate round 2,
  // double-word fix): `triggerAriaLabel` below restates the word and duration once on its own,
  // so the formerly-separate `sr-only` "Took ..." span is dead now and dropped entirely.
  const statusVisible = status !== 'finished'
  const meta = (
    // Gate round 5 fix (issue #941, item 2, HIGH/MEDIUM): `shrink-0` -> `min-w-0 shrink` (same
    // 240-319px chevron-clip fix as the Stage row above); the status word and duration used to
    // run together with NO separator at all when both rendered ("Running1m 20s") -- a real "·"
    // now joins them, bundled inside the duration's own narrow-hideable span (so hiding the
    // duration at `@max-[20rem]` -- matching the Stage row's own threshold -- never leaves a
    // dangling leading "·" with nothing visible before it).
    <span aria-hidden="true" className="flex min-w-0 shrink items-center gap-1 text-xs text-muted-foreground">
      {statusVisible && (
        <span className="min-w-0 truncate" title={SUBAGENT_STATUS_LABEL[status]}>
          {SUBAGENT_STATUS_LABEL[status]}
        </span>
      )}
      {durationMs != null && (
        // Gate round 6 fix (issue #941, item 2, LOW): `whitespace-nowrap` on the duration span
        // -- `tabular-nums` alone does not stop "1m 20s" itself wrapping across two lines once
        // this now-shrinkable slot runs short of room.
        <span className="@max-[20rem]:hidden whitespace-nowrap">
          {statusVisible && <span> · </span>}
          <span className="tabular-nums">{formatElapsed(durationMs)}</span>
        </span>
      )}
    </span>
  )

  return (
    <CollapsedLine
      icon={<SubagentStatusGlyph status={status} />}
      label="Subagents"
      summary={summary}
      summaryWrap
      meta={meta}
      // Gate round 6 fix (issue #941, item 1, MEDIUM): same opt-in as the Stage row above.
      metaClassName="min-w-0 shrink"
      open={open}
      onOpenChange={onOpenChange}
      className="mt-6"
      contentClassName={SPINE_HOST_CONTENT_CLASS}
      // Gate round 2 (Low): also restates the running/failed/etc. word `meta` shows visibly,
      // since `aria-label` replaces the content name outright. Gate round 3 (Medium): the
      // duration is left OUT while running -- it ticks every second (`forceTick` above), and
      // restating a ticking value in the accessible name would change a focused trigger's own
      // name once a second (decision 19/21: the duration stays `aria-hidden` in `meta` and
      // nothing should be announced per tick); it is restated only once settled, the instant it
      // stops ticking.
      triggerAriaLabel={`Subagents, ${summary}${status !== 'finished' ? `, ${SUBAGENT_STATUS_LABEL[status]}` : ''}${!isRunning && durationMs != null ? `, ${formatElapsed(durationMs)}` : ''}`}
      action={<ChainShowPanelButton sessionId={sessionId} />}
    >
      <SpineList gap="stage">
        {stages.map((stage) => (
          <SpineItem key={stage.id} isNew={!seenStageIds.has(stage.id) && isRunning}>
            <ChainStageLine stage={stage} sessionId={sessionId} />
          </SpineItem>
        ))}
      </SpineList>
    </CollapsedLine>
  )
}
