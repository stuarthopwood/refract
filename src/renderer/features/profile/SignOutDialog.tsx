// Shared sign-out confirmation for ManageAccountsDialog and ProfileMenu; the single instance lives outside the
// menu, whose items unmount on close. Focus-on-close is always explicit via `onCloseFocus`: there is no
// Trigger, so Radix would otherwise drop focus to `<body>`.
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
import type { GitHubAccount } from '../../../shared/accounts'

export interface SignOutDialogProps {
  /** Non-null opens the dialog for this account. */
  account: GitHubAccount | null
  /** The raw-CLI-order account list, used only to work out which account becomes active next. */
  accounts: GitHubAccount[]
  onOpenChange(open: boolean): void
  /** Called once on every close, after Radix lifts `aria-hidden`, so the caller builds its announcement here. Return `true` if the caller moved focus itself. */
  onCloseFocus?(outcome: 'confirmed' | 'cancelled', account: GitHubAccount): boolean
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

export function SignOutDialog({ account, accounts, onOpenChange, onCloseFocus }: SignOutDialogProps) {
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Live account ref so an in-flight confirm never acts on a different account's dialog.
  const accountRef = useRef(account)
  accountRef.current = account
  // Keeps an account to render during the closing animation.
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
          const outcome = justConfirmedRef.current ? 'confirmed' : 'cancelled'
          justConfirmedRef.current = false
          if (onCloseFocus?.(outcome, displayAccount)) {
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
