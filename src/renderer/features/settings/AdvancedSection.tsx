// #1212 (spec 021, #714 amendment): Settings > Advanced. Every value Refract itself sets for `omp`
// at launch (the token guard overlay), grouped by area. The values live in Refract's own store,
// never in OMP's config files; a change applies to the next Session that launches. The Advisor
// model is edited under Models > Advisor.
import { useEffect } from 'react'
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { useModelRolesStore } from '@/state'
import { useTokenGuardStore } from '@/state/token-guard-store'
import { TOKEN_GUARD_GROUPS, TOKEN_GUARD_KEYS } from '../../../shared/tokenGuard'
import type { TokenGuardKeyInfo } from '../../../shared/tokenGuard'
import { AdvancedRow } from './advanced/AdvancedRow'
import { defaultRoleWindow } from './advanced/contextWindow'

const ADVISOR_GROUP_HINT = 'Applies in review mode only.'
const THRESHOLDS_RESET_NOTICE = 'Compaction thresholds are now a percent of the context window. Your old token thresholds were reset to the defaults.'

export function AdvancedSection() {
  const { values, defaults, loaded, thresholdsReset, error, load, set, reset } = useTokenGuardStore()
  const roles = useModelRolesStore((state) => state.roles)
  const rolesLoaded = useModelRolesStore((state) => state.loaded)
  const loadRoles = useModelRolesStore((state) => state.load)
  const catalog = useModelRolesStore((state) => state.catalogs.chat)
  const loadCatalog = useModelRolesStore((state) => state.loadCatalog)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!rolesLoaded) void loadRoles()
    void loadCatalog('chat')
  }, [rolesLoaded, loadRoles, loadCatalog])

  const defaultWindow = defaultRoleWindow(roles, catalog)
  const seedPercent = typeof values['compaction.thresholdPercent'] === 'number' ? values['compaction.thresholdPercent'] : 70


  const reasonFor = (info: TokenGuardKeyInfo): string | undefined => {
    if (!info.dependsOn || values[info.dependsOn] === true) return undefined
    const parent = TOKEN_GUARD_KEYS.find((k) => k.key === info.dependsOn)
    return `Turn on ${parent?.label ?? 'the setting above'} to use this.`
  }

  return (
    <SettingsPage
      title="Advanced"
      intro="Refract sets these values every time it starts a Session, to keep token use down. Changes apply to new Sessions only; running Sessions keep the values they launched with."
    >
      {thresholdsReset && (
        <p role="status" className="mb-2 text-sm text-muted-foreground">
          {THRESHOLDS_RESET_NOTICE}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </p>
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
                seedPercent={seedPercent}
                defaultWindow={defaultWindow}
                onChange={(next) => set(info.key, next)}
                onReset={() => reset(info.key)}
              />
            ))}
          </SettingsGroup>
        ))}
    </SettingsPage>
  )
}
