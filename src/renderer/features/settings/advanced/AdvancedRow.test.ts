// The repo has no jsdom, so rows render to a string (see `GhStackNotice.test.ts`).
import { createElement, Fragment } from 'react'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TokenGuardKeyInfo } from '../../../../shared/tokenGuard'
import type { KeySave } from '@/state/token-guard-store'
import { markupText } from '../markupText'
import { AdvancedRow } from './AdvancedRow'

// The real `@/state` wires stores to `window` at import time, which this node-environment suite lacks;
// only the per-model table reads it, and no row here renders that.
vi.mock('@/state', () => ({ useModelRolesStore: vi.fn() }))

const TOGGLE: TokenGuardKeyInfo = { key: 'snapcompact.toolResults', label: 'Compress tool results', kind: 'toggle', live: true, group: 'Image compression', description: 'Shrinks tool output.' }
const COUNT: TokenGuardKeyInfo = { key: 'grep.contextBefore', label: 'Lines before a match', kind: 'count', live: true, unit: 'lines', group: 'Tool output', description: 'Context above a match.' }

function row(info: TokenGuardKeyInfo, value: boolean | number, save?: KeySave): ReactElement {
  return createElement(AdvancedRow, {
    key: info.key,
    info,
    value,
    defaultValue: value,
    seedPercent: 50,
    defaultWindow: null,
    catalogLoading: false,
    save,
    onChange: async () => true,
    onReset: async () => {}
  })
}

const render = (...rows: ReactElement[]): string => renderToStaticMarkup(createElement(Fragment, null, ...rows))

/** The opening tag of the element with this id, so one control's `disabled` is not read off another's. */
function openingTag(html: string, id: string): string {
  return html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? ''
}

/** The text (icons stripped) inside each live region with this role, in document order. */
function liveTexts(html: string, role: 'status' | 'alert'): string[] {
  return [...html.matchAll(new RegExp(`<(\\w+)\\b[^>]*role="${role}"[^>]*>(.*?)</\\1>`, 'g'))].map((m) => markupText(m[2] ?? ''))
}

const isDisabled = (tag: string): boolean => /\bdisabled(=|\s|>)/.test(tag)

describe('AdvancedRow save state (#2002)', () => {
  it('disables only the row whose key is saving and leaves its sibling editable', () => {
    const html = render(row(TOGGLE, true, { state: 'saving', pendingValue: false }), row(COUNT, 3))
    expect(isDisabled(openingTag(html, 'advanced-snapcompact.toolResults'))).toBe(true)
    expect(isDisabled(openingTag(html, 'advanced-grep.contextBefore'))).toBe(false)
  })

  it('leaves the control editable when its key has no save entry', () => {
    expect(isDisabled(openingTag(render(row(TOGGLE, true)), 'advanced-snapcompact.toolResults'))).toBe(false)
  })

  it('shows the pending value while saving', () => {
    const html = render(row(TOGGLE, true, { state: 'saving', pendingValue: false }))
    expect(openingTag(html, 'advanced-snapcompact.toolResults')).toContain('aria-checked="false"')
  })

  it('keeps one status region whose text goes Saving… then Saved then empty', () => {
    const states: Array<KeySave | undefined> = [{ state: 'saving', pendingValue: false }, { state: 'saved' }, undefined]
    const texts = states.map((save) => liveTexts(render(row(TOGGLE, true, save)), 'status'))
    expect(texts).toEqual([['Saving…'], ['Saved'], ['']])
  })

  it('renders a failure as an alert beside the persistent status region and leaves the control editable', () => {
    const html = render(row(TOGGLE, true, { state: 'error', error: 'omp config set failed' }))
    expect(liveTexts(html, 'status')).toEqual([''])
    const alerts = liveTexts(html, 'alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('Could not save: omp config set failed')
    expect(isDisabled(openingTag(html, 'advanced-snapcompact.toolResults'))).toBe(false)
  })

  it('locks a number field while it saves and not its sibling', () => {
    const html = render(row(COUNT, 3, { state: 'saving', pendingValue: 5 }), row(TOGGLE, true))
    expect(isDisabled(openingTag(html, 'advanced-grep.contextBefore'))).toBe(true)
    expect(isDisabled(openingTag(html, 'advanced-snapcompact.toolResults'))).toBe(false)
  })
})
