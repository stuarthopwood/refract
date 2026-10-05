// Manage accounts (FR-008 to FR-011, FR-014, T016/T017): lists every GitHub CLI account,
// offers Switch/Sign out per row, and hosts the inline add-account flow (AddAccountPanel.tsx)
// under its own section header. Sign-out confirmation itself lives one level up, in
// ProfileItem.tsx -- this dialog only asks its caller (`onRequestSignOut`) to open it, since the
// same confirmation is also reachable from the profile menu's own Sign out item, outside this
// dialog entirely.
import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import {
  AtSignIcon,
  CheckIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LoaderCircleIcon,
  TriangleAlertIcon
} from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { initials } from '@/lib/initials'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/state'
import type { GitHubAccount } from '../../../shared/ipc'
import { AddAccountPanel } from './AddAccountPanel'

export interface ManageAccountsDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** Asks the caller (ProfileItem.tsx) to open the shared SignOutDialog for `account`; this
   *  dialog never confirms a sign-out itself. */
  onRequestSignOut(account: GitHubAccount): void
}

/** Imperative focus targets ProfileItem.tsx needs after the shared SignOutDialog closes (its own
 *  focus map depends on whether the row that launched it, here, got a new active account or not
 *  -- state this dialog owns, not ProfileItem). */
export interface ManageAccountsDialogHandle {
  focusAccountSignOutButton(host: string, login: string): void
  focusAddAccountButton(): void
}

function rowKey(host: string, login: string): string {
  return `${host}:${login}`
}

export function ManageAccountsDialog({
  ref,
  open,
  onOpenChange,
  onRequestSignOut
}: ManageAccountsDialogProps & { ref?: Ref<ManageAccountsDialogHandle> }) {
  const github = useAccountsStore((state) => state.github)
  const githubStatus = useAccountsStore((state) => state.githubStatus)
  const addFlow = useAccountsStore((state) => state.addFlow)
  const pendingSwitch = useAccountsStore((state) => state.pendingSwitch)

  const [starting, setStarting] = useState(false)
  const [cancellingFlow, setCancellingFlow] = useState(false)
  const [polite, setPolite] = useState('')
  const [assertive, setAssertive] = useState('')

  const addAccountBtnRef = useRef<HTMLButtonElement>(null)
  const signOutRefs = useRef(new Map<string, HTMLButtonElement>())
  const switchRefs = useRef(new Map<string, HTMLButtonElement>())
  const rowLiRefs = useRef(new Map<string, HTMLLIElement>())
  const addFlowSnapshotRef = useRef<GitHubAccount[]>([])
  const prevAddFlowRef = useRef(addFlow)
  const pendingAddAnnounceRef = useRef(false)

  useImperativeHandle(ref, () => ({
    focusAccountSignOutButton(host, login) {
      signOutRefs.current.get(rowKey(host, login))?.focus()
    },
    focusAddAccountButton() {
      addAccountBtnRef.current?.focus()
    }
  }))

  // Open focus (approved design): the first row's action when there are accounts, else Add
  // account (the empty state's primary button).
  useEffect(() => {
    if (!open) return
    const active = github.find((account) => account.active) ?? github[0]
    if (active) {
      signOutRefs.current.get(rowKey(active.host, active.login))?.focus()
    } else {
      addAccountBtnRef.current?.focus()
    }
    // Only on open itself -- not every time `github` changes while it stays open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Detects an add flow's own completion vs. cancellation: the store nulls `addFlow` for both,
  // so this panel is the only place that still knows WHICH one happened, via the Cancel button's
  // own `cancellingFlow` flag (the only way a flow here ever becomes 'cancelled').
  useEffect(() => {
    const prev = prevAddFlowRef.current
    prevAddFlowRef.current = addFlow
    if (prev && prev.status === 'waiting' && addFlow === null) {
      if (cancellingFlow) {
        setCancellingFlow(false)
        addAccountBtnRef.current?.focus()
      } else {
        pendingAddAnnounceRef.current = true
      }
    }
    if (addFlow?.status === 'failed') {
      setAssertive(`Sign-in failed.${addFlow.detail ? ` ${addFlow.detail}` : ''}`)
    }
  }, [addFlow, cancellingFlow])

  // Once the completed flow's new account actually shows up in `github` (it can arrive slightly
  // after the 'completed' progress event -- contracts/ipc.md), announce and focus it.
  useEffect(() => {
    if (!pendingAddAnnounceRef.current) return
    const before = addFlowSnapshotRef.current
    const added = github.find((account) => !before.some((b) => b.host === account.host && b.login === account.login))
    if (!added) return
    pendingAddAnnounceRef.current = false
    setPolite(`Added GitHub account ${added.displayName ?? added.login}`)
    signOutRefs.current.get(rowKey(added.host, added.login))?.focus()
  }, [github])

  async function startAddFlow(): Promise<void> {
    if (addFlow || starting) return
    addFlowSnapshotRef.current = github
    setCancellingFlow(false)
    setAssertive('')
    setStarting(true)
    await useAccountsStore.getState().addAccountStart()
    setStarting(false)
  }

  function handleCancelFlow(flowId: string): void {
    setCancellingFlow(true)
    void useAccountsStore.getState().addAccountCancel(flowId)
  }

  async function handleSwitch(account: GitHubAccount): Promise<void> {
    rowLiRefs.current.get(rowKey(account.host, account.login))?.focus()
    const result = await useAccountsStore.getState().switchAccount(account.host, account.login)
    if (result.ok) {
      setPolite(`Switched active account to ${account.displayName ?? account.login}`)
      signOutRefs.current.get(rowKey(account.host, account.login))?.focus()
    } else {
      setAssertive(`Could not switch account: ${result.message ?? 'unknown error'}`)
      switchRefs.current.get(rowKey(account.host, account.login))?.focus()
    }
  }

  function handleEscape(event: Event): void {
    const flowActive = starting || addFlow?.status === 'waiting'
    if (flowActive) {
      event.preventDefault()
      if (addFlow) handleCancelFlow(addFlow.flowId)
    }
  }

  function handleOpenChange(next: boolean): void {
    if (!next && addFlow && addFlow.status === 'waiting') {
      void useAccountsStore.getState().addAccountCancel(addFlow.flowId)
    }
    onOpenChange(next)
  }

  const orderedAccounts = [...github.filter((a) => a.active), ...github.filter((a) => !a.active)]

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg" onEscapeKeyDown={handleEscape}>
        <DialogHeader>
          <DialogTitle>Manage accounts</DialogTitle>
          <DialogDescription>
            Refract uses the accounts your command line tools are signed in to. It never stores their tokens.
          </DialogDescription>
        </DialogHeader>

        {githubStatus === 'missing-cli' ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">GitHub CLI not found</h3>
            <p className="text-sm text-muted-foreground">Refract signs in through the GitHub CLI so it never stores your token.</p>
            <a
              href="https://cli.github.com"
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex w-fit items-center gap-1.5 text-sm underline underline-offset-2"
            >
              <ExternalLinkIcon aria-hidden className="size-3.5" />
              Install GitHub CLI
            </a>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">GitHub accounts</h3>
              <Button
                ref={addAccountBtnRef}
                variant={orderedAccounts.length === 0 ? 'default' : 'outline'}
                size="sm"
                aria-label="Add GitHub account"
                disabled={starting || addFlow !== null}
                onClick={() => void startAddFlow()}
              >
                Add account
              </Button>
            </div>

            {orderedAccounts.length === 0 ? (
              <div className="flex flex-col gap-1">
                <h4 className="text-sm font-medium">No GitHub account is signed in</h4>
                <p className="text-sm text-muted-foreground">Sign in to review pull requests and check for updates.</p>
              </div>
            ) : (
              <ul role="list" className="flex max-h-64 flex-col gap-2 overflow-y-auto">
                {orderedAccounts.map((account) => {
                  const key = rowKey(account.host, account.login)
                  const name = account.displayName ?? account.login
                  const busy = pendingSwitch !== null && pendingSwitch.host === account.host && pendingSwitch.login === account.login
                  const switchDisabled = pendingSwitch !== null
                  const authProblem = account.state !== 'success'
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
                      className={cn(
                        'flex items-center gap-2 rounded-md border border-transparent p-2',
                        account.active && 'border-l-2 border-l-active-indicator'
                      )}
                    >
                      <Avatar>
                        <AvatarImage src={account.avatarDataUrl ?? undefined} alt="" />
                        <AvatarFallback>{initials(name)}</AvatarFallback>
                      </Avatar>
                      <div className="flex min-w-0 flex-1 flex-col leading-tight">
                        <div className="flex items-center gap-2">
                          <span id={`account-name-${account.host}-${account.login}`} className="truncate text-sm font-medium">
                            {name}
                          </span>
                          {account.active && (
                            <span className="flex shrink-0 items-center gap-1 text-xs font-medium">
                              <CheckIcon aria-hidden className="size-3.5" />
                              Active
                            </span>
                          )}
                        </div>
                        <span className="flex min-w-0 items-center gap-2 truncate text-xs text-muted-foreground">
                          <span className="flex min-w-0 items-center gap-1 truncate">
                            <AtSignIcon aria-hidden className="size-3 shrink-0" />
                            <span className="truncate">{account.login}</span>
                          </span>
                          <span className="flex min-w-0 items-center gap-1 truncate">
                            <GlobeIcon aria-hidden className="size-3 shrink-0" />
                            <span className="truncate">{account.host}</span>
                          </span>
                        </span>
                        {authProblem && (
                          <span className="flex items-center gap-1 text-xs font-medium text-state-needs-you">
                            <TriangleAlertIcon aria-hidden className="size-3" />
                            Needs attention
                          </span>
                        )}
                        {authProblem && account.host === 'github.com' && (
                          <Button variant="outline" size="xs" className="w-fit" aria-label={`Sign in again to ${name}`} onClick={() => void startAddFlow()}>
                            Sign in again
                          </Button>
                        )}
                        {authProblem && account.host !== 'github.com' && (
                          <span className="text-xs text-muted-foreground">
                            Sign in again from a terminal with gh auth login --hostname {account.host}.
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {!account.active && (
                          <Button
                            ref={(el) => {
                              if (el) switchRefs.current.set(key, el)
                              else switchRefs.current.delete(key)
                            }}
                            variant="outline"
                            size="sm"
                            disabled={switchDisabled}
                            aria-label={`Switch active account to ${name}`}
                            onClick={() => void handleSwitch(account)}
                          >
                            {busy ? <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" /> : null}
                            {busy ? 'Switching…' : 'Switch'}
                          </Button>
                        )}
                        <Button
                          ref={(el) => {
                            if (el) signOutRefs.current.set(key, el)
                            else signOutRefs.current.delete(key)
                          }}
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
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

            <AddAccountPanel flow={addFlow} starting={starting} onCancel={handleCancelFlow} onRetry={() => void startAddFlow()} />
          </div>
        )}

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
