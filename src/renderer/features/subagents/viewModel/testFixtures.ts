import type { SubagentSummary, TranscriptItem } from '../../../../shared/model'
import type { TranscriptSubagentItem } from './runs'

/** A transcript subagent item with sensible defaults, for the view-model tests. */
export function subagentItem(overrides: Partial<TranscriptSubagentItem> & { name: string }): TranscriptSubagentItem {
  return {
    kind: 'subagent',
    id: `call1:${overrides.name}`,
    toolCallId: 'call1',
    specIndex: 0,
    task: `Do ${overrides.name}`,
    status: 'done',
    messageId: 'm1',
    ...overrides
  }
}

/** A readout summary with sensible defaults. */
export function subagentSummary(overrides: Partial<SubagentSummary> & { nameOrTask: string }): SubagentSummary {
  return {
    id: `call1:${overrides.nameOrTask}`,
    toolCallId: 'call1',
    specIndex: 0,
    status: 'finished',
    startedAt: 1000,
    ...overrides
  }
}

/** A non-subagent transcript item, used to break Stage runs. */
export function assistantText(id: string): TranscriptItem {
  return { kind: 'assistant-text', id, text: 'hi', streaming: false }
}
