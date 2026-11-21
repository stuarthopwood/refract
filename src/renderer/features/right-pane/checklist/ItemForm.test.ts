// The repo has no jsdom, so the form renders to a string and its key handling is tested as a pure helper.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ItemNote } from '@/state/checklist-drafts'
import { ItemForm, ItemNoteLine } from './ItemForm'
import { ASK_UNAVAILABLE_REASON, handleFormKey, type ItemFormMode } from './item-controls'

interface RenderOptions {
  mode?: ItemFormMode
  text?: string
  agentRunning?: boolean
  inFlight?: boolean
}

const render = ({ mode = 'ask', text = '', agentRunning = true, inFlight = false }: RenderOptions = {}): string =>
  renderToStaticMarkup(
    createElement(ItemForm, {
      itemText: 'Write the spec',
      mode,
      text,
      agentRunning,
      inFlight,
      onModeChange: () => {},
      onTextChange: () => {},
      onSend: () => {},
      onClose: () => {}
    })
  )

const tag = (html: string, pattern: RegExp): string => pattern.exec(html)?.[0] ?? ''
const submitTag = (html: string): string => tag(html, /<button[^>]*type="submit"[^>]*>/)
const askRadioTag = (html: string): string => tag(html, /<button[^>]*role="radio"[^>]*value="ask"[^>]*>/)
const textOf = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

describe('ItemForm', () => {
  it('ctrl_enter_sends', () => {
    const send = vi.fn()
    const close = vi.fn()
    const preventDefault = vi.fn()
    handleFormKey({ key: 'Enter', ctrlKey: true, metaKey: false, preventDefault }, { send, close })
    expect(send).toHaveBeenCalledOnce()
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
    handleFormKey({ key: 'Enter', ctrlKey: false, metaKey: false }, { send, close })
    expect(send).toHaveBeenCalledOnce()
  })

  it('escape_closes_and_is_not_passed_to_the_pane', () => {
    const send = vi.fn()
    const close = vi.fn()
    const stopPropagation = vi.fn()
    handleFormKey({ key: 'Escape', ctrlKey: false, metaKey: false, stopPropagation }, { send, close })
    expect(close).toHaveBeenCalledOnce()
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
  })

  it('send_disabled_while_in_flight', () => {
    const idle = submitTag(render({ text: 'hello' }))
    expect(idle).not.toContain('aria-disabled=')
    const busy = submitTag(render({ text: 'hello', inFlight: true }))
    expect(busy).toContain('aria-busy="true"')
    expect(busy).toContain('aria-disabled="true"')
    expect(busy).not.toMatch(/\sdisabled=""/)
  })

  it('send_is_aria_disabled_when_empty_so_focus_stays', () => {
    const empty = submitTag(render({ text: '   ' }))
    expect(empty).toContain('aria-disabled="true"')
    expect(empty).not.toMatch(/\sdisabled=""/)
  })

  it('counter_shows_bytes', () => {
    expect(textOf(render({ mode: 'ask', text: 'abc' }))).toContain('3 of 4096 bytes')
    expect(textOf(render({ mode: 'value', text: 'ééé' }))).toContain('6 of 1024 bytes')
    const over = render({ mode: 'value', text: 'x'.repeat(1025) })
    expect(textOf(over)).toContain('1025 of 1024 bytes')
    expect(textOf(over.replace(/<span role="status"[^>]*>[^<]*<\/span>/, '')).match(/too long/gi)).toHaveLength(1)
    expect(over).toContain('aria-invalid="true"')
  })

  it('counter_line_carries_the_plain_text_warning_and_describes_the_textarea', () => {
    const html = render()
    const describedBy = /<textarea[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(describedBy).not.toBe('')
    const line = new RegExp(`<p id="${describedBy}"[^>]*>([\\s\\S]*?)</p>`).exec(html)?.[1] ?? ''
    expect(textOf(line)).toContain('Do not put secrets here')
    expect(textOf(line)).toContain('0 of 4096 bytes')
    expect(describedBy.split(' ')).toHaveLength(1)
  })

  it('textarea_is_labelled_by_mode_and_item', () => {
    expect(render({ mode: 'ask' })).toContain('aria-label="Question for Write the spec"')
    expect(render({ mode: 'value' })).toContain('aria-label="Value for Write the spec"')
  })

  it('refusal_line_alerts_and_the_draft_stays_in_the_form', () => {
    const note: ItemNote = { kind: 'refusal', message: 'Not sent. Your question is still in the box.' }
    const line = renderToStaticMarkup(createElement(ItemNoteLine, { note }))
    expect(line).toContain('role="alert"')
    expect(textOf(line)).toContain('Not sent. Your question is still in the box.')
    expect(render({ text: 'my question' })).toContain('>my question</textarea>')
  })

  it('delivery_line_is_a_status_not_an_alert', () => {
    const line = renderToStaticMarkup(createElement(ItemNoteLine, { note: { kind: 'delivery', delivery: 'queued' } }))
    expect(textOf(line)).toContain('Queued after the current turn')
    expect(line).not.toContain('role="alert"')
  })

  it('no_agent_value_mode_reads_save_value', () => {
    expect(submitTag(render({ mode: 'value', agentRunning: false, text: 'v' }))).toBeTruthy()
    expect(textOf(render({ mode: 'value', agentRunning: false, text: 'v' }))).toContain('Save value')
    expect(textOf(render({ mode: 'value', agentRunning: true, text: 'v' }))).not.toContain('Save value')
  })

  it('no_agent_ask_is_disabled_with_visible_reason', () => {
    const html = render({ mode: 'value', agentRunning: false })
    expect(askRadioTag(html)).toMatch(/\sdisabled=""/)
    expect(textOf(html)).toContain(ASK_UNAVAILABLE_REASON)
    const reasonId = /aria-describedby="([^"]+)"/.exec(askRadioTag(html))?.[1] ?? ''
    expect(html).toContain(`<p id="${reasonId}"`)
    const running = render({ mode: 'ask', agentRunning: true })
    expect(askRadioTag(running)).not.toMatch(/\sdisabled=""/)
    expect(textOf(running)).not.toContain(ASK_UNAVAILABLE_REASON)
  })
})

describe('ItemForm too-long announcement', () => {
  it('the_status_region_is_always_mounted_and_says_too_long_only_when_over_the_cap', () => {
    const status = (html: string): string => /<span role="status"[^>]*>([^<]*)<\/span>/.exec(html)?.[1] ?? 'missing'
    expect(status(render({ mode: 'value', text: 'x'.repeat(1025) }))).toBe('Too long to send.')
    expect(status(render({ mode: 'value', text: 'x' }))).toBe('')
  })
})

describe('ItemNoteLine live regions', () => {
  it('a_refusal_alert_is_never_nested_inside_a_status_region', () => {
    const html = renderToStaticMarkup(createElement(ItemNoteLine, { note: { kind: 'refusal', message: 'Not sent.' } }))
    const open = /<div[^>]*role="status"[^>]*>/.exec(html)
    expect(open).not.toBeNull()
    let depth = 1
    let end = (open?.index ?? 0) + (open?.[0].length ?? 0)
    for (const tagMatch of html.slice(end).matchAll(/<(\/?)div\b/g)) {
      depth += tagMatch[1] === '/' ? -1 : 1
      if (depth === 0) {
        end += tagMatch.index
        break
      }
    }
    expect(html.slice((open?.index ?? 0) + (open?.[0].length ?? 0), end)).not.toContain('role="alert"')
    expect(html).toContain('role="alert"')
  })
})
