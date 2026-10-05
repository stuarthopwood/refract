// Shared sign-out confirmation (FR-011, T016): one AlertDialog instance used from both
// ManageAccountsDialog's per-row Sign out button and ProfileMenu's Sign out item (ProfileItem.tsx
// owns the single instance as a sibling of the DropdownMenu, never nested inside menu content --
// menu items unmount when the menu closes, which would unmount a dialog launched from inside it).
//
// Focus-on-close relies on Radix's own default restore-to-previously-focused-element behaviour
// for the Cancel path (which already lands correctly on either the profile item's name button or
// the Manage accounts row that opened this, since that is whatever had focus the instant this
// dialog mounted) -- only the Confirm path needs an explicit override via `onConfirmFocus`, since
// the account that had focus may no longer be the right place to land (it may have just signed
// out, or a different account may now be active).
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { signOutSuccessor } from '@/lib/account-format'
import { useAccountsStore } from '@/state'
import type { GitHubAccount } from '../../../shared/ipc'

export interface SignOutDialogProps {
  /** Non-null opens the dialog for this account. */
  account: GitHubAccount | null
  /** The full, raw-CLI-order account list (data-model.md), used only to work out which account
   *  becomes active next (FR-011) -- never Manage accounts' own active-first display order. */
  accounts: GitHubAccount[]
  onOpenChange(open: boolean): void
  /** Called once `signOutAccount` actually succeeds, before the dialog starts closing. Lets the
   *  caller announce "Signed out {name}" without this dialog needing to know which surface
   *  (Manage accounts row vs. the profile menu) launched it. */
  onConfirmed(account: GitHubAccount): void
  /** Called once, right as a successful sign-out starts closing this dialog. Returning `true`
   *  means the caller already moved focus itself; this dialog then suppresses Radix's own
   *  close-auto-focus so the two never fight over where focus lands. Returning `false` (or
   *  omitting the prop) falls back to Radix's default restore. */
  onConfirmFocus?(account: GitHubAccount): boolean
}

function signOutBody(account: GitHubAccount, accounts: GitHubAccount[]): string {
  if (!account.active) {
    return `Sign out @${account.login} on ${account.host}? Your other accounts will remain signed in.`
  }
  const next = signOutSuccessor(accounts, account)
  if (next) {
    return `Sign out @${account.login} on ${account.host}? @${next.login} will become the active account.`
  }
  return `Sign out @${account.login} on ${account.host}? No account will remain active.`
}

export function SignOutDialog({ account, accounts, onOpenChange, onConfirmed, onConfirmFocus }: SignOutDialogProps) {
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Same live-account-vs-closure-capture rationale as DeleteDialog.tsx's sessionIdRef: an async
  // handleConfirm in flight must never act on a DIFFERENT account's dialog that opened while it
  // awaited.
  const accountRef = useRef(account)
  accountRef.current = account
  // Kept so the closing animation (open -> false) still has an account to render, the same
  // reason DeleteDialog.tsx's own AlertDialogContent never conditionally unmounts on its prop.
  const lastAccountRef = useRef<GitHubAccount | null>(account)
  if (account) lastAccountRef.current = account
  const justConfirmedRef = useRef(false)

  useEffect(() => {
    if (!account) return
    setSigningOut(false)
    setError(null)
    justConfirmedRef.current = false
  }, [account])

  async function handleConfirm(): Promise<void> {
    const target = accountRef.current
    if (!target) return
    setSigningOut(true)
    setError(null)
    const result = await useAccountsStore.getState().signOutAccount(target.host, target.login)
    if (accountRef.current !== target) return
    setSigningOut(false)
    if (!result.ok) {
      setError(`Could not sign out: ${result.message ?? 'unknown error'}`)
      return
    }
    justConfirmedRef.current = true
    onConfirmed(target)
    onOpenChange(false)
  }

  const displayAccount = lastAccountRef.current
  if (!displayAccount) return null

  return (
    <AlertDialog
      open={account !== null}
      onOpenChange={(next) => {
        if (!signingOut) onOpenChange(next)
      }}
    >
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          cancelRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          if (!justConfirmedRef.current) return
          justConfirmedRef.current = false
          if (onConfirmFocus?.(displayAccount)) {
            event.preventDefault()
          }
        }}
        onEscapeKeyDown={(event) => {
          if (signingOut) event.preventDefault()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out @{displayAccount.login}?</AlertDialogTitle>
          <AlertDialogDescription>{signOutBody(displayAccount, accounts)}</AlertDialogDescription>
        </AlertDialogHeader>
        <p role="alert" className={cn('text-sm text-destructive', !error && 'sr-only')}>
          {error ?? ''}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel
            ref={cancelRef}
            aria-disabled={signingOut}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={(event) => {
              if (signingOut) event.preventDefault()
            }}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            aria-disabled={signingOut}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={(event) => {
              event.preventDefault()
              if (signingOut) return
              void handleConfirm()
            }}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
