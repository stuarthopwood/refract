import { create } from 'zustand'
import type { GitHubAccount, GitHubAddFlowProgress, OmpProviderState } from '../../shared/accounts'
import { notify } from './notify'

export type GithubStatus = 'loading' | 'ready' | 'missing-cli' | 'signed-out' | 'error'

export type OmpStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface AccountMutationResult {
  ok: boolean
  message?: string
}

interface AccountsState {
  github: GitHubAccount[]
  githubStatus: GithubStatus
  addFlow: GitHubAddFlowProgress | null
  addFlowOutcome: 'completed' | 'cancelled' | 'failed' | null
  addFlowSnapshot: GitHubAccount[]
  pendingSwitch: { host: string; login: string } | null
  githubRefreshTicket: number
  githubRefreshing: boolean
  ompProviders: OmpProviderState[]
  ompStatus: OmpStatus
  ompRefreshing: boolean
  setGithub(accounts: GitHubAccount[]): void
  setGithubMissingCli(): void
  setGithubError(): void
  setAddFlow(progress: GitHubAddFlowProgress | null): void
  addAccountStart(): Promise<boolean>
  addAccountCancel(flowId: string): Promise<AccountMutationResult>
  switchAccount(host: string, login: string): Promise<AccountMutationResult>
  signOutAccount(host: string, login: string): Promise<AccountMutationResult>
  refreshGithub(): Promise<AccountMutationResult>
  /** Lazy only -- never called at app start, only on Manage accounts' OMP section opening, "Check again", and "Retry". */
  refreshOmpProviders(): Promise<AccountMutationResult>
}

let ompRefreshSequence = 0

export const useAccountsStore = create<AccountsState>((set, get) => ({
  github: [],
  githubStatus: 'loading',
  addFlow: null,
  addFlowOutcome: null,
  addFlowSnapshot: [],
  pendingSwitch: null,
  githubRefreshTicket: 0,
  githubRefreshing: false,
  ompProviders: [],
  ompStatus: 'idle',
  ompRefreshing: false,
  setGithub: (accounts) =>
    set((state) => ({
      github: accounts,
      githubStatus: accounts.length === 0 ? 'signed-out' : 'ready',
      githubRefreshTicket: state.githubRefreshTicket + 1
    })),
  setGithubMissingCli: () =>
    set((state) => ({ github: [], githubStatus: 'missing-cli', githubRefreshTicket: state.githubRefreshTicket + 1 })),
  setGithubError: () => set((state) => ({ githubStatus: 'error', githubRefreshTicket: state.githubRefreshTicket + 1 })),
  setAddFlow: (progress) => {
    if (progress && (progress.status === 'completed' || progress.status === 'cancelled')) {
      set({ addFlow: null, addFlowOutcome: progress.status })
      return
    }
    if (progress && progress.status === 'failed') {
      set({ addFlow: progress, addFlowOutcome: 'failed' })
      return
    }
    set({ addFlow: progress })
  },
  addAccountStart: async () => {
    // `addFlowOutcome` is reset here too, so a previous flow's terminal outcome can never leak into this new one's own completion detection.
    set({ addFlowSnapshot: get().github, addFlowOutcome: null })
    const result = await window.refract.accounts.github.addStart()
    if (!result.ok) {
      notify(result.error)
      return false
    }
    set({ addFlow: { flowId: result.value.flowId, code: '', status: 'waiting' } })
    return true
  },
  addAccountCancel: async (flowId) => {
    const result = await window.refract.accounts.github.addCancel(flowId)
    if (!result.ok) {
      notify(result.error)
      return { ok: false, message: result.error.message }
    }
    set({ addFlow: null, addFlowOutcome: 'cancelled' })
    return { ok: true }
  },
  switchAccount: async (host, login) => {
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
  refreshGithub: async () => {
    if (get().githubRefreshing) return { ok: true }
    set({ githubRefreshing: true })
    const ticket = get().githubRefreshTicket
    try {
      const result = await window.refract.accounts.github.list()
      const stillCurrent = get().githubRefreshTicket === ticket
      set({ githubRefreshing: false })
      if (!stillCurrent) {
        return result.ok ? { ok: true } : { ok: false, message: result.error.message }
      }
      if (!result.ok) {
        if (result.error.code === 'gh-not-found') {
          get().setGithubMissingCli()
        } else if (get().github.length === 0) {
          get().setGithubError()
        }
        return { ok: false, message: result.error.message }
      }
      get().setGithub(result.value)
      return { ok: true }
    } catch (error) {
      set({ githubRefreshing: false })
      if (get().githubRefreshTicket === ticket && get().github.length === 0) get().setGithubError()
      return { ok: false, message: error instanceof Error ? error.message : 'Unknown error' }
    }
  },
  refreshOmpProviders: async () => {
    const sequence = ++ompRefreshSequence
    const priorStatus = get().ompStatus
    set({ ompRefreshing: true, ompStatus: priorStatus === 'idle' ? 'loading' : priorStatus })
    try {
      const result = await window.refract.accounts.omp.list()
      if (sequence !== ompRefreshSequence) {
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
