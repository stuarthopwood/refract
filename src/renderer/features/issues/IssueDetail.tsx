// The selected issue's detail pane (issue #504, spec 051): title, state, labels, assignees, the
// body through the sanitised `Markdown` path, and Open on GitHub / Copy link. Every field is
// untrusted GitHub text and renders as text or sanitised Markdown only.
import { useEffect, useRef, useState } from 'react'
import { CircleCheckIcon, CircleDotIcon } from 'lucide-react'
import { ColourDot } from '@/components/ColourDot'
import { OpenOnGitHubButton } from '@/components/OpenOnGitHubButton'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { requestSessionFromItem } from '@/features/sessions/startSessionRequest'
import { Markdown } from '@/features/chat/Markdown'
import { RefreshButton } from '@/features/pull-requests/RefreshButton'
import { resolvePullRequestImage } from '@/features/pull-requests/prImages'
import type { IssueDetail as IssueDetailData } from '../../../shared/ipc-issues'

interface IssueDetailProps {
  repositoryId: string
  number: number
}

export function IssueDetail({ repositoryId, number }: IssueDetailProps) {
  const [detail, setDetail] = useState<IssueDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const sequenceRef = useRef(0)

  async function load(): Promise<void> {
    sequenceRef.current += 1
    const sequence = sequenceRef.current
    setLoading(true)
    setError(null)
    const result = await window.refract.issues.view(repositoryId, number)
    if (sequence !== sequenceRef.current) return
    setLoading(false)
    if (!result.ok) {
      setError(result.error.message)
      setFailed(true)
      return
    }
    setFailed(false)
    setDetail(result.value)
  }

  useEffect(() => {
    setDetail(null)
    void load()
    // The parent re-keys this component per issue; `load` is stable for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositoryId, number])

  if (!detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        {failed ? (
          <>
            {error && (
              <div role="alert" className="text-destructive">
                {error}
              </div>
            )}
            {/* Stays mounted while retrying so keyboard focus is not lost. */}
            <RefreshButton loading={loading} onClick={() => void load()} label="Retry loading this issue" />
          </>
        ) : (
          loading && 'Loading…'
        )}
      </div>
    )
  }

  const open = detail.state === 'OPEN'
  const StateIcon = open ? CircleDotIcon : CircleCheckIcon

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-[200px] flex-1">
            <h2 className="line-clamp-2 text-lg font-semibold">
              {detail.title} <span className="font-normal text-muted-foreground">#{detail.number}</span>
            </h2>
            <p className="text-xs text-muted-foreground">
              <span className="font-code">{detail.ownerRepo}</span> opened by {detail.author}
            </p>
          </div>
          <div className="no-drag-region flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1 text-xs">
              <StateIcon aria-hidden className="size-4" />
              {open ? 'Open' : 'Closed'}
            </span>
            <RefreshButton loading={loading} onClick={() => void load()} label="Refresh this issue" />
            <OpenOnGitHubButton url={detail.url} />
            <CopyButton getText={() => detail.url} label="Copy link" announcement="Issue link copied" />
            <Button size="sm" variant="ghost" onClick={() => void requestSessionFromItem({ kind: 'issue', repositoryId, number })}>
              New session
            </Button>
          </div>
        </div>
        {error && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {error}
          </p>
        )}
        {detail.labels.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {detail.labels.map((label) => (
              <span key={label.name} className="flex items-center gap-1">
                <ColourDot color={label.color} />
                {label.name}
              </span>
            ))}
          </div>
        )}
        {detail.assignees.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">Assignees: {detail.assignees.join(', ')}</p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <Markdown
          id={`issue-${detail.ownerRepo}-${detail.number}-body`}
          text={detail.body || '_No description._'}
          githubStyle
          resolveImage={resolvePullRequestImage}
        />
      </div>
    </div>
  )
}
