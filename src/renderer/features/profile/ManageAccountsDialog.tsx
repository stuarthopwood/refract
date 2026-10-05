// Manage accounts (FR-008 to FR-011, FR-014, FR-016, T016/T017/T019): lists every GitHub CLI
// account, offers Switch/Sign out per row, hosts the inline add-account flow
// (AddAccountPanel.tsx) directly under its own section header, and (below a separator) the
// read-only OMP provider section (OmpProvidersSection.tsx). Sign-out confirmation itself lives
// one level up, in ProfileItem.tsx -- this dialog only asks its caller (`onRequestSignOut`) to
// open it, since the same confirmation is also reachable from the profile menu's own Sign out
// item, outside this dialog entirely.
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
import { Separator } from '@/components/ui/separator'
import { findReauthenticatedAccount } from '@/lib/account-format'
import { initials } from '@/lib/initials'
import { cn } from '@/lib/utils'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { useAccountsStore } from '@/state'
import type { GitHubAccount } from '../../../shared/ipc'
import { AddAccountPanel } from './AddAccountPanel'
import { OmpProvidersSection } from './OmpProvidersSection'

export interface ManageAccountsDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** Asks the caller (ProfileItem.tsx) to open the shared SignOutDialog for `account`; this
   *  dialog never confirms a sign-out itself. */
  onRequestSignOut(account: GitHubAccount): void
  /** Called on every close (Esc, the X button, or programmatically), after this dialog's own
   *  close-auto-focus is suppressed -- the caller (ProfileItem.tsx) always returns focus to the
   *  profile item's name button, since nothing inside this dialog is a better target once it is
   *  gone. */
  onCloseFocus?(): void
}

/** Imperative focus targets ProfileItem.tsx needs after the shared SignOutDialog closes (its own
 *  focus map depends on whether the row that launched it, here, got a new active account or not
 *  -- state this dialog owns, not ProfileItem). Each method returns whether it actually found and
 *  focused a live element, so the caller can fall back to a different target when the original
 *  row is gone (e.g. the account it belonged to was just signed out). */
export interface ManageAccountsDialogHandle {
  focusAccountSignOutButton(host: string, login: string): boolean
  focusAddAccountButton(): boolean
  /** Writes to this dialog's own polite live region (quality-gate remediation, accessibility-
   *  auditor High): Radix hides everything outside an open modal dialog from assistive tech, so
   *  a status message produced while this dialog is open -- e.g. ProfileItem.tsx's "Signed out
   *  {name}" after a Manage accounts row's own Sign out confirms -- must be announced from a
   *  region inside THIS dialog, not the caller's own (which stays hidden for as long as this
   *  dialog stays open). A no-op while this dialog is closed (nothing is listening). */
  announce(text: string): void
  /** Runs the exact same guarded start this dialog's own Add account button runs (status
   *  gating, aria-disabled, assertive failure announcement + refocus) -- quality-gate
   *  remediation (code-reviewer/accessibility-auditor Medium): the profile menu's "Sign in to
   *  GitHub…" item opens this dialog and calls this instead of `addAccountStart()` directly,
   *  which used to bypass every one of those guards and could start a second, concurrent flow. */
  startAddFlow(): void
}

function rowKey(host: string, login: string): string {
  return `${host}:${login}`
}

function focusButton(el: HTMLButtonElement | null | undefined): boolean {
  if (!el || !document.body.contains(el)) return false
  el.focus()
  return true
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

  const [starting, setStarting] = useState(false)
  const [cancellingFlow, setCancellingFlow] = useState(false)
  const [polite, announcePolite] = useClearedAnnouncement()
  const [assertive, announceAssertive] = useClearedAnnouncement()

  const addAccountBtnRef = useRef<HTMLButtonElement>(null)
  // Accessibility-auditor High: the CLI-missing branch renders no Add account button at all, so
  // `onOpenAutoFocus` below needs a second, always-present target for that branch.
  const installLinkRef = useRef<HTMLAnchorElement>(null)
  const signOutRefs = useRef(new Map<string, HTMLButtonElement>())
  const switchRefs = useRef(new Map<string, HTMLButtonElement>())
  const rowLiRefs = useRef(new Map<string, HTMLLIElement>())
  const prevAddFlowRef = useRef(addFlow)
  const pendingAddAnnounceRef = useRef(false)
  // Quality-gate remediation (code-reviewer High): `startAddFlow` is async and `open` can change
  // while it awaits; a ref (not the `open` prop itself) is what a callback running after that
  // await needs to see this render's latest value, same reasoning as SignOutDialog.tsx's own
  // `accountRef`.
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
    }
  }))

  // T019: a real OMP read spawns a scratch process (~4.7 s measured) -- fetched once per dialog
  // open, never eagerly at app start and never re-fetched just because `open` stays true (the
  // section's own "Check again"/"Retry" are the only other triggers).
  useEffect(() => {
    if (!open) return
    void useAccountsStore.getState().refreshOmpProviders()
    // data-model.md / plan.md: the GitHub account list is refreshed on open too, the same
    // stale-while-revalidate way the OMP section already is -- `refreshGithub` itself is a cheap
    // no-op if a read is already in flight (e.g. the profile menu triggered one just before this
    // dialog opened).
    void useAccountsStore.getState().refreshGithub()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Detects an add flow's own completion vs. cancellation (quality-gate remediation, code-
  // reviewer Medium, root cause fix): the store nulls `addFlow` identically for BOTH outcomes, so
  // this effect used to infer which one happened from the Cancel button's own `cancellingFlow`
  // flag alone -- which only covers a click on THIS dialog's own Cancel button, never closing the
  // dialog mid-flow (X/overlay) or the closed-while-starting auto-cancel `startAddFlow` issues
  // itself, both of which armed the "Added…"/"Re-authenticated…" announcement by mistake.
  // `addFlowOutcome` (the store's own last terminal status) is now the sole source of truth for
  // THAT decision; `cancellingFlow` still only resets this dialog's own Cancel button UI.
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
    // A failed flow's own "Sign-in failed..." is announced once, by AddAccountPanel.tsx's own
    // `role="alert"` paragraph -- quality-gate remediation (accessibility-auditor Low): a second
    // assertive announcement from here was making a screen reader hear it twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addFlow, addFlowOutcome, cancellingFlow])

  // Once the completed flow's new account actually shows up in `github` (it can arrive slightly
  // after the 'completed' progress event -- contracts/ipc.md), announce and focus it.
  useEffect(() => {
    if (!pendingAddAnnounceRef.current) return
    // Quality-gate remediation (code-reviewer Medium): cleared unconditionally, not only once an
    // "added" account is found -- a "Sign in again" re-auth of an account already in the
    // snapshot would otherwise leave this armed forever, mis-announcing the next unrelated flow.
    pendingAddAnnounceRef.current = false
    const before = useAccountsStore.getState().addFlowSnapshot
    const added = github.find((account) => !before.some((b) => b.host === account.host && b.login === account.login))
    if (added) {
      announcePolite(`Added GitHub account ${added.displayName ?? added.login}`)
      signOutRefs.current.get(rowKey(added.host, added.login))?.focus()
      return
    }
    // No brand new account appeared: this was a re-authentication of one already in the list,
    // which still deserves its own announcement.
    const reauthed = findReauthenticatedAccount(before, github)
    if (reauthed) {
      announcePolite(`Re-authenticated ${reauthed.displayName ?? reauthed.login}`)
      signOutRefs.current.get(rowKey(reauthed.host, reauthed.login))?.focus()
    } else {
      announcePolite('Re-authenticated with GitHub')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [github])

  async function startAddFlow(): Promise<void> {
    // Blocks only while a flow is actually running (quality-gate remediation, code-reviewer
    // High): a 'failed' flow must never keep blocking Add account/Retry/Sign in again forever.
    if (addFlow?.status === 'waiting' || starting) return
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
      // Quality-gate remediation (code-reviewer Medium): the dialog was closed (overlay click,
      // the X button -- anything other than Escape, which `handleEscape` already blocks) while
      // this request was still in flight, before `addFlow` had a `flowId` to cancel by. Now
      // that one exists, cancel immediately rather than leaving `gh auth login` running
      // unattended.
      const flowId = useAccountsStore.getState().addFlow?.flowId
      if (flowId) void useAccountsStore.getState().addAccountCancel(flowId)
    }
  }

  function handleCancelFlow(flowId: string): void {
    setCancellingFlow(true)
    void (async () => {
      const result = await useAccountsStore.getState().addAccountCancel(flowId)
      if (!result.ok) {
        // Quality-gate remediation (accessibility-auditor Medium): otherwise Cancel is stuck on
        // "Cancelling…" for good -- a successful cancel already resets this via the add-flow
        // detection effect above, once `addFlow` actually goes null.
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
        // Quality-gate remediation (code-reviewer High): a failed flow must not survive into the
        // next open, where it would otherwise keep blocking Add account/Retry/Sign in again.
        useAccountsStore.getState().setAddFlow(null)
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
          // Approved design (docs/DESIGN.md): focus always starts on the GitHub section's Add
          // account button, regardless of whether any account is signed in yet (quality-gate
          // remediation, code-reviewer Medium: the previous `[open]` effect ran before Radix's
          // own Portal commit mounted these refs and never actually focused anything). The
          // CLI-missing branch renders no Add account button at all (accessibility-auditor
          // High, round 2): `preventDefault` only fires when a real focus target exists here,
          // so that branch focuses the Install GitHub CLI link instead rather than leaving focus
          // outside the dialog entirely.
          if (addAccountBtnRef.current) {
            event.preventDefault()
            addAccountBtnRef.current.focus()
          } else if (installLinkRef.current) {
            event.preventDefault()
            installLinkRef.current.focus()
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
              <h3 id="github-accounts-heading" className="text-sm font-medium">
                GitHub CLI not found
              </h3>
              <p className="text-sm text-muted-foreground">Refract signs in through the GitHub CLI so it never stores your token.</p>
              <a
                ref={installLinkRef}
                href="https://cli.github.com"
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex w-fit items-center gap-1.5 text-sm underline underline-offset-2"
              >
                <ExternalLinkIcon aria-hidden className="size-3.5" />
                Install GitHub CLI
                <span className="sr-only"> Opens in your browser</span>
              </a>
            </div>
          ) : (
            <div className="flex min-w-0 flex-col gap-3">
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
                    // `aria-disabled`, not `disabled` (quality-gate remediation, accessibility-
                    // auditor High): a disabled focused button drops focus to <body>.
                    if (!starting && addFlow?.status !== 'waiting') void startAddFlow()
                  }}
                >
                  Add account
                </Button>
              </div>

              <AddAccountPanel flow={addFlow} starting={starting} cancelling={cancellingFlow} onCancel={handleCancelFlow} onRetry={() => void startAddFlow()} />

              {orderedAccounts.length === 0 ? (
                <div className="flex flex-col gap-1">
                  <h4 className="text-sm font-medium">No GitHub account is signed in</h4>
                  <p className="text-sm text-muted-foreground">Sign in to review pull requests and check for updates.</p>
                </div>
              ) : (
                <ul role="list" className="flex min-w-0 max-h-48 flex-col gap-2 overflow-y-auto">
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
                          'flex min-w-0 items-center gap-2 rounded-md border border-transparent p-2',
                          account.active && 'border-l-2 border-l-active-indicator'
                        )}
                      >
                        <Avatar>
                          <AvatarImage src={account.avatarDataUrl ?? undefined} alt="" />
                          <AvatarFallback>{initials(name)}</AvatarFallback>
                        </Avatar>
                        <div className="flex min-w-0 flex-1 flex-col leading-tight">
                          <div className="flex min-w-0 items-center gap-2">
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
                          {/* UI M2 (quality-gate remediation): the status line now states the
                              actual cause -- a 'timeout' is offline/unreachable (Sign in again
                              cannot fix that), anything else is an expired/revoked credential
                              (Sign in again can). Both are icon + text, never colour alone. */}
                          {authProblem && (
                            <span className="flex items-center gap-1 text-xs font-medium text-state-needs-you">
                              <TriangleAlertIcon aria-hidden className="size-3" />
                              {account.state === 'timeout' ? "Couldn't reach GitHub" : `Sign-in expired. Sign in again as @${account.login}.`}
                            </span>
                          )}
                          {authProblem && account.state !== 'timeout' && account.host !== 'github.com' && (
                            <span className="min-w-0 break-all text-xs text-muted-foreground">
                              Sign in again from a terminal with gh auth login --hostname {account.host}.
                            </span>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {/* UI M1 (quality-gate remediation): moved out of the text column into
                              this trailing action cluster, before Sign out, so it sits next to
                              Switch/Sign out instead of far away on its own row. */}
                          {authProblem && account.state === 'timeout' && (
                            <Button
                              variant="outline"
                              size="sm"
                              aria-label={`Check again for ${name}`}
                              onClick={() => void useAccountsStore.getState().refreshGithub()}
                            >
                              Check again
                            </Button>
                          )}
                          {authProblem && account.state !== 'timeout' && account.host === 'github.com' && (
                            <Button
                              variant="outline"
                              size="sm"
                              aria-disabled={starting || addFlow?.status === 'waiting' || undefined}
                              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                              aria-label={`Sign in again to ${name}`}
                              onClick={() => {
                                if (!starting && addFlow?.status !== 'waiting') void startAddFlow()
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
