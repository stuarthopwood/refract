// The repo has no DOM, so the root is a stand-in that answers querySelector from a table keyed by selector.
import { describe, expect, test, vi } from 'vitest'
import { fieldSelectors, focusField } from './askFormFocusTarget'

const fakeRoot = (found: Record<string, HTMLElement | undefined>): Pick<ParentNode, 'querySelector'> => ({
  querySelector: ((selector: string) => found[selector] ?? null) as ParentNode['querySelector']
})

const focusable = (): HTMLElement => ({ focus: vi.fn() }) as unknown as HTMLElement

describe('fieldSelectors', () => {
  test('Given a field id, Then the control selector skips disabled controls and includes sliders', () => {
    const { control, container } = fieldSelectors('ask-form-1-2')
    expect(container).toBe('[data-ask-field="ask-form-1-2"]')
    expect(control.startsWith(`${container} `)).toBe(true)
    expect(control).toContain('[role="slider"]')
    expect(control).toContain(':not(:disabled)')
    expect(control).toContain(':not([aria-disabled="true"])')
    expect(control).toContain(':not([data-disabled])')
  })
})

describe('focusField', () => {
  test('Given a usable control, When Submit is blocked, Then it takes focus', () => {
    const control = focusable()
    const container = focusable()
    const selectors = fieldSelectors('f')
    const taken = focusField(fakeRoot({ [selectors.control]: control, [selectors.container]: container }), 'f')
    expect(taken).toBe(control)
    expect(control.focus).toHaveBeenCalledTimes(1)
    expect(container.focus).not.toHaveBeenCalled()
  })

  test('Given every control is disabled, When Submit is blocked, Then the field container takes focus', () => {
    const container = focusable()
    const taken = focusField(fakeRoot({ [fieldSelectors('f').container]: container }), 'f')
    expect(taken).toBe(container)
    expect(container.focus).toHaveBeenCalledTimes(1)
  })

  test('Given no card or no such field, Then nothing is focused', () => {
    expect(focusField(null, 'f')).toBeNull()
    expect(focusField(fakeRoot({}), 'f')).toBeNull()
  })
})
