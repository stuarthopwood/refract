import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentChip, agentChipTitle, type ChipAgent } from './AgentChip'

const render = (agent: ChipAgent) => renderToStaticMarkup(createElement(AgentChip, { agent }))

describe('AgentChip', () => {
  it('shows the status glyph with its word, the name and the role, capped at 40% of the row', () => {
    const html = render({ name: 'Reviewer', role: 'smol', status: 'running' })
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/)
    expect(html).toContain('<span class="sr-only">Running</span>')
    expect(html).toContain('Reviewer')
    expect(html).toContain('smol')
    expect(html).toContain('max-w-[40%]')
    expect(html).toContain('truncate')
  })

  it('puts the full name, role and status in the title', () => {
    expect(agentChipTitle({ name: 'Reviewer', role: 'smol', status: 'failed' })).toBe('Reviewer \u00b7 smol \u00b7 Failed')
    expect(render({ name: 'Reviewer', role: 'smol', status: 'failed' })).toContain('title="Reviewer · smol · Failed"')
  })

  it('omits a missing role with no empty gap', () => {
    expect(agentChipTitle({ name: 'Solo', status: 'finished' })).toBe('Solo \u00b7 Finished')
    expect(render({ name: 'Solo', status: 'finished' })).not.toMatch(/<span class="min-w-0 truncate text-muted-foreground"/)
  })
})
