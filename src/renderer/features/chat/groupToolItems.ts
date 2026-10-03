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
// (T074, docs/DESIGN.md "Chat"). A run of one stays a plain `tool` item (so `ToolRow` renders it
// unchanged). `ask` never groups: T073 gives every `ask` call its own dedicated question
// rendering, never a generic collapsed-tool-call summary. A thinking line, a request, a notice,
// an agent-message, a subagent row, or a different tool name all end the current run.
export function groupToolItems(items: TranscriptItem[]): GroupedTranscriptItem[] {
  const result: GroupedTranscriptItem[] = []
  let run: ToolItem[] = []

  const flushRun = () => {
    if (run.length === 0) return
    if (run.length === 1) {
      result.push(run[0]!)
    } else {
      result.push({ kind: 'tool-group', id: `group:${run[0]!.id}`, tool: run[0]!.tool, items: run })
    }
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
