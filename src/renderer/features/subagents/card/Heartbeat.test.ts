import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Heartbeat, heartbeatText } from './Heartbeat'

const render = (liveDetail: string | undefined) => renderToStaticMarkup(createElement(Heartbeat, { liveDetail }))

describe('Heartbeat (#1928)', () => {
  it('renders nothing when there is no live detail, or only whitespace', () => {
    expect(render(undefined)).toBe('')
    expect(render('')).toBe('')
    expect(render('   ')).toBe('')
    expect(heartbeatText(undefined)).toBeNull()
  })

  it('renders the live detail verbatim', () => {
    const detail = 'On scenario (f) [6/6] · Slowed by high disk I/O from parallel cargo test'
    expect(heartbeatText(detail)).toBe(detail)
    expect(render(detail)).toContain('On scenario (f) [6/6] · Slowed by high disk I/O from parallel cargo test')
  })

  it('pulses, and stops pulsing under prefers-reduced-motion', () => {
    const html = render('Editing')
    expect(html).toContain('animate-pulse')
    expect(html).toContain('motion-reduce:animate-none')
  })

  it('is not a live region, so frame churn is not announced', () => {
    const html = render('Editing')
    expect(html).not.toContain('aria-live')
    expect(html).not.toContain('role="status"')
    expect(html).not.toContain('role="alert"')
  })
})
