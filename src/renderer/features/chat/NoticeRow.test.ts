import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { NoticeSource } from '../../../shared/model'
import { NoticeRow } from './NoticeRow'

// The real `@/state` wires stores to `window` at import time, which this node-environment suite lacks.
vi.mock('@/state', () => ({
  useSettingsStore: (select: (state: { settings: object }) => unknown) => select({ settings: {} })
}))

function render(level: 'info' | 'warning' | 'error', source?: NoticeSource, text = 'Build finished.'): string {
  return renderToStaticMarkup(React.createElement(NoticeRow, { level, text, source }))
}

describe('NoticeRow source style (#2114)', () => {
  it('shows the Bot icon, the accent colour and the "Extension:" label for an info notice from an extension', () => {
    const html = render('info', 'extension')
    expect(html).toContain('lucide-bot')
    expect(html).toContain('text-accent-text')
    expect(html).toContain('Extension:')
    expect(html).not.toContain('lucide-info')
    expect(html).not.toContain('Info:')
  })

  it('keeps the Info icon, the muted colour and the "Info:" label for an info notice with no source', () => {
    const html = render('info')
    expect(html).toContain('lucide-info')
    expect(html).toContain('text-notice-info-fg')
    expect(html).toContain('Info:')
    expect(html).not.toContain('lucide-bot')
    expect(html).not.toContain('Extension:')
  })

  it('leaves a warning from an extension with its warning icon and label', () => {
    const html = render('warning', 'extension')
    expect(html).toContain('Warning:')
    expect(html).not.toContain('lucide-bot')
    expect(html).not.toContain('Extension:')
  })

  it('leaves an error from an extension with its error icon and label', () => {
    const html = render('error', 'extension')
    expect(html).toContain('lucide-octagon-alert')
    expect(html).toContain('Error:')
    expect(html).toContain('text-notice-error-fg')
    expect(html).not.toContain('lucide-bot')
    expect(html).not.toContain('Extension:')
  })

  it('drops the info tone class and hides the icon from assistive tech for an info notice from an extension', () => {
    const html = render('info', 'extension')
    expect(html).not.toContain('text-notice-info-fg')
    expect(html).toMatch(/<svg[^>]*lucide-bot[^>]*aria-hidden="true"|<svg[^>]*aria-hidden="true"[^>]*lucide-bot/)
  })

  it('gives a long notice from an extension the accent and a hover swap to foreground', () => {
    const html = render('info', 'extension', 'x'.repeat(200))
    expect(html).toContain('text-accent-text')
    expect(html).toContain('group-hover/line:text-foreground')
    expect(html).not.toContain('text-notice-info-fg')
  })

  it('adds no hover swap to a long notice with no source', () => {
    const html = render('info', undefined, 'x'.repeat(200))
    expect(html).not.toContain('group-hover/line:text-foreground')
  })
})
