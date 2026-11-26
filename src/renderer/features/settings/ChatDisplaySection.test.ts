// The repo has no jsdom: the section is rendered to a string, and the toggle is exercised through the props
// the real switch row receives, so the Settings wiring (label, default, setter key) is covered without a DOM.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingSwitchRow as SettingSwitchRowComponent } from '@/components/SettingSwitchRow'
import { DEFAULT_TRANSCRIPT_DISPLAY } from '../../../shared/transcriptDisplay'
import { ChatDisplaySection } from './ChatDisplaySection'

const mocks = vi.hoisted(() => ({
  transcriptDisplay: undefined as unknown,
  setTranscriptDisplay: vi.fn(),
  rows: [] as { id: string; label: string; checked: boolean; onCheckedChange: (checked: boolean) => void }[]
}))

vi.mock('@/state', () => ({
  useSettingsStore: (select: (state: object) => unknown) =>
    select({
      settings: { transcriptDisplay: mocks.transcriptDisplay, detectImagePathsOnPaste: true, wordPredictionEnabled: false },
      setTranscriptDisplay: mocks.setTranscriptDisplay
    })
}))
vi.mock('@/state/usage-store', () => {
  const state = { jokes: true, setJokes: vi.fn(), loadPrefs: vi.fn() }
  return { useUsageStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state }) }
})
vi.mock('@/components/SettingSwitchRow', async (importOriginal) => {
  const actual = await importOriginal<{ SettingSwitchRow: typeof SettingSwitchRowComponent }>()
  return {
    SettingSwitchRow: (props: Parameters<typeof SettingSwitchRowComponent>[0]) => {
      mocks.rows.push(props)
      return actual.SettingSwitchRow(props)
    }
  }
})

const EXPAND_ID = 'transcript-display-expand-answered-asks'

function render(transcriptDisplay: unknown): string {
  mocks.transcriptDisplay = transcriptDisplay
  mocks.rows.length = 0
  return renderToStaticMarkup(createElement(ChatDisplaySection))
}

const expandRow = () => mocks.rows.find((row) => row.id === EXPAND_ID)

describe('Settings > Chat > Expand answered questions (#1747)', () => {
  beforeEach(() => mocks.setTranscriptDisplay.mockClear())

  it('shows a labelled switch in the Transcript group', () => {
    const html = render(DEFAULT_TRANSCRIPT_DISPLAY)
    expect(expandRow()?.label).toBe('Expand answered questions')
    expect(html).toContain('Expand answered questions')
    expect(html).toMatch(new RegExp(`<button[^>]*role="switch"[^>]*id="${EXPAND_ID}"|<button[^>]*id="${EXPAND_ID}"[^>]*role="switch"`))
  })

  it('is on by default', () => {
    const html = render(DEFAULT_TRANSCRIPT_DISPLAY)
    expect(expandRow()?.checked).toBe(true)
    expect(html.match(new RegExp(`<button[^>]*id="${EXPAND_ID}"[^>]*>`))?.[0]).toContain('aria-checked="true"')
  })

  it('reads off when the stored setting is off', () => {
    const html = render({ ...DEFAULT_TRANSCRIPT_DISPLAY, expandAnsweredAsks: false })
    expect(expandRow()?.checked).toBe(false)
    expect(html.match(new RegExp(`<button[^>]*id="${EXPAND_ID}"[^>]*>`))?.[0]).toContain('aria-checked="false"')
  })

  it('writes expandAnsweredAsks, and only that key, when toggled', () => {
    render(DEFAULT_TRANSCRIPT_DISPLAY)
    expandRow()?.onCheckedChange(false)
    expect(mocks.setTranscriptDisplay).toHaveBeenCalledExactlyOnceWith('expandAnsweredAsks', false)
    mocks.setTranscriptDisplay.mockClear()
    expandRow()?.onCheckedChange(true)
    expect(mocks.setTranscriptDisplay).toHaveBeenCalledExactlyOnceWith('expandAnsweredAsks', true)
  })
})
