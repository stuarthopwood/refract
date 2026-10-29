// Spec 035 T9: the Advisor model row in Settings > Models. Unlike the other roles it reads and
// writes the value Refract itself launches `omp` with (`modelRoles.advisor` in the token guard
// store), never OMP's global config, so a change applies to Sessions started afterwards.
import { useEffect, useState } from 'react'
import { useTokenGuardStore } from '@/state/token-guard-store'
import type { ModelCatalogEntry } from '../../../shared/model'
import type { RoleValues } from './modelRoleCurrent'
import { RoleRow } from './RoleRow'

const ADVISOR_KEY = 'modelRoles.advisor'

interface AdvisorModelRowProps {
  description: string
  roles: RoleValues
  catalog: ModelCatalogEntry[] | undefined
  catalogError: string | undefined
  selectedProvider: string | null
  announcePolite(message: string): void
  announceAssertive(message: string): void
}

export function AdvisorModelRow({ description, roles, catalog, catalogError, selectedProvider, announcePolite, announceAssertive }: AdvisorModelRowProps) {
  const values = useTokenGuardStore((state) => state.values)
  const defaults = useTokenGuardStore((state) => state.defaults)
  const loaded = useTokenGuardStore((state) => state.loaded)
  const load = useTokenGuardStore((state) => state.load)
  const set = useTokenGuardStore((state) => state.set)
  const reset = useTokenGuardStore((state) => state.reset)
  const [pending, setPending] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>()

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const stored = values[ADVISOR_KEY] ?? defaults[ADVISOR_KEY]
  const value = typeof stored === 'string' ? stored : undefined

  async function commit(next: string | null, announcement?: string): Promise<void> {
    setPending(true)
    setSaveError(undefined)
    let ok = true
    if (next === null) {
      await reset(ADVISOR_KEY)
      ok = !useTokenGuardStore.getState().error
    } else {
      ok = await set(ADVISOR_KEY, next)
    }
    setPending(false)
    if (ok) {
      announcePolite(announcement ?? (next === null ? 'Advisor reset to the Refract default' : 'Advisor saved; applies to new Sessions'))
    } else {
      const message = useTokenGuardStore.getState().error ?? 'unknown error'
      setSaveError(message)
      announceAssertive(`Could not save Advisor: ${message}`)
    }
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
      isPending={pending || !loaded}
      saveError={saveError}
      selectedProvider={selectedProvider}
      unsetLabel="Refract's default"
      onCommit={(next, announcement) => void commit(next, announcement)}
      onBusy={() => announcePolite('Advisor is still saving')}
      announcePolite={announcePolite}
    />
  )
}
