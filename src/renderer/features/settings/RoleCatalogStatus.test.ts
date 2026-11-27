// #1848: a catalog still loading shows a skeleton line with one sr-only label, not a spinner row.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RoleCatalogStatus } from './RoleCatalogStatus'

const noop = () => undefined

describe('RoleCatalogStatus', () => {
  it('shows_a_skeleton_with_the_loading_label_while_the_catalog_is_unknown', () => {
    const html = renderToStaticMarkup(createElement(RoleCatalogStatus, { kind: 'chat', catalog: undefined, error: undefined, isRetrying: false, onRetry: noop }))
    expect(html).toContain('data-slot="skeleton"')
    expect(html).toContain('Loading models…')
    expect(html).not.toContain('animate-spin')
  })

  it('renders_nothing_once_the_catalog_has_loaded', () => {
    const html = renderToStaticMarkup(createElement(RoleCatalogStatus, { kind: 'chat', catalog: [], error: undefined, isRetrying: false, onRetry: noop }))
    expect(html).toBe('')
  })

  it('shows_the_error_and_retry_instead_of_the_skeleton_when_the_load_failed', () => {
    const html = renderToStaticMarkup(createElement(RoleCatalogStatus, { kind: 'chat', catalog: undefined, error: 'boom', isRetrying: false, onRetry: noop }))
    expect(html).not.toContain('data-slot="skeleton"')
    expect(html).toContain('Could not load chat models: boom')
  })
})
