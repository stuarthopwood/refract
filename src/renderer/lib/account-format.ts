// Pure helpers for Manage accounts (User Story 2): kept tiny and tested with a throwaway script
// rather than a framework test, matching plan.md's own convention for this spec's small renderer
// helpers (e.g. src/renderer/lib/initials.ts).
import type { GitHubAccount } from '../../shared/ipc'

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
