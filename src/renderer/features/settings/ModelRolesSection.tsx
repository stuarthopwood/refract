// Issue #455: lets the user see and change OMP's model-role assignments (`modelRoles` in OMP's
// own global config.yml) without hand-editing YAML. Reads/writes go through `omp config`
// (`src/main/omp/config.ts`), never a file edit Refract does itself (constitution Principle I:
// OMP owns its own config) -- `omp config set modelRoles` always writes the GLOBAL config (never
// a project override; `omp://settings.md` "Where writes go"), which answers the issue's own
// "which scope" open question directly from the CLI's documented behaviour. The model picker per
// role is populated from `omp models --kind <kind> --json` (a read-only catalog listing,
// independent of any live RPC session) rather than the RPC `get_available_models` surface the
// issue originally suggested: FINDINGS item 21 found that surface carries no role field at all,
// and the RPC session itself lives in Phase A files (`OmpProcess.ts`/`SessionAgent.ts`) this story
// does not touch -- the catalog listing is the one role-aware, non-Phase-A source available.
//
// Known, explicitly reduced scope (not a silent gap): a role value with a `:thinking` suffix
// (e.g. `anthropic/claude-sonnet-4-5:high`) never matches a catalog `selector` verbatim, so it
// renders as its own "unknown current value" option, and picking a fresh model from the catalog
// drops any existing suffix. Splitting a value into selector+suffix and re-attaching the suffix
// (or adding a separate thinking-level picker) is left for a follow-up; this PR keeps the raw
// current value visible and editable (never silently replaced) rather than hiding the gap.
import { useEffect, useRef } from 'react'
import { Loader2Icon, OctagonXIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { useModelRolesStore } from '@/state'
import { CHAT_MODEL_ROLES, MODEL_KIND_ROLES, ROLE_CATALOG_KIND } from '../../../shared/model'
import type { ModelRoleId } from '../../../shared/model'

interface RoleDescriptor {
  role: ModelRoleId
  label: string
  description: string
}

// Labels/descriptions from `omp://models.md` ("Role aliases and settings"), sentence case per the
// design rules.
const CHAT_ROLE_DESCRIPTORS: RoleDescriptor[] = [
  { role: 'default', label: 'Default', description: 'The active chat model, used when nothing else overrides it.' },
  { role: 'smol', label: 'Smol', description: 'A lightweight model for cheap, fast background work.' },
  { role: 'slow', label: 'Slow', description: 'A stronger model for work worth the extra time.' },
  { role: 'vision', label: 'Vision', description: 'Analyses images, such as a read screenshot.' },
  { role: 'plan', label: 'Plan', description: 'Used while plan mode is active.' },
  { role: 'commit', label: 'Commit', description: 'Writes commit messages.' },
  { role: 'tiny', label: 'Tiny', description: 'Lightweight background work such as session titles; falls back to Smol.' },
  { role: 'memory', label: 'Memory', description: 'Recall and memory work; falls back to Tiny.' },
  { role: 'task', label: 'Task', description: 'Subagents started by the task tool.' },
  { role: 'advisor', label: 'Advisor', description: 'Reviews turns when the advisor is enabled; falls back to Slow.' }
]

const KIND_ROLE_DESCRIPTORS: RoleDescriptor[] = [
  { role: 'image', label: 'Image', description: 'Generates images.' },
  { role: 'web', label: 'Web', description: 'Web search and grounded chat.' },
  { role: 'speech', label: 'Speech', description: 'Text to speech.' },
  { role: 'dictation', label: 'Dictation', description: 'Speech to text.' },
  { role: 'judge', label: 'Judge', description: 'Judgment and evaluation requests.' }
]

// Documented fallback chains (`omp://models.md`): shown next to "Inherited" so the sentinel says
// what it actually resolves to, not just that it is unset.
const ROLE_FALLBACK_LABEL: Partial<Record<ModelRoleId, string>> = {
  tiny: 'Smol',
  memory: 'Tiny',
  advisor: 'Slow'
}

// `Select` needs a non-empty item value; this sentinel stands for "unset" (inherits the role's
// documented fallback) and is translated back to `null` before the IPC call.
const INHERITED_VALUE = '__inherited__'

export function ModelRolesSection() {
  const roles = useModelRolesStore((state) => state.roles)
  const loaded = useModelRolesStore((state) => state.loaded)
  const loadError = useModelRolesStore((state) => state.loadError)
  const pendingRoles = useModelRolesStore((state) => state.pendingRoles)
  const saveErrors = useModelRolesStore((state) => state.saveErrors)
  const catalogs = useModelRolesStore((state) => state.catalogs)
  const catalogErrors = useModelRolesStore((state) => state.catalogErrors)
  const load = useModelRolesStore((state) => state.load)
  const setRole = useModelRolesStore((state) => state.setRole)
  const loadCatalog = useModelRolesStore((state) => state.loadCatalog)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const retryLoadRef = useRef<HTMLButtonElement>(null)
  const wasLoadErrorRef = useRef(false)
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

  // Quality-gate remediation (accessibility-auditor MEDIUM, matching `OmpProvidersSection.tsx`'s
  // own retry-focus pattern): move focus onto the Retry button the moment a load failure first
  // appears, so a keyboard/screen-reader user lands straight on the one useful action.
  useEffect(() => {
    if (loadError && !wasLoadErrorRef.current) {
      retryLoadRef.current?.focus()
    }
    wasLoadErrorRef.current = loadError !== null
  }, [loadError])

  async function handleRoleChange(role: ModelRoleId, label: string, rawValue: string): Promise<void> {
    const value = rawValue === INHERITED_VALUE ? null : rawValue
    const result = await setRole(role, value)
    if (result.ok) {
      announcePolite(value === null ? `${label} cleared` : `${label} saved`)
    } else {
      announceAssertive(`Could not save ${label}: ${result.message}`)
    }
  }

  function renderRole(descriptor: RoleDescriptor) {
    const { role, label, description } = descriptor
    const currentValue = roles[role]
    const kind = ROLE_CATALOG_KIND[role]
    const catalog = catalogs[kind]
    const catalogError = catalogErrors[kind]
    const catalogLoading = catalog === undefined && !catalogError
    const isPending = pendingRoles.has(role)
    const saveError = saveErrors[role]
    const selectId = `model-role-${role}`
    const descriptionId = `${selectId}-description`
    const saveErrorId = `${selectId}-save-error`
    const catalogErrorId = `model-role-catalog-error-${kind}`
    const describedBy = [descriptionId, saveError ? saveErrorId : null, catalogError ? catalogErrorId : null].filter(Boolean).join(' ')

    // The catalog may not list a role's current selector verbatim (a comma-list, an `@alias`, or
    // a selector from a provider the catalog fetch temporarily missed, or one carrying a
    // `:thinking` suffix -- see the module header) -- render it as its own option so the picker
    // never silently shows the wrong thing for a value it does not recognise.
    const knownSelectors = new Set((catalog ?? []).map((entry) => entry.selector))
    const hasUnknownCurrent = currentValue !== undefined && !knownSelectors.has(currentValue)
    const inheritedLabel = ROLE_FALLBACK_LABEL[role] ? `Inherited (${ROLE_FALLBACK_LABEL[role]})` : 'Inherited'

    return (
      <div key={role} className="py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <label htmlFor={selectId} className="text-sm font-medium">
              {label}
            </label>
            <span id={descriptionId} className="text-xs text-muted-foreground">
              {description}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {isPending && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2Icon aria-hidden className="size-3.5 shrink-0 animate-spin" />
                Saving…
              </span>
            )}
            <Select
              value={currentValue ?? INHERITED_VALUE}
              onValueChange={(value) => {
                // Quality-gate remediation (accessibility-auditor HIGH): the trigger stays a real,
                // focusable, non-`disabled` element while a save is pending (see below) so Radix
                // can still return focus to it when the popup closes -- ignoring a change while
                // pending here, rather than disabling the control, is what keeps that focus
                // return working.
                if (isPending) return
                void handleRoleChange(role, label, value)
              }}
            >
              <SelectTrigger
                id={selectId}
                aria-describedby={describedBy || undefined}
                aria-disabled={isPending || undefined}
                aria-invalid={Boolean(saveError) || undefined}
                className="w-64"
              >
                <SelectValue placeholder="Inherited" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERITED_VALUE}>{inheritedLabel}</SelectItem>
                {hasUnknownCurrent && <SelectItem value={currentValue as string}>{currentValue}</SelectItem>}
                {(catalog ?? []).map((entry) => (
                  <SelectItem key={entry.selector} value={entry.selector}>
                    {entry.name} ({entry.provider})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {saveError && (
          <p id={saveErrorId} role="status" className="mt-1 flex items-center gap-1 text-xs text-destructive">
            <OctagonXIcon aria-hidden className="size-3 shrink-0" />
            Could not save: {saveError}
          </p>
        )}
        {catalogLoading && (
          <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2Icon aria-hidden className="size-3 shrink-0 animate-spin" />
            Loading models…
          </p>
        )}
        {catalogError && (
          <p id={catalogErrorId} className="mt-1 flex items-center gap-2 text-xs text-destructive">
            <span className="flex items-center gap-1">
              <OctagonXIcon aria-hidden className="size-3 shrink-0" />
              Could not load models: {catalogError}
            </span>
            <Button variant="outline" size="xs" onClick={() => void loadCatalog(kind, true)}>
              Try again
            </Button>
          </p>
        )}
      </div>
    )
  }

  return (
    <div>
      <h2 ref={headingRef} tabIndex={-1} className="mb-1 text-base font-semibold outline-none">
        Model roles
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Choose which model OMP uses for each role. Changes save immediately to OMP's global configuration and apply to new sessions.
      </p>
      <div aria-live="polite" className="sr-only">
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
          <div className="mt-2">
            <Button ref={retryLoadRef} variant="outline" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </Alert>
      ) : (
        <>
          <h3 id="model-roles-chat-heading" className="mb-1 text-sm font-semibold">
            Chat roles
          </h3>
          <div role="group" aria-labelledby="model-roles-chat-heading" className="mb-6 flex flex-col divide-y divide-border">
            {CHAT_ROLE_DESCRIPTORS.map(renderRole)}
          </div>
          <h3 id="model-roles-kind-heading" className="mb-1 text-sm font-semibold">
            Model-kind roles
          </h3>
          <div role="group" aria-labelledby="model-roles-kind-heading" className="flex flex-col divide-y divide-border">
            {KIND_ROLE_DESCRIPTORS.map(renderRole)}
          </div>
        </>
      )}
    </div>
  )
}
