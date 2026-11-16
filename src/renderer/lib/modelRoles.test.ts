import { describe, expect, it, vi } from 'vitest'
import { CHAT_ROLE_DESCRIPTORS } from '../features/settings/ModelRolesSection'
import { ROLE_LABEL } from './modelRoles'

// The shared state barrel touches `window` on import and the node test environment has none; hoisted so it runs first.
vi.hoisted(() => {
  const noop = () => {}
  vi.stubGlobal('window', { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) })
})

describe('task role label (#1879)', () => {
  it('reads "Task" in the picker and chip labels', () => {
    expect(ROLE_LABEL.task).toBe('Task')
  })

  it('reads "Task" in Settings, from the same descriptor the chip uses', () => {
    expect(CHAT_ROLE_DESCRIPTORS.find((entry) => entry.role === 'task')?.label).toBe('Task')
  })
})
