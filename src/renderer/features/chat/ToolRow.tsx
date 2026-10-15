import * as React from 'react'
import type { TranscriptItem } from '../../../shared/model'
import { CodeBlock, FileLinkButton, inferOutputBlock } from './Markdown'
import { CollapsedLine } from './CollapsedLine'
import { DiffView } from './DiffView'
import { ToolCallDialog } from './ToolCallDialog'
import { formatDuration, StatusIcon, toolStatusLabel, type RowStatus } from './toolStatus'
import { formatElapsed } from './formatElapsed'
import type { ToolGroup } from './groupToolItems'
import { SpineList } from './SpineList'
import { chatRowStatus, SUBAGENT_STATUS_LABEL, SubagentStatusGlyph } from '../subagents/subagentStatus'

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

function quietSummary(output: string | undefined): string | undefined {
  if (!output || output.includes('\n') || output.length > QUIET_SUMMARY_MAX_CHARS) return undefined
  return output
}

// The expansion content for one tool call (#628, #630): an edit's diff (capped, with its own
// Expand/Collapse, `DiffView`'s `capped` prop), a failed call's own error text (plain, never
// boxed -- hiding Arguments/Output must never hide a failure), a successful write's "Wrote N
// lines to <path>" line, or a short successful call's own one-line result -- never a boxed
// Arguments/Output/content block (moved into the "View full call" dialog, `ToolCallDialog.tsx`,
// which still renders every argument and the output through the shared `CodeBlock`, T083,
// FR-050). Split out from the row wrapper so `ToolGroupRow` can reuse the same content for a
// solo call (no nested `CollapsedLine`) and for each call inside a multi-call group (its own
// nested `CollapsedLine` via `ToolCallRow` below) without ever changing the *wrapper* element
// type at a given tree position. `dialogOpen`/`onDialogOpenChange` are controlled from
// `ToolGroupRow` (quality-gate remediation, Medium): see that component's own comment for why.
function ToolCallBody({ item, dialogOpen, onDialogOpenChange }: ToolCallBodyProps) {
  const isError = item.status === 'error'
  // Quality-gate remediation (Sec, Medium): `item.write`/`item.output` are both populated from
  // the call's own arguments or a partial result while it is still running (`transcript.ts`),
  // not only once it actually finishes -- "Wrote N lines to <path>" and a quiet one-line result
  // are both claims that the call *succeeded*, so both are gated on `status === 'done'` and
  // never shown for a running, interrupted or exited call (which could still fail, or never
  // actually have written anything).
  const isDone = item.status === 'done'
  const summary = isDone ? quietSummary(item.output) : undefined
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
      {isError && (
        // Quality-gate remediation (Medium): `[overflow-wrap:anywhere]` so a long unbroken token
        // (a path, URL or hash) in the error text wraps instead of running past the row at a
        // narrow width (WCAG 1.4.10) -- hiding a failure behind horizontal overflow would be the
        // exact thing #628 says must never happen.
        <p className="line-clamp-2 [overflow-wrap:anywhere] text-xs text-destructive">{item.output || 'Failed.'}</p>
      )}
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
  return (
    <CollapsedLine
      icon={<StatusIcon status={item.status} />}
      label={item.tool}
      summary={item.target}
      summaryWrap={summaryWrap}
      meta={item.status !== 'running' && item.durationMs != null ? formatDuration(item.durationMs) : undefined}
      defaultOpen={defaultOpen}
      // #565 decision 10: a member's expanded body starts at the label column, `pl-8` (the
      // default `px-2`'s own `pr-2` is kept, only the left side widens).
      contentClassName="pl-8"
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
// (no "+ N others" summary, no extra nesting). A multi-item group's own status is running while
// any call runs, else failed when any call failed; the summary is the last call's target plus
// "+ N others" (", N failed" appended, text not colour, when any failed), and only the *children*
// of this one `CollapsedLine` -- never its own presence or type -- switch to the per-call list.
//
// Quality-gate remediation (A11y, High round 3; Medium round 2): `openDialogItemId` (which
// call's "View full call" dialog, if any, is open) is held HERE, above the solo/multi switch
// above, keyed by `item.id` -- not as `ToolCallDialog`'s own internal state. The switch between
// the solo branch (`ToolCallBody` directly) and the multi branch (a `<div>` of `ToolCallRow`s)
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
  // Issue #510 slice 3 quality-gate fix (a11y, Low): a multi-call group's own summary names
  // failed calls but silently dropped interrupted ones, so a sighted user could not tell which
  // (or how many) calls were cut off without expanding the group.
  const interruptedCount = group.items.filter((item) => item.status === 'interrupted').length
  const status: RowStatus = group.items.some((item) => item.status === 'running')
    ? 'running'
    : failedCount > 0
      ? 'error'
      : interruptedCount > 0
        ? 'interrupted'
        : 'done'
  const last = group.items[group.items.length - 1]!
  const othersCount = group.items.length - 1
  // Issue #543, first slice: a solo `read` whose target is a `skill://` URL (groupToolItems
  // guarantees it is always solo -- it is exempted from every run, never merged with the calls
  // around it) reads "Using skill: <name>" instead of the raw tool name; the icon and the usual
  // running/done/failed status are unchanged (Accessibility note on #543: "status is icon plus
  // text", the same convention every other row already uses).
  const skillName = solo ? last.skill?.name : undefined
  const label = skillName !== undefined ? 'Using skill:' : solo ? last.tool : group.tool
  const summary =
    skillName !== undefined
      ? <bdi>{skillName}</bdi>
      : solo
        ? last.target
        : `${last.target}  +\u00a0${othersCount}\u00a0${othersCount === 1 ? 'other' : 'others'}${failedCount > 0 ? `, ${failedCount} failed` : ''}${interruptedCount > 0 ? `, ${interruptedCount} interrupted` : ''}`
  const meta = solo && last.status !== 'running' && last.durationMs != null ? formatDuration(last.durationMs) : undefined

  return (
    <CollapsedLine
      icon={<StatusIcon status={status} />}
      label={label}
      summary={summary}
      summaryWrap={summaryWrap}
      meta={meta}
      // #565 decision 10 (solo): the lone call's own body starts at the label column, `pl-8`.
      // #565 decision 8 (multi): the only geometry once a `SpineList` is the content is its own
      // `ml-4`/`pt-1` -- this container's own padding is zeroed (mirrors `StageGroupRow`).
      contentClassName={solo ? 'pl-8' : 'space-y-0 p-0'}
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
            <li key={item.id}>
              <ToolCallRow
                item={item}
                summaryWrap={summaryWrap}
                dialogOpen={openDialogItemId === item.id}
                onDialogOpenChange={(open) => setOpenDialogItemId(open ? item.id : null)}
                defaultOpen={openDialogItemId === item.id}
              />
            </li>
          ))}
        </SpineList>
      )}
    </CollapsedLine>
  )
}

interface SubagentRowProps {
  item: SubagentItem
}

// The expansion content for one subagent row (prompt, then result once known as plain text):
// split out so `StageGroupRow` (`SubagentChainRow.tsx`) can reuse it for its own solo-of-the-turn
// case without ever going through `SubagentRow`'s own `CollapsedLine` wrapper (#563 remediation,
// H2/H3: a Stage's content must never switch element type between solo and multi members).
export function SubagentBody({ item }: SubagentRowProps) {
  const taskBlock = React.useMemo(() => inferOutputBlock(item.task), [item.task])
  const resultBlock = React.useMemo(() => (item.result != null ? inferOutputBlock(item.result) : null), [item.result])
  return (
    <>
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">Prompt</div>
        <div className="max-h-64 overflow-auto rounded-lg">
          <CodeBlock code={taskBlock.code} lang={taskBlock.lang} wrap />
        </div>
      </div>
      {resultBlock != null && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Result</div>
          <div className="max-h-64 overflow-auto rounded-lg">
            <CodeBlock code={resultBlock.code} lang={resultBlock.lang} wrap />
          </div>
        </div>
      )}
    </>
  )
}

// One collapsed line per subagent a batch `task()` call started (T078, docs/DESIGN.md "Chat"):
// never grouped by `groupToolItems` (T074), identity is the stable `item.id` (so a later
// activation can reopen the same subagent's full transcript panel, spec 004). Expanding shows
// the prompt and (once known) the result as plain text.
//
// Quality-gate remediation (H1, unanimous): `icon=` is a `CollapsedLine` icon slot (a fixed
// `size-3.5` box) -- `SubagentStatusGlyph` keeps its status word `sr-only` there (never visible,
// it would overflow the box and paint over the label); the visible word is rendered HERE instead,
// in `meta`, ahead of the duration, gated off for `finished` (decision 14: a quiet icon-plus-
// duration row, never a loud "Finished" claim).
export function SubagentRow({ item }: SubagentRowProps) {
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
  return (
    // Gate round 3 fix (architect M4): this row is ALWAYS a `SpineList` member today (its only
    // caller, `SubagentChainRow.tsx`'s non-solo branch) -- `border-0` removes `Collapsible`'s own
    // unconditional border entirely (not just its colour, which `border-transparent` alone still
    // left at 1px), dropping the unwanted hover box AND matching `SpineList.tsx`'s documented 8px
    // gap exactly instead of a stray 9px.
    <CollapsedLine icon={<SubagentStatusGlyph status={status} />} label={item.name} meta={meta} className="border-0">
      <SubagentBody item={item} />
    </CollapsedLine>
  )
}
