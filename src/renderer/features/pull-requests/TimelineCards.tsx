// The Overview timeline's entries (spec 038 FR-001 to FR-003): commits are unboxed single rows on
// the history line; comments, reviews and threads are cards with a soft `border-divider` hung off
// it. Card headers carry the shared Avatar, login, a muted "Bot" badge, and -- for the signed-in
// viewer -- an accent tint plus a "You" badge (text, never colour alone). All Markdown goes
// through `githubStyle` and the image proxy (ADR 0004).
import type { ReactNode } from 'react'
import { GitCommitHorizontalIcon } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { RelativeTime } from '@/components/relative-time'
import { Markdown } from '@/features/chat/Markdown'
import { cn } from '@/lib/utils'
import type { AutomatedFinding, PullRequestActor, Review, TimelineEntry } from '../../../shared/github'
import { resolvePullRequestImage, useAvatarDataUrl } from './prImages'
import { ThreadActions } from './ThreadReply'

export function actorLabel(actor: PullRequestActor): string {
  return actor.name ?? actor.login
}

function initials(actor: PullRequestActor): string {
  return actor.login.slice(0, 2).toUpperCase()
}

// DISMISSED is a real timeline entry; it reads "{reviewer}'s review was dismissed" because the
// reviewer does not dismiss their own review. The pre-dismissal verdict is not in GitHub's data.
const VERDICT_LABEL: Record<Exclude<Review['verdict'], 'dismissed'>, string> = {
  comment: 'commented',
  approve: 'approved',
  'request-changes': 'requested changes'
}

function reviewSentence(review: Review): string {
  if (review.verdict === 'dismissed') return `\u2019s review was dismissed`
  return ` ${VERDICT_LABEL[review.verdict]}`
}

const SEVERITY_LABEL: Record<AutomatedFinding['severity'], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
  unknown: 'Severity unknown'
}

function ActorAvatar({ actor }: { actor: PullRequestActor }) {
  const dataUrl = useAvatarDataUrl(actor.avatarUrl)
  return (
    <Avatar size="sm" aria-hidden>
      {dataUrl && <AvatarImage src={dataUrl} alt="" />}
      <AvatarFallback>{initials(actor)}</AvatarFallback>
    </Avatar>
  )
}

/** A card's header row: avatar, login, badges, an action sentence, and the relative time. */
function CardHeader({
  actor,
  viewerLogin,
  suffix,
  time,
  edited,
  trailing
}: {
  actor: PullRequestActor
  viewerLogin: string | null
  suffix?: string
  time: string
  edited: boolean
  trailing?: ReactNode
}) {
  const isViewer = viewerLogin !== null && actor.login === viewerLogin
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-t-md border-b border-divider px-3 py-2 text-xs text-muted-foreground',
        isViewer && 'bg-accent/50'
      )}
    >
      <ActorAvatar actor={actor} />
      <span className="text-foreground">
        <span className="font-medium">{actorLabel(actor)}</span>
        {suffix}
      </span>
      {actor.kind === 'bot' && <Badge variant="secondary">Bot</Badge>}
      {isViewer && <Badge variant="secondary">You</Badge>}
      <span className="ml-auto flex items-center gap-2">
        {edited && <span>edited</span>}
        <RelativeTime value={time} />
        {trailing}
      </span>
    </div>
  )
}

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-divider">{children}</div>
}

function PrMarkdown({ id, text, className }: { id: string; text: string; className?: string }) {
  return <Markdown id={id} text={text} githubStyle resolveImage={resolvePullRequestImage} className={className} />
}

export function CommitRow({ entry }: { entry: Extract<TimelineEntry, { kind: 'commit' }> }) {
  const headline = entry.message.split('\n', 1)[0]
  return (
    <div className="flex items-center gap-2 py-1 text-sm">
      <GitCommitHorizontalIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{headline}</span>
      <span className="shrink-0 font-code text-xs text-muted-foreground">{entry.sha.slice(0, 7)}</span>
      <RelativeTime value={entry.committedAt} className="shrink-0 text-xs text-muted-foreground" />
    </div>
  )
}

export function CommentCard({
  entry,
  viewerLogin
}: {
  entry: Extract<TimelineEntry, { kind: 'comment' }>
  viewerLogin: string | null
}) {
  return (
    <Card>
      <CardHeader actor={entry.author} viewerLogin={viewerLogin} time={entry.createdAt} edited={entry.edited} />
      <div className="px-3 py-2">
        <PrMarkdown id={entry.id} text={entry.body} />
      </div>
    </Card>
  )
}

export function ReviewCard({
  entry,
  viewerLogin
}: {
  entry: Extract<TimelineEntry, { kind: 'review' }>
  viewerLogin: string | null
}) {
  const { review } = entry
  return (
    <Card>
      <CardHeader
        actor={review.author}
        viewerLogin={viewerLogin}
        suffix={reviewSentence(review)}
        time={review.submittedAt}
        edited={review.edited}
      />
      {(review.body || review.findings.length > 0) && (
        <div className="px-3 py-2">
          {review.body && <PrMarkdown id={review.id} text={review.body} />}
          {review.findings.length > 0 && (
            <ul className="mt-2 space-y-2">
              {review.findings.map((finding, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span className="shrink-0 rounded border border-border px-1 py-1">
                    {SEVERITY_LABEL[finding.severity]}
                  </span>
                  <PrMarkdown id={`${review.id}-finding-${i}`} text={finding.body} className="text-xs" />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  )
}

export function ThreadCard({
  repositoryId,
  number,
  entry,
  viewerLogin,
  onChanged
}: {
  repositoryId: string
  number: number
  entry: Extract<TimelineEntry, { kind: 'review-thread' }>
  viewerLogin: string | null
  onChanged(): void
}) {
  const { thread } = entry
  return (
    <Card>
      <div className="flex items-center justify-between rounded-t-md border-b border-divider px-3 py-2 text-xs text-muted-foreground">
        <span className="font-code">
          {thread.path}
          {thread.line !== null ? `:${thread.line}` : ''}
        </span>
        <span className={cn(thread.resolved ? 'text-muted-foreground' : 'text-foreground')}>
          {thread.resolved ? 'Resolved' : 'Unresolved'}
        </span>
      </div>
      <div className="divide-y divide-divider">
        {thread.comments.map((comment) => (
          <div key={comment.id}>
            <CardHeader actor={comment.author} viewerLogin={viewerLogin} time={comment.createdAt} edited={comment.edited} />
            <div className="px-3 py-2">
              <PrMarkdown id={comment.id} text={comment.body} />
            </div>
          </div>
        ))}
      </div>
      <div className="px-3 pb-2">
        <ThreadActions repositoryId={repositoryId} number={number} thread={thread} onChanged={onChanged} />
      </div>
    </Card>
  )
}
