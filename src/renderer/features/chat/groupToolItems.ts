import { HIDDEN_TOOL_NOTICE_PREFIX } from '../../../shared/model'
import type { TranscriptItem } from '../../../shared/model'
import { agentSteerTarget } from './agentMessageDirection'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>
type ThinkingItem = Extract<TranscriptItem, { kind: 'thinking' }>

export interface ToolGroup {
  kind: 'tool-group'
  id: string
  tool: string
  items: ToolItem[]
}

// A run of consecutive, non-empty `thinking` items (issue #557, `groupThoughtItems.ts`): every
// run -- including a run of one -- becomes a `ThoughtRun`, the same "always wrap" rule this
// file's own `ToolGroup` follows (see `groupThoughtItems.ts`'s own comment for why). Declared
// here, beside `ToolGroup`, so `GroupedTranscriptItem` is the one place every consumer
// downstream of `groupToolItems` (`groupSubagentStages.ts`, `transcriptRowVisibility.ts`,
// `Transcript.tsx`) already imports its grouped-item union from, with no changes needed in any
// of those files to let a `ThoughtRun` pass through them untouched.
export interface ThoughtRun {
  kind: 'thought-run'
  id: string
  items: ThinkingItem[]
}

export type GroupedTranscriptItem = TranscriptItem | ToolGroup | ThoughtRun

// Parameter widened to `{ kind: string }` (issue #558) rather than the narrower
// `GroupedTranscriptItem` so a caller holding a STILL-WIDER union (`groupAdvisoryItems.ts`'s own
// `AdvisoryGroupedTranscriptItem`, which also admits an `AdvisoryRun`) can call either guard
// directly with no cast and no import cycle; the narrowing each performs is unaffected either way.
export function isToolGroup(item: { kind: string }): item is ToolGroup {
  return item.kind === 'tool-group'
}

export function isThoughtRun(item: { kind: string }): item is ThoughtRun {
  return item.kind === 'thought-run'
}

// #838: a one-call group holding a `write agent://<id>` steering call (always alone, see below).
export function isAgentSteerGroup(item: { kind: string }): boolean {
  return isToolGroup(item) && item.items.length === 1 && agentSteerTarget(item.items[0]!) !== undefined
}

// Merges runs of adjacent `tool` items that share the same `tool` name into one `ToolGroup`
// (T074, docs/DESIGN.md "Chat"). Every run -- including a run of one -- becomes a `ToolGroup`
// (see `flushRun`): `TranscriptRow` must never switch between rendering a lone call and a run
// through two different React component types at the same tree position, or a focused/expanded
// row loses focus the moment a second call arrives (FINDINGS: focus loss on tool-call grouping).
// `ask` never groups: T073 gives every `ask` call its own dedicated question rendering, never a
// generic collapsed-tool-call summary. A `read` whose `skill` field is set never groups either
// (issue #543, first slice): it is a grouping boundary on both sides, so a skill load next to
// ordinary `read` calls is never folded into their run and never splits that run's own
// before/after pieces back together across it. A thinking line, a request, a notice, an
// agent-message, a subagent row, a skill-prompt row, or a different tool name all end the
// current run -- except a hidden bookkeeping tool's own failure notice (T086, FR-052,
// `HIDDEN_TOOL_NOTICE_PREFIX`), the one documented exception: it is emitted in place but never
// flushes `run`, so a hidden call's failure in the middle of a run of the *surrounding* visible
// tool's calls never splits that run into two groups (it does reorder that one notice ahead of
// the eventual merged group in `result`, since the run it belongs to is not flushed until the
// next non-matching item -- an accepted trade-off for never breaking the group apart).
export function groupToolItems(items: TranscriptItem[]): GroupedTranscriptItem[] {
  const result: GroupedTranscriptItem[] = []
  let run: ToolItem[] = []

  const flushRun = () => {
    if (run.length === 0) return
    // Always a `ToolGroup`, even for a run of one: `ToolGroupRow` renders a single-item group
    // identically to how a lone call once rendered, so the component type at this tree position
    // never changes when a second consecutive call to the same tool arrives. Keyed by the run's
    // first item's own id (never a `group:`-prefixed id) so a keyboard user focused or expanded
    // on this row keeps that state as the run grows.
    result.push({ kind: 'tool-group', id: run[0]!.id, tool: run[0]!.tool, items: run })
    run = []
  }

  for (const item of items) {
    // #838: a `write agent://<id>` steering call is an agent-to-agent line, a boundary like a skill.
    if (item.kind === 'tool' && (item.skill || agentSteerTarget(item) !== undefined)) {
      flushRun()
      result.push({ kind: 'tool-group', id: item.id, tool: item.tool, items: [item] })
      continue
    }
    if (item.kind === 'tool' && item.tool !== 'ask' && !item.skill) {
      if (run.length > 0 && run[0]!.tool === item.tool) {
        run.push(item)
      } else {
        flushRun()
        run = [item]
      }
      continue
    }
    if (item.kind === 'notice' && item.id.startsWith(HIDDEN_TOOL_NOTICE_PREFIX)) {
      result.push(item)
      continue
    }
    flushRun()
    result.push(item)
  }
  flushRun()
  return result
}
