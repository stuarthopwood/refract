// Home's Tidy-up section (#869): Sessions whose branch has a merged or closed pull request.
// Archive keeps the Worktree and needs no confirmation (it is reversible); "Archive all clean"
// archives only Sessions with no uncommitted files and no unpushed commits.
import { useEffect, useMemo, useState } from 'react'
import { ScreenSection } from '@/components/ScreenSection'
import { Button } from '@/components/ui/button'
import { useHomeStore } from '@/state/home-store'
import { useRepositoriesStore, useSessionsStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'

interface TidyRow {
  session: SessionSummary
  state: 'MERGED' | 'CLOSED'
  number: number
}

type Cleanliness = 'clean' | 'dirty' | 'unknown'

export function TidyUpSection() {
  const closed = useHomeStore((state) => state.closed)
  const sessions = useSessionsStore((state) => state.sessions)
  const repositories = useRepositoriesStore((state) => state.repositories)
  const [cleanliness, setCleanliness] = useState<Record<string, Cleanliness>>({})

  const rows = useMemo<TidyRow[]>(() => {
    const out: TidyRow[] = []
    for (const item of closed.items) {
      for (const session of sessions) {
        if (!session.archivedAt && session.repositoryId === item.repositoryId && session.branch === item.branch) {
          out.push({ session, state: item.state, number: item.number })
        }
      }
    }
    return out
  }, [closed.items, sessions])

  const idsKey = rows.map((row) => row.session.id).join(',')
  useEffect(() => {
    let cancelled = false
    for (const id of idsKey ? idsKey.split(',') : []) {
      void window.refract.sessions.deleteCheck(id).then((result) => {
        if (cancelled) return
        const value: Cleanliness = !result.ok ? 'unknown' : result.value.uncommittedFiles === 0 && result.value.unpushedCommits === 0 ? 'clean' : 'dirty'
        setCleanliness((current) => ({ ...current, [id]: value }))
      })
    }
    return () => {
      cancelled = true
    }
  }, [idsKey])

  const cleanRows = rows.filter((row) => cleanliness[row.session.id] === 'clean')

  async function archive(id: string): Promise<void> {
    await useSessionsStore.getState().archive(id)
  }

  return (
    <ScreenSection
      title="Tidy up"
      count={rows.length}
      error={closed.error}
      actions={
        cleanRows.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              for (const row of cleanRows) void archive(row.session.id)
            }}
          >
            Archive all clean ({cleanRows.length})
          </Button>
        )
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Sessions have a merged or closed pull request.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const repositoryName = repositories.find((r) => r.id === row.session.repositoryId)?.name ?? 'Unknown project'
            const stateText = cleanliness[row.session.id] === 'clean' ? 'clean' : cleanliness[row.session.id] === 'dirty' ? 'has unsaved work' : 'checking'
            return (
              <li key={row.session.id} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{row.session.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {repositoryName} · #{row.number} {row.state.toLowerCase()} · {stateText}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Archive Session ${row.session.name}`}
                  onClick={() => void archive(row.session.id)}
                >
                  Archive
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </ScreenSection>
  )
}
