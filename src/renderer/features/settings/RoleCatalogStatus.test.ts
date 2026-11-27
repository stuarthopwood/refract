// #1848: a catalog still loading shows a skeleton line with one sr-only label, not a spinner row.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RoleCatalogStatus } from './RoleCatalogStatus'
import type { ReactElement } from 'react'

type RetryElement = ReactElement<{ id: string; onClick: () => void; 'aria-label': string }>

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

  it('renders_nothing_while_a_first_retry_is_in_flight_with_no_catalog_and_no_error', () => {
    const html = renderToStaticMarkup(createElement(RoleCatalogStatus, { kind: 'chat', catalog: undefined, error: undefined, isRetrying: true, onRetry: noop }))
    expect(html).toBe('')
  })

  it('announces_the_loading_skeleton_as_a_status_region', () => {
    const html = renderToStaticMarkup(createElement(RoleCatalogStatus, { kind: 'chat', catalog: undefined, error: undefined, isRetrying: false, onRetry: noop }))
    expect(html).toContain('role="status"')
  })

  it('renders_the_retry_button_and_calls_onRetry_with_the_kind', () => {
    const onRetry = vi.fn()
    const tree = RoleCatalogStatus({ kind: 'tts', catalog: undefined, error: 'boom', isRetrying: false, onRetry }) as ReactElement<{ children: unknown[] }>
    // The error row is `<p><span/>{retry button}</p>`; the component is a plain function, so its returned tree carries the button's props without rendering.
    const button = tree.props.children[1] as RetryElement
    expect(button.props['aria-label']).toBe('Retry loading text-to-speech models')
    button.props.onClick()
    expect(onRetry).toHaveBeenCalledWith('tts')
  })

  it('labels_the_retry_button_as_retrying_while_in_flight', () => {
    const html = renderToStaticMarkup(createElement(RoleCatalogStatus, { kind: 'chat', catalog: undefined, error: 'boom', isRetrying: true, onRetry: noop }))
    expect(html).toContain('aria-label="Retrying chat models"')
    expect(html).toContain('Retrying…')
  })
})
