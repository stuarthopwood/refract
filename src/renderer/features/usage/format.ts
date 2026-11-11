// Number formatting shared by the Usage view's cards, charts and tables. Plain `Intl` output; the
// time zone for day labels is the machine's, matching the `tzOffsetMinutes` sent with each query.
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const usdSmall = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })
const usdPerCall = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3 })
const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export const formatUsd = (value: number): string => (value > 0 && value < 0.01 ? usdSmall.format(value) : usd.format(value))
/** Spend per call: three decimals under $1 so `$0.042` stays readable, else `formatUsd`. */
export const formatUsdPerCall = (value: number): string =>
  value > 0 && value < 0.001 ? usdSmall.format(value) : value > 0 && value < 1 ? usdPerCall.format(value) : formatUsd(value)
export const formatInt = (value: number): string => int.format(Math.round(value))
export const formatCompact = (value: number): string => compact.format(value)
export const formatPercent = (rate: number): string => `${(rate * 100).toFixed(rate > 0 && rate < 0.1 ? 1 : 0)}%`
/** Sort key for a Cost share cell: unpriced rows (no share) rank below a priced 0%. */
export const costShareSortValue = (share: number | undefined): number => share ?? -1

/** Shown where a denominator is zero. */
export const dash = '-'

export function formatDuration(ms: number | null): string {
  if (ms === null) return 'n/a'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

export function formatBucketLabel(ms: number, bucket: 'day' | 'hour'): string {
  const date = new Date(ms)
  return bucket === 'hour'
    ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
