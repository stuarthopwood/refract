// #1848: the issue pane shows a skeleton until the first load settles, the retry view only after a failure.
import { describe, expect, it } from 'vitest'
import { issueDetailGate } from './issueDetailGate'

describe('issueDetailGate', () => {
  it('shows_the_skeleton_while_nothing_has_loaded_and_nothing_failed', () => {
    expect(issueDetailGate(false, false)).toBe('skeleton')
  })

  it('shows_the_retry_view_when_the_first_load_failed', () => {
    expect(issueDetailGate(false, true)).toBe('retry')
  })

  it('keeps_the_loaded_content_even_if_a_later_refresh_failed', () => {
    expect(issueDetailGate(true, true)).toBe('content')
    expect(issueDetailGate(true, false)).toBe('content')
  })
})
