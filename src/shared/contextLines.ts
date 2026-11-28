// #2320: text Refract itself sends to the agent as a user message (an Away Mode reply, a Checklist hint, a
// failed-handoff note). OMP keeps only plain text, so saved history can be told apart only by these prefixes.
// `scripts/check-context-prefixes.mjs` checks this list against the Rust that writes them, so the two cannot drift.
export const CONTEXT_PREFIXES = [
  { prefix: '[Automatic, Away mode] ', kind: 'away' },
  { prefix: '[Refract] ', kind: 'refract' }
] as const

export type ContextLineKind = 'away' | 'checklist' | 'refract'

export interface ContextLine {
  kind: ContextLineKind
  /** The line without its prefix. */
  text: string
}

export interface SplitContext {
  lines: ContextLine[]
  /** What the user typed, with the blank lines that separated it from the context lines dropped. */
  body: string
}

function parseLine(line: string): ContextLine | null {
  for (const { prefix, kind } of CONTEXT_PREFIXES) {
    if (!line.startsWith(prefix)) continue
    const text = line.slice(prefix.length)
    if (text.trim() === '') return null
    // The Rust hint writer marks checklist hints only by this leading word, so the prefix is the only signal.
    return { kind: kind === 'refract' && text.startsWith('Checklist ') ? 'checklist' : kind, text }
  }
  return null
}

/** Splits the known-prefix lines at the very start of a user message from the rest; a prefix further in is ordinary text. */
export function splitContextLines(text: string): SplitContext {
  const lines: ContextLine[] = []
  let rest = text
  for (;;) {
    const newline = rest.indexOf('\n')
    const parsed = parseLine((newline === -1 ? rest : rest.slice(0, newline)).replace(/\r$/, ''))
    if (!parsed) break
    lines.push(parsed)
    rest = newline === -1 ? '' : rest.slice(newline + 1)
  }
  if (lines.length === 0) return { lines, body: text }
  return { lines, body: rest.replace(/^(?:[ \t]*\r?\n)+/, '') }
}
