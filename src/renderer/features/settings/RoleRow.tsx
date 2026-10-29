// One role row in Settings > Models: name, icon and (for four roles) colour swatch, a description,
// the current model as text, and the "Change" dropdown. Used for every role, including Advisor,
// whose value lives in Refract's token guard store rather than OMP's config (`AdvisorModelRow`).
import { Loader2Icon, OctagonXIcon } from 'lucide-react'
import { SettingRow } from '@/components/settings/SettingRow'
import { ROLE_ICONS } from '@/components/icons/role-icons'
import { ROLE_CATALOG_KIND } from '../../../shared/model'
import type { ModelCatalogEntry, ModelRoleId } from '../../../shared/model'
import { filterCatalogByProvider, resolveCatalogEntry } from './modelProviderFilter'
import { describeRoleCurrent } from './modelRoleCurrent'
import type { RoleValues } from './modelRoleCurrent'
import { RoleCurrentModel } from './RoleCurrentModel'
import { RoleModelPicker } from './RoleModelPicker'
import { RoleReasoningRadios } from './RoleReasoningRadios'
import { RoleSwatch } from './RoleSwatch'

export interface RoleRowProps {
  role: ModelRoleId
  label: string
  description: string
  /** The role's own stored value (undefined when unset). */
  value: string | undefined
  roles: RoleValues
  catalog: ModelCatalogEntry[] | undefined
  catalogError: string | undefined
  isPending: boolean
  saveError?: string
  overrideNote?: string
  selectedProvider: string | null
  unsetLabel: string
  onCommit(value: string | null, announcement?: string): void
  onBusy(): void
  announcePolite(message: string): void
}

export function RoleRow({
  role,
  label,
  description,
  value,
  roles,
  catalog,
  catalogError,
  isPending,
  saveError,
  overrideNote,
  selectedProvider,
  unsetLabel,
  onCommit,
  onBusy,
  announcePolite
}: RoleRowProps) {
  const kind = ROLE_CATALOG_KIND[role]
  const isChat = kind === 'chat'
  const selectId = `model-role-${role}`
  const saveErrorId = `${selectId}-save-error`
  const overrideNoteId = `${selectId}-override-note`
  const catalogErrorId = `model-role-catalog-error-${kind}`
  const displayCatalog = isChat ? filterCatalogByProvider(catalog, selectedProvider) : (catalog ?? [])
  // `catalog === undefined` with no error means "not fetched yet", never "this model is unknown".
  const catalogStatus: 'loading' | 'loaded' | 'error' = catalogError ? 'error' : catalog === undefined ? 'loading' : 'loaded'
  const describedBy = [`${selectId}-description`, `${selectId}-current`, saveError ? saveErrorId : null, overrideNote ? overrideNoteId : null, catalogError ? catalogErrorId : null]
    .filter(Boolean)
    .join(' ')
  const current = describeRoleCurrent(role, value, roles, catalog)

  const note = (
    <>
      <RoleCurrentModel id={`${selectId}-current`} current={current} catalogLoaded={catalogStatus === 'loaded'} />
      {saveError && (
        <p id={saveErrorId} className="flex items-center gap-1 text-xs text-destructive">
          <OctagonXIcon aria-hidden className="size-4 shrink-0" />
          Could not save: {saveError}
        </p>
      )}
      {!saveError && overrideNote && (
        <p id={overrideNoteId} className="text-xs text-muted-foreground">
          Saved, but {overrideNote} still controls the effective model for this role.
        </p>
      )}
    </>
  )

  return (
    <div>
      <SettingRow id={selectId} label={label} description={description} note={note} icon={ROLE_ICONS[role]} labelAddon={<RoleSwatch role={role} />}>
        <div className="flex items-center gap-2">
          {isPending && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2Icon aria-hidden className="size-4 shrink-0 animate-spin" />
              Saving…
            </span>
          )}
          <RoleModelPicker
            label={label}
            selectId={selectId}
            describedBy={describedBy}
            currentValue={value}
            catalog={catalog}
            displayCatalog={displayCatalog}
            isChat={isChat}
            selectedProvider={selectedProvider}
            isPending={isPending}
            hasError={Boolean(saveError)}
            unsetLabel={unsetLabel}
            onCommit={onCommit}
            onBusy={onBusy}
          />
        </div>
      </SettingRow>
      {isChat && (
        <RoleReasoningRadios
          role={role}
          roleLabel={label}
          labelId={`${selectId}-label`}
          currentValue={value}
          catalogEntry={resolveCatalogEntry(value, catalog)}
          catalogStatus={catalogStatus}
          disabled={isPending}
          onPick={(nextValue) => onCommit(nextValue)}
          announcePolite={announcePolite}
        />
      )}
    </div>
  )
}
