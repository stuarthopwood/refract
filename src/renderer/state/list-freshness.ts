// One freshness rule for the Pull requests and Issues lists (issue #1894, FR-180): a list that
// already holds rows for the same key, fetched under a minute ago, is shown as is on mount and
// makes no `gh` call. A changed key (filter), Refresh and Show more always fetch.
export const LIST_FRESH_MS = 60_000

/** What the list's held rows were fetched for, and when (renderer clock, ms since epoch). */
export interface ListFreshness {
  key: string
  atMs: number
}

/** Project ids the fetch covers: the chosen ones still present, else every Project. */
export function effectiveProjectIds(chosen: string[], all: string[]): string[] {
  return chosen.length > 0 ? chosen.filter((id) => all.includes(id)) : all
}

/** The list key: tab, state, Project set, applied query, plus any extra filter (Issues' labels). */
export function listKey(parts: { tab: string; state: string; projectIds: string[]; query: string; labels?: string[] }): string {
  return JSON.stringify([
    parts.tab,
    parts.state,
    [...parts.projectIds].sort(),
    parts.query.trim(),
    [...(parts.labels ?? [])].sort()
  ])
}

export function isFresh(freshness: ListFreshness | null, key: string, nowMs: number = Date.now()): boolean {
  return freshness !== null && freshness.key === key && nowMs - freshness.atMs < LIST_FRESH_MS
}
