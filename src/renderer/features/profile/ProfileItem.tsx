// The name tooltip and the menu never stack on the same trigger: the tooltip only renders while the menu is closed.
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { SettingsIcon, TriangleAlertIcon } from 'lucide-react'
import { PauseAllButton } from './PauseAllButton'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { initials } from '@/lib/initials'
import { HolidayAccessory } from '@/features/holidays/HolidayAccessory'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { notify, useAccountsStore, useViewStore } from '@/state'
import type { GithubStatus } from '@/state'
import type { GitHubAccount } from '../../../shared/accounts'
import { HealthCheckDialog } from './HealthCheckDialog'
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog'
import { ManageAccountsDialog } from './ManageAccountsDialog'
import type { ManageAccountsDialogHandle } from './ManageAccountsDialog'
import { ProfileMenuContent } from './ProfileMenu'
import { SignOutDialog } from './SignOutDialog'

function accessibleName(account: GitHubAccount | undefined, githubStatus: GithubStatus): string {
  if (githubStatus === 'missing-cli') return 'GitHub CLI missing'
  if (githubStatus === 'loading') return 'Checking GitHub sign-in'
  if (githubStatus === 'error') return 'GitHub unavailable'
  if (!account) return 'Sign in'
  if (account.state !== 'success') {
    const unreachable = account.problem === 'unreachable' || account.state === 'timeout'
    return `${account.displayName ?? account.login}, ${unreachable ? "can't reach GitHub" : 'GitHub sign-in needs attention'}`
  }
  return `${account.displayName ?? account.login}, signed in to GitHub`
}

export function ProfileItem() {
  const github = useAccountsStore((state) => state.github)
  const githubStatus = useAccountsStore((state) => state.githubStatus)
  const account = github.find((candidate) => candidate.active)
  const missingCli = githubStatus === 'missing-cli'
  const loadingGithub = githubStatus === 'loading'
  const githubError = githubStatus === 'error'
  const authProblem = account !== undefined && account.state !== 'success'
  const name = missingCli
    ? 'GitHub CLI missing'
    : loadingGithub
      ? 'Checking GitHub sign-in'
      : githubError
        ? 'GitHub unavailable'
        : (account?.displayName ?? account?.login ?? null)
  const label = accessibleName(account, githubStatus)
  const [menuOpen, setMenuOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const [signOutTarget, setSignOutTarget] = useState<GitHubAccount | null>(null)
  const [signOutFromMenu, setSignOutFromMenu] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const [healthOpen, setHealthOpen] = useState(false)
  // Shared by every announcement this component itself makes (sign-out, Theme submenu) -- one polite live region is enough, since they never fire at the same moment.
  const [announcement, announce] = useClearedAnnouncement()
  const nameButtonRef = useRef<HTMLButtonElement>(null)
  const manageAccountsRef = useRef<ManageAccountsDialogHandle>(null)

  function focusNameButton(): boolean {
    const el = nameButtonRef.current
    if (!el || !document.body.contains(el)) return false
    el.focus()
    return true
  }

  function handleFixSignIn(): void {
    setManageOpen(true)
    requestAnimationFrame(() => {
      manageAccountsRef.current?.focusActiveAccountFixButton()
    })
  }

  function handleCheckGithubAgain(): void {
    if (useAccountsStore.getState().githubRefreshing) return
    const hadProblem = useAccountsStore.getState().githubStatus === 'error'
    void useAccountsStore
      .getState()
      .refreshGithub()
      .then(() => {
        if (!hadProblem) return
        const status = useAccountsStore.getState().githubStatus
        if (status === 'error') {
          announce("Still can't reach GitHub")
        } else if (status === 'missing-cli') {
          announce('GitHub CLI not found')
        } else {
          announce('GitHub is reachable again')
        }
      })
  }

  function handleSignInFromMenu(): void {
    setManageOpen(true)
    requestAnimationFrame(() => {
      manageAccountsRef.current?.startAddFlow()
    })
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

  function handleThemeApplied(themeLabel: string): void {
    announce(`Applied theme ${themeLabel}`)
  }

  function handleWhatsNew(): void {
    void (async () => {
      const result = await window.refract.app.openReleaseNotes()
      if (result.ok) toast.success('Opening the release notes in your browser…')
      else notify(result.error)
    })()
  }

  function handleSignOutCloseFocus(outcome: 'confirmed' | 'cancelled', confirmedAccount: GitHubAccount): boolean {
    if (outcome === 'confirmed') {
      const message = `Signed out ${confirmedAccount.displayName ?? confirmedAccount.login}`
      if (signOutFromMenu) announce(message)
      else manageAccountsRef.current?.announce(message)
    }
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
    <div className="flex h-12 shrink-0 items-center gap-1 px-2">
      <HolidayAccessory />
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                ref={nameButtonRef}
                type="button"
                aria-label={label}
                data-profile-name-button
                className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring aria-expanded:bg-muted"
              >
                <Avatar size="sm">
                  {!missingCli && !githubError && <AvatarImage src={account?.avatarDataUrl ?? undefined} alt="" />}
                  <AvatarFallback className={githubError ? 'text-state-needs-you' : undefined}>
                    {missingCli ? (
                      '?'
                    ) : githubError ? (
                      <TriangleAlertIcon aria-hidden className="size-4" />
                    ) : (
                      initials(name ?? '?')
                    )}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate text-sm">{name ?? 'Sign in'}</span>
                {authProblem && <TriangleAlertIcon aria-hidden className="size-4 shrink-0 text-state-needs-you" />}
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          {/* Suppressed while the menu is open so the two surfaces never stack on the same trigger. */}
          {name && !menuOpen && <TooltipContent side="top">{name}</TooltipContent>}
        </Tooltip>
        <ProfileMenuContent
          account={account}
          githubStatus={githubStatus}
          onManageAccounts={() => setManageOpen(true)}
          onManageSessions={() => useViewStore.getState().openManageSessions()}
          onSignIn={handleSignInFromMenu}
          onSignOut={handleSignOutFromMenu}
          onFixSignIn={handleFixSignIn}
          onCheckGithubAgain={handleCheckGithubAgain}
          onKeyboardShortcuts={() => setKeyboardOpen(true)}
          onHealthCheck={() => setHealthOpen(true)}
          onWhatsNew={handleWhatsNew}
          onThemeApplied={handleThemeApplied}
        />
      </DropdownMenu>
      <PauseAllButton />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Settings"
            aria-keyshortcuts="Control+,"
            onClick={() => useViewStore.getState().openSettings()}
          >
            <SettingsIcon aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          Settings
          <KbdGroup>
            <Kbd>Ctrl</Kbd>
            <Kbd>
              <span aria-hidden>,</span>
              <span className="sr-only">comma</span>
            </Kbd>
          </KbdGroup>
        </TooltipContent>
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
