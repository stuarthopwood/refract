export type SectionView = 'rendered' | 'source'

// Fixed rules on tool, field and target path (#719, grill 2026-10-29); never content sniffing.
const MARKDOWN_PATH = /\.(md|markdown)$/i
const RENDERED_ARGUMENT_FIELDS: Record<string, readonly string[]> = {
  task: ['task', 'context'],
  send: ['message'],
  ask: ['text', 'question']
}

// Values past either bound open as Source with a "Render anyway" opt-in.
export const LARGE_VALUE_MAX_LINES = 2000
export const LARGE_VALUE_MAX_BYTES = 200 * 1024

function isMarkdownTarget(target: string): boolean {
  return target.startsWith('agent://') || MARKDOWN_PATH.test(target)
}

export function defaultSectionView(tool: string, field: string, target: string): SectionView {
  if (tool === 'write' && field === 'content') return isMarkdownTarget(target) ? 'rendered' : 'source'
  if (tool === 'read' && field === 'Output') return MARKDOWN_PATH.test(target) ? 'rendered' : 'source'
  return RENDERED_ARGUMENT_FIELDS[tool]?.includes(field) ? 'rendered' : 'source'
}

export function isLargeValue(text: string): boolean {
  if (text.length > LARGE_VALUE_MAX_BYTES) return true
  let lines = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (++lines > LARGE_VALUE_MAX_LINES) return true
  }
  return false
}
