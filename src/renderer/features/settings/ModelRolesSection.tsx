// Issue #455: lets the user see and change OMP's model-role assignments (`modelRoles` in OMP's
// own global config.yml) without hand-editing YAML. Reads/writes go through `omp config`
// (`src/main/omp/config.ts`), never a file edit Refract does itself (constitution Principle I:
// OMP owns its own config) -- `omp config set modelRoles` always writes the GLOBAL config (never
// a project override; confirmed live even with `modelRoleStorage: project` set, FINDINGS item 48/
// `docs/spike/model-roles-probe.mjs`), which answers the issue's own "which scope" open question
// directly. The model picker per role is populated from `omp models --kind <kind> --json` (a
// read-only catalog listing, independent of any live RPC session) rather than the RPC
// `get_available_models` surface the issue originally suggested: FINDINGS item 21 found that
// surface carries no role field at all, and the RPC session itself lives in Phase A files
// (`OmpProcess.ts`/`SessionAgent.ts`) this story does not touch -- the catalog listing is the one
// role-aware, non-Phase-A source available.
//
// Thinking-suffix handling: a role value may carry a trailing `:level` (e.g.
// `anthropic/claude-sonnet-4-5:high` -- confirmed the live default on this machine's real
// profile, every chat role carries one). Picking a fresh catalog selector (always suffix-free)
// now carries over the role's EXISTING suffix rather than silently dropping it
// (`splitThinkingSuffix`, quality-gate remediation, test-reviewer MEDIUM).
//
// Catalog status (loading/error/Retry) is rendered ONCE per distinct catalog kind actually used
// in a group, not once per role (quality-gate remediation, code-reviewer/accessibility-auditor
// MEDIUM: ten chat roles all share the `chat` kind, so the old per-role rendering produced ten
// duplicate ids and ten redundant "Try again" buttons). Both the catalog retry and the
// whole-section load retry keep the existing error and its button mounted throughout
// (`aria-disabled` plus "Retrying…" while in flight) rather than replacing it with a bare loading
// line -- the whole-section retry does this by calling `load({ keepError: true })` (quality-gate
// remediation, gate cycle 3 HIGH: the store used to reset to the loading state up front on EVERY
// call, which unmounted the Alert the instant a retry started and made its in-flight state
// unreachable; see `model-roles-store.ts`'s own `load` comment). `aria-disabled` alone does not
// stop activation, so both retry handlers also guard against a second click starting an
// overlapping request (accessibility-auditor/security-auditor MEDIUM/LOW). When a catalog retry
// SUCCEEDS, focus moves to the first role trigger of that kind -- or the heading if none is found
// -- rather than being left on the Retry button that just unmounted (accessibility-auditor
// MEDIUM); the whole-section retry's success case already moves focus to the heading via the
// `loadError` effect below. Catalog error text and the Retry button's `aria-label` both name
// which kind failed, using a human label (`CATALOG_KIND_LABEL`, accessibility-auditor LOW: raw
// `CatalogKind` ids like "tts"/"stt" are spelled out letter by letter by a screen reader and
// don't match the nearby role labels) -- the model-kind roles group can show several of these
// blocks at once. The Retry button's `aria-label` also follows the in-flight state
// (accessibility-auditor MEDIUM, gate cycle 4: a fixed label never exposed "Retrying…" to
// anything but sighted users, since an `aria-label` replaces the element's own text content as
// its accessible name).
import { useEffect, useRef, useState } from 'react'
import { Loader2Icon, OctagonXIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
// `@/lib/providerLabels`, never `@/lib/modelRoles` -- see `ProviderSwitch.tsx`'s own import
// comment for why (that file imports this one's `CHAT_ROLE_DESCRIPTORS` at its module top level).
import { friendlyProviderLabel } from '@/lib/providerLabels'
import { useModelRolesStore } from '@/state'
import { CHAT_MODEL_ROLES, MODEL_KIND_ROLES, ROLE_CATALOG_KIND } from '../../../shared/model'
import type { CatalogKind, ModelRoleId } from '../../../shared/model'
import { defaultProvider, providersInCatalog } from './modelProviderFilter'
import { AdvisorModelRow } from './AdvisorModelRow'
import { ProviderSwitch } from './ProviderSwitch'
import { CATALOG_KIND_LABEL, RoleCatalogStatus } from './RoleCatalogStatus'
import { RoleRow } from './RoleRow'

export interface RoleDescriptor {
  role: ModelRoleId
  label: string
  description: string
}

// Labels/descriptions from `omp://models.md` ("Role aliases and settings"), sentence case per the
// design rules. Exported (#741): the composer's role chip (`lib/modelRoles.ts`) reuses these
// SAME labels/descriptions for its own text and tooltip, so Settings and the chip can never
// drift onto two different names for the same role.
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

// Quality-gate remediation (accessibility-auditor MEDIUM): when a catalog retry succeeds, focus
// moves to the first role trigger that actually queries the kind which just finished loading,
// rather than being left on the now-unmounted Retry button (or silently falling through to
// `<body>`).
const ALL_ROLE_DESCRIPTORS: RoleDescriptor[] = [...CHAT_ROLE_DESCRIPTORS, ...KIND_ROLE_DESCRIPTORS]

function firstRoleIdForKind(kind: CatalogKind): string | undefined {
  const descriptor = ALL_ROLE_DESCRIPTORS.find((entry) => ROLE_CATALOG_KIND[entry.role] === kind)
  return descriptor ? `model-role-${descriptor.role}` : undefined
}

// Documented fallback chains (`omp://models.md`, confirmed live via `model_support.rs`'s own
// `direct_selector_with_fallback`): shown next to "Inherited" so the sentinel says what it
// actually resolves to, not just that it is unset. Exported (gate round 5, #564 follow-up): the
// composer's Model picker reuses this SAME map and wording for its own Roles list, rather than
// inventing a second "unset" sentinel that could drift from this one. Gate round 6 fix
// (`agent://Arch877` Flow L-N1): `smol`/`slow` moved IN here too (they used to live only in a
// second, picker-local copy, `ModelPicker.tsx`'s own now-removed `ROLE_NO_MODEL_FALLBACK`) so
// this section's own "Inherited" (no qualifier) and the picker's "Inherited (...)" can never
// drift apart again -- both unset `smol` and unset `slow` inherit an explicitly configured
// `default`, `model_support.rs`'s own fallback, distinct from the THREE roles below that inherit
// a role covered by this map instead.
export const ROLE_FALLBACK_LABEL: Partial<Record<ModelRoleId, string>> = {
  smol: 'Default',
  slow: 'Default',
  tiny: 'Smol',
  memory: 'Tiny',
  widget: 'Smol',
  advisor: 'Slow'
}

// Spec 035 T7 groups, in display order. Advisor's row reads Refract's launch value (T9).
const ROLE_GROUPS: ReadonlyArray<{ title: string; roles: readonly ModelRoleId[] }> = [
  { title: 'Conversation', roles: ['default', 'plan', 'slow'] },
  { title: 'Background', roles: ['smol', 'tiny', 'widget', 'memory', 'commit'] },
  { title: 'Delegated', roles: ['task', 'advisor'] },
  { title: 'Media', roles: ['vision'] },
  { title: 'Model kinds', roles: ['image', 'web', 'speech', 'dictation', 'judge'] }
]

// Only the two links the probe confirmed (omp-probe.md) name a fallback; every other unset role
// is described by OMP picking one automatically.
function unsetLabelFor(role: ModelRoleId): string {
  return role === 'smol' || role === 'slow' ? 'Inherit Default' : 'OMP picks one automatically'
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
  // Issue #1069 decision 2: the provider switch's own selection, lifted here so it can filter
  // every chat role's dropdown below. Initialised once (`providerInitializedRef`) from the
  // Default role's current model's provider, or the catalog's first provider as a fallback --
  // never re-derived afterward, so picking a different segment is never silently overridden by a
  // later `roles`/`catalogs` update (a save, a catalog retry).
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const providerInitializedRef = useRef(false)
  // Quality-gate remediation (accessibility-auditor HIGH): saving/saved/failed was previously
  // announced nowhere -- the spinner was `aria-hidden` and a failure went only to an
  // auto-dismissing toast. Two regions, matching this app's existing `ManageAccountsDialog`/
  // `OmpProvidersSection` pattern: polite for a routine save/clear, assertive for a failure.
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
    // Intentionally empty: this section loads its own data once on mount, the same pattern
    // `AppearanceSection.tsx`'s own mount-time effects use.
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

  // Quality-gate remediation (code-reviewer MEDIUM): focus the Retry button the moment a load
  // failure first appears (unchanged), AND focus the section heading when a retry SUCCEEDS (the
  // button that had focus just unmounted along with the whole Alert).
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
      // Gate round 1 fix (#1114, Medium #5): picking a new model whose own reasoning support
      // does not cover the role's EXISTING carried-over level writes a bare selector instead
      // (see `renderRole`'s own onValueChange below) and says so here, rather than the generic
      // "saved" that would otherwise mask a silent level drop.
      announcePolite(successAnnouncement ?? (value === null ? `${label} cleared` : `${label} saved`))
    } else {
      announceAssertive(`Could not save ${label}: ${result.message}`)
    }
  }

  async function handleRetryLoad(): Promise<void> {
    // `aria-disabled` does not stop activation on its own (accessibility-auditor/security-auditor
    // MEDIUM/LOW): without this guard, a second click/Enter while the first retry is still in
    // flight starts an overlapping `omp config get` call.
    if (retryingLoad) return
    setRetryingLoad(true)
    // Quality-gate remediation (accessibility-auditor LOW, gate cycle 5, optional): the button's
    // own accessible name changing to "Retrying…" is not reliably re-announced by a screen reader
    // on an element that already has focus, so say it explicitly too.
    announcePolite('Retrying model roles')
    await load({ keepError: true })
    setRetryingLoad(false)
    const state = useModelRolesStore.getState()
    if (state.loadError) {
      // Clears the "Retrying model roles" polite announcement first (gate cycle 6, a11y optional):
      // without this, a screen reader that has not yet read it out could announce the stale
      // in-progress status AFTER the definitive assertive failure message finishes.
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
    // Recorded before the retry starts: this is the only reliable way to know whether the Retry
    // button (about to unmount on success) is what currently holds focus, so success can decide
    // whether to move focus on somewhere, or leave an already-elsewhere focus alone.
    const hadFocus = document.activeElement?.id === `model-role-catalog-retry-${kind}`
    setRetryingKinds((prev) => new Set(prev).add(kind))
    // Quality-gate remediation (accessibility-auditor LOW, gate cycle 5, optional): see the
    // matching comment in `handleRetryLoad` above.
    announcePolite(`Retrying ${kindLabel} models`)
    await loadCatalog(kind, true)
    setRetryingKinds((prev) => {
      const next = new Set(prev)
      next.delete(kind)
      return next
    })
    const state = useModelRolesStore.getState()
    if (state.catalogErrors[kind]) {
      // Clears the "Retrying ... models" polite announcement first (gate cycle 6, a11y optional):
      // see the matching comment in `handleRetryLoad` above.
      announcePolite('')
      announceAssertive(`Could not load ${kindLabel} models: ${state.catalogErrors[kind]}`)
    } else {
      // Quality-gate remediation (accessibility-auditor LOW): names the kind, matching the
      // failure announcement above, instead of a generic "Models loaded" that gave no context
      // when several catalog kinds could be in flight or have just failed elsewhere on the page.
      // Sentence case (gate cycle 5 LOW, a11y: this previously started with a lowercase kind
      // name, inconsistent with every other announcement in this section).
      announcePolite(`Loaded ${kindLabel} models`)
      if (hadFocus) {
        const targetId = firstRoleIdForKind(kind)
        const target = (targetId ? document.getElementById(targetId) : null) ?? headingRef.current
        target?.focus()
      }
    }
  }

  /** The loading/error status of ONE catalog kind, rendered once per kind within a group. */
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
      intro="Choose which model OMP uses for each role. Changes save immediately to OMP's global configuration and apply to new sessions, unless a repository's own .omp config overrides a role."
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
            <Button ref={retryLoadRef} variant="outline" size="sm" aria-disabled={retryingLoad || undefined} onClick={() => void handleRetryLoad()}>
              {retryingLoad ? 'Retrying…' : 'Retry'}
            </Button>
          </div>
        </Alert>
      ) : (
        <>
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
