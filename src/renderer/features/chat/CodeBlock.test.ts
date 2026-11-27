// The repo has no jsdom: the block is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/state', () => ({ useSyntaxTheme: () => 'github-dark' }))

import { TooltipProvider } from '@/components/ui/tooltip'
import { CodeBlock } from './CodeBlock'

function outerTokens(embedded: boolean): string[] {
  const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(CodeBlock, { code: 'const a = 1', lang: 'ts', embedded })))
  return html.match(/<div[^>]*class="([^"]*not-prose[^"]*)"/)![1]!.split(' ')
}

describe('CodeBlock border', () => {
  it('draws its own border by default', () => {
    const tokens = outerTokens(false)
    expect(tokens).toContain('border')
    expect(tokens).toContain('border-border')
  })

  it('drops the border when embedded in a card that draws its own', () => {
    const tokens = outerTokens(true)
    expect(tokens).not.toContain('border')
    expect(tokens).not.toContain('border-border')
  })

  it('keeps a border in forced colours when embedded, where the fill step is dropped', () => {
    expect(outerTokens(true)).toContain('forced-colors:border')
  })
})
