import { describe, expect, it } from 'vitest'
import { advisorSaveAnnouncement, deriveRowSave } from './advisorRowSave'

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

describe('advisorSaveAnnouncement', () => {
  // #2002: the failed row already renders an alert, so a second (assertive) announcement would read the failure twice.
  it('stays silent when the save call rejected, whatever the store recorded', () => {
    expect(advisorSaveAnnouncement(true, { state: 'error', error: 'omp is unavailable' }, 'anthropic/claude-opus')).toBeNull()
    expect(advisorSaveAnnouncement(true, undefined, null)).toBeNull()
  })

  it('stays silent when the store recorded an error for a call that resolved', () => {
    expect(advisorSaveAnnouncement(false, { state: 'error', error: 'omp config set failed' }, 'anthropic/claude-opus')).toBeNull()
  })

  it('announces a saved model for new Sessions', () => {
    expect(advisorSaveAnnouncement(false, { state: 'saved' }, 'anthropic/claude-opus')).toBe('Advisor saved; applies to new Sessions')
  })

  it('announces a reset to the Refract default', () => {
    expect(advisorSaveAnnouncement(false, { state: 'saved' }, null)).toBe('Advisor reset to the Refract default')
  })

  it('prefers the caller-supplied announcement on success', () => {
    expect(advisorSaveAnnouncement(false, { state: 'saved' }, 'anthropic/claude-opus', 'Advisor set to Opus')).toBe('Advisor set to Opus')
  })

  it('treats a settled save with no entry (cleared after the Saved flash) as a success', () => {
    expect(advisorSaveAnnouncement(false, undefined, 'anthropic/claude-opus')).toBe('Advisor saved; applies to new Sessions')
  })
})
