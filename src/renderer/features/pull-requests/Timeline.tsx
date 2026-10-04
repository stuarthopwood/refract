// The Overview tab's ordered timeline (specs/003-pull-request-management FR-008, T016): commits,
// comments, reviews, and review threads in chronological order, each review's automated-reviewer
// findings shown with their severity, all text through the shared `Markdown.tsx` (FR-023). Also
// carries the reply/resolve/unresolve controls for each review thread (FR-013, FR-014, T019):
// calls `pullRequests.replyToThread`/`resolveThread`/`unresolveThread` and shows the exact
// failure inline (including `stale`) rather than silently doing nothing (FR-018).
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Markdown } from '@/features/chat/Markdown'
import { formatRelativeTime } from '@/features/sessions/sessionDisplay'
import { cn } from '@/lib/utils'
import type { AutomatedFinding, PullRequestActor, Review, TimelineEntry } from '../../../shared/github'

interface TimelineProps {
  repositoryId: string
  number: number
  entries: TimelineEntry[]
  /** Re-fetches `pullRequests.detail` after a reply/resolve/unresolve succeeds, so the timeline
   * and staleness cache both reflect the new state without a manual refresh (FR-018). */
  onChanged(): void
}

function actorLabel(actor: PullRequestActor): string {
  return actor.name ?? actor.login
}

const VERDICT_LABEL: Record<Review['verdict'], string> = {
  comment: 'commented',
  approve: 'approved',
  'request-changes': 'requested changes'
}

const SEVERITY_LABEL: Record<AutomatedFinding['severity'], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
  unknown: 'Severity unknown'
}

function CommitRow({ entry }: { entry: Extract<TimelineEntry, { kind: 'commit' }> }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm">
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{entry.sha.slice(0, 7)}</span>
      <span className="min-w-0 flex-1 break-words">{entry.message}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {actorLabel(entry.author)} &middot; {formatRelativeTime(entry.committedAt)}
      </span>
    </div>
  )
}

function CommentRow({ entry }: { entry: Extract<TimelineEntry, { kind: 'comment' }> }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{actorLabel(entry.author)}</span>
        <span>{formatRelativeTime(entry.createdAt)}</span>
      </div>
      <Markdown id={entry.id} text={entry.body} />
    </div>
  )
}

function ReviewRow({ entry }: { entry: Extract<TimelineEntry, { kind: 'review' }> }) {
  const { review } = entry
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {actorLabel(review.author)} {VERDICT_LABEL[review.verdict]}
        </span>
        <span>{formatRelativeTime(review.submittedAt)}</span>
      </div>
      {review.body && <Markdown id={review.id} text={review.body} />}
      {review.findings.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {review.findings.map((finding, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-medium">
                {SEVERITY_LABEL[finding.severity]}
              </span>
              <Markdown id={`${review.id}-finding-${i}`} text={finding.body} className="text-xs" />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ThreadRow({
  repositoryId,
  number,
  entry,
  onChanged
}: {
  repositoryId: string
  number: number
  entry: Extract<TimelineEntry, { kind: 'review-thread' }>
  onChanged(): void
}) {
  const { thread } = entry
  const [replyText, setReplyText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleReply(): Promise<void> {
    const body = replyText.trim()
    if (!body) return
    setBusy(true)
    setError(null)
    const result = await window.refract.pullRequests.replyToThread(repositoryId, number, thread.id, body)
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setReplyText('')
    onChanged()
  }

  async function handleToggleResolve(): Promise<void> {
    setBusy(true)
    setError(null)
    const result = thread.resolved
      ? await window.refract.pullRequests.unresolveThread(repositoryId, number, thread.id)
      : await window.refract.pullRequests.resolveThread(repositoryId, number, thread.id)
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    onChanged()
  }

  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-mono">
          {thread.path}
          {thread.line !== null ? `:${thread.line}` : ''}
        </span>
        <span className={cn('font-medium', thread.resolved ? 'text-muted-foreground' : 'text-foreground')}>
          {thread.resolved ? 'Resolved' : 'Unresolved'}
        </span>
      </div>
      <div className="space-y-2">
        {thread.comments.map((comment) => (
          <div key={comment.id}>
            <div className="mb-0.5 flex items-center justify-between text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{actorLabel(comment.author)}</span>
              <span>{formatRelativeTime(comment.createdAt)}</span>
            </div>
            <Markdown id={comment.id} text={comment.body} />
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-start gap-2">
        <Textarea
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          placeholder="Reply to this thread"
          aria-label={`Reply to the review thread on ${thread.path}`}
          className="min-h-16 flex-1 text-sm"
          disabled={busy}
        />
        <div className="flex shrink-0 flex-col gap-1">
          {/* "Also fix" remediation (a11y AND code-reviewer, corroborated): a screen-reader user
              with several threads open hears identical "Reply"/"Resolve" names with no way to
              tell them apart -- the file path (and line, when known) disambiguates each one. */}
          <Button
            size="sm"
            variant="outline"
            aria-label={`Reply to ${thread.path}${thread.line !== null ? `:${thread.line}` : ''}`}
            onClick={() => void handleReply()}
            disabled={busy || !replyText.trim()}
          >
            Reply
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label={`${thread.resolved ? 'Unresolve' : 'Resolve'} thread on ${thread.path}${thread.line !== null ? `:${thread.line}` : ''}`}
            onClick={() => void handleToggleResolve()}
            disabled={busy}
          >
            {thread.resolved ? 'Unresolve' : 'Resolve'}
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

export function Timeline({ repositoryId, number, entries, onChanged }: TimelineProps) {
  if (entries.length === 0) {
    return <p className="p-3 text-sm text-muted-foreground">No activity yet.</p>
  }
  return (
    <div className="flex flex-col gap-2 p-3">
      {entries.map((entry) => {
        switch (entry.kind) {
          case 'commit':
            return <CommitRow key={`commit-${entry.sha}`} entry={entry} />
          case 'comment':
            return <CommentRow key={`comment-${entry.id}`} entry={entry} />
          case 'review':
            return <ReviewRow key={`review-${entry.review.id}`} entry={entry} />
          case 'review-thread':
            return (
              <ThreadRow
                key={`thread-${entry.thread.id}`}
                repositoryId={repositoryId}
                number={number}
                entry={entry}
                onChanged={onChanged}
              />
            )
        }
      })}
    </div>
  )
}
