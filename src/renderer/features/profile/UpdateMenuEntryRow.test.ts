// The update row's content: one glyph per entry icon, and a failure detail that is cut to the menu width with the full text in a tooltip.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UpdateMenuEntry } from '@/lib/updateStatus'
import { UpdateMenuEntryRow } from './UpdateMenuEntryRow'

const render = (entry: UpdateMenuEntry) => renderToStaticMarkup(createElement(UpdateMenuEntryRow, { entry }))

describe('UpdateMenuEntryRow', () => {
  it('spins_the_glyph_only_for_a_busy_entry_and_stops_for_reduced_motion', () => {
    expect(render({ action: 'busy', icon: 'busy', label: 'Downloading update…' })).toContain('animate-spin motion-reduce:animate-none')
    expect(render({ action: 'check', icon: 'refresh', label: 'Check for updates' })).not.toContain('animate-spin')
  })

  it('renders_a_different_glyph_per_icon_key', () => {
    const icons = (['download', 'warning', 'refresh', 'busy'] as const).map((icon) => render({ action: 'check', icon, label: 'x' }))
    expect(new Set(icons).size).toBe(4)
  })

  it('truncates_a_long_failure_detail_and_keeps_the_full_text_in_the_title', () => {
    const detail = 'ENOSPC: '.repeat(60)
    const html = render({ action: 'check', icon: 'warning', label: 'Update failed. Check again', detail })
    expect(html).toContain('truncate')
    expect(html).toContain(`title="${detail}"`)
  })

  it('shows_no_detail_line_when_the_label_says_enough', () => {
    expect(render({ action: 'check', icon: 'refresh', label: 'Check for updates' })).not.toContain('title=')
  })

  it('shows_the_version_with_a_spoken_prefix', () => {
    const html = render({ action: 'download', icon: 'download', label: 'Download update', version: 'v1.4.0' })
    expect(html).toContain('v1.4.0')
    expect(html).toContain('sr-only')
  })
})
