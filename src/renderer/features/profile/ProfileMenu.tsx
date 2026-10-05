// The profile menu's minimal shell (docs/DESIGN.md "Layout", spec 008 FR-003, FR-004, FR-018,
// FR-024): just the account header (avatar + `@handle`) when signed in, or a Sign in action when
// signed out. `ProfileItem.tsx` (T013) wraps this in a `DropdownMenu`, so arrow-key navigation,
// Esc-to-close, and focus-return-to-trigger all come for free from Radix's primitive (T003) --
// nothing here hand-rolls any of that. Later User Stories (T016, T021, T022, T023) extend this
// content with Manage accounts, Manage sessions, Theme, Keyboard shortcuts, the update entry,
// Health check, What's new, and Sign out, each a further `DropdownMenuItem` appended below the
// header -- none of those exist yet.
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { initials } from '@/features/chat/RequestCard'
import { useAccountsStore } from '@/state'
import type { GitHubAccount } from '../../../shared/ipc'

export function ProfileMenuContent({ account }: { account: GitHubAccount | undefined }) {
  return (
    <DropdownMenuContent align="start" className="w-56">
      {account ? (
        <div className="flex items-center gap-2 px-2 py-1.5">
          <Avatar size="sm">
            <AvatarImage src={account.avatarDataUrl ?? undefined} alt="" />
            <AvatarFallback>{initials(account.displayName ?? account.login)}</AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 truncate text-sm">@{account.login}</span>
        </div>
      ) : (
        <DropdownMenuItem onSelect={() => void useAccountsStore.getState().addAccountStart()}>
          Sign in
        </DropdownMenuItem>
      )}
    </DropdownMenuContent>
  )
}
