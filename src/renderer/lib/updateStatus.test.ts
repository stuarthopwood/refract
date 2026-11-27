// Issue #137: the avatar dot, its accessible name and the profile menu's update item all derive from these helpers.
import { describe, expect, it } from 'vitest'
import type { UpdateState } from '../../shared/updates'
import { profileUpdateSummary, updateAccessibleSuffix, updateAnnouncement, updateIndicator, updateMenuEntry } from './updateStatus'

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
      icon: 'refresh',
      label: 'Check for updates',
      detail: 'Could not reach GitHub.'
    })
  })

  it('offers_a_plain_check_for_updates_when_nothing_is_known', () => {
    expect(updateMenuEntry(null)).toEqual({ action: 'check', icon: 'refresh', label: 'Check for updates' })
  })

  it('picks_the_glyph_from_the_phase_in_one_place', () => {
    expect(updateMenuEntry(state({ phase: 'available' })).icon).toBe('download')
    expect(updateMenuEntry(state({ phase: 'failed' })).icon).toBe('warning')
    expect(updateMenuEntry(state({ phase: 'downloaded' })).icon).toBe('refresh')
    for (const phase of ['downloading', 'installing', 'checking'] as const) {
      expect(updateMenuEntry(state({ phase })).icon).toBe('busy')
    }
  })
})

describe('profileUpdateSummary', () => {
  it('gives_an_accent_badge_and_the_matching_suffix_for_each_pending_phase', () => {
    const expected = { available: 'update available', downloading: 'downloading update', downloaded: 'update ready to install' } as const
    for (const phase of ['available', 'downloading', 'downloaded'] as const) {
      expect(profileUpdateSummary('Ada, signed in to GitHub', state({ phase }))).toEqual({
        badge: 'accent',
        label: `Ada, signed in to GitHub, ${expected[phase]}`
      })
    }
  })

  it('gives_a_danger_badge_and_joins_the_name_with_update_failed_after_a_failure', () => {
    expect(profileUpdateSummary('Ada', state({ phase: 'failed', lastError: 'boom' }))).toEqual({ badge: 'danger', label: 'Ada, update failed' })
  })

  it('leaves_the_name_and_badge_alone_when_idle_checking_unavailable_or_unknown', () => {
    for (const s of [null, state({ phase: 'idle' }), state({ phase: 'checking' }), state({ phase: 'idle', unavailableReason: 'offline' })]) {
      expect(profileUpdateSummary('Ada', s)).toEqual({ badge: undefined, label: 'Ada' })
    }
  })
})

describe('updateAnnouncement', () => {
  it('speaks_the_new_menu_label_for_every_non_idle_phase', () => {
    expect(updateAnnouncement(state({ phase: 'downloading' }))).toBe('Downloading update…')
    expect(updateAnnouncement(state({ phase: 'downloaded' }))).toBe('Restart to update')
    expect(updateAnnouncement(state({ phase: 'failed' }))).toBe('Update failed. Check again')
  })

  it('stays_silent_when_idle_or_unknown', () => {
    expect(updateAnnouncement(null)).toBeNull()
    expect(updateAnnouncement(state({ phase: 'idle' }))).toBeNull()
  })
})
