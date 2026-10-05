// Pure helpers for Manage accounts (User Story 2): kept tiny and tested with a throwaway script
// rather than a framework test, matching plan.md's own convention for this spec's small renderer
// helpers (e.g. src/renderer/lib/initials.ts).
import type { GitHubAccount, OmpProviderState } from '../../shared/ipc'

const CLEAN_DEVICE_CODE = /^[A-Za-z0-9]{8}$/

/** Groups a GitHub CLI one-time device code into "XXXX-XXXX" for display (FR-009). Only a clean
 *  8-character alphanumeric code is grouped; a code that already contains a hyphen (the shape
 *  `gh` actually emits, per research.md Decision 2 -- e.g. "5FCF-5515") or has any other length
 *  is shown exactly as received, never reformatted or truncated. */
export function formatDeviceCode(code: string): string {
  if (!CLEAN_DEVICE_CODE.test(code)) return code
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** Finds the GitHub account that becomes active next if `target` signs out (FR-011): the first
 *  remaining account on `target`'s own host, in the CLI's own order (the order `accounts` is
 *  already in -- callers must pass the raw `accounts.github.list()` order, not Manage accounts'
 *  own active-first display order, since `gh auth logout`'s documented successor behaviour
 *  follows the CLI's internal order, not the UI's). Returns `null` when no other account shares
 *  that host (the sign-out confirmation then says no account will remain active). */
export function signOutSuccessor(accounts: GitHubAccount[], target: { host: string; login: string }): GitHubAccount | null {
  for (const account of accounts) {
    if (account.host !== target.host) continue
    if (account.login === target.login) continue
    return account
  }
  return null
}

/** Finds the account in `after` whose own auth problem (per `state !== 'success'`) is fixed
 * compared to its entry in `before` (ManageAccountsDialog.tsx's add-flow completion effect):
 * identifies which already-known account a "Sign in again" re-authenticated, for the cases where
 * the add flow brought in no brand new account at all. Returns `null` when no existing account's
 * `state` improved (an add flow that genuinely added a new account, for instance). */
export function findReauthenticatedAccount(before: GitHubAccount[], after: GitHubAccount[]): GitHubAccount | null {
  for (const account of after) {
    const prior = before.find((b) => b.host === account.host && b.login === account.login)
    if (prior && prior.state !== 'success' && account.state === 'success') return account
  }
  return null
}

/** The Manage accounts OMP section's summary line (T019): "All {total} providers signed in" is
 *  the one special case; every other count (including 0 and 1) uses the same "{n} of {total}
 *  providers signed in" template verbatim -- "1 of {total}" reads fine without singularizing
 *  "providers" on its own. */
export function ompSummaryLine(signedIn: number, total: number): string {
  if (total > 0 && signedIn === total) return `All ${total} providers signed in`
  return `${signedIn} of ${total} providers signed in`
}

/** Splits OMP's own provider order into the authenticated ones (tier 1, always visible) and the
 *  rest (tier 2, behind the collapsed "Show all" disclosure) -- each sub-list keeps OMP's
 *  original relative order, never re-sorted. */
export function splitOmpProviders<T extends Pick<OmpProviderState, 'authenticated'>>(providers: T[]): { signedIn: T[]; other: T[] } {
  const signedIn: T[] = []
  const other: T[] = []
  for (const provider of providers) {
    (provider.authenticated ? signedIn : other).push(provider)
  }
  return { signedIn, other }
}
