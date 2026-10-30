// Spec 060 S2-14: the empty state, naming the folder searched so a missing or empty sessions
// folder is explained rather than silent.
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'

export function UsageEmptyState({ sessionsDir, found, jokes }: { sessionsDir: string; found: boolean; jokes: boolean }) {
  return (
    <Empty className="border p-4">
      <EmptyHeader>
        <EmptyTitle>{jokes ? 'Nothing to count yet' : 'No usage found'}</EmptyTitle>
        <EmptyDescription>
          {found ? 'No OMP sessions with model calls were found in' : 'The sessions folder does not exist:'}{' '}
          <code className="break-all">{sessionsDir}</code>. Run a session and it will show up here.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
