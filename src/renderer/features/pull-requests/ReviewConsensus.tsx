// Reviewer-consensus rollup shown above the Overview tab's Markdown body (#568 decision 10,
// FR-031). Gate round 1 fix (Code/Flow High): matches GitHub's own standing-review semantics,
// not a bare "latest review wins" reducer -- a reviewer's accessible APPROVED or
// CHANGES_REQUESTED review stays their counted opinion even if they leave a plain COMMENTED
// review afterwards (replying in a thread, for example); GitHub never lets a comment supersede
// an opinionated review. A reviewer is counted as "commented" only when they have never
// submitted an opinionated review at all. The pull request's own author is excluded, since their
// comments on their own pull request aren't a reviewer's verdict. A review that was later
// DISMISSED never reaches this component in the first place (`build_timeline` in
// `mapping.rs` drops every review from a reviewer whose own most recent review was a dismissal),
// so no extra handling is needed here for that case.
import type { Review, ReviewVerdict, TimelineEntry } from '../../../shared/github'

export interface ReviewConsensusProps {
  timeline: TimelineEntry[]
  /** The pull request's own author login (`detail.author.login`) -- excluded from the rollup. */
  authorLogin: string
}

/** The reviewer's standing verdict: the chronologically LATEST review that is `'approve'` or
 * `'request-changes'`, ignoring any `'comment'` review that came after it. `null` when the
 * reviewer has never submitted an opinionated review (comment-only). */
function standingVerdict(reviews: Review[]): Extract<ReviewVerdict, 'approve' | 'request-changes'> | null {
  const byTime = [...reviews].sort((a, b) => new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime())
  for (const review of [...byTime].reverse()) {
    if (review.verdict === 'approve' || review.verdict === 'request-changes') return review.verdict
  }
  return null
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

  if (parts.length === 0) return null

  return <p className="mb-3 text-sm text-muted-foreground">{parts.join(', ')}</p>
}
