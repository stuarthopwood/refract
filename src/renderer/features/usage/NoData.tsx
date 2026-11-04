import { dash } from './format'

/** Placeholder for a figure with no denominator; the dash alone has no accessible name. */
export function NoData() {
  return (
    <span role="img" aria-label="No data">
      {dash}
    </span>
  )
}
