// Lets the user view and change OMP's `modelRoles` via `omp config` (OMP owns its config, never a
// direct file edit); `set` always writes the GLOBAL config. Pickers use `omp models --kind <kind>
// --json`, the one role-aware catalog source outside Phase A files. (#455)
// A role value may carry a `:level` suffix; picking a suffix-free selector keeps the existing one.
// Catalog status renders once per kind per group (not per role) and keeps the error mounted
// while retrying; a successful catalog retry moves focus to that kind's first role trigger.
import { useEffect, useRef, useState } from 'react'
import { Loader2Icon, OctagonXIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
// Imported from `@/lib/providerLabels`, not `@/lib/modelRoles`, to avoid an import cycle (see `ProviderSwitch.tsx`).
import { friendlyProviderLabel } from '@/lib/providerLabels'
import { useModelRolesStore } from '@/state'
import { CHAT_MODEL_ROLES, MODEL_KIND_ROLES, ROLE_CATALOG_KIND } from '../../../shared/model'
import type { CatalogKind, ModelRoleId } from '../../../shared/model'
import { defaultProvider, providersInCatalog } from './modelProviderFilter'
import { AdvisorModelRow } from './AdvisorModelRow'
import { ProviderSwitch } from './ProviderSwitch'
import { CATALOG_KIND_LABEL, RoleCatalogStatus } from './RoleCatalogStatus'
import { RoleRow } from './RoleRow'
import { SuspectWindowsNotice } from './SuspectWindowsNotice'

export interface RoleDescriptor {
  role: ModelRoleId
  label: string
  description: string
}

// Labels from `omp://models.md`; exported so the composer's role chip reuses the same names. (#741)
export const CHAT_ROLE_DESCRIPTORS: RoleDescriptor[] = [
  { role: 'default', label: 'Default', description: 'The active chat model, used when nothing else overrides it.' },
  { role: 'smol', label: 'Smol', description: 'A lightweight model for cheap, fast background work.' },
  { role: 'slow', label: 'Slow', description: 'A stronger model for work worth the extra time.' },
  { role: 'vision', label: 'Vision', description: 'Analyses images, such as a read screenshot.' },
  { role: 'plan', label: 'Plan', description: 'Used while plan mode is active.' },
  { role: 'commit', label: 'Commit', description: 'Writes commit messages.' },
  { role: 'tiny', label: 'Tiny', description: 'Lightweight background work such as session titles; falls back to Smol.' },
  { role: 'widget', label: 'Widget', description: 'Designs background job charts; uses Smol until set.' },
  { role: 'memory', label: 'Memory', description: 'Recall and memory work; falls back to Tiny.' },
  { role: 'task', label: 'Task', description: 'Subagents started by the task tool.' },
  { role: 'advisor', label: 'Advisor', description: "Reviews a Session's turns while the Advisor is on (/advisor on); falls back to Slow." }
]

const KIND_ROLE_DESCRIPTORS: RoleDescriptor[] = [
  { role: 'image', label: 'Image', description: 'Generates images.' },
  { role: 'web', label: 'Web', description: 'Web search and grounded chat.' },
  { role: 'speech', label: 'Speech', description: 'Text to speech.' },
  { role: 'dictation', label: 'Dictation', description: 'Speech to text.' },
  { role: 'judge', label: 'Judge', description: 'Judgment and evaluation requests.' }
]

const ALL_ROLE_DESCRIPTORS: RoleDescriptor[] = [...CHAT_ROLE_DESCRIPTORS, ...KIND_ROLE_DESCRIPTORS]

function firstRoleIdForKind(kind: CatalogKind): string | undefined {
  const descriptor = ALL_ROLE_DESCRIPTORS.find((entry) => ROLE_CATALOG_KIND[entry.role] === kind)
  return descriptor ? `model-role-${descriptor.role}` : undefined
}

// Fallback chains from `omp://models.md`, shown next to "Inherited"; exported so the composer's Model picker uses the same wording. (#564)
export const ROLE_FALLBACK_LABEL: Partial<Record<ModelRoleId, string>> = {
  smol: 'Default',
  slow: 'Default',
  tiny: 'Smol',
  memory: 'Tiny',
  widget: 'Smol',
  advisor: 'Slow'
}

// Display order; Advisor's row reads Refract's launch value.
const ROLE_GROUPS: ReadonlyArray<{ title: string; roles: readonly ModelRoleId[] }> = [
  { title: 'Main', roles: ['default', 'task', 'advisor', 'plan', 'slow'] },
  { title: 'Background', roles: ['smol', 'tiny', 'widget', 'memory', 'commit'] },
  { title: 'Media', roles: ['vision'] },
  { title: 'Model kinds', roles: ['image', 'web', 'speech', 'dictation', 'judge'] }
]

// Only the two links the probe confirmed (omp-probe.md) name a fallback; every other unset role
// is described by OMP picking one automatically.
function unsetLabelFor(role: ModelRoleId): string {
  return role === 'smol' || role === 'slow' ? 'Inherit Default' : 'The agent picks one automatically'
}

export function ModelRolesSection() {
  const roles = useModelRolesStore((state) => state.roles)
  const loaded = useModelRolesStore((state) => state.loaded)
  const loadError = useModelRolesStore((state) => state.loadError)
  const pendingRoles = useModelRolesStore((state) => state.pendingRoles)
  const saveErrors = useModelRolesStore((state) => state.saveErrors)
  const overrideNotes = useModelRolesStore((state) => state.overrideNotes)
  const catalogs = useModelRolesStore((state) => state.catalogs)
  const catalogErrors = useModelRolesStore((state) => state.catalogErrors)
  const load = useModelRolesStore((state) => state.load)
  const setRole = useModelRolesStore((state) => state.setRole)
  const loadCatalog = useModelRolesStore((state) => state.loadCatalog)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const retryLoadRef = useRef<HTMLButtonElement>(null)
  const wasLoadErrorRef = useRef(false)
  const [retryingLoad, setRetryingLoad] = useState(false)
  const [retryingKinds, setRetryingKinds] = useState<ReadonlySet<CatalogKind>>(new Set())
  // Lifted here to filter every chat role's dropdown; initialised once so later updates never override the user's pick. (#1069)
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const providerInitializedRef = useRef(false)
  // Polite for routine saves, assertive for failures, so screen readers hear both.
  const [polite, announcePolite] = useClearedAnnouncement()
  const [assertive, announceAssertive] = useClearedAnnouncement()

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  useEffect(() => {
    void load()
    const kinds = new Set([...CHAT_MODEL_ROLES, ...MODEL_KIND_ROLES].map((role) => ROLE_CATALOG_KIND[role]))
    for (const kind of kinds) {
      void loadCatalog(kind)
    }
    // Intentionally empty: loads once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (providerInitializedRef.current) return
    const chatCatalog = catalogs.chat
    if (!loaded || !chatCatalog) return
    const initial = defaultProvider(roles.default, chatCatalog)
    if (initial === null) return // catalog loaded but empty: nothing to select yet
    setSelectedProvider(initial)
    providerInitializedRef.current = true
  }, [loaded, catalogs.chat, roles.default])

  // Focus Retry when a load failure first appears, and the heading when a retry succeeds (Retry unmounted).
  useEffect(() => {
    if (loadError && !wasLoadErrorRef.current) {
      retryLoadRef.current?.focus()
    } else if (!loadError && wasLoadErrorRef.current) {
      headingRef.current?.focus()
    }
    wasLoadErrorRef.current = loadError !== null
  }, [loadError])

  async function handleRoleChange(role: ModelRoleId, label: string, value: string | null, successAnnouncement?: string): Promise<void> {
    const result = await setRole(role, value)
    if (result.ok) {
      // A model whose reasoning support lacks the carried-over level writes a bare selector (see `renderRole`); the caller's announcement says so. (#1114)
      announcePolite(successAnnouncement ?? (value === null ? `${label} cleared` : `${label} saved`))
    } else {
      announceAssertive(`Could not save ${label}: ${result.message}`)
    }
  }

  async function handleRetryLoad(): Promise<void> {
    // `aria-disabled` doesn't block activation; guard against an overlapping `omp config get`.
    if (retryingLoad) return
    setRetryingLoad(true)
    // A changed accessible name isn't reliably re-announced on a focused element, so announce explicitly.
    announcePolite('Retrying model roles')
    await load({ keepError: true })
    setRetryingLoad(false)
    const state = useModelRolesStore.getState()
    if (state.loadError) {
      // Clear the stale "Retrying" status so it isn't read after the failure message.
      announcePolite('')
      announceAssertive('Could not read model roles')
      retryLoadRef.current?.focus()
    } else {
      announcePolite('Model roles loaded')
    }
  }

  async function handleCatalogRetry(kind: CatalogKind): Promise<void> {
    if (retryingKinds.has(kind)) return
    const kindLabel = CATALOG_KIND_LABEL[kind]
    // Recorded before the retry: Retry unmounts on success, so only now can we tell whether it held focus.
    const hadFocus = document.activeElement?.id === `model-role-catalog-retry-${kind}`
    setRetryingKinds((prev) => new Set(prev).add(kind))
    announcePolite(`Retrying ${kindLabel} models`)
    await loadCatalog(kind, true)
    setRetryingKinds((prev) => {
      const next = new Set(prev)
      next.delete(kind)
      return next
    })
    const state = useModelRolesStore.getState()
    if (state.catalogErrors[kind]) {
      announcePolite('')
      announceAssertive(`Could not load ${kindLabel} models: ${state.catalogErrors[kind]}`)
    } else {
      announcePolite(`Loaded ${kindLabel} models`)
      if (hadFocus) {
        const targetId = firstRoleIdForKind(kind)
        const target = (targetId ? document.getElementById(targetId) : null) ?? headingRef.current
        target?.focus()
      }
    }
  }

  /** Loading/error status of one catalog kind, rendered once per kind within a group. */
  function renderCatalogStatus(kind: CatalogKind) {
    return (
      <RoleCatalogStatus
        key={kind}
        kind={kind}
        catalog={catalogs[kind]}
        error={catalogErrors[kind]}
        isRetrying={retryingKinds.has(kind)}
        onRetry={(retryKind) => void handleCatalogRetry(retryKind)}
      />
    )
  }

  function renderRole(descriptor: RoleDescriptor) {
    const { role, label, description } = descriptor
    const kind = ROLE_CATALOG_KIND[role]
    const common = {
      role,
      label,
      description,
      roles,
      catalog: catalogs[kind],
      catalogError: catalogErrors[kind],
      selectedProvider,
      announcePolite
    }
    if (role === 'advisor') {
      return (
        <AdvisorModelRow
          key={role}
          description="Reviews a Session's turns while the Advisor is on (/advisor on). Refract sets this when it starts a Session, so a change applies to new Sessions."
          roles={roles}
          catalog={common.catalog}
          catalogError={common.catalogError}
          selectedProvider={selectedProvider}
          announcePolite={announcePolite}
          announceAssertive={announceAssertive}
        />
      )
    }
    return (
      <RoleRow
        key={role}
        {...common}
        value={roles[role]}
        isPending={pendingRoles.has(role)}
        saveError={saveErrors[role]}
        overrideNote={overrideNotes[role]}
        unsetLabel={unsetLabelFor(role)}
        onCommit={(value, announcement) => void handleRoleChange(role, label, value, announcement)}
        onBusy={() => announcePolite(`${label} is still saving`)}
      />
    )
  }

  function renderGroup(group: (typeof ROLE_GROUPS)[number]) {
    const descriptors = group.roles.flatMap((role) => ALL_ROLE_DESCRIPTORS.filter((entry) => entry.role === role))
    const kinds = [...new Set(descriptors.map((descriptor) => ROLE_CATALOG_KIND[descriptor.role]))]
    return (
      <SettingsGroup key={group.title} title={group.title} iconSlot>
        {kinds.map(renderCatalogStatus)}
        {descriptors.map(renderRole)}
      </SettingsGroup>
    )
  }

  return (
    <SettingsPage
      title="Models"
      width="wide"
      headingRef={headingRef}
      intro="Choose which model the agent uses for each role. Changes save immediately to the agent's global configuration and apply to new sessions, unless a project's own .omp config overrides a role."
    >      <div aria-live="polite" className="sr-only">
        {polite}
      </div>
      <div aria-live="assertive" className="sr-only">
        {assertive}
      </div>
      {!loaded ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon aria-hidden className="size-4 animate-spin" />
          Loading model roles…
        </p>
      ) : loadError ? (
        <Alert variant="destructive">
          <OctagonXIcon aria-hidden />
          <AlertTitle>Could not read model roles</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
          <div className="col-start-2 mt-2">
            <Button ref={retryLoadRef} variant="ghost" size="sm" className="aria-disabled:opacity-50" aria-disabled={retryingLoad || undefined} onClick={() => void handleRetryLoad()}>
              {retryingLoad ? 'Retrying…' : 'Retry'}
            </Button>
          </div>
        </Alert>
      ) : (
        <>
          <SuspectWindowsNotice catalog={catalogs.chat} />
          <ProviderSwitch
            providers={providersInCatalog(catalogs.chat)}
            selected={selectedProvider}
            onSelect={(provider) => {
              setSelectedProvider(provider)
              // The switch's own change is announced, like any other filter change in this app.
              announcePolite(`Showing ${friendlyProviderLabel(provider)} models`)
            }}
          />
          {ROLE_GROUPS.map(renderGroup)}
        </>
      )}
    </SettingsPage>
  )
}
