import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChecklistItem } from '../../../../shared/checklist'
import { ChecklistItemControlsView } from './ChecklistItemControls'
import { makeItem } from './checklist-fixtures'
import { dismissForm, submitAndRefocus } from './item-controls'

type Props = Parameters<typeof ChecklistItemControlsView>[0]

const baseProps = (item: ChecklistItem, overrides: Partial<Props> = {}): Props => ({
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

const view = (item: ChecklistItem, overrides: Partial<Props> = {}): ReactElement => ChecklistItemControlsView(baseProps(item, overrides))

const collect = (node: ReactNode, match: (props: Record<string, unknown>) => boolean, found: ReactElement<Record<string, unknown>>[] = []) => {
  Children.forEach(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return
    if (match(child.props)) found.push(child)
    collect(child.props.children as ReactNode, match, found)
  })
  return found
}

const buttonWith = (root: ReactElement, match: (props: Record<string, unknown>) => boolean): ReactElement<Record<string, unknown>> | undefined =>
  collect(root, match)[0]

const html = (item: ChecklistItem, overrides: Partial<Props> = {}): string => renderToStaticMarkup(createElement(ChecklistItemControlsView, baseProps(item, overrides)))
const textOf = (markup: string): string => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
const isDisclosure = (props: Record<string, unknown>): boolean => 'aria-expanded' in props
const isDoItem = (props: Record<string, unknown>): boolean => props['aria-disabled'] !== undefined && !('aria-expanded' in props)

describe('ChecklistItemControls', () => {
  it('disclosure_opens_one_form', () => {
    const onToggle = vi.fn()
    const closed = view(makeItem({ id: 'a' }), { onToggle })
    const disclosure = buttonWith(closed, isDisclosure)
    expect(disclosure?.props['aria-expanded']).toBe(false)
    expect(disclosure?.props['aria-controls']).toBeUndefined()
    ;(disclosure?.props.onClick as () => void)()
    expect(onToggle).toHaveBeenCalledOnce()
    expect(html(makeItem({ id: 'a' }))).not.toContain('<form')

    const open = html(makeItem({ id: 'a' }), { open: true })
    expect(open.match(/<form/g)).toHaveLength(1)
    expect(open).toContain('aria-expanded="true"')
    expect(open).toContain('id="checklist-item-form-a"')
    expect(open).toContain('aria-controls="checklist-item-form-a"')
  })

  it('needs_value_button_opens_value_mode', () => {
    const onNeedsValue = vi.fn()
    const needing = makeItem({ id: 'a', requiresValue: true })
    const button = buttonWith(view(needing, { onNeedsValue }), (props) => typeof props['aria-label'] === 'string' && props['aria-label'].startsWith('Needs a value'))
    expect(button).toBeDefined()
    ;(button?.props.onClick as () => void)()
    expect(onNeedsValue).toHaveBeenCalledOnce()

    const markup = html(needing)
    expect(textOf(markup)).toContain('Needs a value')
    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"/)
    expect(html(makeItem({ id: 'a' }))).not.toContain('Needs a value')
    expect(html(makeItem({ id: 'a', requiresValue: true, value: 'v' }))).not.toContain('Needs a value')
  })

  it('do_item_calls_item_message_complete', () => {
    const onDoItem = vi.fn()
    const button = buttonWith(view(makeItem({ id: 'a' }), { onDoItem }), isDoItem)
    expect(button?.props['aria-disabled']).toBe(false)
    ;(button?.props.onClick as () => void)()
    expect(onDoItem).toHaveBeenCalledOnce()
    expect(textOf(html(makeItem({ id: 'a' })))).toContain('Do this item')

    const blocked = vi.fn()
    const needsValue = buttonWith(view(makeItem({ id: 'a', requiresValue: true }), { onDoItem: blocked }), isDoItem)
    ;(needsValue?.props.onClick as () => void)()
    const stopped = buttonWith(view(makeItem({ id: 'a' }), { onDoItem: blocked, agentRunning: false }), isDoItem)
    ;(stopped?.props.onClick as () => void)()
    const sending = buttonWith(view(makeItem({ id: 'a' }), { onDoItem: blocked, inFlight: true }), isDoItem)
    ;(sending?.props.onClick as () => void)()
    expect(blocked).not.toHaveBeenCalled()
  })

  it('do_item_stays_mounted_aria_disabled_while_in_progress', () => {
    const onDoItem = vi.fn()
    const working = makeItem({ id: 'a', status: 'in_progress' })
    const markup = html(working)
    const tagMatch = /<button[^>]*>(?:(?!<\/button>).)*Agent is doing this item/.exec(markup)?.[0] ?? ''
    expect(tagMatch).toContain('aria-disabled="true"')
    expect(tagMatch).not.toMatch(/\sdisabled=""/)
    const button = buttonWith(view(working, { onDoItem }), isDoItem)
    ;(button?.props.onClick as () => void)()
    expect(onDoItem).not.toHaveBeenCalled()
    expect(textOf(markup)).not.toContain('Do this item')
  })

  it('hidden_for_human_or_complete_items', () => {
    expect(html(makeItem({ id: 'a', owner: 'human' }))).not.toContain('Do this item')
    expect(html(makeItem({ id: 'a', status: 'complete' }))).not.toContain('Do this item')
  })

  it('hint_is_text_linked_by_aria_describedby', () => {
    const markup = html(makeItem({ id: 'a' }), { agentRunning: false, focused: true })
    const describedBy = /aria-describedby="([^"]+)"/.exec(markup)?.[1] ?? ''
    expect(describedBy).not.toBe('')
    expect(markup).toContain(`<p id="${describedBy}" class="text-xs text-muted-foreground"`)
    expect(textOf(markup)).toContain('The agent is not running')
  })

  it('a_blocked_do_item_is_described_by_its_reason_even_before_the_hint_is_shown', () => {
    const markup = html(makeItem({ id: 'a' }), { agentRunning: false })
    const describedBy = /aria-describedby="([^"]+)"/.exec(markup)?.[1] ?? ''
    expect(describedBy).not.toBe('')
    expect(markup).toContain(`<p id="${describedBy}" class="sr-only"`)
  })

  it('escape_returns_focus_to_disclosure', () => {
    const order: string[] = []
    dismissForm(() => order.push('close'), { focus: () => order.push('focus') })
    expect(order).toEqual(['close', 'focus'])
  })

  it('success_returns_focus', async () => {
    const focus = vi.fn()
    await submitAndRefocus(() => Promise.resolve(true), { focus })
    expect(focus).toHaveBeenCalledOnce()
    const refusedFocus = vi.fn()
    await submitAndRefocus(() => Promise.resolve(false), { focus: refusedFocus })
    expect(refusedFocus).not.toHaveBeenCalled()
  })
})
