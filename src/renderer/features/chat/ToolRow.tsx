import * as React from 'react'
import { CheckIcon, Loader2Icon, UnplugIcon, XIcon } from 'lucide-react'
import type { TranscriptItem } from '../../../shared/model'
import { Button } from '@/components/ui/button'
import { CodeBlock, FileLinkButton, inferOutputBlock } from './Markdown'
import { CollapsedLine } from './CollapsedLine'
import { DiffView } from './DiffView'
import type { ToolGroup } from './groupToolItems'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>
type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

const OUTPUT_LINE_CAP = 200

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export type RowStatus = 'running' | 'done' | 'error' | 'exited' | 'interrupted'

// Issue #457 quality-gate fix (a11y, Medium): exported so `Transcript.tsx` can reuse the exact
// same status word for a hidden-but-running `ToolGroup`'s one-line sr-only progress placeholder
// (`isHiddenRow`'s `'sr-only'` case) that `StatusIcon` below already uses for its own sr-only
// text -- one source of truth for the five status words, not two copies that could drift apart.
export function toolStatusLabel(status: RowStatus): string {
  return status === 'running'
    ? 'Running'
    : status === 'error'
      ? 'Failed'
      : status === 'exited'
        ? 'Agent exited'
        : status === 'interrupted'
          ? 'Interrupted'
          : 'Done'
}

// Language inference for a tool call's Arguments block (T083, FR-050): always `json`, except a
// `bash` call's own `command` string, shown verbatim and highlighted as `bash` instead of being
// JSON-escaped inside the full arguments object -- far more readable for the one tool whose
// primary argument is itself source text. A `write` call's own `content` string is tried as JSON
// too (Stuart's screenshot, docs/DESIGN.md "Every JSON-shaped tool/code surface uses `CodeBlock`"):
// a `write` targeting an `xd://` device takes JSON *as* its content, so leaving it a string would
// bury a whole second JSON document as one unreadable, fully-escaped line inside the outer
// Arguments JSON; parsing and re-nesting it lets the outer `JSON.stringify` pretty-print both
// levels. A plain-text file write's `content` never parses as JSON and is left untouched.
function inferArgumentsBlock(item: ToolItem): { lang: string; code: string } {
  if (item.tool === 'bash') {
    const record = item.args && typeof item.args === 'object' ? (item.args as Record<string, unknown>) : {}
    if (typeof record.command === 'string') return { lang: 'bash', code: record.command }
  }
  if (item.tool === 'write') {
    const record = item.args && typeof item.args === 'object' ? (item.args as Record<string, unknown>) : {}
    if (typeof record.content === 'string') {
      try {
        return { lang: 'json', code: JSON.stringify({ ...record, content: JSON.parse(record.content) }, null, 2) }
      } catch {
        // `content` is plain file text, not JSON -- fall through to the generic stringify below.
      }
    }
  }
  return { lang: 'json', code: JSON.stringify(item.args, null, 2) }
}

// A distinct icon shape per status (never colour alone, T080/WCAG 2.1 AA): spinner, check, cross,
// unplug (`'exited'`, issue #489 gate finding 4 -- matches `SubagentPanel.tsx`'s own icon/wording
// for the same state so the chat row and the panel row never disagree; `'interrupted'`, issue
// #510 slice 3 -- the same family, a tool call left with no result because its Conversation's
// tail shows the writing process is gone, reusing the unplug shape so neither reads as "done").
function StatusIcon({ status }: { status: RowStatus }) {
  const label = toolStatusLabel(status)
  return (
    <>
      {status === 'running' && <Loader2Icon className="size-3.5 shrink-0 animate-spin text-state-working" />}
      {status === 'error' && <XIcon className="size-3.5 shrink-0 text-destructive" />}
      {(status === 'exited' || status === 'interrupted') && <UnplugIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      {status === 'done' && <CheckIcon className="size-3.5 shrink-0 text-state-working" />}
      <span className="sr-only">{label}</span>
    </>
  )
}

interface ToolCallBodyProps {
  item: ToolItem
}

// The expansion content for one tool call: arguments, output, and (for `edit`/`write` results) a
// diff. Arguments and output are always inert text (constitution V), each in a `CodeBlock` (T083,
// FR-050) labelled by its inferred language. Split out from the row wrapper so `ToolGroupRow` can
// reuse the same content for a solo call (no nested `CollapsedLine`) and for each call inside a
// multi-call group (its own nested `CollapsedLine` via `ToolCallRow` below) without ever changing
// the *wrapper* element type at a given tree position.
function ToolCallBody({ item }: ToolCallBodyProps) {
  const [showAllOutput, setShowAllOutput] = React.useState(false)
  const [showAllWrite, setShowAllWrite] = React.useState(false)

  const argumentsBlock = React.useMemo(() => inferArgumentsBlock(item), [item])
  const outputBlock = React.useMemo(() => (item.output != null ? inferOutputBlock(item.output) : null), [item.output])
  const outputLines = React.useMemo(() => outputBlock?.code.split('\n') ?? [], [outputBlock])
  const truncated = !showAllOutput && outputLines.length > OUTPUT_LINE_CAP
  const visibleOutputCode = truncated ? outputLines.slice(0, OUTPUT_LINE_CAP).join('\n') : (outputBlock?.code ?? '')

  // `writeBlock`/`writeCodeLines` are the (possibly JSON-reformatted) CodeBlock content, truncated
  // the same way `outputBlock`/`outputLines` are above; both the "Wrote N lines" label and the
  // "Show all (M lines)" button below count `writeCodeLines` (test-reviewer, round 2: the label
  // used to count the file's own raw lines while "Show all" counted the reformatted CodeBlock's
  // lines, so the two disagreed whenever `write.content` was compact JSON re-pretty-printed for
  // display -- both numbers must describe the one block actually rendered on screen).
  const writeBlock = React.useMemo(() => (item.write != null ? inferOutputBlock(item.write.content) : null), [item.write])
  const writeCodeLines = React.useMemo(() => writeBlock?.code.split('\n') ?? [], [writeBlock])
  const writeTruncated = !showAllWrite && writeCodeLines.length > OUTPUT_LINE_CAP
  const visibleWriteCode = writeTruncated ? writeCodeLines.slice(0, OUTPUT_LINE_CAP).join('\n') : (writeBlock?.code ?? '')

  return (
    <>
      {item.edit && <DiffView path={item.edit.path} oldText={item.edit.oldText} newText={item.edit.newText} />}
      {item.write && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            Wrote {writeCodeLines.length} {writeCodeLines.length === 1 ? 'line' : 'lines'} to{' '}
            <FileLinkButton path={item.write.path} />
          </div>
          <div className="max-h-64 overflow-auto rounded-lg">
            <CodeBlock code={visibleWriteCode} lang={writeBlock?.lang ?? null} copyText={writeBlock?.code ?? ''} />
          </div>
          {writeTruncated && (
            <Button variant="ghost" size="sm" className="mt-1" onClick={() => setShowAllWrite(true)}>
              Show all ({writeCodeLines.length} lines)
            </Button>
          )}
        </div>
      )}
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">Arguments</div>
        {/* `max-h-64 overflow-auto` restores the height cap `ToolCallBody` always had before T083
         * moved this onto the shared `CodeBlock` (which, per FR-049, scrolls sideways but never
         * caps its own height -- correct for a markdown fence, but a 200-line tool call's own
         * Arguments/Output still needs its own vertical scroll so one row can never force the
         * whole transcript to scroll past a screen's worth of code, WCAG 1.4.10). */}
        <div className="max-h-64 overflow-auto rounded-lg">
          <CodeBlock code={argumentsBlock.code} lang={argumentsBlock.lang} />
        </div>
      </div>
      {outputBlock != null && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Output</div>
          <div className="max-h-64 overflow-auto rounded-lg">
            <CodeBlock code={visibleOutputCode} lang={outputBlock.lang} copyText={outputBlock.code} />
          </div>
          {truncated && (
            <Button variant="ghost" size="sm" className="mt-1" onClick={() => setShowAllOutput(true)}>
              Show all ({outputLines.length} lines)
            </Button>
          )}
        </div>
      )}
    </>
  )
}

interface ToolCallRowProps {
  item: ToolItem
  /** Forwarded to the nested `CollapsedLine`'s `summaryWrap` (see `ToolGroupRowProps`). */
  summaryWrap?: boolean
}

// One compact row per tool call, used only for each call nested inside an expanded multi-call
// group (never at the top-level tree position `ToolGroupRow` itself occupies).
function ToolCallRow({ item, summaryWrap }: ToolCallRowProps) {
  return (
    <CollapsedLine
      icon={<StatusIcon status={item.status} />}
      label={item.tool}
      summary={item.target}
      summaryWrap={summaryWrap}
      meta={item.status !== 'running' && item.durationMs != null ? formatDuration(item.durationMs) : undefined}
    >
      <ToolCallBody item={item} />
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
export function ToolGroupRow({ group, summaryWrap }: ToolGroupRowProps) {
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
  const label = solo ? last.tool : group.tool
  const summary = solo
    ? last.target
    : `${last.target}  +\u00a0${othersCount}\u00a0${othersCount === 1 ? 'other' : 'others'}${failedCount > 0 ? `, ${failedCount} failed` : ''}${interruptedCount > 0 ? `, ${interruptedCount} interrupted` : ''}`
  const meta = solo && last.status !== 'running' && last.durationMs != null ? formatDuration(last.durationMs) : undefined

  return (
    <CollapsedLine icon={<StatusIcon status={status} />} label={label} summary={summary} summaryWrap={summaryWrap} meta={meta}>
      {solo ? (
        <ToolCallBody item={last} />
      ) : (
        <div className="space-y-1">
          {group.items.map((item) => (
            <ToolCallRow key={item.id} item={item} summaryWrap={summaryWrap} />
          ))}
        </div>
      )}
    </CollapsedLine>
  )
}

interface SubagentRowProps {
  item: SubagentItem
}

// One collapsed line per subagent a batch `task()` call started (T078, docs/DESIGN.md "Chat"):
// never grouped by `groupToolItems` (T074), identity is the stable `item.id` (so a later
// activation can reopen the same subagent's full transcript panel, spec 004). Expanding shows
// the prompt and (once known) the result as plain text.
export function SubagentRow({ item }: SubagentRowProps) {
  const taskBlock = React.useMemo(() => inferOutputBlock(item.task), [item.task])
  const resultBlock = React.useMemo(() => (item.result != null ? inferOutputBlock(item.result) : null), [item.result])
  return (
    <CollapsedLine
      icon={<StatusIcon status={item.status} />}
      label={item.name}
      meta={item.status !== 'running' && item.durationMs != null ? formatDuration(item.durationMs) : undefined}
    >
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
    </CollapsedLine>
  )
}
