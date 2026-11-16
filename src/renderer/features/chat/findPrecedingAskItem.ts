import { type TranscriptItem } from '../../../shared/model'
import { type ToolItem } from './TranscriptRow'

/**
 * The nearest preceding `ask` tool item for a `request` item at `requestIndex`. Earlier `request`
 * items are skipped because one ask sends a frame per field (and per checkbox toggle); any other
 * tool item ends the scan so an unrelated approval never links to an older ask.
 */
export function findPrecedingAskItem(items: TranscriptItem[], requestIndex: number): ToolItem | undefined {
  for (let i = requestIndex - 1; i >= 0; i--) {
    const candidate = items[i]!
    if (candidate.kind === 'tool') return candidate.tool === 'ask' ? candidate : undefined
  }
  return undefined
}
