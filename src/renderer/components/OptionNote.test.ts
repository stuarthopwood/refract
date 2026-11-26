// The repo has no jsdom: components are rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { OPTION_NOTE_MAX_LENGTH, OptionNoteHint, OptionNoteSlot, noteCounterText, noteEditorAction, noteLimitAnnouncement, normalizeNoteText, type AskChoiceNotes } from './OptionNote'

const press = (key: string, isComposing = false) => ({ key, nativeEvent: { isComposing } })

describe('noteCounterText (#1987)', () => {
  it('stays hidden well below the cap and shows n/1000 near it', () => {
    expect(noteCounterText(0)).toBeNull()
    expect(noteCounterText(899)).toBeNull()
    expect(noteCounterText(900)).toBe('900/1000')
    expect(noteCounterText(OPTION_NOTE_MAX_LENGTH)).toBe('1000/1000')
  })
})

describe('noteLimitAnnouncement (#1987)', () => {
  it('is silent below 900 characters', () => {
    expect(noteLimitAnnouncement(0)).toBe('')
    expect(noteLimitAnnouncement(899)).toBe('')
  })

  it('changes only at 900, 950 and 1000, so a live region speaks at those points and not per keystroke', () => {
    const bands = [900, 949, 950, 999, 1000].map(noteLimitAnnouncement)
    expect(bands[0]).toBe(bands[1])
    expect(bands[2]).toBe(bands[3])
    expect(new Set([bands[0], bands[2], bands[4]]).size).toBe(3)
    expect(bands.every((text) => text !== '')).toBe(true)
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

function slot(picked: boolean, n: AskChoiceNotes, disabled = false) {
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(OptionNoteSlot, { value: 'A', label: 'Alpha', picked, disabled, notes: n })))
}

describe('OptionNoteSlot (#1987)', () => {
  it('shows only a Note button, hidden until hover or focus-within, on an option that is not picked, and not its kept note', () => {
    const html = slot(false, notes({ texts: { A: 'kept' } }))
    expect(html).toContain('aria-label="Add a note to Alpha"')
    expect(html).toContain('opacity-0')
    expect(html).toContain('group-hover/option:opacity-100')
    expect(html).toContain('group-focus-within/option:opacity-100')
    expect(html).not.toContain('kept')
  })

  it('draws the hover hint like the selected hint: no border or fill, vertically centred and only as tall as its text, still revealed by opacity (#2180)', () => {
    const html = slot(false, notes())
    const classes = /<button[^>]*class="([^"]*)"/.exec(html)?.[1]?.split(' ') ?? []
    expect(classes).toEqual(expect.arrayContaining(['top-1/2', '-translate-y-1/2', 'opacity-0']))
    for (const stale of ['border-border', 'bg-background', 'inset-y-0', 'my-auto']) expect(classes).not.toContain(stale)
    expect(html).toContain('aria-keyshortcuts="N"')
    expect(html).toContain('aria-label="Add a note to Alpha"')
  })

  it('shows nothing under an unpicked option once the card is busy', () => {
    expect(slot(false, notes(), true)).toBe('')
  })

  it('offers a labelled Note button with the N shortcut on a picked option without a note', () => {
    const html = slot(true, notes())
    expect(html).toContain('aria-label="Add a note to Alpha"')
    expect(html).toContain('aria-keyshortcuts="N"')
    expect(html).toContain('Note')
    expect(html).not.toContain('opacity-0')
  })

  it('renders a saved note as "Note: text" in the warning token on the warning background, with Edit and remove controls', () => {
    const html = slot(true, notes({ texts: { A: 'ship it' } }))
    expect(html).toContain('Note:')
    expect(html).toContain('ship it')
    expect(html).toContain('text-severity-warning')
    expect(html).toContain('bg-severity-warning-bg')
    expect(html).toContain('aria-label="Edit note on Alpha"')
    expect(html).toContain('aria-label="Remove note on Alpha"')
  })

  it('draws the saved-note bar flush with the option row: no top border or indent, buttons centred on the text line, balanced vertical padding (#2184)', () => {
    const html = slot(true, notes({ texts: { A: 'ship it' } }))
    const bar = /<div class="([^"]*bg-severity-warning-bg[^"]*)"/.exec(html)?.[1]?.split(' ') ?? []
    expect(bar).toEqual(expect.arrayContaining(['items-center', 'py-1', 'bg-severity-warning-bg']))
    expect(bar).not.toContain('border-t')
    expect(bar).not.toContain('border-border')
    expect(bar).not.toContain('ml-6')
    expect(bar).not.toContain('items-start')
    expect(bar).not.toContain('pt-2')
  })

  it('renders the editor, labelled, capped and tied to its keyboard hint, while its option is being edited', () => {
    const html = slot(true, notes({ texts: { A: 'draft' }, editing: 'A' }))
    expect(html).toContain('aria-label="Note on Alpha"')
    expect(html).toContain('maxLength="1000"')
    expect(html).toContain('Enter saves, Escape cancels')
    const describedBy = /<textarea[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(html).toContain(`id="${describedBy}">Enter saves, Escape cancels`)
  })

  it('shows the counter, tied to the editor, once the text nears the cap, with a separate live region for the limit warning', () => {
    const html = slot(true, notes({ texts: { A: 'x'.repeat(950) }, editing: 'A' }))
    expect(html).toContain('950/1000')
    expect(html).toContain('Fewer than 50 characters left')
    const describedBy = /<textarea[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(describedBy.split(' ')).toHaveLength(2)
    expect(html).not.toMatch(/role="status"[^>]*>\s*950\/1000/)
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
