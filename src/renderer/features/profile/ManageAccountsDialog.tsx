import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { findReauthenticatedAccount } from '@/lib/account-format'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { useAccountsStore } from '@/state'
import type { GitHubAccount } from '../../../shared/accounts'
import { focusButton, focusWhenReady, isUnreachable, rowKey } from './accountDialogFocus'
import type { AccountRowRefs } from './GitHubAccountRow'
import { GitHubAccountsSection } from './GitHubAccountsSection'
import { OmpProvidersSection } from './OmpProvidersSection'
export interface ManageAccountsDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  onRequestSignOut(account: GitHubAccount): void
  onCloseFocus?(): void
}

/** Imperative focus targets ProfileItem.tsx needs after the shared SignOutDialog closes (its own */
export interface ManageAccountsDialogHandle {
  focusAccountSignOutButton(host: string, login: string): boolean
  focusAddAccountButton(): boolean
  announce(text: string): void
  startAddFlow(): void
  focusActiveAccountFixButton(): boolean
}

export function ManageAccountsDialog({
  ref,
  open,
  onOpenChange,
  onRequestSignOut,
  onCloseFocus
}: ManageAccountsDialogProps & { ref?: Ref<ManageAccountsDialogHandle> }) {
  const github = useAccountsStore((state) => state.github)
  const githubStatus = useAccountsStore((state) => state.githubStatus)
  const addFlow = useAccountsStore((state) => state.addFlow)
  const addFlowOutcome = useAccountsStore((state) => state.addFlowOutcome)
  const pendingSwitch = useAccountsStore((state) => state.pendingSwitch)
  const githubRefreshing = useAccountsStore((state) => state.githubRefreshing)

  const [starting, setStarting] = useState(false)
  const [reauthLogin, setReauthLogin] = useState<string | null>(null)
  const [cancellingFlow, setCancellingFlow] = useState(false)
  const [polite, announcePolite] = useClearedAnnouncement()
  const [assertive, announceAssertive] = useClearedAnnouncement()

  const addAccountBtnRef = useRef<HTMLButtonElement>(null)
  const installLinkRef = useRef<HTMLAnchorElement>(null)
  const checkAgainHeaderRef = useRef<HTMLButtonElement>(null)
  const rowRefs = useRef<AccountRowRefs>({
    signOut: new Map(),
    switchTo: new Map(),
    signInAgain: new Map(),
    checkAgain: new Map(),
    rowLi: new Map()
  }).current
  const prevAddFlowRef = useRef(addFlow)
  const pendingAddAnnounceRef = useRef(false)
  const openRef = useRef(open)
  openRef.current = open

  useImperativeHandle(ref, () => ({
    focusAccountSignOutButton(host, login) {
      return focusButton(rowRefs.signOut.get(rowKey(host, login)))
    },
    focusAddAccountButton() {
      return focusButton(addAccountBtnRef.current)
    },
    announce(text) {
      announcePolite(text)
    },
    startAddFlow() {
      void startAddFlow()
    },
    focusActiveAccountFixButton() {
      const active = useAccountsStore.getState().github.find((candidate) => candidate.active)
      if (!active) return false
      const key = rowKey(active.host, active.login)
      if (isUnreachable(active)) return focusButton(rowRefs.checkAgain.get(key))
      return focusButton(rowRefs.signInAgain.get(key))
    }
  }))

  useEffect(() => {
    if (!open) return
    void useAccountsStore.getState().refreshOmpProviders()
    void useAccountsStore.getState().refreshGithub()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    const prev = prevAddFlowRef.current
    prevAddFlowRef.current = addFlow
    if (prev && prev.status === 'waiting' && addFlow === null) {
      if (cancellingFlow) {
        setCancellingFlow(false)
        addAccountBtnRef.current?.focus()
      }
      setReauthLogin(null)
      if (addFlowOutcome === 'completed') {
        pendingAddAnnounceRef.current = true
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addFlow, addFlowOutcome, cancellingFlow])

  useEffect(() => {
    if (!pendingAddAnnounceRef.current) return
    pendingAddAnnounceRef.current = false
    const before = useAccountsStore.getState().addFlowSnapshot
    const activeBefore = before.find((candidate) => candidate.active)
    const activeAfter = github.find((candidate) => candidate.active)
    const activeChanged =
      activeAfter !== undefined && (activeBefore === undefined || activeBefore.host !== activeAfter.host || activeBefore.login !== activeAfter.login)
    const activeSuffix = activeChanged ? ' It is now the active account.' : ''
    const added = github.find((account) => !before.some((b) => b.host === account.host && b.login === account.login))
    if (added) {
      announcePolite(`Added GitHub account ${added.displayName ?? added.login}${activeSuffix}`)
      rowRefs.signOut.get(rowKey(added.host, added.login))?.focus()
      return
    }
    const reauthed = findReauthenticatedAccount(before, github)
    if (reauthed) {
      announcePolite(`Re-authenticated ${reauthed.displayName ?? reauthed.login}${activeSuffix}`)
      rowRefs.signOut.get(rowKey(reauthed.host, reauthed.login))?.focus()
    } else {
      announcePolite(`Re-authenticated with GitHub${activeSuffix}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [github])

  async function startAddFlow(reauth: string | null = null): Promise<void> {
    if (addFlow?.status === 'waiting' || starting) return
    setReauthLogin(reauth)
    if (addFlow?.status === 'failed') useAccountsStore.getState().setAddFlow(null)
    setCancellingFlow(false)
    setStarting(true)
    const started = await useAccountsStore.getState().addAccountStart()
    setStarting(false)
    if (!started) {
      setReauthLogin(null)
      announceAssertive('Could not start sign-in')
      addAccountBtnRef.current?.focus()
      return
    }
    if (!openRef.current) {
      const flowId = useAccountsStore.getState().addFlow?.flowId
      if (flowId) void useAccountsStore.getState().addAccountCancel(flowId)
    }
  }

  function handleCancelFlow(flowId: string): void {
    setCancellingFlow(true)
    void (async () => {
      const result = await useAccountsStore.getState().addAccountCancel(flowId)
      if (!result.ok) {
        setCancellingFlow(false)
        announceAssertive(`Could not cancel sign-in: ${result.message ?? 'unknown error'}`)
      }
    })()
  }

  async function handleSwitch(account: GitHubAccount): Promise<void> {
    rowRefs.rowLi.get(rowKey(account.host, account.login))?.focus()
    const result = await useAccountsStore.getState().switchAccount(account.host, account.login)
    if (result.ok) {
      announcePolite(`Switched active account to ${account.displayName ?? account.login}`)
      rowRefs.signOut.get(rowKey(account.host, account.login))?.focus()
    } else {
      announceAssertive(`Could not switch account: ${result.message ?? 'unknown error'}`)
      rowRefs.switchTo.get(rowKey(account.host, account.login))?.focus()
    }
  }

  async function handleRowCheckAgain(account: GitHubAccount): Promise<void> {
    if (useAccountsStore.getState().githubRefreshing) return
    const key = rowKey(account.host, account.login)
    await useAccountsStore.getState().refreshGithub()
    if (useAccountsStore.getState().githubStatus === 'missing-cli') {
      announcePolite('GitHub CLI not found')
      focusWhenReady(
        () => focusButton(installLinkRef.current),
        () => focusButton(checkAgainHeaderRef.current)
      )
      return
    }
    const after = useAccountsStore.getState().github.find((candidate) => candidate.host === account.host && candidate.login === account.login)
    if (after && after.state === 'success') {
      announcePolite('GitHub is reachable again')
      // A non-active row offers Switch first; the active row has none, so it goes to Sign out.
      focusWhenReady(
        () => focusButton(after.active ? rowRefs.signOut.get(key) : rowRefs.switchTo.get(key)),
        () => {
          if (focusButton(rowRefs.signOut.get(key))) return true
          const li = rowRefs.rowLi.get(key)
          if (!li) return false
          li.focus()
          return true
        }
      )
    } else if (after && isUnreachable(after)) {
      announceAssertive("Still can't reach GitHub")
    } else {
      announcePolite(after ? `GitHub is reachable. Sign in again as @${account.login}.` : 'That account is no longer signed in.')
      focusWhenReady(
        // The row is gone when `after` is undefined, so Add account is the target then.
        () => (after ? focusButton(rowRefs.signInAgain.get(key)) : focusButton(addAccountBtnRef.current)),
        () =>
          focusButton(rowRefs.signOut.get(key)) ||
          focusButton(addAccountBtnRef.current) ||
          focusButton(checkAgainHeaderRef.current) ||
          focusButton(installLinkRef.current)
      )
    }
  }

  async function handleHeaderCheckAgain(): Promise<void> {
    if (useAccountsStore.getState().githubRefreshing) return
    await useAccountsStore.getState().refreshGithub()
    const status = useAccountsStore.getState().githubStatus
    if (status === 'error') {
      // Still showing this same button -- focus already stays put; only the announcement is new.
      announceAssertive("Still can't read your GitHub CLI accounts")
      return
    }
    if (status === 'missing-cli') {
      announcePolite('GitHub CLI not found')
      focusWhenReady(() => focusButton(installLinkRef.current))
      return
    }
    announcePolite('GitHub accounts loaded')
    focusWhenReady(
      () => focusButton(addAccountBtnRef.current),
      () => {
        const freshGithub = useAccountsStore.getState().github
        const first = [...freshGithub.filter((a) => a.active), ...freshGithub.filter((a) => !a.active)][0]
        if (!first) return false
        const key = rowKey(first.host, first.login)
        if (focusButton(rowRefs.switchTo.get(key))) return true
        if (focusButton(rowRefs.signOut.get(key))) return true
        const li = rowRefs.rowLi.get(key)
        if (!li) return false
        li.focus()
        return true
      }
    )
  }

  function handleEscape(event: Event): void {
    const flowActive = starting || addFlow?.status === 'waiting'
    if (flowActive) {
      event.preventDefault()
      if (addFlow) handleCancelFlow(addFlow.flowId)
    }
  }

  function handleDismissFlow(): void {
    useAccountsStore.getState().setAddFlow(null)
    setReauthLogin(null)
    addAccountBtnRef.current?.focus()
  }

  function handleOpenChange(next: boolean): void {
    if (!next) {
      if (addFlow?.status === 'waiting') {
        void useAccountsStore.getState().addAccountCancel(addFlow.flowId)
      } else if (addFlow?.status === 'failed') {
        useAccountsStore.getState().setAddFlow(null)
        setReauthLogin(null)
      }
    }
    onOpenChange(next)
  }

  const orderedAccounts = [...github.filter((a) => a.active), ...github.filter((a) => !a.active)]

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="min-w-0 max-h-[min(680px,calc(100vh-4rem))] overflow-y-auto sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          if (addAccountBtnRef.current) {
            event.preventDefault()
            addAccountBtnRef.current.focus()
          } else if (installLinkRef.current) {
            event.preventDefault()
            installLinkRef.current.focus()
          } else if (checkAgainHeaderRef.current) {
            event.preventDefault()
            checkAgainHeaderRef.current.focus()
          }
        }}
        onEscapeKeyDown={handleEscape}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onCloseFocus?.()
        }}
      >
        <DialogHeader>
          <DialogTitle>Manage accounts</DialogTitle>
          <DialogDescription>
            Refract uses the accounts your command line tools are signed in to. It never stores their tokens.
          </DialogDescription>
        </DialogHeader>

        <GitHubAccountsSection
          status={githubStatus}
          accounts={orderedAccounts}
          rowRefs={rowRefs}
          addAccountRef={addAccountBtnRef}
          installLinkRef={installLinkRef}
          checkAgainHeaderRef={checkAgainHeaderRef}
          githubRefreshing={githubRefreshing}
          starting={starting}
          addFlow={addFlow}
          cancellingFlow={cancellingFlow}
          reauthLogin={reauthLogin}
          pendingSwitch={pendingSwitch}
          onHeaderCheckAgain={() => void handleHeaderCheckAgain()}
          onAddAccount={() => void startAddFlow()}
          onSignInAgain={(login) => void startAddFlow(login)}
          onCancelFlow={handleCancelFlow}
          onRetryFlow={() => void startAddFlow(reauthLogin)}
          onDismissFlow={handleDismissFlow}
          onRowCheckAgain={(account) => void handleRowCheckAgain(account)}
          onSwitch={(account) => void handleSwitch(account)}
          onSignOut={onRequestSignOut}
        />
        <Separator />

        <OmpProvidersSection announcePolite={announcePolite} announceAssertive={announceAssertive} />

        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {polite}
        </div>
        <div aria-live="assertive" aria-atomic="true" className="sr-only">
          {assertive}
        </div>
      </DialogContent>
    </Dialog>
  )
}
