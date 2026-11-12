// #1212 (spec 021), #1767: Settings > Advanced. The token guard values Refract owns, grouped by area.
// They are written to OMP's global config (`~/.omp/agent/config.yml`), so Refract is the source of
// truth. Only keys marked `live` reach a running Session; the rest apply to new Sessions.
// The Advisor model is edited under Models > Advisor.
import { useEffect, useRef } from 'react'
import { InfoIcon, TriangleAlertIcon } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { useDefaultRepositoryId } from '@/lib/defaultRepository'
import { useModelRolesStore } from '@/state'
import { useTokenGuardStore } from '@/state/token-guard-store'
import { TOKEN_GUARD_GROUPS, TOKEN_GUARD_KEYS } from '../../../shared/tokenGuard'
import type { TokenGuardKeyInfo } from '../../../shared/tokenGuard'
import { AdvancedRow } from './advanced/AdvancedRow'
import { defaultRoleWindow } from './advanced/contextWindow'
import { changedRows } from './advanced/changedRows'
import { formatCount } from './advanced/NumberUnitField'
import { OptimiseTokenUsage } from './advanced/OptimiseTokenUsage'

const ADVISOR_GROUP_HINT = 'Applies in review mode only.'

export function AdvancedSection() {
  const { values, defaults, loaded, migration, effectiveTriggers, projectOverrides, warnings, error, load, set, reset, dismissMigrationNotice } = useTokenGuardStore()
  const repositoryId = useDefaultRepositoryId()
  const roles = useModelRolesStore((state) => state.roles)
  const rolesLoaded = useModelRolesStore((state) => state.loaded)
  const loadRoles = useModelRolesStore((state) => state.load)
  const catalog = useModelRolesStore((state) => state.catalogs.chat)
  const catalogFailed = useModelRolesStore((state) => state.catalogErrors.chat !== undefined)
  const loadCatalog = useModelRolesStore((state) => state.loadCatalog)

  useEffect(() => {
    void load(repositoryId)
  }, [load, repositoryId])

  useEffect(() => {
    if (!rolesLoaded) void loadRoles()
    void loadCatalog('chat')
  }, [rolesLoaded, loadRoles, loadCatalog])

  const headingRef = useRef<HTMLHeadingElement>(null)
  const defaultWindow = defaultRoleWindow(roles, catalog)
  const seedPercent = typeof values['compaction.thresholdPercent'] === 'number' ? values['compaction.thresholdPercent'] : Number(defaults['compaction.thresholdPercent'])

  const reasonFor = (info: TokenGuardKeyInfo): string | undefined => {
    if (!info.dependsOn || values[info.dependsOn] === true) return undefined
    const parent = TOKEN_GUARD_KEYS.find((k) => k.key === info.dependsOn)
    return `Turn on ${parent?.label ?? 'the setting above'} to use this.`
  }

  return (
    <SettingsPage
      title="Advanced"
      headingRef={headingRef}
      actions={loaded ? <OptimiseTokenUsage rows={changedRows(values, defaults, defaultWindow)} /> : undefined}
      intro="Refract writes these values to OMP's global config, so they apply to every Session you start from Refract. Keys marked 'Applies to new Sessions' do not change a running Session."
    >
      {migration?.status === 'failed' && (
        <p role="alert" className="mb-2 text-sm text-destructive">
          Could not move your old token guard settings into OMP's config. Refract tries again next launch, and the old settings stay in use until then. {migration.error}
        </p>
      )}
      {migration?.backupPath && (
        <Alert role="status" className="mb-6">
          <InfoIcon aria-hidden />
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>Your previous OMP config was backed up to {migration.backupPath}.</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void dismissMigrationNotice()
                headingRef.current?.focus()
              }}
            >
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {loaded && effectiveTriggers.length > 0 && (
        <ul aria-label="Where compaction starts" className="mb-6 flex flex-col gap-1 text-xs text-muted-foreground">
          {effectiveTriggers.map((t) => (
            <li key={t.model}>
              {t.model}: {formatCount(t.triggerTokens)} tokens ({t.modelThreshold === undefined ? `${t.thresholdPercent}% global` : `${t.modelThreshold} per-model`} of {formatCount(t.contextWindow)})
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {warnings.length > 0 && (
        <Alert variant="warning" className="mb-6">
          <TriangleAlertIcon aria-hidden />
          <AlertDescription>
            <ul>
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {loaded &&
        TOKEN_GUARD_GROUPS.map((group) => (
          <SettingsGroup key={group} title={group} description={group === 'Advisor' ? ADVISOR_GROUP_HINT : undefined}>
            {TOKEN_GUARD_KEYS.filter((info) => info.group === group).map((info) => (
              <AdvancedRow
                key={info.key}
                info={info}
                value={values[info.key]}
                defaultValue={defaults[info.key]}
                disabledReason={reasonFor(info)}
                projectOverride={projectOverrides.includes(info.key)}
                seedPercent={seedPercent}
                defaultWindow={defaultWindow}
                catalogLoading={catalog === undefined && !catalogFailed}
                onChange={(next) => set(info.key, next)}
                onReset={() => reset(info.key)}
              />
            ))}
          </SettingsGroup>
        ))}
    </SettingsPage>
  )
}
