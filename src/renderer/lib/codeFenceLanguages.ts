// Deliberately not Shiki's 200-plus ids: its short aliases (`r`, `v`, `d`, `log`, `make`) are
// ordinary words or letters, and a prose first word must never be swallowed as a language. Only
// the one-line shorthand consults this table; the multi-line form passes any tag through.

const LABEL_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['TypeScript', ['ts', 'typescript']],
  ['TSX', ['tsx']],
  ['JavaScript', ['js', 'javascript']],
  ['JSX', ['jsx']],
  ['Python', ['py', 'python']],
  ['Shell', ['sh', 'shell']],
  ['Bash', ['bash']],
  ['JSON', ['json']],
  ['YAML', ['yaml', 'yml']],
  ['Rust', ['rs', 'rust']],
  ['Go', ['go', 'golang']],
  ['C#', ['cs', 'csharp']],
  ['C++', ['cpp']],
  ['C', ['c']],
  ['Java', ['java']],
  ['Kotlin', ['kt', 'kotlin']],
  ['Ruby', ['rb', 'ruby']],
  ['PHP', ['php']],
  ['SQL', ['sql']],
  ['HTML', ['html']],
  ['CSS', ['css']],
  ['SCSS', ['scss']],
  ['XML', ['xml']],
  ['Markdown', ['md', 'markdown']],
  ['PowerShell', ['ps1', 'powershell']],
  ['TOML', ['toml']],
  ['Diff', ['diff']],
  ['Swift', ['swift']]
]

/** Every lowercase alias to its display name. */
export const FENCE_LANGUAGES: Readonly<Record<string, string>> = Object.fromEntries(LABEL_ALIASES.flatMap(([label, aliases]) => aliases.map((alias) => [alias, label] as const)))

/** Own-property lookup, so a word like `constructor` is never mistaken for a language. */
function lookup(tag: string): string | null {
  return Object.hasOwn(FENCE_LANGUAGES, tag) ? FENCE_LANGUAGES[tag]! : null
}

/** The lowercase tag to write and the name to show for a known word (case-insensitive); null for anything else. */
export function resolveFenceTag(word: string): { tag: string; label: string } | null {
  const tag = word.toLowerCase()
  const label = lookup(tag)
  return label ? { tag, label } : null
}

/** Display name of a tag, or null when it is not in the table (the header then reads "text"). */
export function languageLabel(tag: string | null): string | null {
  return tag ? lookup(tag.toLowerCase()) : null
}

// `go` and `c` are also plain words ("go away", "c is"): they only count as a language when the
// rest of the line shows code punctuation.
const AMBIGUOUS_TAGS: Readonly<Record<string, true>> = { go: true, c: true }
const CODE_PUNCTUATION = /[(){}[\];=<>]/

/** `resolveFenceTag` for the one-line form: `word` is the first word, `rest` the text after it. */
export function resolveOneLineTag(word: string, rest: string): { tag: string; label: string } | null {
  const resolved = resolveFenceTag(word)
  if (!resolved) return null
  return Object.hasOwn(AMBIGUOUS_TAGS, resolved.tag) && !CODE_PUNCTUATION.test(rest) ? null : resolved
}
