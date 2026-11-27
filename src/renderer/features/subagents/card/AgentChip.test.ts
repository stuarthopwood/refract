import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentChip, agentChipTitle, type ChipAgent } from './AgentChip'

const render = (agent: ChipAgent) => renderToStaticMarkup(createElement(AgentChip, { agent }))

describe('AgentChip', () => {
  it('names the agent as quiet monospace text, capped at 40% of the row, with no border and no repeated tick', () => {
    const html = render({ name: 'Reviewer', role: 'smol', status: 'running' })
    expect(html).toContain('Reviewer')
    expect(html).toContain('max-w-[40%]')
    expect(html).toContain('truncate')
    expect(html).toContain('font-mono')
    expect(html).not.toContain('<svg')
    expect(html).not.toMatch(/\bborder\b/)
  })

  it('puts the full name, role and status in the title', () => {
    expect(agentChipTitle({ name: 'Reviewer', role: 'smol', status: 'failed' })).toBe('Reviewer \u00b7 smol \u00b7 Failed')
    expect(render({ name: 'Reviewer', role: 'smol', status: 'failed' })).toContain('title="Reviewer · smol · Failed"')
  })

  it('omits a missing role with no empty gap', () => {
    expect(agentChipTitle({ name: 'Solo', status: 'finished' })).toBe('Solo \u00b7 Finished')
  })
})
