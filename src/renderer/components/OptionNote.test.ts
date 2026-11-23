// The repo has no jsdom: components are rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OPTION_NOTE_MAX_LENGTH, OptionNoteHint, OptionNoteSlot, noteCounterText, noteEditorAction, normalizeNoteText, type AskChoiceNotes } from './OptionNote'

const press = (key: string, isComposing = false) => ({ key, nativeEvent: { isComposing } })

describe('noteCounterText (#1987)', () => {
  it('stays hidden well below the cap and shows n/1000 near it', () => {
    expect(noteCounterText(0)).toBeNull()
    expect(noteCounterText(899)).toBeNull()
    expect(noteCounterText(900)).toBe('900/1000')
    expect(noteCounterText(OPTION_NOTE_MAX_LENGTH)).toBe('1000/1000')
  })
})

describe('normalizeNoteText (#1987)', () => {
  it('turns line breaks into spaces so the note stays one line', () => {
    expect(normalizeNoteText('a\nb\r\nc')).toBe('a b c')
  })

  it('enforces the 1000 character cap on typed or pasted text', () => {
    expect(normalizeNoteText('x'.repeat(1500))).toHaveLength(OPTION_NOTE_MAX_LENGTH)
  })
})

describe('noteEditorAction (#1987)', () => {
  it('saves on Enter and cancels on Escape', () => {
    expect(noteEditorAction(press('Enter'))).toBe('save')
    expect(noteEditorAction(press('Escape'))).toBe('cancel')
  })

  it('does nothing for other keys, or for Enter that confirms IME text', () => {
    expect(noteEditorAction(press('a'))).toBeNull()
    expect(noteEditorAction(press('Enter', true))).toBeNull()
  })
})

function notes(overrides: Partial<AskChoiceNotes> = {}): AskChoiceNotes {
  return { texts: {}, editing: null, onEdit: vi.fn(), onSave: vi.fn(), onCancel: vi.fn(), onRemove: vi.fn(), ...overrides }
}

function slot(picked: boolean, n: AskChoiceNotes) {
  return renderToStaticMarkup(createElement(OptionNoteSlot, { value: 'A', label: 'Alpha', picked, disabled: false, notes: n }))
}

describe('OptionNoteSlot (#1987)', () => {
  it('shows nothing under an option that is not picked, even when it holds a note', () => {
    expect(slot(false, notes({ texts: { A: 'kept' } }))).toBe('')
  })

  it('offers a labelled Note button with the N shortcut on a picked option without a note', () => {
    const html = slot(true, notes())
    expect(html).toContain('aria-label="Add a note to Alpha"')
    expect(html).toContain('aria-keyshortcuts="N"')
    expect(html).toContain('Note')
  })

  it('renders a saved note as "Note: text" in the warning token, with Edit and remove controls', () => {
    const html = slot(true, notes({ texts: { A: 'ship it' } }))
    expect(html).toContain('Note:')
    expect(html).toContain('ship it')
    expect(html).toContain('text-severity-warning')
    expect(html).toContain('aria-label="Edit note on Alpha"')
    expect(html).toContain('aria-label="Remove note on Alpha"')
  })

  it('renders the editor, labelled and capped, while its option is being edited', () => {
    const html = slot(true, notes({ texts: { A: 'draft' }, editing: 'A' }))
    expect(html).toContain('aria-label="Note on Alpha"')
    expect(html).toContain('maxLength="1000"')
    expect(html).toContain('Enter saves, Esc cancels')
  })

  it('shows the counter in the editor once the text nears the cap', () => {
    const html = slot(true, notes({ texts: { A: 'x'.repeat(950) }, editing: 'A' }))
    expect(html).toContain('950/1000')
  })
})

describe('OptionNoteHint (#1987)', () => {
  it('reads "Press N to add a note to selected option" with N as a key chip', () => {
    const html = renderToStaticMarkup(createElement(OptionNoteHint))
    expect(html).toContain('Press')
    expect(html).toContain('to add a note to selected option')
    expect(html).toMatch(/<kbd[^>]*>N<\/kbd>/)
  })
})
