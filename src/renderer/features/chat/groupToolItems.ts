import { HIDDEN_TOOL_NOTICE_PREFIX } from '../../../shared/model'
import type { TranscriptItem } from '../../../shared/model'
import { agentSteerTarget } from './agentMessageDirection'
import { resolveToolDisplay } from './toolDisplay'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>
type ThinkingItem = Extract<TranscriptItem, { kind: 'thinking' }>

function displayKey(item: ToolItem): string {
  return resolveToolDisplay(item.tool, item.target).key
}

export interface ToolGroup {
  kind: 'tool-group'
  id: string
  tool: string
  items: ToolItem[]
}

// A run of consecutive non-empty `thinking` items; always wrapped, like `ToolGroup` (#557).
// Declared here so `GroupedTranscriptItem` stays the one union downstream consumers import.
export interface ThoughtRun {
  kind: 'thought-run'
  id: string
  items: ThinkingItem[]
}

export type GroupedTranscriptItem = TranscriptItem | ToolGroup | ThoughtRun

// Takes `{ kind: string }` so wider unions (e.g. with `AdvisoryRun`) can call it without a cast or import cycle (#558).
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

// Merges adjacent `tool` items sharing a tool name into a `ToolGroup`, always wrapping even a run of
// one so a focused/expanded row keeps focus when a second call arrives. `ask` and skill `read`s
// never group (grouping boundaries). A hidden tool's failure notice is emitted in place without
// flushing the run, so it can precede the merged group in `result` (accepted trade-off).
export function groupToolItems(items: TranscriptItem[]): GroupedTranscriptItem[] {
  const result: GroupedTranscriptItem[] = []
  let run: ToolItem[] = []

  const flushRun = () => {
    if (run.length === 0) return
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
      // Group on the display key so `write xd://a`, `write xd://b` and plain `write` never share a run.
      if (run.length > 0 && displayKey(run[0]!) === displayKey(item)) {
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
