// The profile item (docs/DESIGN.md "Layout", spec 008 FR-001 to FR-007, FR-024, FR-008 to
// FR-011, FR-014, FR-018 to FR-024): pinned at the bottom of the left nav, below the session
// list. Shows the active GitHub account's round avatar (`avatar.tsx`, T003) and display name,
// the GitHub-CLI-missing state (FR-014: avatar fallback "?", name "GitHub CLI missing"), or a
// generic avatar and "Sign in" when no account is signed in. A separate cog button opens Settings
// (FR-002), replacing spec 004 FR-011's temporary left-nav Settings entry now that this lands.
// Selecting the avatar/name part anywhere opens the profile menu (FR-003) via a `DropdownMenu`
// (T003's primitive) wrapping `ProfileMenu.tsx`'s content; Radix's primitive supplies arrow-key
// navigation, Esc to close, and returning focus to this trigger on close for free (FR-024). The
// name tooltip and the menu never stack on the same trigger: the tooltip only renders while the
// menu is closed.
//
// This component also owns every dialog the profile menu can open (Manage accounts, Sign out,
// Keyboard shortcuts, Health check) as SIBLINGS of the `DropdownMenu`, never nested inside its
// content -- a menu item unmounts the instant the menu closes, which would tear down a dialog
// launched from inside it mid-open. The `DropdownMenu` itself is `modal={false}`: Radix's modal
// dropdown can leave `document.body.style.pointerEvents` stuck at `'none'` when a Dialog opens
// immediately after it closes (a known Radix interaction), which this avoids entirely rather than
// working around it.
//
// Focus-on-close for EVERY dialog here is explicit (verified live, not assumed): none is given a
// `Trigger`, so Radix's own default close-auto-focus has no trigger ref to fall back to and
// drops focus to `<body>` rather than restoring it anywhere. `handleSignOutCloseFocus` and each
// dialog's own `onCloseFocus` are this component's replacement for that default.
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { SettingsIcon } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { initials } from '@/lib/initials'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { notify, useAccountsStore, useViewStore } from '@/state'
import type { GithubStatus } from '@/state'
import type { GitHubAccount } from '../../../shared/ipc'
import { HealthCheckDialog } from './HealthCheckDialog'
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog'
import { ManageAccountsDialog } from './ManageAccountsDialog'
import type { ManageAccountsDialogHandle } from './ManageAccountsDialog'
import { ProfileMenuContent } from './ProfileMenu'
import { SignOutDialog } from './SignOutDialog'

/** The signed-in account's combined accessible name (FR-005): name and GitHub sign-in state
 *  together as one phrase a screen reader can read in one pass. */
function accessibleName(account: GitHubAccount | undefined, githubStatus: GithubStatus): string {
  if (githubStatus === 'missing-cli') return 'GitHub CLI not found'
  if (!account) return 'Sign in'
  return `${account.displayName ?? account.login}, signed in to GitHub`
}

export function ProfileItem() {
  const github = useAccountsStore((state) => state.github)
  const githubStatus = useAccountsStore((state) => state.githubStatus)
  const account = github.find((candidate) => candidate.active)
  const missingCli = githubStatus === 'missing-cli'
  const name = missingCli ? 'GitHub CLI missing' : (account?.displayName ?? account?.login ?? null)
  const label = accessibleName(account, githubStatus)
  const [menuOpen, setMenuOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const [signOutTarget, setSignOutTarget] = useState<GitHubAccount | null>(null)
  const [signOutFromMenu, setSignOutFromMenu] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const [healthOpen, setHealthOpen] = useState(false)
  // Shared by every announcement this component itself makes (sign-out, Theme submenu) -- one
  // polite live region is enough, since they never fire at the same moment.
  const [announcement, announce] = useClearedAnnouncement()
  const nameButtonRef = useRef<HTMLButtonElement>(null)
  const manageAccountsRef = useRef<ManageAccountsDialogHandle>(null)

  function focusNameButton(): boolean {
    const el = nameButtonRef.current
    if (!el || !document.body.contains(el)) return false
    el.focus()
    return true
  }

  function handleSignInFromMenu(): void {
    setManageOpen(true)
    void useAccountsStore.getState().addAccountStart()
  }

  function handleSignOutFromMenu(): void {
    if (!account) return
    setSignOutFromMenu(true)
    setSignOutTarget(account)
  }

  function handleRequestSignOutFromDialog(target: GitHubAccount): void {
    setSignOutFromMenu(false)
    setSignOutTarget(target)
  }

  function handleSignOutOpenChange(open: boolean): void {
    if (!open) setSignOutTarget(null)
  }

  function handleSignOutConfirmed(confirmedAccount: GitHubAccount): void {
    announce(`Signed out ${confirmedAccount.displayName ?? confirmedAccount.login}`)
  }

  /** The Theme submenu's own `onThemeApplied` (FR-019, T022): fires only once `save` actually
   *  succeeds (ProfileMenu.tsx's `ThemeSubmenu` checks the resolved boolean itself). */
  function handleThemeApplied(themeLabel: string): void {
    announce(`Applied theme ${themeLabel}`)
  }

  /** What's new (FR-023): opens the installed version's release notes in the system browser;
   *  the menu item itself needs no dialog, just a toast on either outcome. */
  function handleWhatsNew(): void {
    void (async () => {
      const result = await window.refract.app.openReleaseNotes()
      if (result.ok) toast.success('Opening the release notes in your browser…')
      else notify(result.error)
    })()
  }

  /** The shared SignOutDialog's own `onCloseFocus`: launched from the profile menu always
   *  returns to the name button; launched from a Manage accounts row returns to that SAME row's
   *  Sign out button on Cancel/Esc (falling back to Add account if the row is gone), or to the
   *  new active row's Sign out button (or Add account, if none remain) on Confirm. */
  function handleSignOutCloseFocus(outcome: 'confirmed' | 'cancelled', confirmedAccount: GitHubAccount): boolean {
    if (signOutFromMenu) {
      return focusNameButton()
    }
    if (outcome === 'cancelled') {
      return (
        manageAccountsRef.current?.focusAccountSignOutButton(confirmedAccount.host, confirmedAccount.login) ||
        manageAccountsRef.current?.focusAddAccountButton() ||
        false
      )
    }
    const newActive = useAccountsStore.getState().github.find((candidate) => candidate.active)
    if (newActive && manageAccountsRef.current?.focusAccountSignOutButton(newActive.host, newActive.login)) {
      return true
    }
    return manageAccountsRef.current?.focusAddAccountButton() ?? false
  }

  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-t border-sidebar-border px-2">
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                ref={nameButtonRef}
                type="button"
                aria-label={label}
                className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring aria-expanded:bg-muted"
              >
                <Avatar size="sm">
                  {!missingCli && <AvatarImage src={account?.avatarDataUrl ?? undefined} alt="" />}
                  <AvatarFallback>{missingCli ? '?' : initials(name ?? '?')}</AvatarFallback>
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
        <ProfileMenuContent
          account={account}
          githubStatus={githubStatus}
          onManageAccounts={() => setManageOpen(true)}
          onSignIn={handleSignInFromMenu}
          onSignOut={handleSignOutFromMenu}
          onKeyboardShortcuts={() => setKeyboardOpen(true)}
          onHealthCheck={() => setHealthOpen(true)}
          onWhatsNew={handleWhatsNew}
          onThemeApplied={handleThemeApplied}
        />
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

      <ManageAccountsDialog
        ref={manageAccountsRef}
        open={manageOpen}
        onOpenChange={setManageOpen}
        onRequestSignOut={handleRequestSignOutFromDialog}
        onCloseFocus={focusNameButton}
      />
      <SignOutDialog
        account={signOutTarget}
        accounts={github}
        onOpenChange={handleSignOutOpenChange}
        onConfirmed={handleSignOutConfirmed}
        onCloseFocus={handleSignOutCloseFocus}
      />
      <KeyboardShortcutsDialog open={keyboardOpen} onOpenChange={setKeyboardOpen} onCloseFocus={focusNameButton} />
      <HealthCheckDialog open={healthOpen} onOpenChange={setHealthOpen} onCloseFocus={focusNameButton} />
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
