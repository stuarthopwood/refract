// The repo has no jsdom: the section is rendered to a string and the Reduce motion switch is exercised through the
// props the real switch row receives (the same pattern as ChatDisplaySection.test.ts), so the wiring is covered without a DOM.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingSwitchRow as SettingSwitchRowComponent } from '@/components/SettingSwitchRow'
import { AppearanceSection } from './AppearanceSection'

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  setReduceMotion: vi.fn(),
  rows: [] as { id: string; label: string; checked: boolean; onCheckedChange: (checked: boolean) => void }[]
}))

vi.mock('@/state', () => ({
  useSettingsStore: (select: (state: object) => unknown) =>
    select({
      settings: mocks.settings,
      setReduceMotion: mocks.setReduceMotion,
      setWatermarkEnabled: vi.fn(),
      setHolidayTouches: vi.fn(),
      setActivityText: vi.fn(),
      setAnimatedStatusText: vi.fn()
    })
}))
// The pickers and preview are other features' wiring; only the switch rows matter here.
vi.mock('./ThemePicker', () => ({ ThemePicker: () => null }))
vi.mock('./ChatWidthPicker', () => ({ ChatWidthPicker: () => null }))
vi.mock('./TextSizeGroup', () => ({ TextSizeGroup: () => null }))
vi.mock('./ChatRowSpacingGroup', () => ({ ChatRowSpacingGroup: () => null }))
vi.mock('./StatusStylePicker', () => ({ StatusStylePicker: () => null }))
vi.mock('@/features/chat/BrandWatermark', () => ({ BrandWatermark: () => null }))
vi.mock('@/components/SettingSwitchRow', async (importOriginal) => {
  const actual = await importOriginal<{ SettingSwitchRow: typeof SettingSwitchRowComponent }>()
  return {
    SettingSwitchRow: (props: Parameters<typeof SettingSwitchRowComponent>[0]) => {
      mocks.rows.push(props)
      return actual.SettingSwitchRow(props)
    }
  }
})

function render(settings: Record<string, unknown>): string {
  mocks.settings = settings
  mocks.rows.length = 0
  return renderToStaticMarkup(createElement(AppearanceSection))
}

const reduceMotionRow = () => mocks.rows.find((row) => row.id === 'reduce-motion')

describe('Settings > Appearance > Reduce motion (#566)', () => {
  beforeEach(() => mocks.setReduceMotion.mockClear())

  it('shows_a_labelled_switch_that_is_off_when_the_setting_is_absent', () => {
    const html = render({})
    expect(reduceMotionRow()?.label).toBe('Reduce motion')
    expect(reduceMotionRow()?.checked).toBe(false)
    expect(html.match(/<button[^>]*id="reduce-motion"[^>]*>/)?.[0]).toContain('aria-checked="false"')
  })

  it('reflects_settings_reduce_motion_when_it_is_on', () => {
    const html = render({ reduceMotion: true })
    expect(reduceMotionRow()?.checked).toBe(true)
    expect(html.match(/<button[^>]*id="reduce-motion"[^>]*>/)?.[0]).toContain('aria-checked="true"')
  })

  it('calls_setReduceMotion_with_the_new_value_when_toggled', () => {
    render({})
    reduceMotionRow()?.onCheckedChange(true)
    expect(mocks.setReduceMotion).toHaveBeenCalledExactlyOnceWith(true)
    mocks.setReduceMotion.mockClear()
    reduceMotionRow()?.onCheckedChange(false)
    expect(mocks.setReduceMotion).toHaveBeenCalledExactlyOnceWith(false)
  })
})
