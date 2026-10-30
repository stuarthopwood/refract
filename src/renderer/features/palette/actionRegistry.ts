import type { LucideIcon } from 'lucide-react'

/** A key chord as display tokens, modifiers first: `['Ctrl', 'Shift', 'X']`. */
export type Chord = readonly string[]

/** One command the palette, the shortcuts dialog and (slice 2) menus can list and run. */
export interface PaletteAction {
  id: string
  label: string
  /** Heading the shortcuts dialog files this action's chord under. */
  group: string
  /** Leading icon in menus and the palette; one icon per action everywhere (#1405). */
  icon?: LucideIcon
  chord?: Chord
  aliasChord?: Chord
  /** Chord fires even with an overlay open or on key repeat, and is swallowed when `when()` is false. */
  chordUnguarded?: boolean
  /** Extra words the fuzzy search also matches. */
  keywords?: readonly string[]
  /** Read at call time from store state, so the answer is never stale. */
  when(): boolean
  run(): void
  /** Appears in menus only: the caller supplies `onSelect` for its own target, so the palette and chords skip it. */
  menuOnly?: boolean
}

const registry = new Map<string, PaletteAction>()

/** Adds actions (replacing any with the same id) and returns an unregister function. */
export function registerActions(actions: readonly PaletteAction[]): () => void {
  for (const action of actions) registry.set(action.id, action)
  return () => {
    for (const action of actions) if (registry.get(action.id) === action) registry.delete(action.id)
  }
}

/** Every palette-visible action in registration order (menu-only actions are left out). */
export function getActions(): PaletteAction[] {
  return [...registry.values()].filter((action) => !action.menuOnly)
}

/** Looks an action up by id. */
export function findAction(id: string): PaletteAction | undefined {
  return registry.get(id)
}

/** True when the action's `when` says it can run now. */
export function isActionEnabled(action: PaletteAction): boolean {
  return action.when()
}

/** Chord as text for display and screen readers, for example `Ctrl+Shift+X`. */
export function chordText(chord: Chord): string {
  return chord.join('+')
}

/** Chord as words for screen readers, for example `Ctrl plus Shift plus comma`. */
export function spokenChord(chord: Chord): string {
  return chord.map((key) => (key === ',' ? 'comma' : key)).join(' plus ')
}

const PUNCTUATION_CODES: Record<string, string> = { '\\': 'Backslash', ',': 'Comma' }

// Letters and comma match on `event.key` with an `event.code` fallback for non-Latin layouts; Backslash matches on code
// alone because Shift changes `event.key` to '|'.
function keyMatches(event: KeyboardEvent, token: string): boolean {
  const code = PUNCTUATION_CODES[token]
  if (code === undefined) {
    const latin = /^(?:[\x21-\x7e]|\p{Script=Latin})$/u.test(event.key)
    if (latin) return event.key.toLowerCase() === token.toLowerCase()
    return /^[A-Za-z]$/.test(token) && event.code === `Key${token.toUpperCase()}`
  }
  if (token === '\\') return event.code === code
  const latin = /^(?:[\x21-\x7e]|\p{Script=Latin})$/u.test(event.key)
  return latin ? event.key === token : event.code === code
}

/** True when the keydown is exactly this chord: same modifiers, same final key. */
export function chordMatches(event: KeyboardEvent, chord: Chord): boolean {
  const key = chord[chord.length - 1]
  if (key === undefined) return false
  const modifiers = chord.slice(0, -1)
  return (
    event.ctrlKey === modifiers.includes('Ctrl') &&
    event.shiftKey === modifiers.includes('Shift') &&
    event.altKey === modifiers.includes('Alt') &&
    event.metaKey === modifiers.includes('Meta') &&
    keyMatches(event, key)
  )
}
