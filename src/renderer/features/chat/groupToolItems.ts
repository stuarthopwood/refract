import type { TranscriptItem } from '../../../shared/model'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

export interface ToolGroup {
  kind: 'tool-group'
  id: string
  tool: string
  items: ToolItem[]
}

export type GroupedTranscriptItem = TranscriptItem | ToolGroup

export function isToolGroup(item: GroupedTranscriptItem): item is ToolGroup {
  return item.kind === 'tool-group'
}

// Merges runs of adjacent `tool` items that share the same `tool` name into one `ToolGroup`
// (T074, docs/DESIGN.md "Chat"). Every run -- including a run of one -- becomes a `ToolGroup`
// (see `flushRun`): `TranscriptRow` must never switch between rendering a lone call and a run
// through two different React component types at the same tree position, or a focused/expanded
// row loses focus the moment a second call arrives (FINDINGS: focus loss on tool-call grouping).
// `ask` never groups: T073 gives every `ask` call its own dedicated question rendering, never a
// generic collapsed-tool-call summary. A thinking line, a request, a notice, an agent-message, a
// subagent row, or a different tool name all end the current run.
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
    if (item.kind === 'tool' && item.tool !== 'ask') {
      if (run.length > 0 && run[0]!.tool === item.tool) {
        run.push(item)
      } else {
        flushRun()
        run = [item]
      }
      continue
    }
    flushRun()
    result.push(item)
  }
  flushRun()
  return result
}
