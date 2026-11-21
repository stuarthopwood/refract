import type { TranscriptItem } from '../../../../shared/model'
import { userTurnText } from '../../chat/userTurnText'

/** What each searchable message says when its row is not mounted: the words the row would render. */
export function sourceTextById(items: readonly TranscriptItem[]): Map<string, string> {
  const text = new Map<string, string>()
  for (const item of items) {
    if (item.kind === 'user') text.set(item.id, userTurnText(item))
    else if (item.kind === 'assistant-text') text.set(item.id, item.text)
  }
  return text
}
