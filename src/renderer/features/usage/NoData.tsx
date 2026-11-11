import { dash } from './format'

/** Placeholder for a figure with no denominator; the dash alone has no accessible name. */
export function NoData({ label = 'No data' }: { label?: string }) {
  return (
    <span role="img" aria-label={label}>
      {dash}
    </span>
  )
}
