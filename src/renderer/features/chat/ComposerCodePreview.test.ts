// The repo has no jsdom: the component is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/state', () => ({ useSyntaxTheme: () => 'github-dark' }))

import { TooltipProvider } from '@/components/ui/tooltip'
import { ComposerCodePreview, PREVIEW_MAX_LINES, capPreviewBlock } from './ComposerCodePreview'

function render(text: string, enabled = true): string {
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ComposerCodePreview, { text, enabled })))
}

const EMPTY_STATUS = '<p role="status" aria-live="polite" class="sr-only"></p>'
const lines = (count: number) => Array.from({ length: count }, (_, i) => `line${i + 1}`).join('\n')

describe('ComposerCodePreview', () => {
  it('renders only the empty status region when there is no fence', () => {
    expect(render('just words')).toBe(EMPTY_STATUS)
  })

  it('renders only the empty status region when disabled', () => {
    expect(render('```ts\nconst a = 1\n```', false)).toBe(EMPTY_STATUS)
  })

  it('hides the strip from assistive tech and makes it inert', () => {
    const html = render('```ts\nconst a = 1\n```')
    expect(html).toMatch(/<div(?=[^>]*\saria-hidden="true")(?=[^>]*\sinert="")[^>]*>/)
  })

  it('is an in-flow strip, never positioned over the textarea', () => {
    expect(render('```ts\nconst a = 1\n```')).not.toMatch(/class="[^"]*\b(absolute|fixed|inset-0)\b/)
  })

  it('has no button, link or input, and any tab stop sits inside the inert strip', () => {
    const html = render('```ts\nconst a = 1\n```')
    expect(html).not.toMatch(/<(button|a|input)[\s>]/)
    const inertAt = html.indexOf('inert=""')
    expect(inertAt).toBeGreaterThan(-1)
    for (const match of html.matchAll(/tabindex=/g)) expect(match.index).toBeGreaterThan(inertAt)
  })

  it('announces the language and line count in a status line', () => {
    expect(render('```ts\nconst a = 1\nconst b = 2\n```')).toContain('>TypeScript code block, 2 lines</p>')
  })

  it('shows "text" in the header and announcement for an unknown tag', () => {
    const html = render('```zig\nconst a = 1\n```')
    expect(html).toContain('>text code block, 1 line</p>')
    expect(html).toMatch(/aria-label="text code block"/)
  })

  it('shows the block as typed under the cap with no overflow label', () => {
    expect(render(`\`\`\`ts\n${lines(PREVIEW_MAX_LINES)}\n\`\`\``)).not.toContain('more line')
  })

  it('caps a long block at 12 lines and says how many more there are', () => {
    const html = render(`\`\`\`ts\n${lines(15)}\n\`\`\``)
    expect(html).toContain('3 more lines')
    expect(html).toContain('line12')
    expect(html).not.toContain('line13')
    expect(html).toContain('max-h-[min(12rem,30vh)]')
  })
})

describe('capPreviewBlock', () => {
  it('uses the singular for one hidden line', () => {
    expect(capPreviewBlock({ tag: 'ts', body: lines(13), lineCount: 13 })).toEqual({ code: lines(12), hidden: 1 })
  })

  it('leaves a short block whole', () => {
    expect(capPreviewBlock({ tag: null, body: 'a\nb', lineCount: 2 })).toEqual({ code: 'a\nb', hidden: 0 })
  })
})
