import { describe, expect, it } from 'vitest'
import { deriveRowSave } from './advisorRowSave'

describe('deriveRowSave', () => {
  // #2002: before the store loads nothing is being written, so the row is locked but must not claim Saving.
  it('locks the row without reporting Saving while the store has not loaded', () => {
    expect(deriveRowSave(false, undefined)).toEqual({ disabled: true, state: 'idle' })
  })

  it('leaves the row editable and idle once loaded with no write for the key', () => {
    expect(deriveRowSave(true, undefined)).toEqual({ disabled: false, state: 'idle' })
  })

  it.each([true, false])('disables the row and shows the pending value while its own write is in flight (loaded=%s)', (loaded) => {
    expect(deriveRowSave(loaded, { state: 'saving', pendingValue: 'anthropic/claude-opus' })).toEqual({
      disabled: true,
      state: 'saving',
      pendingValue: 'anthropic/claude-opus'
    })
  })

  it('keeps a pending value that is falsy rather than dropping it', () => {
    expect(deriveRowSave(true, { state: 'saving', pendingValue: '' })).toEqual({ disabled: true, state: 'saving', pendingValue: '' })
  })

  it('shows Saved with the row editable after a loaded write finishes', () => {
    expect(deriveRowSave(true, { state: 'saved' })).toEqual({ disabled: false, state: 'saved' })
  })

  it('shows the write error with the row editable so the user can retry', () => {
    expect(deriveRowSave(true, { state: 'error', error: 'omp config set failed' })).toEqual({ disabled: false, state: 'error', error: 'omp config set failed' })
  })

  it('stays locked for a settled save entry until the store has loaded', () => {
    expect(deriveRowSave(false, { state: 'saved' }).disabled).toBe(true)
    expect(deriveRowSave(false, { state: 'error', error: 'x' }).disabled).toBe(true)
  })
})
