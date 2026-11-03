// Home's Tidy-up section (#869): Sessions whose branch has a merged or closed pull request.
// Archive keeps the Worktree and needs no confirmation (it is reversible); "Archive all clean"
// archives only Sessions with no uncommitted files and no unpushed commits.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ListCardButton } from '@/components/ListCardButton'
import { ScreenSection } from '@/components/ScreenSection'
import { Button } from '@/components/ui/button'
import { useHomeStore } from '@/state/home-store'
import { useRepositoriesStore, useSessionsStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import { openSession } from './HomeSessionSections'

interface TidyRow {
  session: SessionSummary
  state: 'MERGED' | 'CLOSED'
  number: number
}

type Cleanliness = { kind: 'checked'; uncommitted: boolean; unpushed: boolean } | { kind: 'error' }

function cleanlinessText(value: Cleanliness | undefined): string {
  if (!value) return 'Checking for unsaved work'
  if (value.kind === 'error') return "Couldn't check for unsaved work"
  const parts = [value.uncommitted && 'Uncommitted changes', value.unpushed && 'Unpushed commits'].filter(Boolean)
  return parts.length === 0 ? 'Clean' : parts.join(', ')
}

const isClean = (value: Cleanliness | undefined): boolean => value?.kind === 'checked' && !value.uncommitted && !value.unpushed

export function TidyUpSection({ onAnnounce }: { onAnnounce(message: string): void }) {
  const closed = useHomeStore((state) => state.closed)
  const firstFetch = useHomeStore((state) => state.fetchedAt === null)
  const sessions = useSessionsStore((state) => state.sessions)
  const repositories = useRepositoriesStore((state) => state.repositories)
  const [cleanliness, setCleanliness] = useState<Record<string, Cleanliness>>({})
  const [archiving, setArchiving] = useState<ReadonlySet<string>>(new Set())
  const [actionError, setActionError] = useState<string | null>(null)
  const requested = useRef<Set<string>>(new Set())
  const listRef = useRef<HTMLUListElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

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

  // Only Sessions never checked before are fetched; a cached result stays until the app restarts.
  const idsKey = rows.map((row) => row.session.id).join(',')
  useEffect(() => {
    for (const id of idsKey ? idsKey.split(',') : []) {
      if (requested.current.has(id)) continue
      requested.current.add(id)
      window.refract.sessions
        .deleteCheck(id)
        .then((result): Cleanliness =>
          result.ok ? { kind: 'checked', uncommitted: result.value.uncommittedFiles > 0, unpushed: result.value.unpushedCommits > 0 } : { kind: 'error' }
        )
        .catch((): Cleanliness => ({ kind: 'error' }))
        .then((value) => setCleanliness((current) => ({ ...current, [id]: value })))
    }
  }, [idsKey])

  const cleanRows = rows.filter((row) => isClean(cleanliness[row.session.id]))

  function focusAfterArchive(preferredId: string | undefined): void {
    requestAnimationFrame(() => {
      const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-tidy-archive]') ?? [])
      const target = buttons.find((button) => button.dataset.tidyArchive === preferredId) ?? buttons[0]
      if (target) target.focus()
      else headingRef.current?.focus()
    })
  }

  async function archiveRows(targets: TidyRow[], preferredId?: string): Promise<void> {
    if (archiving.size > 0 || targets.length === 0) return
    setArchiving(new Set(targets.map((row) => row.session.id)))
    setActionError(null)
    const results = await Promise.allSettled(targets.map((row) => useSessionsStore.getState().archive(row.session.id)))
    const failed = targets.filter((_, index) => {
      const result = results[index]
      return !result || result.status === 'rejected' || result.value !== true
    })
    setArchiving(new Set())
    if (failed.length > 0) setActionError(`Couldn't archive ${failed.map((row) => row.session.name).join(', ')}.`)
    const done = targets.length - failed.length
    const [only] = targets
    if (done > 0) onAnnounce(only && targets.length === 1 ? `Archived Session ${only.session.name}` : `Archived ${done} Sessions`)
    focusAfterArchive(preferredId)
  }

  function archiveOne(row: TidyRow): void {
    const index = rows.indexOf(row)
    const neighbour = rows[index + 1] ?? rows[index - 1]
    void archiveRows([row], neighbour?.session.id)
  }

  const busy = archiving.size > 0

  return (
    <ScreenSection
      title="Tidy up"
      count={rows.length}
      loading={firstFetch}
      empty={rows.length === 0 ? 'No Sessions have a merged or closed pull request.' : null}
      error={actionError ?? closed.error}
      headingRef={headingRef}
      actions={
        cleanRows.length > 0 && (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void archiveRows(cleanRows)}>
            Archive all clean ({cleanRows.length})
          </Button>
        )
      }
    >
      <ul ref={listRef} className="flex flex-col gap-2">
        {rows.map((row) => {
          const repositoryName = repositories.find((r) => r.id === row.session.repositoryId)?.name ?? 'Unknown project'
          const detail = `${repositoryName} · #${row.number} ${row.state.toLowerCase()} · ${cleanlinessText(cleanliness[row.session.id])}`
          return (
            <li key={row.session.id}>
              <ListCardButton
                ariaLabel={`Open Session ${row.session.name}, ${detail}`}
                onClick={() => openSession(row.session)}
                actions={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-tidy-archive={row.session.id}
                    disabled={busy}
                    aria-label={`Archive Session ${row.session.name}`}
                    onClick={() => archiveOne(row)}
                  >
                    Archive
                  </Button>
                }
              >
                <span className="truncate font-medium">{row.session.name}</span>
                <span className="truncate text-xs text-muted-foreground">{detail}</span>
              </ListCardButton>
            </li>
          )
        })}
      </ul>
    </ScreenSection>
  )
}
