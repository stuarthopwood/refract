// The polite "N results" announcement every list filter shares (#1811). It speaks only while the
// query is long enough to filter (`effectiveFilterQuery`), and waits for typing to pause so a
// screen reader is not interrupted on each keystroke.
import { useEffect, useState } from 'react'
import { effectiveFilterQuery } from '@/components/filterQueryRule'

/** Pause after the last change before the count is spoken. */
const ANNOUNCE_DELAY_MS = 500

export function filterResultText(count: number): string {
  return count === 0 ? 'No results' : `${count} ${count === 1 ? 'result' : 'results'}`
}

export interface FilterResultStatusProps {
  /** The raw field value; the count is announced only once it reaches the filter threshold. */
  query: string
  /** How many rows the filter left; omit while the list is still loading or has failed. */
  count?: number
}

export function FilterResultStatus({ query, count }: FilterResultStatusProps) {
  const text = count !== undefined && effectiveFilterQuery(query) !== '' ? filterResultText(count) : ''
  const [announced, setAnnounced] = useState('')
  useEffect(() => {
    if (text === '') {
      setAnnounced('')
      return
    }
    const timer = setTimeout(() => setAnnounced(text), ANNOUNCE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [text])
  return (
    <span role="status" data-slot="filter-result-status" className="sr-only">
      {announced}
    </span>
  )
}
