import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock('@/state', () => ({
  useSettingsStore: (select: (s: { settings: object }) => unknown) => select({ settings: settings.current })
}))
vi.mock('@/hooks/useWindowVisible', () => ({ useWindowVisible: () => true }))

import { ShimmerText } from './ShimmerText'

function render(current: Record<string, unknown>): string {
  settings.current = current
  return renderToStaticMarkup(createElement(ShimmerText, { active: true, children: 'Working' }))
}

describe('ShimmerText', () => {
  it('shimmers_by_default', () => {
    const html = render({})
    expect(html).toContain('text-shimmer')
    expect(html).toContain('data-shimmer="on"')
  })

  it('has_no_shimmer_class_when_the_reduce_motion_switch_is_on', () => {
    const html = render({ reduceMotion: true })
    expect(html).not.toContain('text-shimmer')
    expect(html).toContain('data-shimmer="off"')
  })

  it('has_no_shimmer_class_when_animated_status_text_is_off', () => {
    expect(render({ animatedStatusText: false })).not.toContain('text-shimmer')
  })
})
