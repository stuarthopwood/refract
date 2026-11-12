// The repo has no jsdom, so the tag is called as a plain function and its element tree inspected,
// or rendered to a string. A native <button> carries Enter/Space activation in the browser, so
// "keyboard activates" is proven by the element being a real button wired through onClick alone.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageSquareIcon } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import { SourceTag } from './SourceTag'
import { Button } from '@/components/ui/button'

function findAll(node: ReactNode, match: (el: ReactElement<Record<string, unknown>>) => boolean, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) node.forEach((child) => findAll(child, match, out))
  else if (isValidElement<Record<string, unknown>>(node)) {
    if (match(node)) out.push(node)
    findAll(node.props.children as ReactNode, match, out)
  }
  return out
}

const buttons = (node: ReactNode) => findAll(node, (el) => el.type === Button)

describe('SourceTag', () => {
  it('renders plain text with no button and no tab stop when no action is given', () => {
    const tree = SourceTag({ icon: MessageSquareIcon, label: 'Advisor' })
    expect(buttons(tree)).toHaveLength(0)
    const html = renderToStaticMarkup(createElement(SourceTag, { icon: MessageSquareIcon, label: 'Advisor', className: 'text-sm' }))
    expect(html).toContain('data-slot="source-tag"')
    expect(html).toContain('Advisor')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('tabindex')
  })

  it('renders the action as a real type=button element after the label', () => {
    const html = renderToStaticMarkup(
      createElement(SourceTag, { icon: MessageSquareIcon, label: 'From Session', action: { label: 'Alpha', onActivate: () => {} } }),
    )
    expect(html).toMatch(/From Session<button[^>]*type="button"[^>]*>Alpha<\/button>/)
  })

  it('activates through onClick only, so Enter and Space (native button clicks) fire it once', () => {
    const onActivate = vi.fn()
    const tree = SourceTag({ icon: MessageSquareIcon, label: 'From Session', action: { label: 'Alpha', onActivate } })
    const [button] = buttons(tree)
    expect(button).toBeDefined()
    expect(button!.props.onKeyDown).toBeUndefined()
    expect(button!.props.onKeyUp).toBeUndefined()
    expect(button!.props.tabIndex).toBeUndefined()
    ;(button!.props.onClick as () => void)()
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('passes an explicit ariaLabel to the button and none otherwise', () => {
    const withLabel = renderToStaticMarkup(
      createElement(SourceTag, { icon: MessageSquareIcon, label: 'From Session', action: { label: 'Alpha', onActivate: () => {}, ariaLabel: 'Open Session Alpha' } }),
    )
    expect(withLabel).toContain('aria-label="Open Session Alpha"')
    const without = renderToStaticMarkup(
      createElement(SourceTag, { icon: MessageSquareIcon, label: 'From Session', action: { label: 'Alpha', onActivate: () => {} } }),
    )
    expect(without).not.toContain('aria-label')
  })
})
