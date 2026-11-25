const NUMBERED_RESULT = /^(The developer|Away Mode) answered \d+ questions?\./

// Mirrors the host's one-line flatten: invisible format/bidi characters are dropped (U+200D stays),
// line breaks and other control characters become spaces.
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu
const BREAKS = /[\p{Cc}\u2028\u2029]/gu

export function flatten(text: string): string {
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

export interface NumberedPick {
  label: string
  recommended: boolean
}

export interface NumberedNote {
  option: string
  text: string
}

/** One question of a numbered result, as the host worded it. */
export interface NumberedAnswer {
  picks: NumberedPick[]
  /** The typed Other text; empty when there is none. */
  typed: string
  notes: NumberedNote[]
}

export interface NumberedResult {
  /** The result begins `Away Mode answered`; any other opening reads as the developer. */
  byAway: boolean
  /** One entry per question. */
  answers: NumberedAnswer[]
}

/** The picks of `A "Postgres" (recommended), B "MySQL"`, worded as the live options; a pick the question never offered carries no letter. */
function readPicks(picks: string, options: string[]): NumberedPick[] {
  const entry = /(?:([A-Z]+) )?"(.*?)"( \(recommended\))?(?=, (?:[A-Z]+ )?"|$)/y
  const out: NumberedPick[] = []
  for (let match = entry.exec(picks); match; match = entry.exec(picks)) {
    const live = match[1] === undefined ? undefined : options.find((_, index) => optionLetter(index) === match[1])
    out.push({ label: live ?? match[2]!, recommended: match[3] !== undefined })
    if (entry.lastIndex >= picks.length) break
    entry.lastIndex += 2
  }
  return out
}

const TYPED = 'Typed: "'

/** `Picked: ...` and `Typed: "..."` back to its picks and typed text; `No answer` reads as neither. */
function readOutcome(line: string, options: string[]): { picks: NumberedPick[]; typed: string } {
  const outcome = line.replace(/\.$/, '')
  const typedFrom = outcome.startsWith(TYPED) ? 0 : outcome.includes(`. ${TYPED}`) ? outcome.indexOf(`. ${TYPED}`) + 2 : -1
  const picksText = typedFrom < 0 ? outcome : outcome.slice(0, Math.max(typedFrom - 2, 0))
  const typed = typedFrom >= 0 && outcome.endsWith('"') ? outcome.slice(typedFrom + TYPED.length, -1).trim() : ''
  const picks = picksText.startsWith('Picked: ') ? readPicks(picksText.slice('Picked: '.length), options) : []
  return { picks, typed }
}

function readNote(line: string, options: string[]): NumberedNote | undefined {
  const match = /^ ?Note on (?:([A-Z]+)|"(.*)"): (.*)\.$/.exec(line)
  if (!match) return undefined
  const letterIndex = match[1] === undefined ? -1 : options.findIndex((_, index) => optionLetter(index) === match[1])
  const option = match[1] === undefined ? match[2]! : (options[letterIndex] ?? match[1])
  return { option, text: match[3]!.trim() }
}

/**
 * A `refract_ask` result read back from saved history, which carries only its numbered text: one
 * entry per question, or undefined when the text is not that result.
 */
export function readNumberedAnswers(output: string | undefined, questions: { question: string; options: string[] }[]): NumberedResult | undefined {
  const opening = output ? NUMBERED_RESULT.exec(output) : null
  if (!output || !opening || questions.length === 0) return undefined
  const markers = questions.map((entry, index) => `\n${index + 1}. ${flatten(entry.question)} `)
  const starts: number[] = []
  let from = 0
  for (const marker of markers) {
    const start = output.indexOf(marker, from)
    if (start < 0) return undefined
    starts.push(start)
    from = start + marker.length
  }
  const answers = questions.map((entry, index) => {
    const end = index + 1 < starts.length ? starts[index + 1]! : output.length
    const [outcome = '', ...noteLines] = output.slice(starts[index]! + markers[index]!.length, end).trim().split('\n')
    const notes = noteLines.flatMap((line) => readNote(line, entry.options) ?? [])
    return { ...readOutcome(outcome.trim(), entry.options), notes }
  })
  return { byAway: opening[1] === 'Away Mode', answers }
}
