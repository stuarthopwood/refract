import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusDocumentTab } from './document-tab-focus'

type FakeButton = { focus: () => void }

function stubDocument(button: FakeButton | null, takesFocus: boolean) {
  const doc = {
    activeElement: null as FakeButton | null,
    getElementById: () => button
  }
  if (button) button.focus = () => void (doc.activeElement = takesFocus ? button : null)
  vi.stubGlobal('document', doc)
}

describe('focusDocumentTab', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is true when the strip button took focus', () => {
    stubDocument({ focus: () => undefined }, true)
    expect(focusDocumentTab('s1', 'file:a.ts')).toBe(true)
  })

  it('is false when the strip has no button for the tab', () => {
    stubDocument(null, true)
    expect(focusDocumentTab('s1', 'file:a.ts')).toBe(false)
  })

  it('is false when the button is present but focus did not land', () => {
    stubDocument({ focus: () => undefined }, false)
    expect(focusDocumentTab('s1', 'file:a.ts')).toBe(false)
  })
})
