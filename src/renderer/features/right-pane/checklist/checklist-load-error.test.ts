import { describe, expect, it } from 'vitest'
import { loadErrorCopy } from './checklist-load-error'

describe('loadErrorCopy', () => {
  it('unsupported_format_says_update_and_is_not_retryable', () => {
    expect(loadErrorCopy('store-unsupported', false)).toEqual({
      message: 'This checklist was saved by a newer version of Refract. Update Refract to see it.',
      retryable: false
    })
  })

  it('other_codes_get_generic_retryable_copy_never_the_raw_code', () => {
    const copy = loadErrorCopy('store-failed', false)
    expect(copy.retryable).toBe(true)
    expect(copy.message).not.toContain('store-failed')
  })

  it('a_held_checklist_is_called_the_last_version', () => {
    expect(loadErrorCopy(null, true).message).toBe("Couldn't refresh the checklist. Showing the last version.")
  })
})
