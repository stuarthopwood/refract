import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { NoticeSource } from '../../../shared/model'
import { NoticeRow } from './NoticeRow'

// The real `@/state` wires stores to `window` at import time, which this node-environment suite lacks.
vi.mock('@/state', () => ({
  useSettingsStore: (select: (state: { settings: object }) => unknown) => select({ settings: {} })
}))

function render(level: 'info' | 'warning' | 'error', source?: NoticeSource): string {
  return renderToStaticMarkup(React.createElement(NoticeRow, { level, text: 'Build finished.', source }))
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
})
