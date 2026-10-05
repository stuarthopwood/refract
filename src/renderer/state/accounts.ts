import { create } from 'zustand'
import type { GitHubAccount, GitHubAddFlowProgress, OmpProviderState } from '../../shared/ipc'
import type { ChatAnswer } from '../../shared/ipc'
import { notify } from './notify'

interface AccountsState {
  github: GitHubAccount[]
  addFlow: GitHubAddFlowProgress | null
  ompProviders: OmpProviderState[]
  setGithub(accounts: GitHubAccount[]): void
  setAddFlow(progress: GitHubAddFlowProgress | null): void
  setOmpProviders(providers: OmpProviderState[]): void
  refreshGithub(): Promise<void>
  addAccountStart(): Promise<void>
  addAccountCancel(flowId: string): Promise<void>
  switchAccount(host: string, login: string): Promise<void>
  signOutAccount(host: string, login: string): Promise<void>
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
  addFlow: null,
  ompProviders: [],
  setGithub: (accounts) => set({ github: accounts }),
  setAddFlow: (progress) => set({ addFlow: progress }),
  setOmpProviders: (providers) => set({ ompProviders: providers }),
  refreshGithub: async () => {
    const result = await window.refract.accounts.github.list()
    if (!result.ok) {
      notify(result.error)
      return
    }
    set({ github: result.value })
  },
  addAccountStart: async () => {
    const result = await window.refract.accounts.github.addStart()
    if (!result.ok) {
      notify(result.error)
      return
    }
    // The one-time code and progress itself arrive via `accounts:github-add-progress`
    // (init-stores.ts -> setAddFlow); this call only starts the flow and learns its id.
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
    const result = await window.refract.accounts.github.switch(host, login)
    if (!result.ok) {
      notify(result.error)
      return
    }
    set({ github: result.value })
  },
  signOutAccount: async (host, login) => {
    const result = await window.refract.accounts.github.signOut(host, login)
    if (!result.ok) {
      notify(result.error)
      return
    }
    set({ github: result.value })
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
