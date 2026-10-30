import type { GitHubAccount, OmpProviderState } from '../../shared/accounts'

const CLEAN_DEVICE_CODE = /^[A-Za-z0-9]{8}$/

/** Splits a clean 8-character device code with a hyphen; other codes pass through. */
export function formatDeviceCode(code: string): string {
  if (!CLEAN_DEVICE_CODE.test(code)) return code
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** First other account on the same host as `target`, or null. */
export function signOutSuccessor(accounts: GitHubAccount[], target: { host: string; login: string }): GitHubAccount | null {
  for (const account of accounts) {
    if (account.host !== target.host) continue
    if (account.login === target.login) continue
    return account
  }
  return null
}

/** First account whose state went from non-success to success between the two lists, or null. */
export function findReauthenticatedAccount(before: GitHubAccount[], after: GitHubAccount[]): GitHubAccount | null {
  for (const account of after) {
    const prior = before.find((b) => b.host === account.host && b.login === account.login)
    if (prior && prior.state !== 'success' && account.state === 'success') return account
  }
  return null
}

/** One-line summary of signed-in OMP providers. */
export function ompSummaryLine(signedIn: number, total: number): string {
  if (total > 0 && signedIn === total) return `All ${total} providers signed in`
  return `${signedIn} of ${total} providers signed in`
}

/** Splits providers into signed-in and other. */
export function splitOmpProviders<T extends Pick<OmpProviderState, 'authenticated'>>(providers: T[]): { signedIn: T[]; other: T[] } {
  const signedIn: T[] = []
  const other: T[] = []
  for (const provider of providers) {
    (provider.authenticated ? signedIn : other).push(provider)
  }
  return { signedIn, other }
}
