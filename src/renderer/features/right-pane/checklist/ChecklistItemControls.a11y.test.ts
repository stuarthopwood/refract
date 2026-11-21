// The repo has no jsdom, so the controls render to a string and the assertions read that markup.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ItemNote } from '@/state/checklist-drafts'
import type { ChecklistItem } from '../../../../shared/checklist'
import { ChecklistItemControlsView } from './ChecklistItemControls'
import { ChecklistRow } from './ChecklistRow'
import { describeAgentChange } from './checklist-announcements'
import { makeChecklist, makeItem } from './checklist-fixtures'
import { ItemNoteLine } from './ItemForm'

type Props = Parameters<typeof ChecklistItemControlsView>[0]

const controls = (item: ChecklistItem, overrides: Partial<Props> = {}): string =>
  renderToStaticMarkup(
    createElement(ChecklistItemControlsView, {
      item,
      open: false,
      mode: 'ask',
      text: '',
      agentRunning: true,
      inFlight: false,
      note: undefined,
      focused: false,
      onToggle: () => {},
      onNeedsValue: () => {},
      onDoItem: () => {},
      onModeChange: () => {},
      onTextChange: () => {},
      onSend: () => {},
      onClose: () => {},
      ...overrides
    })
  )

const row = (item: ChecklistItem): string =>
  renderToStaticMarkup(createElement('ol', null, createElement(ChecklistRow, { item, sessionId: 's1', checklistId: 'p1', agentRunning: true, pending: false, onTick: () => {} })))

const textOf = (markup: string): string => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
const note = (n: ItemNote): string => renderToStaticMarkup(createElement(ItemNoteLine, { note: n }))

interface Focusable {
  tag: string
  name: string
}

/** Tabbable elements in document order, each with the name a screen reader would give it. */
const focusables = (markup: string): Focusable[] => {
  const found: Focusable[] = []
  const pattern = /<(button|textarea|input|a)\b([^>]*)>([\s\S]*?)(?=<(?:button|textarea|input|a)\b|<\/form>|$)/g
  for (const match of markup.matchAll(pattern)) {
    const attrs = match[2] ?? ''
    if (/\baria-hidden="true"/.test(attrs) && /tabindex="-1"/.test(attrs)) continue
    const label = /aria-label="([^"]*)"/.exec(attrs)?.[1]
    const inner = textOf((match[3] ?? '').split(/<\/button>|<\/textarea>/)[0] ?? '').trim()
    found.push({ tag: match[1] ?? '', name: label ?? inner })
  }
  return found
}

describe('ChecklistItemControls accessibility', () => {
  it('awaiting_input_uses_text_and_icon', () => {
    const item = makeItem({ id: 'a', requiresValue: true })
    const markup = controls(item)
    const button = /<button[^>]*aria-label="Needs a value: [^"]*"[^>]*>(.*?)<\/button>/.exec(markup)?.[1] ?? ''
    expect(button).toMatch(/<svg[^>]*aria-hidden="true"/)
    expect(textOf(button).trim()).toBe('Needs a value')
    // In the row the same state is also said in words next to the tick, not by colour.
    expect(textOf(row(item))).toContain('This item needs a value before it can be ticked.')
  })

  it('in_progress_uses_text_and_icon', () => {
    const item = makeItem({ id: 'a', status: 'in_progress' })
    const markup = controls(item)
    const button = /<button[^>]*aria-disabled="true"[^>]*>(.*?)<\/button>/.exec(markup)?.[1] ?? ''
    expect(textOf(button)).toContain('Agent is doing this item')
    expect(button).toMatch(/<svg/)
    // The row's status line carries an aria-hidden icon and the visible word.
    const status = /<span id="[^"]*-status"[^>]*>.*?<\/span><\/span>/.exec(row(item))?.[0] ?? ''
    expect(status).toMatch(/<svg[^>]*aria-hidden="true"/)
    expect(textOf(status)).toContain('In progress')
  })

  it('live_regions_announce_outcomes_and_stay_mounted', () => {
    expect(note({ kind: 'delivery', delivery: 'queued' })).toMatch(/<div[^>]*role="status"[^>]*>.*Queued after the current turn/)
    expect(note({ kind: 'delivery', delivery: 'held' })).toContain('Held until you resume')
    const refused = note({ kind: 'refusal', message: 'Not sent. Your question is still in the box.' })
    expect(refused).toMatch(/role="alert"[^>]*><svg[^>]*aria-hidden="true".*Error: <\/span>Not sent\. Your question is still in the box\./)
    const idle = renderToStaticMarkup(createElement(ItemNoteLine, { note: undefined }))
    expect(idle).toMatch(/<div data-slot="checklist-item-note"><div role="status"><\/div><\/div>/)
    expect(idle).not.toContain('role="alert"')
  })

  it('agent_status_changes_are_spoken_as_words', () => {
    const before = makeChecklist({ items: [makeItem({ id: 'i1', text: 'Write the spec', status: 'next' })] })
    const after = makeChecklist({ items: [makeItem({ id: 'i1', text: 'Write the spec', status: 'in_progress' })] })
    expect(describeAgentChange(before, after)).toBe('Write the spec is now in progress')
  })

  it('each_control_is_labelled', () => {
    const markup = controls(makeItem({ id: 'a', text: 'Write the spec', requiresValue: true }), { open: true })
    const controlsFound = focusables(markup)
    expect(controlsFound.length).toBeGreaterThanOrEqual(6)
    for (const control of controlsFound) expect(control.name, `${control.tag} has no accessible name`).not.toBe('')
    expect(markup).toContain('aria-label="Ask or provide a value for Write the spec"')
    expect(markup).toContain('aria-label="Needs a value: Write the spec"')
    expect(markup).toContain('aria-label="Do this item: Write the spec"')
    expect(markup).toContain('aria-label="Question for Write the spec"')
    expect(markup).toContain('aria-label="What to send"')
  })

  it('tab_order_follows_the_reading_order', () => {
    const markup = controls(makeItem({ id: 'a', text: 'Write the spec', requiresValue: true }), { open: true })
    expect(markup).not.toMatch(/tabindex="[1-9]/)
    const names = focusables(markup).map((control) => control.name)
    expect(names).toEqual([
      'Ask or provide a value for Write the spec',
      'Needs a value: Write the spec',
      'Do this item: Write the spec',
      'Ask the agent',
      'Provide a value',
      'Question for Write the spec',
      'Send'
    ])
  })
})
