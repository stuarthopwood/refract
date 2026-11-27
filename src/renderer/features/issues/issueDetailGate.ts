export type IssueDetailGate = 'content' | 'skeleton' | 'retry'

/** Content wins once an issue has loaded; before that a failed fetch shows the retry view and anything else shows the skeleton. */
export function issueDetailGate(hasDetail: boolean, failed: boolean): IssueDetailGate {
  if (hasDetail) return 'content'
  return failed ? 'retry' : 'skeleton'
}
