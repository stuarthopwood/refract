import { useRef, useState, type ReactNode } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { runTextFieldAction } from '@/features/menus/textFieldActions'
import { spellingItems, textEditItems, type TextEditAction } from '@/features/palette/menuItems'

type FieldAction = TextEditAction | { replace: string } | 'add-word'

interface SpellState {
  word: string
  start: number
  end: number
  misspelt: boolean
  suggestions: string[]
}

const NO_SPELL: SpellState = { word: '', start: 0, end: 0, misspelt: false, suggestions: [] }
const WORD_CHAR = /[\p{L}\p{M}'’]/u
const MIN_SPELL_CHARS = 2
const MAX_SPELL_CHARS = 64

// The selection when it is one word, else the word around the caret.
function wordAt(el: HTMLTextAreaElement): { word: string; start: number; end: number } | null {
  let start = el.selectionStart ?? 0
  let end = el.selectionEnd ?? 0
  if (start === end) {
    while (start > 0 && WORD_CHAR.test(el.value.charAt(start - 1))) start--
    while (end < el.value.length && WORD_CHAR.test(el.value.charAt(end))) end++
  }
  const word = el.value.slice(start, end).replace(/^'+|'+$/g, '')
  if (!word || /[^\p{L}\p{M}'’]/u.test(word)) return null
  return { word, start: el.value.indexOf(word, start), end: el.value.indexOf(word, start) + word.length }
}

function isSpellable(word: string): boolean {
  return word.length >= MIN_SPELL_CHARS && word.length <= MAX_SPELL_CHARS && !/\p{Cc}/u.test(word)
}

interface FieldState {
  hasSelection: boolean
  editable: boolean
  hasText: boolean
}

/** Right-click / Shift+F10 / Menu key menu for a composer text field (#471): Cut, Copy, Paste,
 * Paste as plain text, Select all. Wraps the textarea without changing its layout. */
export function ComposerContextMenu({ children }: { children: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef<FieldAction | null>(null)
  const copyTextRef = useRef('')
  const spellEpochRef = useRef(0)
  const [spell, setSpell] = useState<SpellState>(NO_SPELL)
  const [state, setState] = useState<FieldState>({ hasSelection: false, editable: false, hasText: false })

  const field = () => boxRef.current?.querySelector('textarea') ?? null

  return (
    <ContextMenu
      onOpenChange={(open) => {
        const el = field()
        if (!open || !el) return
        const epoch = ++spellEpochRef.current
        setSpell(NO_SPELL)
        const target = el.readOnly || el.disabled ? null : wordAt(el)
        if (target && isSpellable(target.word)) {
          void window.refract.spellcheck.suggest(target.word, navigator.language).then((result) => {
            if (result.ok && epoch === spellEpochRef.current) setSpell({ ...target, ...result.value })
          }).catch(() => undefined)
        }
        copyTextRef.current = el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
        setState({ hasSelection: el.selectionStart !== el.selectionEnd, editable: !el.readOnly && !el.disabled, hasText: el.value !== '' })
      }}
    >
      <ContextMenuTrigger asChild>
        <div ref={boxRef} className="contents select-text">
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label="Text editing"
        collisionPadding={8}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const el = field()
          const action = pendingRef.current
          pendingRef.current = null
          el?.focus()
          if (!el || !action) return
          if (typeof action === 'object') {
            el.setSelectionRange(spell.start, spell.end)
            document.execCommand('insertText', false, action.replace)
          } else if (action === 'add-word') void window.refract.spellcheck.add(spell.word, navigator.language).catch(() => undefined)
          else void runTextFieldAction(el, action, copyTextRef.current)
        }}
      >
        {spellingItems({ ...spell, onReplace: (replace) => (pendingRef.current = { replace }), onAdd: () => (pendingRef.current = 'add-word') })}
        {textEditItems({ ...state, onSelect: (action) => (pendingRef.current = action) })}
      </ContextMenuContent>
    </ContextMenu>
  )
}
