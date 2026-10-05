import { create } from 'zustand'
import type { GitHubAccount, GitHubAddFlowProgress, OmpProviderState } from '../../shared/ipc'
import { notify } from './notify'

/** Derived GitHub CLI reachability/sign-in state (User Story 2): distinct from the raw
 *  `github` list itself so the profile item and Manage accounts dialog can tell "the CLI has
 *  never answered yet" (`loading`) apart from "the CLI answered: nobody is signed in"
 *  (`signed-out`) and "the CLI itself is not on PATH" (`missing-cli`) -- three UI states FR-014
 *  and the Manage accounts dialog both need to render differently. `loading` is also what
 *  init-stores.ts keeps the store in when the very first `accounts.github.list()` itself throws
 *  (quality-gate remediation, code-reviewer Medium): a transient invoke failure must never read
 *  as "nobody is signed in". The profile item (ProfileItem.tsx) is the one surface that DOES show
 *  something of its own for `loading` -- a disabled "Checking GitHub sign-in" row -- every other
 *  surface falls back to its ordinary no-account rendering until this settles. */
export type GithubStatus = 'loading' | 'ready' | 'missing-cli' | 'signed-out'

/** OMP provider section state (User Story 3, T019): `idle` before Manage accounts' OMP section
 *  has ever been opened (the list is never fetched eagerly at startup -- a real read spawns a
 *  scratch `omp` process, measured ~4.7 s). `loading` only while the FIRST read for this app
 *  session is in flight and nothing is cached yet; once any read has ever succeeded, a later
 *  in-flight read keeps `ready` (stale-while-revalidate) and is tracked by `ompRefreshing`
 *  instead, so the cached list never disappears behind a full loading state again. `error` keeps
 *  whatever was cached (if anything) and is shown alongside it, never in place of it. */
export type OmpStatus = 'idle' | 'loading' | 'ready' | 'error'

/** A mutation's own outcome, for a caller that needs to build a live-region announcement
 *  distinct from the toast `notify()` already shows (both ManageAccountsDialog.tsx and
 *  SignOutDialog.tsx need the failure message a second time, for their own assertive region). */
export interface AccountMutationResult {
  ok: boolean
  message?: string
}

interface AccountsState {
  github: GitHubAccount[]
  githubStatus: GithubStatus
  addFlow: GitHubAddFlowProgress | null
  /** A snapshot of `github` taken the instant `addAccountStart` is called, by EITHER entry point
   *  (Manage accounts' own Add account/Retry/Sign in again, or the profile menu's Sign in item,
   *  ProfileItem.tsx's `handleSignInFromMenu`) -- quality-gate remediation (code-reviewer
   *  Medium): taking it here, not in whichever component happened to start the flow, means
   *  ManageAccountsDialog.tsx's own completion effect can always tell a brand new account apart
   *  from an existing one that was just re-authenticated, regardless of which surface started it. */
  addFlowSnapshot: GitHubAccount[]
  /** Non-null while a Manage accounts Switch action is in flight (data-model.md extension, User
   *  Story 2): the active marker must never move until `gh` itself confirms the switch, so the
   *  UI renders the target row as busy from the moment the request starts, not just once it
   *  resolves. */
  pendingSwitch: { host: string; login: string } | null
  ompProviders: OmpProviderState[]
  ompStatus: OmpStatus
  /** True whenever an `accounts.omp.list()` read is in flight, regardless of `ompStatus` --
   *  distinct from `ompStatus === 'loading'` (the first-ever read) so a later refresh with
   *  cached data to show can still drive its own "Checking…" indicator (T019 stale-while-
   *  revalidate) without reverting the section to a full loading skeleton. */
  ompRefreshing: boolean
  setGithub(accounts: GitHubAccount[]): void
  /** Sets the CLI-not-installed state directly, bypassing `setGithub`'s own empty-list ->
   *  'signed-out' rule (an empty list means something different in this case). */
  setGithubMissingCli(): void
  setAddFlow(progress: GitHubAddFlowProgress | null): void
  addAccountStart(): Promise<boolean>
  /** Resolves `{ ok: false, message }` on failure (quality-gate remediation, accessibility-
   *  auditor Medium) instead of `void`, so a caller stuck on a "Cancelling…" button (Manage
   *  accounts' Cancel) can reset its own pending state and announce the failure instead of being
   *  stuck for good. */
  addAccountCancel(flowId: string): Promise<AccountMutationResult>
  switchAccount(host: string, login: string): Promise<AccountMutationResult>
  signOutAccount(host: string, login: string): Promise<AccountMutationResult>
  /** Lazy only (research.md decision 6 / FINDINGS item 43: a real read spawns a scratch `omp`
   *  process, ~4.7 s) -- never called at app start, only on Manage accounts' OMP section opening,
   *  "Check again", and "Retry" (T019). Never throws (wrapped in try/catch, quality-gate
   *  remediation code-reviewer Medium): a failure sets `ompStatus: 'error'`, keeps any already-
   *  cached `ompProviders`, and resolves `{ ok: false, message }` instead, so a caller can build
   *  its own assertive announcement without a second `try/catch`. Concurrent calls are deduped
   *  by a module-level sequence number (code-reviewer Medium: StrictMode's double-invoked open
   *  effect, or closing and reopening mid-read, must never let a slower stale read overwrite a
   *  faster later one) -- only the call that is still the newest when its own read resolves ever
   *  writes state. */
  refreshOmpProviders(): Promise<AccountMutationResult>
}

// Spec 008 data-model.md "Account store state": GitHub accounts (contracts/ipc.md "GitHub
// accounts") and OMP provider sign-in (contracts/ipc.md "OMP provider sign-in", User Story 3).
// `github` is applied from init-stores.ts's own initial `accounts.github.list()` load and kept
// current by every `accounts:github-changed` broadcast; `ompProviders` only when Manage
// accounts' OMP section opens (never eagerly at startup, unlike `github`) -- a scratch
// OmpProcess probe per data-model.md is cheap but not free, and nothing needs it before that
// section is actually visible.
let ompRefreshSequence = 0

export const useAccountsStore = create<AccountsState>((set, get) => ({
  github: [],
  githubStatus: 'loading',
  addFlow: null,
  addFlowSnapshot: [],
  pendingSwitch: null,
  ompProviders: [],
  ompStatus: 'idle',
  ompRefreshing: false,
  setGithub: (accounts) => set({ github: accounts, githubStatus: accounts.length === 0 ? 'signed-out' : 'ready' }),
  setGithubMissingCli: () => set({ github: [], githubStatus: 'missing-cli' }),
  setAddFlow: (progress) => set({ addFlow: progress }),
  addAccountStart: async () => {
    // Quality-gate remediation (code-reviewer Medium): snapshotting here, not in whichever
    // component called this, means it is taken exactly once per flow regardless of which entry
    // point (Manage accounts or the profile menu's Sign in item) started it.
    set({ addFlowSnapshot: get().github })
    const result = await window.refract.accounts.github.addStart()
    if (!result.ok) {
      notify(result.error)
      return false
    }
    // The one-time code and the rest of this flow's progress arrive via
    // `accounts:github-add-progress` (init-stores.ts -> setAddFlow); set a placeholder here too
    // so `addFlow` is never null for the whole lifetime of a running flow, even in the brief gap
    // between this call resolving and the first progress event landing (the Manage accounts
    // dialog's Cancel button needs a `flowId` to target during that gap).
    set({ addFlow: { flowId: result.value.flowId, code: '', status: 'waiting' } })
    return true
  },
  addAccountCancel: async (flowId) => {
    const result = await window.refract.accounts.github.addCancel(flowId)
    if (!result.ok) {
      notify(result.error)
      return { ok: false, message: result.error.message }
    }
    set({ addFlow: null })
    return { ok: true }
  },
  switchAccount: async (host, login) => {
    // Pessimistic (data-model.md extension): the active marker moves only once `gh` confirms,
    // since switching changes the identity used for the next pull request or update request.
    set({ pendingSwitch: { host, login } })
    const result = await window.refract.accounts.github.switch(host, login)
    if (!result.ok) {
      set({ pendingSwitch: null })
      notify(result.error)
      return { ok: false, message: result.error.message }
    }
    get().setGithub(result.value)
    set({ pendingSwitch: null })
    return { ok: true }
  },
  signOutAccount: async (host, login) => {
    const result = await window.refract.accounts.github.signOut(host, login)
    if (!result.ok) {
      notify(result.error)
      return { ok: false, message: result.error.message }
    }
    get().setGithub(result.value)
    return { ok: true }
  },
  refreshOmpProviders: async () => {
    // Stale-while-revalidate (T019): the full 'loading' skeleton is only for this app session's
    // very first OMP read (`ompStatus` starts 'idle'); every later call -- including a Retry
    // after an 'error' with nothing cached -- keeps whatever status is already shown (and with
    // it, whatever is already on screen, error block included) and is tracked by `ompRefreshing`
    // instead, so a focused Retry/Check again button is never yanked out from under the user
    // mid-click (quality-gate remediation, code-reviewer Medium).
    const sequence = ++ompRefreshSequence
    const priorStatus = get().ompStatus
    set({ ompRefreshing: true, ompStatus: priorStatus === 'idle' ? 'loading' : priorStatus })
    try {
      const result = await window.refract.accounts.omp.list()
      if (sequence !== ompRefreshSequence) {
        // A newer refresh started while this one was in flight (StrictMode's double-invoked
        // open effect, or a close-then-reopen mid-read); only the newest call's own result is
        // ever written, so a slower stale response can never clobber a faster later one.
        return result.ok ? { ok: true } : { ok: false, message: result.error.message }
      }
      if (!result.ok) {
        set({ ompRefreshing: false, ompStatus: 'error' })
        return { ok: false, message: result.error.message }
      }
      set({ ompProviders: result.value, ompStatus: 'ready', ompRefreshing: false })
      return { ok: true }
    } catch (error) {
      if (sequence === ompRefreshSequence) set({ ompRefreshing: false, ompStatus: 'error' })
      return { ok: false, message: error instanceof Error ? error.message : 'Unknown error' }
    }
  }
}))
