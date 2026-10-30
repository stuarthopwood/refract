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
  /** Extra words the fuzzy search also matches. */
  keywords?: readonly string[]
  /** Read at call time from store state, so the answer is never stale. */
  when(): boolean
  run(): void
}

const registry = new Map<string, PaletteAction>()

/** Adds actions (replacing any with the same id) and returns an unregister function. */
export function registerActions(actions: readonly PaletteAction[]): () => void {
  for (const action of actions) registry.set(action.id, action)
  return () => {
    for (const action of actions) if (registry.get(action.id) === action) registry.delete(action.id)
  }
}

/** Every registered action in registration order. */
export function getActions(): PaletteAction[] {
  return [...registry.values()]
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

// Latin letters match on `event.key` and other layouts fall back to `event.code`, like the window-level handlers.
function keyMatches(event: KeyboardEvent, token: string): boolean {
  const latin = /^(?:[\x21-\x7e]|\p{Script=Latin})$/u.test(event.key)
  if (latin) return event.key.toLowerCase() === token.toLowerCase()
  return /^[A-Za-z]$/.test(token) && event.code === `Key${token.toUpperCase()}`
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
