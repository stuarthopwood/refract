// Reviewer-consensus rollup shown above the Overview tab's Markdown body (research.md decision
// 10, FR-031). Mirrors GitHub's own de-duplication semantics: only a reviewer's chronologically
// latest review counts -- an earlier verdict is superseded the moment they re-review.
import type { Review, TimelineEntry } from '../../../shared/github'

export interface ReviewConsensusProps {
  timeline: TimelineEntry[]
}

function latestReviewPerReviewer(timeline: TimelineEntry[]): Review[] {
  const latestByLogin = new Map<string, Review>()

  for (const entry of timeline) {
    if (entry.kind !== 'review') continue
    const { review } = entry
    const existing = latestByLogin.get(review.author.login)
    if (!existing || new Date(review.submittedAt).getTime() > new Date(existing.submittedAt).getTime()) {
      latestByLogin.set(review.author.login, review)
    }
  }

  return [...latestByLogin.values()]
}

export function ReviewConsensus({ timeline }: ReviewConsensusProps) {
  const latestReviews = latestReviewPerReviewer(timeline)

  if (latestReviews.length === 0) return null

  const approved = latestReviews.filter((review) => review.verdict === 'approve').length
  const changesRequested = latestReviews.filter((review) => review.verdict === 'request-changes').length
  const commented = latestReviews.filter((review) => review.verdict === 'comment').length

  const parts = [
    approved > 0 ? `${approved} approved` : null,
    changesRequested > 0 ? `${changesRequested} changes requested` : null,
    commented > 0 ? `${commented} commented` : null
  ].filter((part): part is string => part !== null)

  return <p className="mb-3 text-sm text-muted-foreground">{parts.join(', ')}</p>
}
