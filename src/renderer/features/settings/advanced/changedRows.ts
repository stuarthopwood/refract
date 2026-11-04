// The one source for "which token guard values differ from their defaults": the Optimise token
// usage button's enabled state and its confirm dialog list both read it (#1581).
import { COMPACTION_METHODS, TOKEN_GUARD_KEYS } from '../../../../shared/tokenGuard'
import type { TokenGuardKeyInfo, TokenGuardValue, TokenGuardValues } from '../../../../shared/tokenGuard'
import { tokensToPercent } from './contextWindow'
import { formatCount } from './NumberUnitField'

/** Not an Advanced row (it is edited under Models > Advisor) but the reset covers it. */
const ADVISOR_MODEL_KEY = 'modelRoles.advisor'

export interface ChangedRow {
  key: string
  label: string
  from: string
  to: string
}

/** Order-insensitive deep compare, so a record equals itself however its keys were stored. */
export const sameValue = (a: unknown, b: unknown): boolean => {
  const norm = (v: unknown): string =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(Object.entries(v).sort()) : JSON.stringify(v)
  return norm(a) === norm(b)
}

/** Plain-language text for one value of a row. */
export function describeValue(info: Pick<TokenGuardKeyInfo, 'unit' | 'percentOfWindow' | 'options'>, value: TokenGuardValue | undefined, window: number | null): string {
  if (typeof value === 'number') {
    if (info.unit === '%') return `${value}%`
    if (info.percentOfWindow && window !== null) return `${tokensToPercent(value, window)}%`
    return `${formatCount(value)} ${info.unit ?? ''}`.trim()
  }
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (typeof value === 'string') return info.options?.find((o) => o.value === value)?.label ?? value
  if (Array.isArray(value)) return value.map((m) => COMPACTION_METHODS.find((c) => c.value === m)?.label ?? m).join(', ')
  if (value && Object.keys(value).length > 0) return `${Object.keys(value).length} models`
  return 'none'
}

/** Every row (and the advisor model) whose value differs from its default, in page order. */
export function changedRows(values: TokenGuardValues, defaults: TokenGuardValues, window: number | null): ChangedRow[] {
  const rows: ChangedRow[] = []
  for (const info of TOKEN_GUARD_KEYS) {
    if (sameValue(values[info.key], defaults[info.key])) continue
    rows.push({ key: info.key, label: info.label, from: describeValue(info, values[info.key], window), to: describeValue(info, defaults[info.key], window) })
  }
  if (!sameValue(values[ADVISOR_MODEL_KEY], defaults[ADVISOR_MODEL_KEY])) {
    rows.push({ key: ADVISOR_MODEL_KEY, label: 'Advisor model', from: describeValue({}, values[ADVISOR_MODEL_KEY], window), to: describeValue({}, defaults[ADVISOR_MODEL_KEY], window) })
  }
  return rows
}
