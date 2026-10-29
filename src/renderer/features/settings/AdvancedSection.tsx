// #1212 (spec 021, #714 amendment): Settings > Advanced. Every value Refract itself sets for `omp`
// at launch (the token guard overlay), grouped by area. The values live in Refract's own store,
// never in OMP's config files; a change applies to the next Session that launches. The Advisor
// model is edited under Models > Advisor.
import { useEffect } from 'react'
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { useTokenGuardStore } from '@/state/token-guard-store'
import { TOKEN_GUARD_GROUPS, TOKEN_GUARD_KEYS } from '../../../shared/tokenGuard'
import type { TokenGuardKeyInfo } from '../../../shared/tokenGuard'
import { AdvancedRow } from './advanced/AdvancedRow'

const ADVISOR_GROUP_HINT = 'Applies in review mode only.'

export function AdvancedSection() {
  const { values, defaults, loaded, error, load, set, reset } = useTokenGuardStore()

  useEffect(() => {
    void load()
  }, [load])

  const fallbackTokens = typeof values['compaction.thresholdTokens'] === 'number' ? values['compaction.thresholdTokens'] : 100_000
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
                fallbackTokens={fallbackTokens}
                onChange={(next) => set(info.key, next)}
                onReset={() => reset(info.key)}
              />
            ))}
          </SettingsGroup>
        ))}
    </SettingsPage>
  )
}
