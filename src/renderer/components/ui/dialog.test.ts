// The repo has no jsdom and Radix portals render nothing on the server, so the Radix dialog parts are
// replaced by plain elements that keep their props; the real DialogContent then renders to static markup.
import type * as RadixUi from 'radix-ui'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DialogContent } from './dialog'

vi.mock('radix-ui', async (importOriginal) => {
  const original = await importOriginal<typeof RadixUi>()
  const passthrough = ({ children, asChild: _asChild, ...props }: { children?: ReactNode; asChild?: boolean }) =>
    createElement('div', props, children)
  return { ...original, Dialog: { ...original.Dialog, Portal: passthrough, Overlay: passthrough, Content: passthrough, Close: passthrough } }
})

function contentClasses(className?: string): string[] {
  const markup = renderToStaticMarkup(createElement(DialogContent, { showCloseButton: false, className }, 'body'))
  const tag = /<div[^>]*data-slot="dialog-content"[^>]*>/.exec(markup)?.[0]
  const classAttribute = tag === undefined ? undefined : /class="([^"]*)"/.exec(tag)?.[1]
  expect(classAttribute, markup).toBeDefined()
  return (classAttribute ?? '').split(/\s+/)
}

describe('DialogContent column (#2322, FR-224)', () => {
  it('lays_dialog_content_in_one_shrinkable_column_so_a_long_line_cannot_widen_it_past_the_panel', () => {
    const classes = contentClasses()
    expect(classes).toContain('grid')
    expect(classes).toContain('grid-cols-[minmax(0,1fr)]')
  })

  it('keeps_the_column_class_when_a_caller_widens_the_dialog', () => {
    const classes = contentClasses('sm:max-w-2xl')
    expect(classes).toContain('sm:max-w-2xl')
    expect(classes).toContain('grid')
    expect(classes).toContain('grid-cols-[minmax(0,1fr)]')
  })
})
