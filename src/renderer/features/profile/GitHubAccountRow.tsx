import { AtSignIcon, CheckIcon, GlobeIcon, TriangleAlertIcon } from 'lucide-react'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { InlineStatus } from '@/components/InlineStatus'
import { UserAvatar } from '@/components/UserAvatar'
import { Button } from '@/components/ui/button'
import type { GitHubAccount } from '../../../shared/accounts'
import { isUnreachable, mapRef, rowKey } from './accountDialogFocus'

export interface AccountRowRefs {
  signOut: Map<string, HTMLButtonElement>
  switchTo: Map<string, HTMLButtonElement>
  signInAgain: Map<string, HTMLButtonElement>
  checkAgain: Map<string, HTMLButtonElement>
  rowLi: Map<string, HTMLLIElement>
}

export interface GitHubAccountRowProps {
  account: GitHubAccount
  refs: AccountRowRefs
  /** True while a switch is pending for this row. */
  busy: boolean
  /** True while any switch is pending. */
  switchDisabled: boolean
  githubRefreshing: boolean
  /** True while an add or re-sign-in flow is starting or waiting. */
  flowActive: boolean
  onCheckAgain(account: GitHubAccount): void
  onSignInAgain(login: string): void
  onSwitch(account: GitHubAccount): void
  onSignOut(account: GitHubAccount): void
}

export function GitHubAccountRow({
  account,
  refs,
  busy,
  switchDisabled,
  githubRefreshing,
  flowActive,
  onCheckAgain,
  onSignInAgain,
  onSwitch,
  onSignOut
}: GitHubAccountRowProps) {
  const key = rowKey(account.host, account.login)
  const name = account.displayName ?? account.login
  const authProblem = account.state !== 'success'
  const unreachable = isUnreachable(account)
  return (
    <li
      ref={mapRef(refs.rowLi, key)}
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
            {unreachable ? "Couldn't reach GitHub." : account.problem === 'expired' ? 'Sign-in expired.' : 'Sign-in needs attention.'}
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
            ref={mapRef(refs.checkAgain, key)}
            variant="outline"
            size="sm"
            aria-disabled={githubRefreshing || undefined}
            aria-label={githubRefreshing ? `Checking ${name}…` : `Check again for ${name}`}
            onClick={() => {
              if (!githubRefreshing) onCheckAgain(account)
            }}
          >
            {githubRefreshing ? 'Checking…' : 'Check again'}
          </Button>
        )}
        {authProblem && !unreachable && account.host === 'github.com' && (
          <Button
            ref={mapRef(refs.signInAgain, key)}
            variant="outline"
            size="sm"
            aria-disabled={flowActive || undefined}
            aria-label={`Sign in again as @${account.login}`}
            onClick={() => {
              if (!flowActive) onSignInAgain(account.login)
            }}
          >
            Sign in again
          </Button>
        )}
        {!account.active && (
          <Button
            ref={mapRef(refs.switchTo, key)}
            variant="outline"
            size="sm"
            disabled={switchDisabled}
            loading={busy}
            aria-label={busy ? `Switching to ${name}` : `Switch active account to ${name}`}
            onClick={() => onSwitch(account)}
          >
            {busy ? 'Switching…' : 'Switch'}
          </Button>
        )}
        <Button ref={mapRef(refs.signOut, key)} variant="ghost-destructive" size="sm" aria-label={`Sign out ${name}`} onClick={() => onSignOut(account)}>
          Sign out
        </Button>
      </div>
    </li>
  )
}
