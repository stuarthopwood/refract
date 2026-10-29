// Paints chat Find matches with the CSS Custom Highlight API (spec 041, #753). Where the API is
// missing, nothing paints and the results list plus jump still work.

const OTHER_NAME = 'chat-find'
const CURRENT_NAME = 'chat-find-current'

interface HighlightRegistry {
  set(name: string, highlight: unknown): unknown
  delete(name: string): unknown
}

interface PanePaint {
  others: Range[]
  current: Range | null
}

const panes = new Map<string, PanePaint>()

function registry(): HighlightRegistry | null {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight !== 'function') return null
  return (CSS as unknown as { highlights: HighlightRegistry }).highlights
}

export function highlightsSupported(): boolean {
  return registry() !== null
}

// Split panes share the two document-wide highlight names, so each pane's ranges are unioned.
function flush(): void {
  const highlights = registry()
  if (!highlights) return
  const others: Range[] = []
  const current: Range[] = []
  for (const paint of panes.values()) {
    others.push(...paint.others)
    if (paint.current) current.push(paint.current)
  }
  if (others.length > 0) highlights.set(OTHER_NAME, new Highlight(...others))
  else highlights.delete(OTHER_NAME)
  if (current.length > 0) highlights.set(CURRENT_NAME, new Highlight(...current))
  else highlights.delete(CURRENT_NAME)
}

export function paintPane(sessionId: string, others: Range[], current: Range | null): void {
  if (!registry()) return
  panes.set(sessionId, { others, current })
  flush()
}

export function clearPane(sessionId: string): void {
  if (!panes.delete(sessionId)) return
  flush()
}
