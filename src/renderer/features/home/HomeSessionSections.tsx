// Home's two Session sections (#869): Needs you and Recent Sessions. Every field is derived from
// state the app already holds, plus the one-line last message read in Rust; no model call.
import { useEffect, useMemo } from 'react'
import { ListCardButton } from '@/components/ListCardButton'
import { RelativeTime } from '@/components/relative-time'
import { ScreenSection } from '@/components/ScreenSection'
import { Button } from '@/components/ui/button'
import { StateIcon, displayLabel, displayStatus, formatRelativeTime, isNeedsYouSession } from '@/features/sessions/sessionDisplay'
import { useHomeStore } from '@/state/home-store'
import { useRepositoriesStore, useSessionsStore, useSplitStore, useViewStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'

/** How many Sessions Recent Sessions lists. Matches the last-message read cap today, but is its own knob. */
const HOME_RECENT_MAX = 8

export function useHomeSessions(): { needsYou: SessionSummary[]; recent: SessionSummary[] } {
  const sessions = useSessionsStore((state) => state.sessions)
  return useMemo(() => {
    const live = sessions.filter((session) => !session.archivedAt && !session.hiddenAt)
    const byRecent = (a: SessionSummary, b: SessionSummary) => b.lastActivityAt.localeCompare(a.lastActivityAt)
    const needsYou = live.filter(isNeedsYouSession).sort(byRecent)
    const recent = live.filter((session) => !isNeedsYouSession(session)).sort(byRecent).slice(0, HOME_RECENT_MAX)
    return { needsYou, recent }
  }, [sessions])
}

export function openSession(session: SessionSummary): void {
  useSplitStore.getState().replaceFocused(session.id)
  void useSessionsStore.getState().open(session.id)
  useViewStore.getState().openChat(session.repositoryId)
}

function SessionCard({ session, lastMessage }: { session: SessionSummary; lastMessage?: string | null }) {
  const repositoryName = useRepositoriesStore((state) => state.repositories.find((r) => r.id === session.repositoryId)?.name ?? 'Unknown project')
  const status = displayStatus(session)
  const label = displayLabel(session)
  const messagePart = lastMessage ? `, last message: ${lastMessage}` : ''
  return (
    <li>
      <ListCardButton
        ariaLabel={`Open Session ${session.name}, project ${repositoryName}, ${label}, ${formatRelativeTime(session.lastActivityAt)}${messagePart}`}
        onClick={() => openSession(session)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <StateIcon status={status} />
          <span className="min-w-0 truncate font-medium">{session.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
          <RelativeTime value={session.lastActivityAt} focusable={false} className="ml-auto shrink-0 text-xs text-muted-foreground" />
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {repositoryName} · {session.branch}
        </span>
        {lastMessage && <span className="truncate text-xs">{lastMessage}</span>}
      </ListCardButton>
    </li>
  )
}

export function NeedsYouSection({ sessions }: { sessions: SessionSummary[] }) {
  return (
    <ScreenSection title="Needs you" count={sessions.length} empty={sessions.length === 0 ? 'Nothing is waiting on you.' : null}>
      <ul className="flex flex-col gap-1">
        {sessions.map((session) => (
          <SessionCard key={session.id} session={session} />
        ))}
      </ul>
    </ScreenSection>
  )
}

export function RecentSessionsSection({ sessions }: { sessions: SessionSummary[] }) {
  const lastMessages = useHomeStore((state) => state.lastMessages)
  const loadLastMessages = useHomeStore((state) => state.loadLastMessages)
  const openManageSessions = useViewStore((state) => state.openManageSessions)
  const idsKey = sessions.map((session) => session.id).join(',')
  useEffect(() => {
    void loadLastMessages(idsKey ? idsKey.split(',') : [])
  }, [idsKey, loadLastMessages])
  return (
    <ScreenSection
      title="Recent Sessions"
      count={sessions.length}
      empty={sessions.length === 0 ? 'No other Sessions yet.' : null}
      actions={
        <Button type="button" variant="outline" size="sm" aria-label="Show all sessions" onClick={openManageSessions}>
          Show all
        </Button>
      }
    >
      <ul className="flex flex-col gap-1">
        {sessions.map((session) => (
          <SessionCard key={session.id} session={session} lastMessage={lastMessages[session.id]} />
        ))}
      </ul>
    </ScreenSection>
  )
}
