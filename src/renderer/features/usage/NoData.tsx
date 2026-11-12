import { dash } from './format'

/**
 * Placeholder for a figure with no denominator. Sighted users see the dash and can hover for the
 * reason; screen readers skip the dash and read the label.
 */
export function NoData({ label = 'No data' }: { label?: string }) {
  return (
    <span title={label}>
      <span aria-hidden="true">{dash}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
