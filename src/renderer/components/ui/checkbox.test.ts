import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CHECKBOX_BOX_ONLY_CLASS, CheckboxItem } from './checkbox'

const classesOf = (className?: string): string[] => {
  const html = renderToStaticMarkup(createElement(CheckboxItem, { className }))
  return (/class="([^"]*)"/.exec(html)?.[1] ?? '').split(' ')
}

describe('CheckboxItem box-only class', () => {
  it('box_only_class_has_no_row_chrome', () => {
    const merged = classesOf(CHECKBOX_BOX_ONLY_CLASS)

    expect(merged).toContain('size-4')
    expect(merged).toContain('p-0')
    for (const chrome of ['w-full', 'px-4', 'py-2', 'rounded-lg', 'bg-background', 'hover:bg-muted', 'data-[state=checked]:bg-primary/5']) {
      expect(merged).not.toContain(chrome)
    }
  })

  it('plain_item_keeps_row_chrome', () => {
    expect(classesOf()).toEqual(expect.arrayContaining(['w-full', 'px-4', 'py-2']))
  })
})
