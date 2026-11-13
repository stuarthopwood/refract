// The repo has no jsdom, so the notice renders to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { useGhStackStore } from '@/state/gh-stack-store'
import { GhStackNotice } from './GhStackNotice'

// Server rendering reads the store's initial snapshot, so patch that too.
function setStore(patch: Partial<ReturnType<typeof useGhStackStore.getState>>): void {
  useGhStackStore.setState(patch)
  Object.assign(useGhStackStore.getInitialState(), patch)
}

beforeEach(() => setStore({ state: 'missing', installing: false, error: null }))

describe('GhStackNotice status text', () => {
  it('says "Installing gh-stack…" in a status region while installing, inline', () => {
    setStore({ installing: true })
    const html = renderToStaticMarkup(createElement(GhStackNotice, { layout: 'inline' }))
    expect(html).toMatch(/role="status"[^>]*>Installing gh-stack…/)
  })

  it('announces the same in the callout and is empty when idle', () => {
    setStore({ installing: true })
    expect(renderToStaticMarkup(createElement(GhStackNotice, { layout: 'callout' }))).toMatch(/role="status"[^>]*>Installing gh-stack…/)
    setStore({ installing: false })
    const idle = renderToStaticMarkup(createElement(GhStackNotice, { layout: 'callout' }))
    expect(idle).toMatch(/role="status"[^>]*><\/span>/)
  })
})
