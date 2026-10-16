// Reviewer-consensus rollup shown above the Overview tab's Markdown body (#568 decision 10,
// FR-031). Matches GitHub's own standing-review semantics, not a bare "latest review wins"
// reducer: per reviewer, fold every review in chronological order, tracking one "standing"
// verdict --
//   - approve / request-changes REPLACES the standing verdict (the latest opinionated review
//     always wins);
//   - comment leaves the standing verdict unchanged (a reply doesn't supersede an approval);
//   - dismissed RESETS the standing verdict to none -- gate round 2 fix (#568 decision 10
//     amendment, Code High N1): a dismissal clears whatever was standing, it does NOT let an
//     EARLIER review resurface (dismissing a "changes requested" review that came after an
//     earlier "approve" leaves the reviewer with no current opinion, not a reverted approval).
// A reviewer with no standing verdict after the fold (comment-only, or their last opinionated
// review was since dismissed) is counted as "commented". The pull request's own author is
// excluded, since their own comments on their own pull request aren't a reviewer's verdict.
import type { Review, ReviewVerdict, TimelineEntry } from '../../../shared/github'

export interface ReviewConsensusProps {
  timeline: TimelineEntry[]
  /** The pull request's own author login (`detail.author.login`) -- excluded from the rollup. */
  authorLogin: string
}

type StandingVerdict = Extract<ReviewVerdict, 'approve' | 'request-changes'> | null

function standingVerdict(reviews: Review[]): StandingVerdict {
  const byTime = [...reviews].sort((a, b) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime())
  let standing: StandingVerdict = null
  for (const review of byTime) {
    if (review.verdict === 'approve' || review.verdict === 'request-changes') standing = review.verdict
    else if (review.verdict === 'dismissed') standing = null
    // 'comment' leaves `standing` unchanged.
  }
  return standing
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
    const verdict = standingVerdict(reviews)
    if (verdict === 'approve') approved++
    else if (verdict === 'request-changes') changesRequested++
    else commented++
  }

  const parts = [
    approved > 0 ? `${approved} approved` : null,
    changesRequested > 0 ? `${changesRequested} changes requested` : null,
    commented > 0 ? `${commented} commented` : null
  ].filter((part): part is string => part !== null)

  return <p className="mb-3 text-sm text-muted-foreground">{parts.join(', ')}</p>
}
