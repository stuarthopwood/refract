// Issue #137: the avatar dot, its accessible name and the profile menu's update item all derive from these helpers.
import { describe, expect, it } from 'vitest'
import type { UpdateState } from '../../shared/updates'
import { updateAccessibleSuffix, updateIndicator, updateMenuEntry } from './updateStatus'

const state = (patch: Partial<UpdateState>): UpdateState => ({ version: 1, phase: 'idle', ...patch })

describe('updateIndicator', () => {
  it('shows_an_accent_dot_while_an_update_is_available_downloading_or_downloaded', () => {
    for (const phase of ['available', 'downloading', 'downloaded'] as const) {
      expect(updateIndicator(state({ phase }))).toBe('pending')
    }
  })

  it('shows_a_red_dot_when_the_update_failed', () => {
    expect(updateIndicator(state({ phase: 'failed', lastError: 'boom' }))).toBe('failed')
  })

  it('shows_no_dot_when_idle_checking_unavailable_or_unknown', () => {
    expect(updateIndicator(null)).toBeNull()
    expect(updateIndicator(state({ phase: 'idle' }))).toBeNull()
    expect(updateIndicator(state({ phase: 'checking' }))).toBeNull()
    expect(updateIndicator(state({ phase: 'idle', unavailableReason: 'offline' }))).toBeNull()
  })
})

describe('updateAccessibleSuffix', () => {
  it('names_the_update_state_the_dot_shows', () => {
    expect(updateAccessibleSuffix(state({ phase: 'available' }))).toBe('update available')
    expect(updateAccessibleSuffix(state({ phase: 'downloading' }))).toBe('downloading update')
    expect(updateAccessibleSuffix(state({ phase: 'downloaded' }))).toBe('update ready to install')
    expect(updateAccessibleSuffix(state({ phase: 'failed' }))).toBe('update failed')
  })

  it('adds_nothing_when_there_is_no_dot', () => {
    expect(updateAccessibleSuffix(null)).toBeNull()
    expect(updateAccessibleSuffix(state({ phase: 'idle' }))).toBeNull()
  })
})

describe('updateMenuEntry', () => {
  it('offers_download_update_with_the_version_when_one_is_available', () => {
    expect(updateMenuEntry(state({ phase: 'available', availableVersion: '1.4.0' }))).toMatchObject({
      action: 'download',
      label: 'Download update',
      version: 'v1.4.0'
    })
  })

  it('offers_update_now_once_downloaded', () => {
    expect(updateMenuEntry(state({ phase: 'downloaded', availableVersion: '1.4.0' }))).toMatchObject({
      action: 'update-now',
      label: 'Restart to update',
      version: 'v1.4.0'
    })
  })

  it('ignores_a_choice_while_downloading_installing_or_checking', () => {
    for (const phase of ['downloading', 'installing', 'checking'] as const) {
      expect(updateMenuEntry(state({ phase })).action).toBe('busy')
    }
  })

  it('offers_check_again_with_the_failure_text_after_a_failure', () => {
    expect(updateMenuEntry(state({ phase: 'failed', lastError: 'checksum mismatch' }))).toMatchObject({
      action: 'check',
      detail: 'checksum mismatch'
    })
    expect(updateMenuEntry(state({ phase: 'failed' })).detail).toBe('Update failed for an unknown reason.')
  })

  it('explains_an_unavailable_check_in_plain_words_without_calling_it_a_failure', () => {
    expect(updateMenuEntry(state({ phase: 'idle', unavailableReason: 'offline' }))).toEqual({
      action: 'check',
      label: 'Check for updates',
      detail: 'Could not reach GitHub.'
    })
  })

  it('offers_a_plain_check_for_updates_when_nothing_is_known', () => {
    expect(updateMenuEntry(null)).toEqual({ action: 'check', label: 'Check for updates' })
  })
})
