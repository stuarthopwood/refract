// The profile item (docs/DESIGN.md "Layout", spec 008 FR-001 to FR-007, FR-024): pinned at the
// bottom of the left nav, below the session list. Shows the active GitHub account's round avatar
// (`avatar.tsx`, T003) and display name, or a generic avatar and "Sign in" when no account is
// signed in (FR-004). A separate cog button opens Settings (FR-002), replacing spec 004 FR-011's
// temporary left-nav Settings entry now that this lands. Selecting the avatar/name part anywhere
// opens the profile menu (FR-003) via a `DropdownMenu` (T003's primitive) wrapping
// `ProfileMenu.tsx`'s content (T014); Radix's primitive supplies arrow-key navigation, Esc to
// close, and returning focus to this trigger on close for free (FR-024). The name tooltip and the
// menu never stack on the same trigger: the tooltip only renders while the menu is closed.
import { useState } from 'react'
import { SettingsIcon } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { initials } from '@/lib/initials'
import { useAccountsStore, useViewStore } from '@/state'
import type { GitHubAccount } from '../../../shared/ipc'
import { ProfileMenuContent } from './ProfileMenu'

/** The signed-in account's combined accessible name (FR-005): name and GitHub sign-in state
 *  together as one phrase a screen reader can read in one pass. */
function accessibleName(account: GitHubAccount | undefined): string {
  if (!account) return 'Sign in'
  return `${account.displayName ?? account.login}, signed in to GitHub`
}

export function ProfileItem() {
  const account = useAccountsStore((state) => state.github.find((candidate) => candidate.active))
  const name = account?.displayName ?? account?.login ?? null
  const label = accessibleName(account)
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-t border-sidebar-border px-2">
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={label}
                className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring aria-expanded:bg-muted"
              >
                <Avatar size="sm">
                  <AvatarImage src={account?.avatarDataUrl ?? undefined} alt="" />
                  <AvatarFallback>{initials(name ?? '?')}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{name ?? 'Sign in'}</span>
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          {/* FR-026: the display name stays available as a tooltip even when the row truncates
              it (FR-028) or the nav is narrow. Suppressed while the menu is open so the two
              surfaces never stack on the same trigger. */}
          {name && !menuOpen && <TooltipContent side="top">{name}</TooltipContent>}
        </Tooltip>
        <ProfileMenuContent account={account} />
      </DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Settings"
            onClick={() => useViewStore.getState().openSettings()}
          >
            <SettingsIcon aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Settings</TooltipContent>
      </Tooltip>
    </div>
  )
}
