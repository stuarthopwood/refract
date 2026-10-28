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
import type { ReactNode } from 'react'
import { Loader2Icon, OctagonXIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
// `@/lib/providerLabels`, never `@/lib/modelRoles` -- see `ProviderSwitch.tsx`'s own import
// comment for why (that file imports this one's `CHAT_ROLE_DESCRIPTORS` at its module top level).
import { friendlyProviderLabel } from '@/lib/providerLabels'
import { useModelRolesStore } from '@/state'
import { CHAT_MODEL_ROLES, MODEL_KIND_ROLES, ROLE_CATALOG_KIND } from '../../../shared/model'
import type { CatalogKind, ModelCatalogEntry, ModelRoleId } from '../../../shared/model'
import { applyThinkingSuffixCarryOver, splitThinkingSuffix } from './modelRoleSuffix'
import { defaultProvider, filterCatalogByProvider, providersInCatalog, resolveCatalogEntry } from './modelProviderFilter'
import { ProviderSwitch } from './ProviderSwitch'
import { isLevelCarryable, RoleReasoningRadios } from './RoleReasoningRadios'

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

// Human-readable catalog-kind names for error text and labels (accessibility-auditor LOW, gate
// cycle 4): the raw `CatalogKind` ids ("tts", "stt") are spelled letter by letter by a screen
// reader and don't match the role labels shown next to them (Speech, Dictation, Web).
const CATALOG_KIND_LABEL: Record<CatalogKind, string> = {
  chat: 'chat',
  tiny: 'tiny',
  image: 'image',
  tts: 'text-to-speech',
  stt: 'speech-to-text',
  search: 'web search',
  judge: 'judge'
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

  /** Renders the loading/error status for ONE catalog kind, ONCE -- callers must only call this
   * for the first role of each kind within a group (see `renderGroup`'s own `seenKinds`
   * tracking). */
  function renderCatalogStatus(kind: CatalogKind) {
    const catalog = catalogs[kind]
    const catalogError = catalogErrors[kind]
    const isRetrying = retryingKinds.has(kind)
    const catalogLoading = catalog === undefined && !catalogError && !isRetrying
    const catalogErrorId = `model-role-catalog-error-${kind}`

    if (catalogLoading) {
      return (
        <p key={kind} className="mb-2 flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2Icon aria-hidden className="size-4 shrink-0 animate-spin" />
          Loading models…
        </p>
      )
    }
    if (catalogError) {
      const kindLabel = CATALOG_KIND_LABEL[kind]
      return (
        <p key={kind} id={catalogErrorId} className="mb-2 flex items-center gap-2 text-xs text-destructive">
          <span className="flex items-center gap-1">
            <OctagonXIcon aria-hidden className="size-4 shrink-0" />
            Could not load {kindLabel} models: {catalogError}
          </span>
          <Button
            id={`model-role-catalog-retry-${kind}`}
            variant="outline"
            size="xs"
            aria-disabled={isRetrying || undefined}
            // Quality-gate remediation (accessibility-auditor MEDIUM): the accessible name now
            // follows the in-flight state the same way the visible text does -- a fixed label
            // never exposed "Retrying…" to anything but sighted users.
            aria-label={isRetrying ? `Retrying ${kindLabel} models` : `Retry loading ${kindLabel} models`}
            onClick={() => void handleCatalogRetry(kind)}
          >
            {isRetrying ? 'Retrying…' : 'Retry'}
          </Button>
        </p>
      )
    }
    return null
  }

  function renderRole(descriptor: RoleDescriptor) {
    const { role, label, description } = descriptor
    const currentValue = roles[role]
    const kind = ROLE_CATALOG_KIND[role]
    const catalog = catalogs[kind]
    const catalogError = catalogErrors[kind]
    const isPending = pendingRoles.has(role)
    const saveError = saveErrors[role]
    const overrideNote = overrideNotes[role]
    const selectId = `model-role-${role}`
    const labelId = `${selectId}-label`
    const descriptionId = `${selectId}-description`
    const saveErrorId = `${selectId}-save-error`
    const overrideNoteId = `${selectId}-override-note`
    const catalogErrorId = `model-role-catalog-error-${kind}`
    const describedBy = [descriptionId, saveError ? saveErrorId : null, overrideNote ? overrideNoteId : null, catalogError ? catalogErrorId : null]
      .filter(Boolean)
      .join(' ')

    // Issue #1069 decision 1: a chat role's own dropdown lists only the selected provider's
    // models (decision 6: the five model-kind roles are unaffected and keep today's unfiltered
    // list and `{name} ({provider})` item labels).
    const isChat = kind === 'chat'
    const displayCatalog = isChat ? filterCatalogByProvider(catalog, selectedProvider) : (catalog ?? [])
    // Gate round 2 fix (Medium #6): the reasoning radios' own caption must stay silent while the
    // catalog is still loading or failed -- `catalog === undefined` with no error means "not
    // fetched yet", never "this model is unknown".
    const catalogStatus: 'loading' | 'loaded' | 'error' = catalogError ? 'error' : catalog === undefined ? 'loading' : 'loaded'

    // The displayed list may not list a role's current selector verbatim (a comma-list, an
    // `@alias`, a selector from a provider the catalog fetch temporarily missed, one carrying a
    // `:thinking` suffix, or -- for a chat role -- simply a different provider than the one
    // selected) -- render it as its own pinned option so the picker never silently shows the
    // wrong thing for a value the displayed list does not contain verbatim.
    const knownSelectors = new Set(displayCatalog.map((entry) => entry.selector))
    // Gate round 1 fix (#1114, High #2/Visual H1): compare on the BASE selector (suffix
    // stripped), never the raw suffixed value -- every suffixed chat role (the common case:
    // Stuart's real profile carries one on every chat role) previously failed this check
    // regardless of whether its own model was actually still in the displayed list, pinning a
    // DUPLICATE item showing the exact same text as the real catalog entry
    // (`report.json`: `["Claude Fable 5","Claude Fable 5"]`).
    const currentBase = currentValue !== undefined ? splitThinkingSuffix(currentValue).base : undefined
    const hasUnknownCurrent = currentBase !== undefined && !knownSelectors.has(currentBase)
    const inheritedLabel = ROLE_FALLBACK_LABEL[role] ? `Inherited (${ROLE_FALLBACK_LABEL[role]})` : 'Inherited'
    // Decisions 3 and 5: resolved against the FULL (unfiltered) catalog, never `displayCatalog`,
    // so a role on a different provider is still identified by its real model, and the reasoning
    // radios below read the model's own `reasoning`/`thinking` fields regardless of which
    // provider is currently selected on the switch.
    const resolvedCurrentEntry: ModelCatalogEntry | undefined = isChat ? resolveCatalogEntry(currentValue, catalog) : undefined
    // Gate round 1 fix (High #2): the Select's own `value` matches the BASE selector whenever
    // that base is already a real, displayed catalog item -- Radix then shows that SAME item
    // selected, instead of a redundant pinned duplicate; only a genuinely off-list base (a
    // different provider, an alias, or an unresolvable model) falls back to the raw suffixed
    // value, matched by the pinned item below.
    const selectValue = hasUnknownCurrent ? (currentValue ?? INHERITED_VALUE) : (currentBase ?? INHERITED_VALUE)

    return (
      <div key={role} className="py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <label id={labelId} htmlFor={selectId} className="text-sm">
              {label}
            </label>
            <span id={descriptionId} className="text-xs text-muted-foreground">
              {description}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {isPending && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2Icon aria-hidden className="size-4 shrink-0 animate-spin" />
                Saving…
              </span>
            )}
            <Select
              value={selectValue}
              onValueChange={(pickedValue) => {
                // Quality-gate remediation (accessibility-auditor HIGH): the trigger stays a
                // real, focusable, non-`disabled` element while a save is pending (see below) so
                // Radix can still return focus to it when the popup closes -- ignoring a change
                // while pending here, rather than disabling the control, is what keeps that
                // focus return working.
                if (isPending) {
                  // Quality-gate remediation (code-reviewer/accessibility-auditor LOW): a pick
                  // made while a save for this role is still pending used to be silently
                  // dropped -- the combobox still opens (it stays non-`disabled`, see above), so
                  // say so instead of leaving a screen-reader user with no feedback at all.
                  announcePolite(`${label} is still saving`)
                  return
                }
                // Gate round 1 fix (High #2): picking the item the Select ALREADY shows
                // selected (whether the regular list's own matching base, or the pinned item's
                // exact raw value) writes nothing -- this can only be a re-pick of the exact
                // current model, never a real change.
                if (pickedValue === selectValue) return
                if (pickedValue === INHERITED_VALUE) {
                  void handleRoleChange(role, label, null)
                  return
                }
                // Gate round 1 fix (Medium #5): if the role's EXISTING level is not supported by
                // the newly picked model, write the bare selector (never a silently-dropped
                // level masquerading as "saved") and announce the reset explicitly. Gate round 2
                // fix (Medium #2): `isLevelCarryable`, not the plain per-level support check --
                // `auto` is model-independent (real `omp` never reports it as a catalog level at
                // all) so it must not be dropped on every single model change.
                const carried = applyThinkingSuffixCarryOver(pickedValue, currentValue)
                const carriedSuffix = splitThinkingSuffix(carried).suffix
                if (carriedSuffix) {
                  const pickedEntry = resolveCatalogEntry(pickedValue, catalog)
                  if (!isLevelCarryable(carriedSuffix.slice(1), pickedEntry)) {
                    void handleRoleChange(role, label, pickedValue, `${label} saved; reasoning reset to Inherit`)
                    return
                  }
                }
                void handleRoleChange(role, label, carried)
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
                {hasUnknownCurrent && (
                  <SelectItem value={currentValue as string}>
                    {resolvedCurrentEntry ? (
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate">{resolvedCurrentEntry.name}</span>
                        {resolvedCurrentEntry.provider !== selectedProvider && (
                          <span className="shrink-0 text-xs text-muted-foreground">{' '}via {friendlyProviderLabel(resolvedCurrentEntry.provider)}</span>
                        )}
                      </span>
                    ) : (
                      currentValue
                    )}
                  </SelectItem>
                )}
                {displayCatalog.map((entry) => (
                  <SelectItem key={entry.selector} value={entry.selector}>
                    {isChat ? entry.name : `${entry.name} (${entry.provider})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {saveError && (
          <p id={saveErrorId} className="mt-1 flex items-center gap-1 text-xs text-destructive">
            <OctagonXIcon aria-hidden className="size-4 shrink-0" />
            Could not save: {saveError}
          </p>
        )}
        {!saveError && overrideNote && (
          <p id={overrideNoteId} className="mt-1 text-xs text-muted-foreground">
            Saved, but {overrideNote} still controls the effective model for this role.
          </p>
        )}
        {isChat && (
          <RoleReasoningRadios
            role={role}
            roleLabel={label}
            labelId={labelId}
            currentValue={currentValue}
            catalogEntry={resolvedCurrentEntry}
            catalogStatus={catalogStatus}
            disabled={isPending}
            onPick={(nextValue) => void handleRoleChange(role, label, nextValue)}
            announcePolite={announcePolite}
          />
        )}
      </div>
    )
  }

  function renderGroup(descriptors: RoleDescriptor[]) {
    const seenKinds = new Set<CatalogKind>()
    const statusBlocks: ReactNode[] = []
    for (const descriptor of descriptors) {
      const kind = ROLE_CATALOG_KIND[descriptor.role]
      if (seenKinds.has(kind)) continue
      seenKinds.add(kind)
      const status = renderCatalogStatus(kind)
      if (status) statusBlocks.push(status)
    }
    return (
      <>
        {statusBlocks}
        <div className="flex flex-col divide-y divide-border">{descriptors.map(renderRole)}</div>
      </>
    )
  }

  return (
    <div>
      <h2 ref={headingRef} tabIndex={-1} className="mb-1 text-base font-semibold outline-none">
        Model roles
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Choose which model OMP uses for each role. Changes save immediately to OMP's global
        configuration and apply to new sessions, unless a repository's own .omp config overrides a
        role.
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
          <div className="col-start-2 mt-2">
            <Button ref={retryLoadRef} variant="outline" size="sm" aria-disabled={retryingLoad || undefined} onClick={() => void handleRetryLoad()}>
              {retryingLoad ? 'Retrying…' : 'Retry'}
            </Button>
          </div>
        </Alert>
      ) : (
        <>
          <h3 id="model-roles-chat-heading" className="mb-1 text-sm font-medium">
            Chat roles
          </h3>
          <ProviderSwitch
            providers={providersInCatalog(catalogs.chat)}
            selected={selectedProvider}
            onSelect={(provider) => {
              setSelectedProvider(provider)
              // Gate round 1 fix (#1114, Flow/Visual Medium #7): the switch's own change was
              // never announced -- the issue itself asks for it, and a filter change elsewhere
              // in this app (e.g. `ManageSessionsToolbar.tsx`'s archive filter) always is.
              announcePolite(`Showing ${friendlyProviderLabel(provider)} models`)
            }}
          />
          <div role="group" aria-labelledby="model-roles-chat-heading" className="mb-6">
            {renderGroup(CHAT_ROLE_DESCRIPTORS)}
          </div>
          <h3 id="model-roles-kind-heading" className="mb-1 text-sm font-medium">
            Model-kind roles
          </h3>
          <div role="group" aria-labelledby="model-roles-kind-heading">
            {renderGroup(KIND_ROLE_DESCRIPTORS)}
          </div>
        </>
      )}
    </div>
  )
}
