// The profile menu's content (docs/DESIGN.md "Layout", spec 008 FR-003, FR-004, FR-008 to
// FR-011, FR-014, FR-018, FR-024): the account header (avatar + display name + `@handle` on
// host) plus Manage accounts and Sign out when signed in; a Sign in action plus Manage accounts
// when signed out; an Install action plus Manage accounts when the GitHub CLI itself is missing
// (FR-014). `ProfileItem.tsx` wraps this in a `DropdownMenu`, so arrow-key navigation, Esc-to-
// close, and focus-return-to-trigger all come for free from Radix's primitive -- nothing here
// hand-rolls any of that. `ProfileItem.tsx` owns both dialogs this menu can open (Manage accounts,
// Sign out) as siblings of the `DropdownMenu`, since a menu item unmounts the moment the menu
// closes -- this component only calls the callbacks it is given, never touches a dialog itself.
import { ExternalLinkIcon } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { initials } from '@/lib/initials'
import type { GithubStatus } from '@/state'
import type { GitHubAccount } from '../../../shared/ipc'

export interface ProfileMenuContentProps {
  account: GitHubAccount | undefined
  githubStatus: GithubStatus
  onManageAccounts(): void
  /** Signed-out "Sign in to GitHub…" item (FR-009, FR-010): opens Manage accounts AND starts the
   *  add-account flow immediately, since there is nowhere else signed-out to put a Sign in
   *  action that can actually show the flow's one-time code. */
  onSignIn(): void
  onSignOut(): void
}

export function ProfileMenuContent({ account, githubStatus, onManageAccounts, onSignIn, onSignOut }: ProfileMenuContentProps) {
  return (
    <DropdownMenuContent side="top" align="start" sideOffset={6} collisionPadding={8} className="w-60">
      {githubStatus === 'ready' && account ? (
        <>
          <DropdownMenuLabel className="flex items-center gap-2.5 font-normal">
            <Avatar>
              <AvatarImage src={account.avatarDataUrl ?? undefined} alt="" />
              <AvatarFallback>{initials(account.displayName ?? account.login)}</AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-sm font-medium">{account.displayName ?? account.login}</span>
              <span className="truncate text-xs text-muted-foreground">@{account.login} on {account.host}</span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onManageAccounts}>Manage accounts</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onSignOut}>
            Sign out
          </DropdownMenuItem>
        </>
      ) : githubStatus === 'missing-cli' ? (
        <>
          <DropdownMenuItem asChild>
            <a href="https://cli.github.com" target="_blank" rel="noreferrer noopener" className="flex items-center gap-2">
              <ExternalLinkIcon aria-hidden />
              Install GitHub CLI
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onManageAccounts}>Manage accounts</DropdownMenuItem>
        </>
      ) : githubStatus === 'signed-out' ? (
        <>
          <DropdownMenuItem onSelect={onSignIn}>Sign in to GitHub…</DropdownMenuItem>
          <DropdownMenuItem onSelect={onManageAccounts}>Manage accounts</DropdownMenuItem>
        </>
      ) : (
        <DropdownMenuItem disabled>Sign in to GitHub…</DropdownMenuItem>
      )}
    </DropdownMenuContent>
  )
}
