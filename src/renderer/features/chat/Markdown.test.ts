// The repo has no jsdom: the Markdown is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Markdown } from './Markdown'

// The state barrel the renderer imports needs a browser `window`, so it is stubbed.
vi.mock('@/state', () => ({
  notifyPersistentError: vi.fn(),
  useSyntaxTheme: () => 'github-dark',
  useThemeKey: () => 'light',
  useSessionsStore: (select: (state: { sessions: [] }) => unknown) => select({ sessions: [] })
}))

const TEXT = 'A claim.[^1]\n\n[^1]: The note.'

function render(props: { streaming?: boolean; inert?: boolean }) {
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Markdown, { id: 'm1', text: TEXT, ...props })))
}

describe('Markdown footnotes', () => {
  it('links the reference and the backref when the text is live', () => {
    const html = render({})
    expect(html).toMatch(/<a[^>]*data-footnote-ref[^>]*href="#/)
    expect(html).toMatch(/<a[^>]*data-footnote-backref/)
  })

  it.each([
    ['streaming', { streaming: true }],
    ['inside a control', { inert: true }]
  ])('renders the reference and the backref as plain text while %s, so no anchor can take focus', (_name, props) => {
    const html = render(props)
    expect(html).not.toContain('<a')
    expect(html).not.toMatch(/\sdata-footnote-(ref|backref)=/)
    expect(html).toContain('The note.')
  })
})

describe('Markdown embedded', () => {
  const FENCES = ['```ts', 'const a = 1', '```'].join('\n')
  const MERMAID = ['```mermaid', 'graph TD', '  A-->B', '```'].join('\n')
  const html = (text: string, props: { embedded?: boolean; streaming?: boolean }) =>
    renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Markdown, { id: 'm1', text, ...props })))
  const blockTokens = (markup: string) => markup.match(/<div[^>]*class="([^"]*not-prose[^"]*)"/)![1]!.split(' ')

  it('keeps the border on a fenced code block by default', () => {
    expect(blockTokens(html(FENCES, {}))).toEqual(expect.arrayContaining(['border', 'border-border']))
  })

  it('gives a fenced code block no border of its own when embedded', () => {
    const tokens = blockTokens(html(FENCES, { embedded: true }))
    expect(tokens).not.toContain('border')
    expect(tokens).not.toContain('border-border')
  })

  it('gives a mermaid fence the embedded code block too', () => {
    const tokens = blockTokens(html(MERMAID, { embedded: true, streaming: true }))
    expect(tokens).not.toContain('border-border')
    expect(tokens).toContain('forced-colors:border')
  })
})
