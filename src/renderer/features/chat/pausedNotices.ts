import type { TranscriptItem } from '../../../shared/model'

const PAUSE_NOTICE = /^(Pause (cancelled|could not (cancel|list)) |Resumed\. Pause had cancelled )/

// The transcript is inert while Paused, so these notices are never read in place; this turns the
// ones the backend posts into short spoken text. "Session resumed" is announced separately, so
// the notice's own "Resumed." is dropped.
function spoken(text: string): string {
  return text
    .replace(/^Resumed\. /, '')
    .replace(/, which started while this Session was paused/, ' (started while paused)')
    .replace(/ They are not restarted; ask the agent to run them again if you still need them\./, ' They are not restarted.')
}

/** New Pause-related notices in `items` that are not in `seen`, joined as one announcement. */
export function pausedNoticeAnnouncement(
  items: readonly TranscriptItem[],
  seen: ReadonlySet<string>
): { text: string; ids: string[] } {
  const fresh = items.filter(
    (item): item is Extract<TranscriptItem, { kind: 'notice' }> =>
      item.kind === 'notice' && !seen.has(item.id) && PAUSE_NOTICE.test(item.text)
  )
  return { text: fresh.map((item) => spoken(item.text)).join(' '), ids: fresh.map((item) => item.id) }
}
