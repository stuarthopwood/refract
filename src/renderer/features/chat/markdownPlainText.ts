const FENCE_LINE = /^\s{0,3}(?:```|~~~)/
const INLINE_CODE = /(`[^`\n]+`)/

function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, '$1')
}

function stripLine(line: string): string {
  const body = line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s{0,3}>\s?/, '')
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(body)) return ''
  return body
    .split(INLINE_CODE)
    .map((part) => (part.startsWith('`') && part.endsWith('`') && part.length > 2 ? part.slice(1, -1) : stripInline(part)))
    .join('')
}

/** A message's Markdown source as plain text: markers dropped, fenced code kept verbatim. */
export function markdownToPlainText(markdown: string): string {
  const out: string[] = []
  let inFence = false
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence
      continue
    }
    out.push(inFence ? line : stripLine(line))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
