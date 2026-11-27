// The repo has no jsdom: the real shared Markdown is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/state', () => ({
  notifyPersistentError: vi.fn(),
  useSyntaxTheme: () => 'github-dark',
  useThemeKey: () => 'light',
  useSessionsStore: (select: (state: { sessions: [] }) => unknown) => select({ sessions: [] })
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { ResultMarkdown, type ResultLines } from './ResultMarkdown'

const LINK = 'See [the PR](https://x.test/pr) now'

function render(props: { text?: string; lines?: ResultLines; interactive?: boolean }) {
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ResultMarkdown, { text: props.text ?? 'Fixed it', lines: props.lines, interactive: props.interactive })))
}

// The markup escapes `&` in an attribute, so the arbitrary variant reads `[&amp;_p]`.
const classOfFirstDiv = (html: string) => html.match(/<div[^>]*class="([^"]*)"/)![1]!.split(' ')

describe('ResultMarkdown line limit', () => {
  it('truncates the paragraph to one line for lines=1', () => {
    const tokens = classOfFirstDiv(render({ lines: 1 }))
    expect(tokens).toContain('[&amp;_p]:truncate')
    expect(tokens).not.toContain('[&amp;_p]:line-clamp-2')
  })

  it('clamps the paragraph to two lines for lines=2', () => {
    const tokens = classOfFirstDiv(render({ lines: 2 }))
    expect(tokens).toContain('[&amp;_p]:line-clamp-2')
    expect(tokens).not.toContain('[&amp;_p]:truncate')
  })

  it('applies no clamp for lines="all"', () => {
    const tokens = classOfFirstDiv(render({ lines: 'all' }))
    expect(tokens.filter((token) => token.includes('line-clamp') || token.includes('truncate'))).toEqual([])
  })

  it('applies no clamp when no line limit is given', () => {
    const tokens = classOfFirstDiv(render({}))
    expect(tokens.filter((token) => token.includes('line-clamp') || token.includes('truncate'))).toEqual([])
  })
})

describe('ResultMarkdown links', () => {
  it('renders a link as plain inert text by default, with no anchor and no href', () => {
    const html = render({ text: LINK })
    expect(html).not.toContain('<a')
    expect(html).not.toContain('href=')
    expect(html).toContain('the PR')
    expect(html).toMatch(/<span class="[^"]*underline[^"]*">the PR<\/span>/)
  })

  it('renders an anchor with its href when interactive', () => {
    const html = render({ text: LINK, interactive: true })
    expect(html).toMatch(/<a[^>]*href="https:\/\/x\.test\/pr"/)
    expect(html).not.toMatch(/<span class="[^"]*underline/)
  })

  it('removes the accent colour and underline of an inert link, and keeps them off an interactive one', () => {
    expect(classOfFirstDiv(render({ text: LINK }))).toEqual(expect.arrayContaining(['[&amp;_span.underline]:text-inherit', '[&amp;_span.underline]:no-underline']))
    expect(classOfFirstDiv(render({ text: LINK, interactive: true })).filter((token) => token.includes('span.underline'))).toEqual([])
  })
})
