// The repo has no jsdom, so the row renders to a string (see `GhStackNotice.test.ts`).
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ModelCatalogEntry, ModelRoleId } from '../../../shared/model'
import { markupText } from './markupText'
import { RoleRow } from './RoleRow'
import type { RoleRowProps } from './RoleRow'

const seed = vi.hoisted(() => ({ open: false }))
// `forceOpen` seeds the row's `changing` state (its first boolean `useState`), since a static render cannot click Change.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useState: ((initial: unknown) => {
      if (seed.open && typeof initial === 'boolean') {
        seed.open = false
        return actual.useState(true)
      }
      return actual.useState(initial as never)
    }) as typeof actual.useState
  }
})

const ENTRY: ModelCatalogEntry = { provider: 'anthropic', id: 'opus', selector: 'anthropic/opus', name: 'Opus', reasoning: true, thinking: ['low', 'high'] }

function render(role: ModelRoleId, overrides: Partial<RoleRowProps>, forceOpen: boolean): string {
  seed.open = forceOpen
  try {
    return renderToStaticMarkup(
      React.createElement(RoleRow, {
        role,
        label: 'Role',
        description: 'What the role does.',
        value: 'anthropic/opus',
        roles: { [role]: 'anthropic/opus' },
        catalog: [ENTRY],
        catalogError: undefined,
        isPending: false,
        saveState: 'idle',
        selectedProvider: 'anthropic',
        unsetLabel: 'Inherit',
        onCommit: () => {},
        onBusy: () => {},
        announcePolite: () => {},
        ...overrides
      })
    )
  } finally {
    seed.open = false
  }
}

/** The text (icons stripped) of each save-status region, in document order. */
function statusTexts(html: string): string[] {
  return [...html.matchAll(/<div role="status"[^>]*>(.*?)<\/div>/g)].map((m) => markupText(m[1] ?? ''))
}

describe('RoleRow save status (#2002)', () => {
  it('shows Saving… once, beside Change, when the picker is closed', () => {
    expect(statusTexts(render('default', { isPending: true, saveState: 'saving' }, false))).toEqual(['Saving…'])
  })

  // The radios own the status while open; a second region would announce the same save twice.
  it('shows exactly one status region saying Saving… when a chat role has its picker open', () => {
    const html = render('default', { isPending: true, saveState: 'saving' }, true)
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('role="radiogroup"')
    expect(statusTexts(html)).toEqual(['Saving…'])
  })

  it('keeps the Change-row status for a model-kind role with its picker open, as it has no radios', () => {
    const html = render('image', { isPending: true, saveState: 'saving' }, true)
    expect(html).toContain('aria-expanded="true"')
    expect(html).not.toContain('role="radiogroup"')
    expect(statusTexts(html)).toEqual(['Saving…'])
  })

  it('shows an idle empty region and no alert when nothing is saving', () => {
    const html = render('default', {}, true)
    expect(statusTexts(html)).toEqual([''])
    expect(html).not.toContain('role="alert"')
  })

  // The error's own SaveStatus mounts an (empty) status region beside the Change-row one; the text is only in the alert.
  it('renders a save error as a single alert and leaves every status region empty', () => {
    const html = render('default', { saveError: 'omp config set failed' }, false)
    expect(statusTexts(html).every((text) => text === '')).toBe(true)
    expect(html.match(/role="alert"/g)).toHaveLength(1)
    expect(html).toContain('Could not save: omp config set failed')
  })
})
