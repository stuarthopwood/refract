// Spec 036 T9: the Advisor model row in Settings > Models. Unlike the other roles it reads and
// writes the value Refract itself launches `omp` with (`modelRoles.advisor` in the token guard
// store), never OMP's global config, so a change applies to Sessions started afterwards.
import { useEffect, useState } from 'react'
import { useTokenGuardStore } from '@/state/token-guard-store'
import type { ModelCatalogEntry } from '../../../shared/model'
import { describeAdvisorRoster } from '../../../shared/ipc-advisor-roster'
import type { AdvisorRoster } from '../../../shared/ipc-advisor-roster'
import type { RoleValues } from './modelRoleCurrent'
import { RoleRow } from './RoleRow'
import { advisorSaveAnnouncement, deriveRowSave } from './advisorRowSave'

const ADVISOR_KEY = 'modelRoles.advisor'

interface AdvisorModelRowProps {
  description: string
  roles: RoleValues
  catalog: ModelCatalogEntry[] | undefined
  catalogError: string | undefined
  selectedProvider: string | null
  announcePolite(message: string): void
}

export function AdvisorModelRow({ description, roles, catalog, catalogError, selectedProvider, announcePolite }: AdvisorModelRowProps) {
  const values = useTokenGuardStore((state) => state.values)
  const defaults = useTokenGuardStore((state) => state.defaults)
  const loaded = useTokenGuardStore((state) => state.loaded)
  const load = useTokenGuardStore((state) => state.load)
  const set = useTokenGuardStore((state) => state.set)
  const reset = useTokenGuardStore((state) => state.reset)
  const save = useTokenGuardStore((state) => state.saves[ADVISOR_KEY])
  const [roster, setRoster] = useState<AdvisorRoster | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.refract.advisorRoster.detect().then((result) => {
      if (!cancelled) setRoster(result.ok ? result.value : null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  // While the write is in flight (or waiting on the migration) the row shows the value being saved.
  const rowSave = deriveRowSave(loaded, save)
  const stored = rowSave.state === 'saving' ? rowSave.pendingValue : (values[ADVISOR_KEY] ?? defaults[ADVISOR_KEY])
  const value = typeof stored === 'string' ? stored : undefined

  async function commit(next: string | null, announcement?: string): Promise<void> {
    let rejected = false
    try {
      if (next === null) await reset(ADVISOR_KEY)
      else await set(ADVISOR_KEY, next)
    } catch {
      // The store already recorded the failure on the row; letting it escape would be an unhandled rejection from a fire-and-forget click.
      rejected = true
    }
    // A failure reaches the user through the row's own alert, so only a success is announced here.
    const message = advisorSaveAnnouncement(rejected, useTokenGuardStore.getState().saves[ADVISOR_KEY], next, announcement)
    if (message) announcePolite(message)
  }

  return (
    <RoleRow
      role="advisor"
      label="Advisor"
      description={description}
      value={value}
      roles={roles}
      catalog={catalog}
      catalogError={catalogError}
      // Not yet loaded disables the row without claiming a save; only the user's own write says Saving….
      isPending={rowSave.disabled}
      saveState={rowSave.state === 'error' ? 'idle' : rowSave.state}
      saveError={rowSave.error}
      warning={roster ? `${describeAdvisorRoster(roster)}. File: ${roster.path}` : undefined}
      selectedProvider={selectedProvider}
      unsetLabel="Refract's default"
      onCommit={(next, announcement) => void commit(next, announcement)}
      onBusy={() => announcePolite('Advisor is still saving')}
      announcePolite={announcePolite}
    />
  )
}
