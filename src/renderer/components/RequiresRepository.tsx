import { useId, type ReactNode } from 'react'
import { FolderXIcon } from 'lucide-react'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { useSessionsStore } from '@/state'

/** Shown in place of a repo-only panel for the Personal Agent, which is not linked to a Project. */
export function NoRepositoryEmpty() {
  const titleId = useId()
  return (
    <Empty className="h-full" role="region" aria-labelledby={titleId}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderXIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle id={titleId} role="heading" aria-level={2}>
          No repository
        </EmptyTitle>
        <EmptyDescription>
          The Personal Agent isn&apos;t linked to a Project, so there are no changes, files, or pull requests to show.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/** Renders `children` only for a Project Session; the Personal Agent gets the empty state and the panel never mounts, so it makes no backend call. */
export function RequiresRepository({ sessionId, children }: { sessionId: string | null; children: ReactNode }) {
  const isPersonal = useSessionsStore((s) => (sessionId ? s.sessions.find((x) => x.id === sessionId)?.kind === 'personal' : false))
  return isPersonal ? <NoRepositoryEmpty /> : children
}
