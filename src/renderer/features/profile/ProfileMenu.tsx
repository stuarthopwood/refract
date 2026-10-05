// The profile menu's minimal shell (docs/DESIGN.md "Layout", spec 008 FR-003, FR-004, FR-018,
// FR-024): just the account header (avatar + display name + `@handle` on host) when signed in, or
// a disabled Sign in row when signed out. The Sign in row is intentionally inert until T016/T017
// land the Manage accounts dialog with its add-account flow: the previous version called
// `addAccountStart()` straight from this menu, which spawned `gh auth login --web` with no UI
// anywhere to show its one-time code. `ProfileItem.tsx` (T013) wraps this in a `DropdownMenu`, so
// arrow-key navigation, Esc-to-close, and focus-return-to-trigger all come for free from Radix's
// primitive (T003) -- nothing here hand-rolls any of that. Later User Stories (T016, T021, T022,
// T023) extend this content with Manage accounts, Manage sessions, Theme, Keyboard shortcuts, the
// update entry, Health check, What's new, and Sign out, each a further `DropdownMenuItem` appended
// below the header (with a `DropdownMenuSeparator` between groups) -- none of those exist yet.
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu'
import { initials } from '@/lib/initials'
import type { GitHubAccount } from '../../../shared/ipc'

export function ProfileMenuContent({ account }: { account: GitHubAccount | undefined }) {
  return (
    <DropdownMenuContent side="top" align="start" sideOffset={6} collisionPadding={8} className="w-60">
      {account ? (
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
      ) : (
        <DropdownMenuItem disabled>Sign in to GitHub…</DropdownMenuItem>
      )}
    </DropdownMenuContent>
  )
}
