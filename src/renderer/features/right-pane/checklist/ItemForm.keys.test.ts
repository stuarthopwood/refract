// The repo has no jsdom, so the form function is called directly with `useId` stubbed to read the key handler it wires.
import type * as ReactModule from 'react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ItemForm } from './ItemForm'

vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof ReactModule>()), useId: () => 'id' }))

describe('ItemForm keys', () => {
  it('escape_on_the_form_closes_it_from_any_control_inside', () => {
    const onClose = vi.fn()
    const form: ReactElement<{ onKeyDown: (event: object) => void }> = ItemForm({
      itemText: 'Write the spec',
      mode: 'ask',
      text: '',
      agentRunning: true,
      inFlight: false,
      onModeChange: () => {},
      onTextChange: () => {},
      onSend: () => {},
      onClose
    })
    expect(form.type).toBe('form')
    form.props.onKeyDown({ key: 'Escape', ctrlKey: false, metaKey: false, preventDefault: () => {}, stopPropagation: () => {} })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
