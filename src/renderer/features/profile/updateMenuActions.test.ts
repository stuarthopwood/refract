// The profile menu's update item: which handler each action reaches, and what each toast branch says.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../../../shared/updates'
import { checkForUpdates, downloadUpdate, runUpdateMenuAction } from './updateMenuActions'

const toast = vi.hoisted(() => ({
  loading: vi.fn(() => 'toast-1'),
  dismiss: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn()
}))
const notify = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast }))
vi.mock('@/state', () => ({ notify }))

const handlers = () => ({ download: vi.fn(), updateNow: vi.fn(), check: vi.fn() })
const state = (patch: Partial<UpdateState>): UpdateState => ({ version: 1, phase: 'idle', ...patch })

function stubUpdates(updates: { install?: () => Promise<unknown>; check?: () => Promise<unknown> }): void {
  vi.stubGlobal('window', { refract: { updates } })
}

beforeEach(() => {
  for (const fn of Object.values(toast)) fn.mockClear()
  notify.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

describe('runUpdateMenuAction', () => {
  it('starts_the_download_for_the_download_action', () => {
    const h = handlers()
    expect(runUpdateMenuAction('download', h)).toBe(true)
    expect(h.download).toHaveBeenCalledOnce()
    expect(h.updateNow).not.toHaveBeenCalled()
    expect(h.check).not.toHaveBeenCalled()
  })

  it('asks_to_update_now_for_the_update_now_action', () => {
    const h = handlers()
    expect(runUpdateMenuAction('update-now', h)).toBe(true)
    expect(h.updateNow).toHaveBeenCalledOnce()
    expect(h.download).not.toHaveBeenCalled()
    expect(h.check).not.toHaveBeenCalled()
  })

  it('checks_again_for_the_check_action', () => {
    const h = handlers()
    expect(runUpdateMenuAction('check', h)).toBe(true)
    expect(h.check).toHaveBeenCalledOnce()
    expect(h.download).not.toHaveBeenCalled()
    expect(h.updateNow).not.toHaveBeenCalled()
  })

  it('ignores_a_busy_item_and_reports_it_so_the_menu_stays_open', () => {
    const h = handlers()
    expect(runUpdateMenuAction('busy', h)).toBe(false)
    expect(h.download).not.toHaveBeenCalled()
    expect(h.updateNow).not.toHaveBeenCalled()
    expect(h.check).not.toHaveBeenCalled()
  })
})

describe('downloadUpdate', () => {
  it('dismisses_the_loading_toast_when_the_install_starts', async () => {
    stubUpdates({ install: () => Promise.resolve({ ok: true }) })
    await downloadUpdate()
    expect(toast.dismiss).toHaveBeenCalledWith('toast-1')
    expect(notify).not.toHaveBeenCalled()
  })

  it('dismisses_the_loading_toast_and_reports_the_error_when_the_install_is_refused', async () => {
    const error = { message: 'No space' }
    stubUpdates({ install: () => Promise.resolve({ ok: false, error }) })
    await downloadUpdate()
    expect(toast.dismiss).toHaveBeenCalledWith('toast-1')
    expect(notify).toHaveBeenCalledWith(error)
  })

  it('turns_the_loading_toast_into_an_error_when_the_call_rejects', async () => {
    stubUpdates({ install: () => Promise.reject(new Error('ipc gone')) })
    await downloadUpdate()
    expect(toast.error).toHaveBeenCalledWith('Could not download the update.', { id: 'toast-1' })
  })
})

describe('checkForUpdates', () => {
  const check = (result: unknown) => {
    stubUpdates({ check: () => Promise.resolve(result) })
    return checkForUpdates()
  }

  it('shows_the_refusal_message_when_the_check_is_refused', async () => {
    await check({ ok: false, error: { message: 'Offline' } })
    expect(toast.error).toHaveBeenCalledWith('Offline', { id: 'toast-1' })
  })

  it('shows_the_last_error_when_the_check_ends_failed', async () => {
    await check({ ok: true, value: state({ phase: 'failed', lastError: 'Signature mismatch' }) })
    expect(toast.error).toHaveBeenCalledWith('Signature mismatch', { id: 'toast-1' })
  })

  it('falls_back_to_a_generic_failure_when_no_error_text_was_kept', async () => {
    await check({ ok: true, value: state({ phase: 'failed' }) })
    expect(toast.error).toHaveBeenCalledWith('Update failed for an unknown reason.', { id: 'toast-1' })
  })

  it('warns_with_the_reason_when_updates_are_unavailable', async () => {
    await check({ ok: true, value: state({ phase: 'idle', unavailableReason: 'offline' }) })
    expect(toast.warning).toHaveBeenCalledOnce()
  })

  it('says_it_is_up_to_date_when_idle_with_nothing_wrong', async () => {
    await check({ ok: true, value: state({ phase: 'idle' }) })
    expect(toast.info).toHaveBeenCalledWith('Refract is up to date.', { id: 'toast-1' })
  })

  it('points_at_the_menu_when_an_update_is_available', async () => {
    await check({ ok: true, value: state({ phase: 'available', availableVersion: '1.4.0' }) })
    expect(toast.info).toHaveBeenCalledWith('Refract v1.4.0 is available. Choose Download update in this menu.', { id: 'toast-1' })
  })

  it('turns_the_loading_toast_into_an_error_when_the_call_rejects', async () => {
    stubUpdates({ check: () => Promise.reject(new Error('ipc gone')) })
    await checkForUpdates()
    expect(toast.error).toHaveBeenCalledWith('Could not check for updates.', { id: 'toast-1' })
  })
})
