// #1140/#496: reads OMP's approval option list by POSITION, never by guessing label text. OMP
// builds it as [...grant labels, ...grant "always" labels, plain approve, session item?, deny]
// (OMP 18.12.5+; the plain label is "Approve Once" when grants exist, "Approve" otherwise), and
// maps any label it does not recognise to a deny, so every answer must echo one of these exactly.
// The same structural reading lives in Rust (`requests.rs`, `plain_approve_label`).

export interface ApprovalGrant {
  label: string
  /** The paired "remember across sessions" label, sent instead of `label` when that is on. */
  alwaysLabel: string
}

export interface ApprovalOptions {
  plain: string
  deny: string
  session?: string
  grants: ApprovalGrant[]
}

const SESSION_SUFFIX = ' for this session'

export function parseApprovalOptions(options: readonly string[] | undefined): ApprovalOptions {
  const list = options ?? []
  const n = list.length
  const at = (i: number): string => list[i] ?? ''
  if (n < 2) return { plain: 'Approve', deny: 'Deny', grants: [] }
  const hasSession = n >= 3 && at(n - 2).endsWith(SESSION_SUFFIX)
  const plainIndex = hasSession ? n - 3 : n - 2
  const half = plainIndex / 2
  const grants = Number.isInteger(half)
    ? list.slice(0, half).map((label, i) => ({ label, alwaysLabel: at(half + i) }))
    : []
  return {
    plain: at(plainIndex),
    deny: at(n - 1),
    session: hasSession ? at(n - 2) : undefined,
    grants
  }
}
