// Label options for the Issues view's Label filter: each in-scope Project's own labels
// (`issues.labels`), merged by name. The selected labels are always kept so it never vanishes from
// the control when a Project filter narrows the scope.
import { useEffect, useMemo, useState } from 'react'
import type { IssueLabel } from '../../../shared/ipc-issues'

export function useIssueLabelOptions(repositoryIds: string[], selected: string[]): IssueLabel[] {
  const [byRepository, setByRepository] = useState<Record<string, IssueLabel[]>>({})
  const key = repositoryIds.join('|')

  useEffect(() => {
    let cancelled = false
    for (const id of repositoryIds) {
      if (byRepository[id]) continue
      void window.refract.issues.labels(id).then((result) => {
        if (cancelled) return
        setByRepository((prev) => ({ ...prev, [id]: result.ok ? result.value : [] }))
      })
    }
    return () => {
      cancelled = true
    }
    // `byRepository` is a cache read: re-running on its own updates would refetch nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return useMemo(() => {
    const merged = new Map<string, IssueLabel>()
    for (const id of repositoryIds) {
      for (const label of byRepository[id] ?? []) if (!merged.has(label.name)) merged.set(label.name, label)
    }
    for (const name of selected) if (!merged.has(name)) merged.set(name, { name, color: '', description: '' })
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, byRepository, selected])
}
