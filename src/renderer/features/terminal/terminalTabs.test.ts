import { describe, expect, it, vi } from 'vitest'
import { NAME_MAX_CHARS, OUTPUT_CAP_BYTES } from '../../../shared/terminalLimits'
import { buildAskMessage, capTail, quoteBlock, truncationNotice } from './terminalAgent'
import { closeTab, renamedValue, tabIndexForKey, tabMarker } from './terminalTabs'

// The sonner toast and the draft store are only reached by the click handlers; vitest hoists these mocks above the imports.
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/state/draft-store', () => ({ useDraftStore: { getState: () => ({ bySession: {}, setText: vi.fn() }) } }))

describe('terminal tab rules', () => {
  it('speaks_only_the_states_that_need_a_word', () => {
    expect(tabMarker({ kind: 'running' }).label).toBeNull()
    expect(tabMarker({ kind: 'ended', code: 3 })).toEqual({ label: 'ended with code 3', tone: 'ended' })
    expect(tabMarker({ kind: 'failed', message: 'x' }).tone).toBe('failed')
  })

  it('wraps_arrow_keys_and_jumps_on_home_and_end', () => {
    expect(tabIndexForKey('ArrowRight', 2, 3)).toBe(0)
    expect(tabIndexForKey('ArrowLeft', 0, 3)).toBe(2)
    expect(tabIndexForKey('Home', 2, 3)).toBe(0)
    expect(tabIndexForKey('End', 0, 3)).toBe(2)
    expect(tabIndexForKey('a', 0, 3)).toBeNull()
  })

  it('sends_a_rename_only_when_the_name_changed_and_cuts_it_to_the_limit', () => {
    expect(renamedValue('  ', 'Terminal 1')).toBeNull()
    expect(renamedValue('Terminal 1', 'Terminal 1')).toBeNull()
    expect(renamedValue(' build ', 'Terminal 1')).toBe('build')
    expect(renamedValue('x'.repeat(NAME_MAX_CHARS + 10), 'a')).toHaveLength(NAME_MAX_CHARS)
  })
})

describe('closing a tab', () => {
  const ok = <T,>(value: T) => ({ ok: true as const, value })

  it('closes_an_idle_tab_without_a_prompt', async () => {
    const close = vi.fn().mockResolvedValue(ok({ closed: true, needsConfirm: false }))
    expect(await closeTab({ close }, { id: 't1' }, false)).toEqual({ kind: 'closed' })
    expect(close).toHaveBeenCalledWith('t1', false)
  })

  it('asks_for_confirmation_when_a_job_is_running_and_force_closes_only_when_asked_again', async () => {
    const close = vi.fn().mockResolvedValueOnce(ok({ closed: false, needsConfirm: true })).mockResolvedValueOnce(ok({ closed: true, needsConfirm: false }))
    expect(await closeTab({ close }, { id: 't1' }, false)).toEqual({ kind: 'confirm' })
    expect(await closeTab({ close }, { id: 't1' }, true)).toEqual({ kind: 'closed' })
    expect(close).toHaveBeenLastCalledWith('t1', true)
  })

  it('reports_a_failed_close', async () => {
    const close = vi.fn().mockResolvedValue({ ok: false, error: { code: 'terminal-not-found', message: 'Gone' } })
    expect(await closeTab({ close }, { id: 't1' }, false)).toEqual({ kind: 'failed', message: 'Gone' })
  })
})

describe('terminal output for the agent', () => {
  it('quotes_every_line_so_it_reads_as_a_quotation', () => {
    expect(quoteBlock('a\r\n\r\nb\n')).toBe('> a\n>\n> b')
  })

  it('keeps_the_end_of_over_long_output_and_reports_the_total', () => {
    const text = `${'a'.repeat(OUTPUT_CAP_BYTES)}END`
    const capped = capTail(text, OUTPUT_CAP_BYTES)
    expect(capped.truncated).toBe(true)
    expect(capped.text.endsWith('END')).toBe(true)
    expect(capped.totalBytes).toBe(OUTPUT_CAP_BYTES + 3)
    expect(capTail('short', OUTPUT_CAP_BYTES).truncated).toBe(false)
  })

  it('puts_the_truncation_line_in_the_message_and_fences_around_backticks', () => {
    const message = buildAskMessage({ text: 'echo ```\n', truncated: true, totalBytes: 100000 })
    expect(message).toContain(truncationNotice(100000))
    expect(message).toContain('[Truncated: last 32 KiB of 98 KiB shown]')
    expect(message).toContain('````\necho ```\n````')
  })
})
