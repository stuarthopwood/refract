import { describe, expect, it, vi } from 'vitest'
import { checklistBridge } from './checklist'

describe('checklistBridge', () => {
  it('item_message_sends_the_channel_and_args', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, value: null })
    const bridge = checklistBridge(request as never, vi.fn())

    await bridge.itemMessage('s1', 'ck1', 'i1', 7, 'value', 'blue')

    expect(request).toHaveBeenCalledWith('checklist.itemMessage', 's1', 'ck1', 'i1', 7, 'value', 'blue')
  })

  it('item_message_leaves_text_undefined_for_complete', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, value: null })
    const bridge = checklistBridge(request as never, vi.fn())

    await bridge.itemMessage('s1', 'ck1', 'i1', 7, 'complete')

    expect(request).toHaveBeenCalledWith('checklist.itemMessage', 's1', 'ck1', 'i1', 7, 'complete', undefined)
  })
})
