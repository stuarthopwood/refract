import { describe, it, expect } from 'vitest'
import { describeSaveStatus, SAVED_VISIBLE_MS } from './saveStatusView'

describe('describeSaveStatus', () => {
  it('says nothing when idle', () => {
    expect(describeSaveStatus('idle')).toBeNull()
  })

  it('shows Saving… as a polite loading status with a spinner', () => {
    expect(describeSaveStatus('saving')).toEqual({ text: 'Saving…', tone: 'loading', icon: 'spinner' })
  })

  it('shows Saved as a polite notice with a check', () => {
    expect(describeSaveStatus('saved')).toEqual({ text: 'Saved', tone: 'notice', icon: 'check' })
  })

  it('shows the error text as an error tone with an alert icon', () => {
    expect(describeSaveStatus('error', 'omp config set failed')).toEqual({ text: 'Could not save: omp config set failed', tone: 'error', icon: 'alert' })
  })

  it('still reports an error that carries no message', () => {
    expect(describeSaveStatus('error')?.text).toBe('Could not save')
  })
})

describe('SAVED_VISIBLE_MS', () => {
  it('keeps Saved visible for 3 seconds (FR-043)', () => {
    expect(SAVED_VISIBLE_MS).toBe(3000)
  })
})
