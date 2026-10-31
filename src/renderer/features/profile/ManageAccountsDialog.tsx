import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import {
  AtSignIcon,
  CheckIcon,
  GlobeIcon,
  LoaderCircleIcon,
  TriangleAlertIcon
} from 'lucide-react'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { ExternalLink } from '@/components/ExternalLink'
import { InlineStatus } from '@/components/InlineStatus'
import { UserAvatar } from '@/components/UserAvatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { findReauthenticatedAccount } from '@/lib/account-format'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { useAccountsStore } from '@/state'
import type { GitHubAccount } from '../../../shared/accounts'
import { AddAccountPanel } from './AddAccountPanel'
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

function rowKey(host: string, login: string): string {
  return `${host}:${login}`
}

function focusButton(el: HTMLElement | null | undefined): boolean {
  if (!el || !document.body.contains(el)) return false
  el.focus()
  return document.activeElement === el
}

function focusWhenReady(preferred: () => boolean, fallback?: () => boolean, tries = 12): void {
  requestAnimationFrame(() => {
    if (preferred()) return
    if (tries <= 1) {
      fallback?.()
      return
    }
    focusWhenReady(preferred, fallback, tries - 1)
  })
}

function isUnreachable(account: GitHubAccount): boolean {
  return account.problem === 'unreachable' || account.state === 'timeout'
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
  const signOutRefs = useRef(new Map<string, HTMLButtonElement>())
  const switchRefs = useRef(new Map<string, HTMLButtonElement>())
  const signInAgainRefs = useRef(new Map<string, HTMLButtonElement>())
  const checkAgainRefs = useRef(new Map<string, HTMLButtonElement>())
  const rowLiRefs = useRef(new Map<string, HTMLLIElement>())
  const prevAddFlowRef = useRef(addFlow)
  const pendingAddAnnounceRef = useRef(false)
  const openRef = useRef(open)
  openRef.current = open

  useImperativeHandle(ref, () => ({
    focusAccountSignOutButton(host, login) {
      return focusButton(signOutRefs.current.get(rowKey(host, login)))
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
      if (isUnreachable(active)) return focusButton(checkAgainRefs.current.get(key))
      return focusButton(signInAgainRefs.current.get(key))
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
      signOutRefs.current.get(rowKey(added.host, added.login))?.focus()
      return
    }
    const reauthed = findReauthenticatedAccount(before, github)
    if (reauthed) {
      announcePolite(`Re-authenticated ${reauthed.displayName ?? reauthed.login}${activeSuffix}`)
      signOutRefs.current.get(rowKey(reauthed.host, reauthed.login))?.focus()
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
    rowLiRefs.current.get(rowKey(account.host, account.login))?.focus()
    const result = await useAccountsStore.getState().switchAccount(account.host, account.login)
    if (result.ok) {
      announcePolite(`Switched active account to ${account.displayName ?? account.login}`)
      signOutRefs.current.get(rowKey(account.host, account.login))?.focus()
    } else {
      announceAssertive(`Could not switch account: ${result.message ?? 'unknown error'}`)
      switchRefs.current.get(rowKey(account.host, account.login))?.focus()
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
        () => focusButton(after.active ? signOutRefs.current.get(key) : switchRefs.current.get(key)),
        () => {
          if (focusButton(signOutRefs.current.get(key))) return true
          const li = rowLiRefs.current.get(key)
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
        () => (after ? focusButton(signInAgainRefs.current.get(key)) : focusButton(addAccountBtnRef.current)),
        () =>
          focusButton(signOutRefs.current.get(key)) ||
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
        if (focusButton(switchRefs.current.get(key))) return true
        if (focusButton(signOutRefs.current.get(key))) return true
        const li = rowLiRefs.current.get(key)
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

  function handleOpenChange(next: boolean): void {
    if (!next) {
      if (addFlow?.status === 'waiting') {
        void useAccountsStore.getState().addAccountCancel(addFlow.flowId)
      } else if (addFlow?.status === 'failed') {
        useAccountsStore.getState().setAddFlow(null)
      }
    }
    onOpenChange(next)
  }

  const headerCheckAgain = (
    <Button
      ref={checkAgainHeaderRef}
      variant="outline"
      size="sm"
      className="shrink-0 aria-disabled:pointer-events-none aria-disabled:opacity-50"
      aria-disabled={githubRefreshing || undefined}
      onClick={() => {
        if (!githubRefreshing) void handleHeaderCheckAgain()
      }}
    >
      {githubRefreshing ? 'Checking…' : 'Check again'}
    </Button>
  )

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

        <section aria-labelledby="github-accounts-heading" className="min-w-0">
          {githubStatus === 'missing-cli' ? (
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <h3 id="github-accounts-heading" className="truncate text-sm font-medium">
                  GitHub CLI not found
                </h3>
                {headerCheckAgain}
              </div>
              <p className="text-sm text-muted-foreground">Refract signs in through the GitHub CLI so it never stores your token.</p>
              <Button asChild variant="outline" size="sm" className="w-fit">
                <ExternalLink ref={installLinkRef} href="https://cli.github.com">
                  Install GitHub CLI
                </ExternalLink>
              </Button>
            </div>
          ) : githubStatus === 'loading' ? (
            <div className="flex min-w-0 items-center gap-2" aria-busy="true">
              <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground" />
              <h3 id="github-accounts-heading" className="text-sm text-muted-foreground">
                Checking GitHub sign-in…
              </h3>
            </div>
          ) : githubStatus === 'error' ? (
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <TriangleAlertIcon aria-hidden className="size-4 shrink-0 text-state-needs-you" />
                <h3 id="github-accounts-heading" className="truncate text-sm font-medium">
                  Couldn't read your GitHub CLI accounts.
                </h3>
              </div>
              {headerCheckAgain}
            </div>          ) : (
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <h3 id="github-accounts-heading" className="truncate text-sm font-medium">
                  GitHub accounts
                </h3>
                <Button
                  ref={addAccountBtnRef}
                  variant={orderedAccounts.length === 0 ? 'default' : 'outline'}
                  size="sm"
                  aria-disabled={starting || addFlow?.status === 'waiting' || undefined}
                  className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                  onClick={() => {
                    if (!starting && addFlow?.status !== 'waiting') void startAddFlow()
                  }}
                >
                  Add account
                </Button>
              </div>

              <AddAccountPanel flow={addFlow} starting={starting} cancelling={cancellingFlow} reauthLogin={reauthLogin} onCancel={handleCancelFlow} onRetry={() => void startAddFlow(reauthLogin)} />

              {orderedAccounts.length === 0 ? (
                <div className="flex flex-col gap-1">
                  <h4 className="text-sm font-medium">No GitHub account is signed in</h4>
                  <p className="text-sm text-muted-foreground">Sign in to review pull requests and check for updates.</p>
                </div>
              ) : (
                <ul role="list" className="flex min-w-0 flex-col gap-2">
                  {orderedAccounts.map((account) => {
                    const key = rowKey(account.host, account.login)
                    const name = account.displayName ?? account.login
                    const busy = pendingSwitch !== null && pendingSwitch.host === account.host && pendingSwitch.login === account.login
                    const switchDisabled = pendingSwitch !== null
                    const authProblem = account.state !== 'success'
                    const unreachable = isUnreachable(account)
                    return (
                      <li
                        key={key}
                        ref={(el) => {
                          if (el) rowLiRefs.current.set(key, el)
                          else rowLiRefs.current.delete(key)
                        }}
                        tabIndex={-1}
                        aria-labelledby={`account-name-${account.host}-${account.login}`}
                        aria-current={account.active ? 'true' : undefined}
                        aria-busy={busy || undefined}
                        className="relative flex min-w-0 items-center gap-2 rounded-md p-2"
                      >
                        {account.active && <ActiveIndicatorBar />}
                        <UserAvatar name={name} src={account.avatarDataUrl ?? undefined} />
                        <div className="flex min-w-0 flex-1 flex-col leading-tight">
                          <div className="flex min-w-0 items-center gap-2">
                            <span id={`account-name-${account.host}-${account.login}`} className="truncate text-sm">
                              {name}
                            </span>
                            {account.active && (
                              <span className="flex shrink-0 items-center gap-1 text-xs">
                                <CheckIcon aria-hidden className="size-4" />
                                Active
                              </span>
                            )}
                          </div>
                          <span className="flex min-w-0 items-center gap-2 truncate text-xs text-muted-foreground">
                            <span className="flex min-w-0 items-center gap-1 truncate">
                              <AtSignIcon aria-hidden className="size-4 shrink-0" />
                              <span className="truncate">{account.login}</span>
                            </span>
                            <span className="flex min-w-0 items-center gap-1 truncate">
                              <GlobeIcon aria-hidden className="size-4 shrink-0" />
                              <span className="truncate">{account.host}</span>
                            </span>
                          </span>
                          {authProblem && (
                            <InlineStatus tone="notice" density="compact" className="flex items-center gap-1 p-0 text-state-needs-you">
                              <TriangleAlertIcon aria-hidden className="size-4" />
                              {unreachable
                                ? "Couldn't reach GitHub."
                                : account.problem === 'expired'
                                  ? 'Sign-in expired.'
                                  : 'Sign-in needs attention.'}
                            </InlineStatus>
                          )}
                          {authProblem && !unreachable && account.host !== 'github.com' && (
                            <InlineStatus density="compact" className="min-w-0 break-all p-0">
                              Sign in again from a terminal with gh auth login --hostname {account.host}.
                            </InlineStatus>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {authProblem && unreachable && (
                            <Button
                              ref={(el) => {
                                if (el) checkAgainRefs.current.set(key, el)
                                else checkAgainRefs.current.delete(key)
                              }}
                              variant="outline"
                              size="sm"
                              aria-disabled={githubRefreshing || undefined}
                              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                              aria-label={githubRefreshing ? `Checking ${name}…` : `Check again for ${name}`}
                              onClick={() => {
                                if (!githubRefreshing) void handleRowCheckAgain(account)
                              }}
                            >
                              {githubRefreshing ? 'Checking…' : 'Check again'}
                            </Button>
                          )}
                          {authProblem && !unreachable && account.host === 'github.com' && (
                            <Button
                              ref={(el) => {
                                if (el) signInAgainRefs.current.set(key, el)
                                else signInAgainRefs.current.delete(key)
                              }}
                              variant="outline"
                              size="sm"
                              aria-disabled={starting || addFlow?.status === 'waiting' || undefined}
                              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                              aria-label={`Sign in again as @${account.login}`}
                              onClick={() => {
                                if (!starting && addFlow?.status !== 'waiting') void startAddFlow(account.login)
                              }}
                            >
                              Sign in again
                            </Button>
                          )}
                          {!account.active && (
                            <Button
                              ref={(el) => {
                                if (el) switchRefs.current.set(key, el)
                                else switchRefs.current.delete(key)
                              }}
                              variant="outline"
                              size="sm"
                              disabled={switchDisabled}
                              aria-label={busy ? `Switching to ${name}` : `Switch active account to ${name}`}
                              onClick={() => void handleSwitch(account)}
                            >
                              {busy ? <LoaderCircleIcon aria-hidden className="size-4 animate-spin" /> : null}
                              {busy ? 'Switching…' : 'Switch'}
                            </Button>
                          )}
                          <Button
                            ref={(el) => {
                              if (el) signOutRefs.current.set(key, el)
                              else signOutRefs.current.delete(key)
                            }}
                            variant="ghost-destructive"
                            size="sm"
                            aria-label={`Sign out ${name}`}
                            onClick={() => onRequestSignOut(account)}
                          >
                            Sign out
                          </Button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}
        </section>

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
