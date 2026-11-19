// The repo has no jsdom, so the markup is rendered to a string. Named `.ts` because vitest only includes `*.test.ts`.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SessionUsageToggles } from './SessionUsageToggles'

const render = (hasConversation: boolean, scope: 'session' | 'conversation' | 'main' = 'session') =>
  renderToStaticMarkup(
    createElement(SessionUsageToggles, { scope, range: 'all', hasConversation, onScopeChange: () => {}, onRangeChange: () => {} })
  )

describe('SessionUsageToggles', () => {
  it('says there is no conversation yet when the Session has none', () => {
    expect(render(false)).toContain('This session has no conversation yet.')
  })

  it('describes the selected scope, directly under the scope group and before the range group', () => {
    const html = render(true, 'main')
    expect(html).toContain("This conversation&#x27;s main agent only.")
    expect(html.indexOf('Usage scope')).toBeLessThan(html.indexOf('main agent only'))
    expect(html.indexOf('main agent only')).toBeLessThan(html.indexOf('Usage range'))
  })
})
