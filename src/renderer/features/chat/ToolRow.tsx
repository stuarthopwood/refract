import * as React from 'react'
import type { TranscriptItem } from '../../../shared/model'
import { CodeBlock, FileLinkButton, inferOutputBlock } from './Markdown'
import { CollapsedLine, LABEL_COLUMN_CONTENT_CLASS } from './CollapsedLine'
import { DiffView } from './DiffView'
import { ToolCallDialog } from './ToolCallDialog'
import { formatDuration, StatusIcon, type RowStatus } from './toolStatus'
import { toolAriaPrefix, toolVerb } from './toolVerbs'
import { formatElapsed } from './formatElapsed'
import { COMMAND_STYLE_TOOLS, commandRowText, sanitizeLines } from './formatToolCommand'
import { callMeta, editStatForItem, diffStatAriaText, joinMetaParts } from './toolRowLabels'
import type { ToolGroup } from './groupToolItems'
import { SpineList, SpineItem, SPINE_HOST_CONTENT_CLASS } from './SpineList'
import { cn } from '@/lib/utils'
import {
  chatRowStatus,
  isSubagentSuccessStatus,
  SUBAGENT_STATUS_LABEL,
  SUBAGENT_SUCCESS_TEXT_CLASS,
  SubagentStatusGlyph
} from '../subagents/subagentStatus'
import { extractResultSummary } from './stageMeta'
import { InlineDisclosure } from '@/components/InlineDisclosure'
import { SubagentGoalPreview } from './SubagentGoalPreview'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>
type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

interface ToolCallBodyProps {
  item: ToolItem
  dialogOpen: boolean
  onDialogOpenChange: (open: boolean) => void
}

// A short result is safe to show as this call's own quiet one-line summary straight in the row
// (#628, e.g. "Queued for ... (was parked; revived)."); a longer or multi-line result needs
// "View full call" instead, never a misleading truncated first line.
const QUIET_SUMMARY_MAX_CHARS = 200
// Gate round 2 (G909Arch N1): the group-detail attribution prefix (the failing call's own
// target, muted) is capped well short of the Error line's own 200-character budget, so a long
// command never pushes the actual error text out of the 2-line clamp.
const ATTRIBUTION_PREFIX_MAX_CHARS = 40

function quietSummary(output: string | undefined): string | undefined {
  if (!output || output.includes('\n') || output.length > QUIET_SUMMARY_MAX_CHARS) return undefined
  return output
}

// #570 decision 7 (live probe, docs/spike/bash-error-probe-570.mjs, FINDINGS item 60), AMENDED
// after gate round 1 (G909Arch H1, G909Code, G909A11y): the ORIGINAL cut also stripped OMP's own
// `Command exited with code N`/timed-out line, so a silent failure (`exit 9`, `grep -q`, a failed
// `test`) showed OMP's literal `(no output)` placeholder instead of the one fact that actually
// explains the failure -- the exit code. Fixed: only `Wall time: Ns` (OMP's own exact pattern,
// `^Wall time: \d+(?:\.\d+)? seconds$`) is stripped from the end; the exit-code or timeout line
// that follows it is read FIRST, as the fallback, before the cut -- any notice line OMP inserts
// between them (for example "Timeout clamped to ...") is skipped over, never mistaken for the
// real error. A lone `(no output)` left after the cut is also wrapper chrome, not content: when
// nothing real remains, the fallback (the exit code or timeout line, or `item.details.exitCode`
// when the text itself lacks one) is shown instead; "Failed." is reserved for a call with no
// output AND no exit/timeout information at all. Every other tool is unaffected: no footer, no
// fallback, just its own FIRST non-empty line. Control sequences (CSI/OSC), C0 controls, and
// bidi-override characters are stripped first so a stray terminal code or a spoofing override
// never leaks into the plain-text row (security hardening, gate round 1). #962: `sanitizeLines`
// moved to `formatToolCommand.ts` so its own `commandRowText` can run the same cleaning over its
// command and path text -- one copy of the regex, imported above.
const WALL_TIME_LINE = /^Wall time: \d+(?:\.\d+)? seconds$/
const EXIT_CODE_LINE = /^Command exited with code (-?\d+)$/
const TIMEOUT_LINE = /^Command timed out after (\d+) seconds$/
const TIMEOUT_BRACKETED = /\[Command timed out after (\d+) seconds\]/

function errorLine(item: ToolItem): string {
  const raw = item.output
  let lines = raw ? sanitizeLines(raw) : []
  let fallback: string | undefined
  if (item.tool === 'bash') {
    // Gate round 2 (G909Arch/G909Code N3): the LAST `Wall time:` line, not the first -- a
    // command whose own real output happens to print a matching line must not have its genuine
    // trailing footer missed, and the real footer is always the final occurrence.
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
      // Gate round 2 (G909Code N8): read BEFORE the `lines.length === 0` check below, not after
      // -- a bash call with no output at all (`raw` falsy) must still fall through to this,
      // never short-circuit straight to "Failed." while a real exit code is known.
      const details = item.details as { exitCode?: number } | undefined
      if (typeof details?.exitCode === 'number') fallback = `Exited with code ${details.exitCode}`
    }
    // OMP's own placeholder for a call that printed nothing at all: wrapper chrome, never the
    // actual error (that is exactly what the fallback above is for).
    if (lines.length > 0 && lines[lines.length - 1] === '(no output)') lines = lines.slice(0, -1)
  }
  if (lines.length === 0) return fallback ?? 'Failed.'
  const line = item.tool === 'bash' ? lines[lines.length - 1]! : lines[0]!
  return line.length > QUIET_SUMMARY_MAX_CHARS ? `${line.slice(0, QUIET_SUMMARY_MAX_CHARS)}…` : line
}

// The expansion content for one tool call (#628, #630): an edit's diff (capped, with its own
// Expand/Collapse, `DiffView`'s `capped` prop), a successful write's "Wrote N lines to <path>"
// line, or a short successful call's own one-line result -- never a boxed Arguments/Output/
// content block (moved into the "View full call" dialog, `ToolCallDialog.tsx`, which still
// renders every argument and the output through the shared `CodeBlock`, T083, FR-050). A failed
// call's own error text is NOT part of this expansion (#570 decision 10): it is the Error line,
// a baseline fixture rendered by `CollapsedLine` itself under the row, visible whether the row is
// collapsed or expanded, never duplicated here. Split out from the row wrapper so `ToolGroupRow`
// can reuse the same content for a solo call (no nested `CollapsedLine`) and for each call inside
// a multi-call group (its own nested `CollapsedLine` via `ToolCallRow` below) without ever
// changing the *wrapper* element type at a given tree position. `dialogOpen`/`onDialogOpenChange`
// are controlled from `ToolGroupRow` (quality-gate remediation, Medium): see that component's own
// comment for why.
function ToolCallBody({ item, dialogOpen, onDialogOpenChange }: ToolCallBodyProps) {
  // Quality-gate remediation (Sec, Medium): `item.write`/`item.output` are both populated from
  // the call's own arguments or a partial result while it is still running (`transcript.ts`),
  // not only once it actually finishes -- "Wrote N lines to <path>" and a quiet one-line result
  // are both claims that the call *succeeded*, so both are gated on `status === 'done'` and
  // never shown for a running, interrupted or exited call (which could still fail, or never
  // actually have written anything).
  // Gate round 1 (ui-architect-v3 High, H6): #632's own acceptance is that an expanded `bash`
  // call shows NO output text at all except a failed call's Error line -- `quietSummary` is
  // skipped for `bash` only (FR-061's "single line, 200 chars or fewer, shows verbatim" rule now
  // excludes it, spec.md corrected to match); every other tool is unaffected.
  const isDone = item.status === 'done'
  const summary = isDone && item.tool !== 'bash' ? quietSummary(item.output) : undefined
  // Quality-gate remediation (Low): a `content` ending in a trailing newline (the common case for
  // a real file) used to count one line too many -- `split('\n')` turns "a\nb\n" into
  // `['a', 'b', '']`, counting the empty string after the final newline as a line of its own.
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
  /** Forwarded to the nested `CollapsedLine`'s `summaryWrap` (see `ToolGroupRowProps`). */
  summaryWrap?: boolean
  dialogOpen: boolean
  onDialogOpenChange: (open: boolean) => void
  /** Quality-gate remediation (High, round 3): when the solo→multi reshape below mounts a FRESH
   * `ToolCallRow` for a call whose dialog was already open, its nested `CollapsedLine` must
   * start expanded -- `Collapsible`'s `CollapsibleContent` has no `forceMount` (`collapsible.tsx`,
   * `ui/collapsible.tsx`) and renders no children at all while collapsed, so an uncontrolled
   * `defaultOpen={false}` here would mean `ToolCallBody`/`ToolCallDialog` never mount in the new
   * position: the dialog would stay invisible with focus dropped to `<body>` even though
   * `ToolGroupRow`'s own `openDialogItemId` still names this item, and that stale id would later
   * pop the dialog open unprompted the moment the user manually expanded this row. Read once, on
   * mount, the same contract `CollapsedLine`'s own `defaultOpen` already has. */
  defaultOpen?: boolean
}

// One compact row per tool call, used only for each call nested inside an expanded multi-call
// group (never at the top-level tree position `ToolGroupRow` itself occupies).
function ToolCallRow({ item, summaryWrap, dialogOpen, onDialogOpenChange, defaultOpen }: ToolCallRowProps) {
  // Gate round 1 (code-reviewer/ui-architect-v3 Medium, M2): a `bash`/`grep` member's own
  // `summary` (`commandRowText`) already names the tool ("$ ..."/"grep \"...\""), so a separate
  // `label` read as a duplicate word; dropped for exactly those two tools.
  const isCommandStyle = COMMAND_STYLE_TOOLS.has(item.tool)
  // Gate round 1 (accessibility-auditor Medium, M1): this row had no explicit accessible name
  // (content-based, lost once `label` is dropped above, and prone to #570's doubled-space
  // artifact) -- built explicitly from tool, status, `commandRowText` (M1), and duration.
  // #1208 FR-006: the verb now leads the name, so `grep`'s old prefix skip (D3) is gone; a status
  // word is kept only as a prefix for a failed/stopped call. (Main, D2): the edit stat's sr-only
  // text folds in here instead -- an explicit `aria-label` makes a browser ignore every child.
  const memberDuration = item.status !== 'running' && item.durationMs != null ? formatDuration(item.durationMs) : undefined
  const memberAriaLabel = [
    [toolAriaPrefix(item.status, item.tool), toolVerb(item.tool, item.status), commandRowText(item)].filter(Boolean).join(' '),
    diffStatAriaText(editStatForItem(item)),
    memberDuration
  ]
    .filter((part): part is string => !!part)
    .join(', ')
  return (
    <CollapsedLine
      icon={<StatusIcon status={item.status} />}
      label={isCommandStyle ? undefined : toolVerb(item.tool, item.status)}
      labelClassName={item.status === 'error' ? 'text-severity-error' : undefined}
      // Gate round 1 fix (H1/M2 interaction, found live): #570 decision 4 colours icon+label
      // red on failure; a command-style row's dropped label left no coloured text -- restored here.
      summary={commandRowText(item)}
      summaryClassName={isCommandStyle && item.status === 'error' ? 'text-severity-error' : undefined}
      summaryWrap={summaryWrap}
      // Gate round 1 (code-reviewer High, H4): wrap-on-expand is opt-in now; a tool call's row
      // text (FR-061) wants it for every tool, not only the command-style ones.
      wrapWhenOpen
      meta={callMeta(item)}
      triggerAriaLabel={memberAriaLabel}
      // #570 decisions 6, 9: a failed member's own Error line, shown whether this row is
      // collapsed or expanded -- no `hideDetailWhenOpen` here, that only applies to the GROUP
      // header below, which this member row is not.
      detail={item.status === 'error' ? errorLine(item) : undefined}
      defaultOpen={defaultOpen}
      // #565 decision 10: a member's expanded body starts at the label column (the default
      // `px-2`'s own `pr-2` is kept, only the left side widens).
      contentClassName={LABEL_COLUMN_CONTENT_CLASS}
    >
      <ToolCallBody item={item} dialogOpen={dialogOpen} onDialogOpenChange={onDialogOpenChange} />
    </CollapsedLine>
  )
}

interface ToolGroupRowProps {
  group: ToolGroup
  /** Opt-in (#492, spec 004 FR-022): the Subagents panel's narrower column wraps a long target
   * instead of truncating it, where the main transcript's own wider rows stay one-line. */
  summaryWrap?: boolean
}

// A collapsed run of consecutive calls to the same tool (T074, docs/DESIGN.md "Chat"). Always
// renders exactly one top-level `CollapsedLine`, whatever the run's length, so this never changes
// element type at this tree position when a run grows from one call to two or more (FIX: focus
// and expansion used to be lost the moment a second call arrived -- first because a lone call and
// a run rendered through two different components, `ToolRow` vs `ToolGroupRow`, then because this
// function's own single-call branch still returned a *different* top-level element, `ToolCallRow`,
// than its multi-call branch's `CollapsedLine`; both cases make React unmount/remount the
// Collapsible that holds the trigger's focus and open state; see `groupToolItems`, which now
// always hands this a `ToolGroup`, even for a run of one). A one-item group's `CollapsedLine` gets
// the same label/summary/meta a lone call used to show, with that call's own body as the content
// (no multi-call header, no extra nesting). A multi-item group's own status is running while
// any call runs, else failed when any call failed; #632 replaced its old summary ("the last
// call's target, plus + N others") with an explicit count folded into the label itself ("bash
// ×2") and no summary text at all -- the failed/interrupted counts and the run's own total
// duration live in the never-shrinking `meta` slot instead (#570 decision 12, text AND colour:
// "N failed" reads in the error colour; #632: all three join with the same "·" grammar) -- and
// only the *children* of this one `CollapsedLine` -- never its own presence or type -- switch to
// the per-call list.
//
// Quality-gate remediation (A11y, High round 3; Medium round 2): `openDialogItemId` (which
// call's "View full call" dialog, if any, is open) is held HERE, above the solo/multi switch
// above, keyed by `item.id` -- not as `ToolCallDialog`'s own internal state. The switch between
// the solo branch (`ToolCallBody` directly) and the multi branch (a `SpineList` `<ol>` of `ToolCallRow`s)
// changes the child's element type at this tree position (exactly the
// `ToolCallRow`-vs-`CollapsedLine` problem the comment above already solved one level up), so a
// `ToolCallBody`/`ToolCallDialog` for a call that is mid-run unmounts and remounts the moment a
// second call of the same tool starts streaming. Lifting the state here is necessary but NOT
// sufficient on its own (round 2's mistake): `ToolCallRow`'s own nested `CollapsedLine` is still
// uncontrolled and mounts collapsed by default, and `Collapsible`'s content renders nothing at
// all while collapsed (no `forceMount`) -- so without `ToolCallRow`'s own `defaultOpen` prop
// (above), the freshly mounted `ToolCallBody`/`ToolCallDialog` would never mount into the DOM at
// all, the dialog would stay invisible with focus dropped to `<body>`, and the stale
// `openDialogItemId` would later pop the dialog open unprompted the next time the user manually
// expanded that row. With BOTH the lifted state and `ToolCallRow`'s `defaultOpen={dialogOpen}`,
// the freshly mounted nested row starts expanded, so `ToolCallDialog` mounts with `open` already
// `true` and Radix's own focus-return targets the newly mounted trigger on close.
export function ToolGroupRow({ group, summaryWrap }: ToolGroupRowProps) {
  const [openDialogItemIdState, setOpenDialogItemId] = React.useState<string | null>(null)
  // Defensive (round 3): `groupToolItems` only ever appends to a run, never removes from it, so
  // this should never actually trigger today -- but a stale id naming a call that is no longer
  // in this group must never be treated as "open" (it would silently start a nested row expanded
  // for the wrong reason, or leave `openDialogItemId` unreclaimable).
  const openDialogItemId =
    openDialogItemIdState != null && group.items.some((item) => item.id === openDialogItemIdState) ? openDialogItemIdState : null
  const solo = group.items.length === 1
  const failedCount = group.items.filter((item) => item.status === 'error').length
  // Issue #510 slice 3 quality-gate fix (a11y, Low): a multi-call group used to name failed
  // calls but silently drop interrupted ones, so a sighted user could not tell which (or how
  // many) calls were cut off without expanding the group (gate round 1, #570: both counts now
  // live in the meta slot instead of the summary text, "N failed" in the error colour).
  const interruptedCount = group.items.filter((item) => item.status === 'interrupted').length
  // Issue #911: a user-initiated Stop never gets its own count merged into `interruptedCount`
  // above -- same reasoning as `subagentStatus.tsx`'s own `summarizeSubagentStatuses` doc
  // comment (decision 15): "cancelled" and "interrupted" are different claims (the user acted
  // vs. the writing process just vanished) and must never fold into one shared number.
  const cancelledCount = group.items.filter((item) => item.status === 'cancelled').length
  // #570 decisions 6, 9: the group header's own Error line while collapsed is the LATEST failed
  // member's (replaced by each failed member's own line once expanded, decision 9's
  // `hideDetailWhenOpen` below); for a solo "group" this is simply that one call.
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
  // #565 decision 26 (mirrors `StageGroupRow`'s own seen-set, `SubagentChainRow.tsx`): a member
  // that mounts WHILE this group is live (running) fades in; one already present at a settled
  // or history mount never does. Seeded synchronously during render (never in an effect, so a
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
  const last = group.items[group.items.length - 1]!
  // Issue #543, first slice: a solo `read` whose target is a `skill://` URL (groupToolItems
  // guarantees it is always solo -- it is exempted from every run, never merged with the calls
  // around it) reads "Using skill <name>" ("Used skill" once settled, #1208) instead of the raw tool name; the icon and the usual
  // running/done/failed status are unchanged (Accessibility note on #543: "status is icon plus
  // text", the same convention every other row already uses).
  const skillName = solo ? last.skill?.name : undefined
  // `toolLabel` is the tool's verb (#1208, `toolVerbs.ts`: FR-002, FR-005 no colon), read by the aria-label composition
  // below; `visibleLabel` is what the row itself shows -- for a multi-call group that folds the
  // run's own count in (#632, #1208 FR-013: "Ran ×2", never the last call's own command). The group header
  // used to show `${last.target} + N others` as its `summary`, which named one call and implied
  // the rest were minor variants of it; the fix is a header that is honestly about every call at
  // once, so a multi-call group's `summary` below is dropped entirely (no text between the
  // label and the meta slot, matching the issue's own mockup), not replaced with a different
  // single-call description.
  // A multi-call group's verb tracks only running vs settled; its failed/stopped counts carry
  // the rest, so a group with one failed member still reads "Ran ×2", never "Failed Ran".
  const verbPhase: RowStatus = solo ? status : isRunning ? 'running' : 'done'
  const toolLabel = toolVerb(skillName !== undefined ? 'skill' : solo ? last.tool : group.tool, verbPhase)
  // Gate round 1 (code-reviewer/ui-architect-v3 Medium, M2): a solo command-style call's own
  // `summary` already names the tool; the bare label repeated it, so it's dropped for those two
  // tools only (`toolLabel` still feeds the accessible name, so this is visual-only).
  const soloIsCommandStyle = solo && skillName === undefined && COMMAND_STYLE_TOOLS.has(last.tool)
  const visibleLabel = soloIsCommandStyle ? undefined : solo ? toolLabel : `${toolLabel} \u00d7${group.items.length}`
  const summary = skillName !== undefined ? <bdi>{skillName}</bdi> : solo ? commandRowText(last) : undefined
  // #632: a multi-call group's own total time -- the sum of every member's own `durationMs`,
  // matching the mockup's own worked example (11.8s + 4.1s = 15.9s) -- joins the failed/
  // interrupted counts below in the meta slot. Gate round 1 (code-reviewer Medium, M6): a
  // missing `durationMs` used to be treated as zero, silently understating the real total as a
  // partial sum presented as complete -- shown only once EVERY member carries its own duration.
  const totalDurationMs = group.items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0)
  const allHaveDuration = group.items.every((item) => item.durationMs != null)
  const totalDuration = !isRunning && allHaveDuration ? formatDuration(totalDurationMs) : undefined
  // #570 decision 12: a multi-call group's own failed/interrupted counts move from the summary
  // text above into this never-shrinking meta slot, "N failed" in the error colour the instant
  // any member fails -- even mid-run, since colour here is reinforcement, not the only signal
  // (the word itself carries it) -- while "N interrupted" stays neutral (decision 5: interrupted
  // is never red). Issue #911: "N stopped" joins them, same neutral treatment as interrupted
  // (never red -- the user's own action, not a claim anything went wrong). A solo call's own
  // meta reuses the same per-call stat `ToolCallRow` shows (an `edit`'s own "+N -M", #632,
  // alongside its duration) -- one function, so the two can never show a different stat for
  // what is otherwise the identical row.
  const meta = solo
    ? callMeta(last)
    : joinMetaParts([
        failedCount > 0 ? <span className="text-severity-error">{failedCount} failed</span> : undefined,
        interruptedCount > 0 ? <span>{interruptedCount} interrupted</span> : undefined,
        cancelledCount > 0 ? <span>{cancelledCount} stopped</span> : undefined,
        totalDuration
      ])

  // Gate round 2 (Main, G909Arch): an explicit accessible name, matching decision 15's own
  // illustrated form ("Failed bash, 2 calls, 1 failed, 15.9 seconds"), bypassing the browser's
  // content-based name computation entirely -- that computation inserts its own space at every
  // sibling-element boundary regardless of nesting, which produced a doubled space before the
  // meta separator's comma ("...+ 2 others , 1 failed") no amount of DOM restructuring removed.
  // Read straight off the raw fields (never off the visual `meta` JSX above, which can carry a
  // coloured diff-stat span the aria string has no use for) so this never breaks if that JSX
  // shape changes.
  // Gate round 1 (accessibility-auditor Medium, M1, WCAG 2.5.3 Label in Name): a solo command-
  // style call's own VISIBLE summary is `commandRowText` ("$ ..."/"grep \"...\""), but this
  // accessible-name text used the raw, untransformed target -- the two could read completely
  // different text for the identical row. `commandRowText` here too, so the visible text and
  // the accessible name's own description of it can never diverge.
  const soloSummaryText = skillName !== undefined ? skillName : commandRowText(last)
  const soloDurationText = last.status !== 'running' && last.durationMs != null ? formatDuration(last.durationMs) : undefined
  // #1208 FR-006: verb first for every tool (no `grep` skip any more), status prefix only when
  // `toolAriaPrefix` gives one; (Main, D2): the edit stat's aria text folds in here (never read off the visual `meta` JSX).
  const triggerAriaLabel = solo
    ? [
        [toolAriaPrefix(status, skillName !== undefined ? 'skill' : last.tool), toolLabel, soloSummaryText].filter(Boolean).join(' '),
        diffStatAriaText(editStatForItem(last)),
        soloDurationText
      ]
        .filter((part): part is string => !!part)
        .join(', ')
    : [
        toolLabel,
        `${group.items.length} calls`,
        failedCount > 0 ? `${failedCount} failed` : undefined,
        interruptedCount > 0 ? `${interruptedCount} interrupted` : undefined,
        cancelledCount > 0 ? `${cancelledCount} stopped` : undefined,
        totalDuration
      ]
        .filter((part): part is string => !!part)
        .join(', ')

  return (
    <CollapsedLine
      icon={<StatusIcon status={status} />}
      label={visibleLabel}
      labelClassName={status === 'error' ? 'text-severity-error' : undefined}
      // See `ToolCallRow`'s own identical comment -- the solo branch needs the same restore.
      summary={summary}
      summaryClassName={soloIsCommandStyle && status === 'error' ? 'text-severity-error' : undefined}
      summaryWrap={summaryWrap}
      // Gate round 1 (H4): see `ToolCallRow`'s own comment -- the solo branch is a tool row too.
      wrapWhenOpen
      meta={meta}
      triggerAriaLabel={triggerAriaLabel}
      // #570 decisions 6, 9: the group's own Error line while collapsed is the LATEST failed
      // member (replaced by each failed member's own line once expanded -- `hideDetailWhenOpen`
      // only for a multi-call group; a solo call's line has no such condition, decision 6, since
      // there is no separate "expanded body" of other members to replace it with).
      // Gate round 1 (accessibility-auditor/code-reviewer Medium, M5): #632 dropped the group
      // header's own `summary` entirely (never any one call's command), so the OLD "prefix only
      // when it differs from the last call" condition no longer applies -- the prefix is now
      // UNCONDITIONAL for a multi-call group, through `commandRowText` (matches the row itself);
      // a solo group shows the bare Error line, since the row directly above it is that call.
      detail={
        lastFailedItem
          ? solo
            ? errorLine(lastFailedItem)
            : (() => {
                // Gate round 2 (G909Arch N1): the prefix used to be the raw, uncapped target --
                // inside the same `line-clamp-2`, a target of about 90+ characters (easily hit
                // by a real command string) could fill both lines and clip the actual error text
                // entirely, the one thing decision 6 exists to keep visible. Sanitized the same
                // way as the error text (ANSI/control-char stripped), capped short, and dropped
                // outright when empty rather than rendering a bare "undefined: ".
                const failingCommandText = sanitizeLines(commandRowText(lastFailedItem))[0]
                const truncatedPrefix =
                  failingCommandText && failingCommandText.length > ATTRIBUTION_PREFIX_MAX_CHARS
                    ? `${failingCommandText.slice(0, ATTRIBUTION_PREFIX_MAX_CHARS)}…`
                    : failingCommandText
                // #962: the colon used to sit INSIDE the `bdi`, with the space right after it --
                // the space was then the last character of the inline-block's own line box, and
                // CSS collapses/drops trailing whitespace at the end of an inline formatting
                // context, so the visible gap vanished even though the space was in the markup
                // ("$ exit 9:Command exited with code 9"). The space now sits OUTSIDE the `bdi`,
                // an ordinary sibling text node between two inline elements, never collapsed.
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
      // #565 decision 10 (solo): the lone call's own body starts at the label column.
      // #565 decision 8 (multi): the only geometry once a `SpineList` is the content is its own
      // `ml-4`/`pt-1` -- this container's own padding is zeroed (mirrors `StageGroupRow`).
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
  )
}

interface SubagentRowProps {
  item: SubagentItem
  /** Issue #1077: true shows this row's own goal (`item.task`'s first lines, clamped to 3
   * lines) above the toggle. Required (item 10: no implicit default) -- `SubagentChainRow.tsx`
   * decides per item, correlated by `toolCallId` (a joined Stage can hold several task() calls,
   * each with its own context or none, stamped only on that call's spec-index-0 item); a
   * context-less solo Stage's own goal renders at the Stage level instead, before "Uses:"
   * (item 7), so `false` for it. */
  showGoal: boolean
}

// `SubagentGoalPreview` (own file, gate round 1 fix, item 7/file-size): the goal paragraph
// alone, exported so `StageGroupRow` can render a context-less solo Stage's own goal before
// "Uses:", not nested inside `SubagentBody`. The goal (when `showGoal`), then a "See input &
// output" toggle (`InlineDisclosure`, ADR 0003, `MermaidBlock`'s "Show source" shape) -- split
// out so `StageGroupRow` reuses it for its own solo-of-the-turn case without `SubagentRow`'s
// own `CollapsedLine` wrapper (#563, H2/H3: never switch element type between solo and multi
// members). Never stays mounted while collapsed, so re-expanding always starts fresh.
export function SubagentBody({ item, showGoal }: SubagentRowProps) {
  const taskBlock = React.useMemo(() => inferOutputBlock(item.task), [item.task])
  const resultBlock = React.useMemo(() => (item.result != null ? inferOutputBlock(item.result) : null), [item.result])
  const [open, setOpen] = React.useState(false)
  const contentId = React.useId()
  const hasResult = item.result != null
  // Gate round 1 fix (item 9): an sr-only name suffix -- every sibling link reads identical text.
  const label = (
    <>
      {open ? 'Hide' : 'See'} input{hasResult ? ' & output' : ''}
      <span className="sr-only"> for {item.name}</span>
    </>
  )
  return (
    <div className="space-y-1">
      {showGoal && <SubagentGoalPreview task={item.task} />}
      <InlineDisclosure open={open} onOpenChange={setOpen} contentId={contentId} label={label}>
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Prompt</div>
          <div className="max-h-64 overflow-auto rounded-lg">
            <CodeBlock code={taskBlock.code} lang={taskBlock.lang} wrap />
          </div>
        </div>
        {resultBlock != null && (
          <div>
            <div className="mb-1 text-xs text-muted-foreground">Result</div>
            <div className="max-h-64 overflow-auto rounded-lg">
              <CodeBlock code={resultBlock.code} lang={resultBlock.lang} wrap />
            </div>
          </div>
        )}
      </InlineDisclosure>
    </div>
  )
}

// One collapsed line per subagent a batch `task()` call started (T078, docs/DESIGN.md "Chat"):
// never grouped by `groupToolItems` (T074), identity is the stable `item.id` (so a later
// activation can reopen the same subagent's full transcript panel, spec 004). Expanding shows
// the prompt and (once known) the result as plain text.
//
// Quality-gate remediation (H1, unanimous): `icon=` is a `CollapsedLine` icon slot (a fixed
// `size-4` box, #565 decision 7) -- `SubagentStatusGlyph` keeps its status word `sr-only` there
// (never visible, it would overflow the box and paint over the label); the visible word is
// rendered HERE instead, in `meta`, ahead of the duration, gated off for `finished` (decision 14:
// a quiet icon-plus-duration row, never a loud "Finished" claim).
export function SubagentRow({ item, showGoal }: SubagentRowProps) {
  const status = chatRowStatus(item.status)
  const duration =
    item.status !== 'running' && item.durationMs != null ? (
      <span className="tabular-nums">{formatElapsed(item.durationMs)}</span>
    ) : undefined
  // Gate round 2 (Low, double-word fix): the status word here duplicates the icon slot's own
  // `SubagentStatusGlyph` `sr-only` word (both sit inside this row's computed accessible name,
  // e.g. "Failed alpha Failed 3s") -- `aria-hidden` keeps the visible word sighted-only.
  const meta = (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      {status !== 'finished' && <span aria-hidden="true">{SUBAGENT_STATUS_LABEL[status]}</span>}
      {duration}
    </span>
  )
  // Issue #941 grill item 4: a Stage expanding reveals each member's own one-line result right
  // here, with no need to ALSO expand this row individually -- `extractResultSummary` (gate
  // round 1 fix): first line, Markdown markers stripped, capped ~120 chars (a full multi-line
  // result still needs this row's own expansion, `SubagentBody` below, for the rest).
  const resultSummary = item.result != null ? extractResultSummary(item.result) : undefined
  return (
    // #565 decision 10: this row is always a `SpineList` member (its only caller,
    // `SubagentChainRow.tsx`'s non-solo branch), so its own expanded body starts at the same
    // label column `ToolCallRow`'s member body does -- one geometry for every Spine member.
    <CollapsedLine
      icon={<SubagentStatusGlyph status={status} />}
      label={item.name}
      labelClassName={cn(isSubagentSuccessStatus(status) && SUBAGENT_SUCCESS_TEXT_CLASS)}
      summary={resultSummary}
      meta={meta}
      contentClassName={LABEL_COLUMN_CONTENT_CLASS}
    >
      <SubagentBody item={item} showGoal={showGoal} />
    </CollapsedLine>
  )
}
