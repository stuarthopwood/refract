// The repo has no jsdom: the Markdown is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { normaliseFencesForSend } from '@/lib/codeSnippetFence'
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

// #525: the bubble renders a sent one-line block through the shared CodeBlock, like a typed canonical fence.
// Shiki loads asynchronously, so the server render shows the pre-highlight "text" header for any tag.
describe('Markdown normalised one-line fences', () => {
  const html = (text: string) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Markdown, { id: 'm1', text })))

  it('renders a normalised one-line block exactly like the canonical three-part fence', () => {
    const sent = normaliseFencesForSend('```TS const a = 1```')
    expect(sent).toBe('```ts\nconst a = 1\n```')
    expect(html(sent)).toBe(html('```ts\nconst a = 1\n```'))
    expect(html(sent)).toContain('const a = 1')
  })

  it('renders a no-language block with the "text" header and its code', () => {
    const markup = html(normaliseFencesForSend('```hello world```'))
    expect(markup).toContain('aria-label="text code block"')
    expect(markup).toContain('hello world')
    expect(markup).not.toContain('```')
  })
})
