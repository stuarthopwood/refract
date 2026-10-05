import { create } from 'zustand'
import type { GitHubAccount, GitHubAddFlowProgress, OmpProviderState } from '../../shared/ipc'
import type { ChatAnswer } from '../../shared/ipc'
import { notify } from './notify'

/** Derived GitHub CLI reachability/sign-in state (User Story 2): distinct from the raw
 *  `github` list itself so the profile item and Manage accounts dialog can tell "the CLI has
 *  never answered yet" (`loading`) apart from "the CLI answered: nobody is signed in"
 *  (`signed-out`) and "the CLI itself is not on PATH" (`missing-cli`) -- three UI states FR-014
 *  and the Manage accounts dialog both need to render differently. `loading` is the only one
 *  that never shows anything of its own: every surface that reads it falls back to its ordinary
 *  no-account rendering until the first `accounts.github.list()` settles, so there is no flash. */
export type GithubStatus = 'loading' | 'ready' | 'missing-cli' | 'signed-out'

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
  /** Non-null while a Manage accounts Switch action is in flight (data-model.md extension, User
   *  Story 2): the active marker must never move until `gh` itself confirms the switch, so the
   *  UI renders the target row as busy from the moment the request starts, not just once it
   *  resolves. */
  pendingSwitch: { host: string; login: string } | null
  ompProviders: OmpProviderState[]
  setGithub(accounts: GitHubAccount[]): void
  /** Sets the CLI-not-installed state directly, bypassing `setGithub`'s own empty-list ->
   *  'signed-out' rule (an empty list means something different in this case). */
  setGithubMissingCli(): void
  setAddFlow(progress: GitHubAddFlowProgress | null): void
  setOmpProviders(providers: OmpProviderState[]): void
  refreshGithub(): Promise<void>
  addAccountStart(): Promise<boolean>
  addAccountCancel(flowId: string): Promise<void>
  switchAccount(host: string, login: string): Promise<AccountMutationResult>
  signOutAccount(host: string, login: string): Promise<AccountMutationResult>
  refreshOmpProviders(): Promise<void>
  signInOmpProvider(providerId: string): Promise<void>
  signOutOmpProvider(providerId: string): Promise<void>
  answerOmpRequest(requestId: string, answer: ChatAnswer): Promise<void>
}

// Spec 008 data-model.md "Account store state": GitHub accounts (contracts/ipc.md "GitHub
// accounts") and OMP provider sign-in (contracts/ipc.md "OMP provider sign-in", User Story 3).
// `github` is refreshed on open and on `accounts:github-changed`; `ompProviders` only when
// Manage accounts' OMP section opens (never eagerly at startup, unlike `github`) -- a scratch
// OmpProcess probe per data-model.md is cheap but not free, and nothing needs it before that
// section is actually visible.
export const useAccountsStore = create<AccountsState>((set, get) => ({
  github: [],
  githubStatus: 'loading',
  addFlow: null,
  pendingSwitch: null,
  ompProviders: [],
  setGithub: (accounts) => set({ github: accounts, githubStatus: accounts.length === 0 ? 'signed-out' : 'ready' }),
  setGithubMissingCli: () => set({ github: [], githubStatus: 'missing-cli' }),
  setAddFlow: (progress) => set({ addFlow: progress }),
  setOmpProviders: (providers) => set({ ompProviders: providers }),
  refreshGithub: async () => {
    const result = await window.refract.accounts.github.list()
    if (!result.ok) {
      // 'gh-not-found' is a state the UI shows (FR-014), not an error -- no toast for it, just
      // as the initial load in init-stores.ts never toasts either.
      if (result.error.code === 'gh-not-found') {
        get().setGithubMissingCli()
        return
      }
      notify(result.error)
      return
    }
    get().setGithub(result.value)
  },
  addAccountStart: async () => {
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
      return
    }
    set({ addFlow: null })
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
    const result = await window.refract.accounts.omp.list()
    if (!result.ok) {
      notify(result.error)
      return
    }
    set({ ompProviders: result.value })
  },
  signInOmpProvider: async (providerId) => {
    const result = await window.refract.accounts.omp.signIn(providerId)
    if (!result.ok) {
      notify(result.error)
      return
    }
    // research.md decision 6 fallback (FINDINGS item 43): this never actually raises a
    // requestId in the current omp version, but refresh anyway in case a future omp does.
    if (result.value.requestId === null) void get().refreshOmpProviders()
  },
  signOutOmpProvider: async (providerId) => {
    const result = await window.refract.accounts.omp.signOut(providerId)
    if (!result.ok) {
      notify(result.error)
      return
    }
    if (result.value.requestId === null) void get().refreshOmpProviders()
  },
  answerOmpRequest: async (requestId, answer) => {
    const result = await window.refract.accounts.omp.answer(requestId, answer)
    if (!result.ok) {
      notify(result.error)
    }
  }
}))
