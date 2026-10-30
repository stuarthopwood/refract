// The Overview tab's ordered timeline (specs/003-pull-request-management FR-008, T016; restyled
// by spec 038 FR-001 to FR-003): a 1px history line down the left, consecutive commits grouped
// under an "N commits" heading, and comments, reviews and review threads as cards. Entries are
// rendered by `TimelineCards.tsx`; reply/resolve controls live in `ThreadReply.tsx`.
import type { ReactNode } from 'react'
import type { TimelineEntry } from '../../../shared/github'
import { InlineStatus } from '@/components/InlineStatus'
import { CommentCard, CommitRow, ReviewCard, ThreadCard } from './TimelineCards'

interface TimelineProps {
  repositoryId: string
  number: number
  entries: TimelineEntry[]
  viewerLogin: string | null
  /** Unsent reply drafts by thread id, owned by PullRequestDetail. */
  replyDrafts: Record<string, string>
  onReplyDraftChange(threadId: string, value: string): void
  /** Re-fetches `pullRequests.detail` after a reply/resolve/unresolve succeeds, so the timeline
   * and staleness cache both reflect the new state without a manual refresh (FR-018). */
  onChanged(): void
}

type CommitEntry = Extract<TimelineEntry, { kind: 'commit' }>
type Block = { kind: 'commits'; commits: CommitEntry[] } | { kind: 'entry'; entry: Exclude<TimelineEntry, CommitEntry> }

function toBlocks(entries: TimelineEntry[]): Block[] {
  const blocks: Block[] = []
  for (const entry of entries) {
    if (entry.kind !== 'commit') {
      blocks.push({ kind: 'entry', entry })
      continue
    }
    const last = blocks[blocks.length - 1]
    if (last?.kind === 'commits') last.commits.push(entry)
    else blocks.push({ kind: 'commits', commits: [entry] })
  }
  return blocks
}

function Item({ children }: { children: ReactNode }) {
  return <li className="relative">{children}</li>
}

export function Timeline({ repositoryId, number, entries, viewerLogin, replyDrafts, onReplyDraftChange, onChanged }: TimelineProps) {
  if (entries.length === 0) {
    return <InlineStatus>No activity yet.</InlineStatus>
  }
  return (
    <div className="relative p-4">
      <div aria-hidden className="absolute bottom-4 left-6 top-4 w-px bg-divider" />
      <ul className="relative flex flex-col gap-2 pl-6">
        {toBlocks(entries).map((block) => {
          if (block.kind === 'commits') {
            const { commits } = block
            const [first] = commits
            if (!first) return null
            if (commits.length === 1) {
              return (
                <Item key={`commit-${first.sha}`}>
                  <CommitRow entry={first} />
                </Item>
              )
            }
            return (
              <Item key={`commits-${first.sha}`}>
                <p className="py-1 text-xs font-medium text-muted-foreground">{commits.length} commits</p>
                <ul>
                  {commits.map((commit) => (
                    <li key={commit.sha}>
                      <CommitRow entry={commit} />
                    </li>
                  ))}
                </ul>
              </Item>
            )
          }
          const { entry } = block
          switch (entry.kind) {
            case 'comment':
              return (
                <Item key={`comment-${entry.id}`}>
                  <CommentCard entry={entry} viewerLogin={viewerLogin} />
                </Item>
              )
            case 'review':
              return (
                <Item key={`review-${entry.review.id}`}>
                  <ReviewCard entry={entry} viewerLogin={viewerLogin} />
                </Item>
              )
            case 'review-thread':
              return (
                <Item key={`thread-${entry.thread.id}`}>
                  <ThreadCard
                    repositoryId={repositoryId}
                    number={number}
                    entry={entry}
                    viewerLogin={viewerLogin}
                    draft={replyDrafts[entry.thread.id] ?? ''}
                    onDraftChange={(value) => onReplyDraftChange(entry.thread.id, value)}
                    onChanged={onChanged}
                  />
                </Item>
              )
          }
        })}
      </ul>
    </div>
  )
}
