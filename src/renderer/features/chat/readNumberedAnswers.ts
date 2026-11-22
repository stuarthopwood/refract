const NUMBERED_RESULT = /^The developer (?:answered \d+ questions?|cancelled the questions)\./

// Mirrors the host's one-line flatten: invisible format/bidi characters are dropped (U+200D stays),
// line breaks and other control characters become spaces.
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu
const BREAKS = /[\p{Cc}\u2028\u2029]/gu

function flatten(text: string): string {
  return text.replace(INVISIBLE, '').replace(BREAKS, ' ')
}

function optionLetter(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    n -= 1
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26)
  }
  return out
}

/** The picked labels of `A "Postgres" (recommended), B "MySQL"`; a pick the question never offered carries no letter. */
function readPicks(picks: string): string[] {
  const entry = /(?:[A-Z]+ )?"(.*?)"(?: \(recommended\))?(?=, (?:[A-Z]+ )?"|$)/y
  const labels: string[] = []
  for (let match = entry.exec(picks); match; match = entry.exec(picks)) {
    labels.push(match[1]!)
    if (entry.lastIndex >= picks.length) break
    entry.lastIndex += 2
  }
  return labels
}

const TYPED = 'Typed: "'

/** `Picked: ...` and `Typed: "..."` back to the live card's `Postgres, Other: ...` wording. */
function readOutcome(line: string): string {
  const outcome = line.replace(/\.$/, '')
  if (outcome === 'No answer') return 'None selected'
  const typedFrom = outcome.startsWith(TYPED) ? 0 : outcome.includes(`. ${TYPED}`) ? outcome.indexOf(`. ${TYPED}`) + 2 : -1
  const picksText = typedFrom < 0 ? outcome : outcome.slice(0, Math.max(typedFrom - 2, 0))
  const typed = typedFrom >= 0 && outcome.endsWith('"') ? outcome.slice(typedFrom + TYPED.length, -1).trim() : ''
  const labels = picksText.startsWith('Picked: ') ? readPicks(picksText.slice('Picked: '.length)) : []
  const parts: string[] = []
  if (labels.length > 0) parts.push(labels.join(', '))
  if (typed) parts.push(`Other: ${typed}`)
  return parts.length > 0 ? parts.join(', ') : line
}

function readNote(line: string, options: string[]): string | undefined {
  const match = /^ ?Note on (?:([A-Z]+)|"(.*)"): (.*)\.$/.exec(line)
  if (!match) return undefined
  const letterIndex = match[1] === undefined ? -1 : options.findIndex((_, index) => optionLetter(index) === match[1])
  const target = match[1] === undefined ? match[2]! : (options[letterIndex] ?? match[1])
  return `Note on ${target}: ${match[3]!.trim()}`
}

/**
 * A `refract_ask` result read back from saved history, which carries only its numbered text: one
 * entry per question, worded as the live card words it, or undefined when the text is not that result.
 */
export function readNumberedAnswers(output: string | undefined, questions: { question: string; options: string[] }[]): string[] | undefined {
  if (!output || !NUMBERED_RESULT.test(output) || questions.length === 0) return undefined
  const markers = questions.map((entry, index) => `\n${index + 1}. ${flatten(entry.question)} `)
  const starts: number[] = []
  let from = 0
  for (const marker of markers) {
    const start = output.indexOf(marker, from)
    if (start < 0) return undefined
    starts.push(start)
    from = start + marker.length
  }
  return questions.map((entry, index) => {
    const end = index + 1 < starts.length ? starts[index + 1]! : output.length
    const [outcome = '', ...noteLines] = output.slice(starts[index]! + markers[index]!.length, end).trim().split('\n')
    const notes = noteLines.flatMap((line) => readNote(line, entry.options) ?? [])
    return [readOutcome(outcome.trim()), ...notes].join('\n')
  })
}
