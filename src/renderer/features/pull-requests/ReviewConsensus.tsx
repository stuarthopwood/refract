// Matches GitHub's own standing-review semantics, not a bare "latest review wins" reducer.
import type { Review, ReviewVerdict, TimelineEntry } from '../../../shared/github'

export interface ReviewConsensusProps {
  timeline: TimelineEntry[]
  authorLogin: string
}

type StandingVerdict = Extract<ReviewVerdict, 'approve' | 'request-changes'> | null

function foldReviews(reviews: Review[]): { standing: StandingVerdict; hasComment: boolean } {
  const byTime = [...reviews].sort((a, b) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime())
  let standing: StandingVerdict = null
  let hasComment = false
  for (const review of byTime) {
    if (review.verdict === 'approve' || review.verdict === 'request-changes') standing = review.verdict
    else if (review.verdict === 'dismissed') standing = null
    else if (review.verdict === 'comment') hasComment = true
  }
  return { standing, hasComment }
}

function groupReviewsByReviewer(timeline: TimelineEntry[], authorLogin: string): Map<string, Review[]> {
  const byLogin = new Map<string, Review[]>()
  for (const entry of timeline) {
    if (entry.kind !== 'review') continue
    const { review } = entry
    if (review.author.login === authorLogin) continue
    const existing = byLogin.get(review.author.login)
    if (existing) existing.push(review)
    else byLogin.set(review.author.login, [review])
  }
  return byLogin
}

export function ReviewConsensus({ timeline, authorLogin }: ReviewConsensusProps) {
  const reviewsByReviewer = groupReviewsByReviewer(timeline, authorLogin)

  if (reviewsByReviewer.size === 0) return null

  let approved = 0
  let changesRequested = 0
  let commented = 0
  for (const reviews of reviewsByReviewer.values()) {
    const { standing, hasComment } = foldReviews(reviews)
    if (standing === 'approve') approved++
    else if (standing === 'request-changes') changesRequested++
    else if (hasComment) commented++
  }

  const parts = [
    approved > 0 ? `${approved} approved` : null,
    changesRequested > 0 ? `${changesRequested} changes requested` : null,
    commented > 0 ? `${commented} commented` : null
  ].filter((part): part is string => part !== null)

  if (parts.length === 0) return null

  return <p className="mb-2 text-sm text-muted-foreground">{parts.join(', ')}</p>
}
