// Shared sign-out confirmation for ManageAccountsDialog and ProfileMenu; the single instance lives outside the
// menu, whose items unmount on close. Focus-on-close is always explicit via `onCloseFocus`: there is no
// Trigger, so Radix would otherwise drop focus to `<body>`.
import { useEffect, useRef, useState } from 'react'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
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
    return `This signs @${account.login} out on ${account.host}. Your other accounts stay signed in.`
  }
  const next = signOutSuccessor(accounts, account)
  if (next) {
    return `This signs @${account.login} out on ${account.host}. @${next.login} becomes the active account.`
  }
  return `This signs @${account.login} out on ${account.host}. No account will be active afterwards.`
}

export function SignOutDialog({ account, accounts, onOpenChange, onCloseFocus }: SignOutDialogProps) {
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
    <ConfirmAlertDialog
      open={account !== null}
      busy={signingOut}
      title={`Sign out @${displayAccount.login}?`}
      description={signOutBody(displayAccount, accounts)}
      confirmLabel="Sign out"
      busyLabel="Signing out…"
      tone="destructive"
      error={error}
      onCancel={() => onOpenChange(false)}
      onConfirm={() => void handleConfirm()}
      onCloseAutoFocus={() => {
        const outcome = justConfirmedRef.current ? 'confirmed' : 'cancelled'
        justConfirmedRef.current = false
        return Boolean(onCloseFocus?.(outcome, displayAccount))
      }}
    />
  )
}
