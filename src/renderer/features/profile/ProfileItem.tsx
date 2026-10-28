// The profile item (docs/DESIGN.md "Layout", spec 008 FR-001 to FR-007, FR-024, FR-008 to
// FR-011, FR-014, FR-018 to FR-024): pinned at the bottom of the left nav, below the session
// list. Shows the active GitHub account's round avatar (`avatar.tsx`, T003) and display name,
// the GitHub-CLI-missing state (FR-014: avatar fallback "?", name "GitHub CLI missing"), a
// disabled "Checking GitHub sign-in" row while the first `accounts.github.list()` is still in
// flight (quality-gate remediation, ui-architect-v3 Low: this used to read "Sign in" during that
// window, indistinguishable from the real signed-out state), or a generic avatar and "Sign in"
// once that settles with nobody signed in. A separate cog button opens Settings
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
import { SettingsIcon, TriangleAlertIcon } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { initials } from '@/lib/initials'
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

/** The signed-in account's combined accessible name (FR-005): name and GitHub sign-in state
 *  together as one phrase a screen reader can read in one pass. */
function accessibleName(account: GitHubAccount | undefined, githubStatus: GithubStatus): string {
  // Quality-gate remediation (accessibility-auditor Medium, WCAG 2.5.3 Label in Name): each
  // branch's accessible name now starts with (here, matches exactly) its own visible text below.
  if (githubStatus === 'missing-cli') return 'GitHub CLI missing'
  if (githubStatus === 'loading') return 'Checking GitHub sign-in'
  // UI M3 (quality-gate remediation): a `gh-failed`/thrown-invoke read never claims "Sign in" --
  // that would misreport "the CLI could not be read" as "nobody is signed in".
  if (githubStatus === 'error') return 'GitHub unavailable'
  if (!account) return 'Sign in'
  // UI M4 (quality-gate remediation): the active account's own auth problem (an expired or
  // revoked token `gh` itself still lists, `state !== 'success'`) is never announced as plainly
  // "signed in to GitHub" -- that is simply false once `gh` can no longer act as that account.
  // UI N4 (quality-gate remediation, gate-3): an unreachable-host problem reads as "can't reach
  // GitHub", distinct from the generic "sign-in needs attention" that implies a credential issue
  // Sign in again could actually fix -- it can't, for an unreachable host.
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
  // UI M4: the active account's own GitHub-side auth problem, independent of `githubStatus`
  // (which only ever reflects the CLI's own reachability, never one specific account's state).
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

  // Quality-gate remediation (accessibility-auditor MEDIUM, gate-3 M1): used to re-read
  // `github` on every menu open, which could unmount the menu's own focused first-slot item
  // ("Fix sign-in…"/"Sign in"/"GitHub unavailable" <-> the signed-in header) while a non-modal
  // menu was open, dropping focus to `<body>`. Removed in favour of refreshing on the Manage
  // accounts dialog's own open (kept, ManageAccountsDialog.tsx) and on the window regaining
  // focus/visibility (init-stores.ts), neither of which can ever happen while this menu itself
  // is open and focused.

  /** UI N4 (quality-gate remediation, gate-3): a separate path from "Sign in"/"Manage
   *  accounts" below -- opens Manage accounts WITHOUT starting any flow, then focuses whichever
   *  recovery control the ACTIVE account's own row actually shows (Sign in again, or Check
   *  again for an unreachable host) -- never auto-starts a new sign-in itself. */
  function handleFixSignIn(): void {
    setManageOpen(true)
    requestAnimationFrame(() => {
      manageAccountsRef.current?.focusActiveAccountFixButton()
    })
  }

  /** A11y M1 / UI N3 (quality-gate remediation, gate-3): the profile menu's own "GitHub
   *  unavailable / Check again" item (ProfileMenu.tsx) unmounts the instant the menu closes
   *  (Radix's default on select), so the refresh's outcome can only ever be announced from a
   *  region outside that menu -- this component's own shared live region, below. */
  function handleCheckGithubAgain(): void {
    if (useAccountsStore.getState().githubRefreshing) return
    const hadProblem = useAccountsStore.getState().githubStatus === 'error'
    void useAccountsStore
      .getState()
      .refreshGithub()
      .then(() => {
        if (!hadProblem) return
        // Quality-gate remediation (code-reviewer Low, gate-4): `missing-cli` used to fall into
        // the same "GitHub is reachable again" branch as every other non-'error' outcome -- a
        // flat-out false claim when the refresh actually found the CLI itself gone, not merely
        // reachable again. Only a status that is neither 'error' nor 'missing-cli' is a real
        // recovery.
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
    // Quality-gate remediation (code-reviewer/accessibility-auditor Medium): runs the SAME
    // guarded `startAddFlow` the dialog's own Add account button runs (status gating,
    // aria-disabled, assertive failure announcement + refocus), never `addAccountStart()`
    // directly -- a direct call bypassed every one of those guards and could start a second,
    // concurrent flow. Deferred one frame (the dialog was just opened by the line above, and its
    // content needs to actually mount first), the same `requestAnimationFrame`-after-open pattern
    // ProfileMenu.tsx's own Theme submenu already uses for its post-open focus.
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
    if (outcome === 'confirmed') {
      const message = `Signed out ${confirmedAccount.displayName ?? confirmedAccount.login}`
      // Quality-gate remediation (accessibility-auditor High): announced from here, not from
      // `signOutAccount`'s own resolution, since by now Radix has lifted the `aria-hidden` it
      // puts on everything outside whichever dialog was open -- including this component's own
      // live region when the sign-out came from the profile menu, or Manage accounts' own live
      // region (via its `announce` handle method) when THAT dialog is still open underneath.
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
    // #567 decision 20: own `border-t` removed -- `SessionList.tsx`'s footer div (rendered
    // right above this component in `App.tsx`) now carries the one soft `border-divider` for
    // the whole footer block, so the two surfaces no longer draw a double line.
    <div className="flex h-12 shrink-0 items-center gap-1 px-2">
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
                {/* UI M4: icon plus text, never colour alone (the amber token used here matches
                    the dialog's own "Needs attention" rows) -- shown only for the ACTIVE
                    account's own auth problem, distinct from `githubError` above (the CLI itself
                    being unreachable, with no account known at all). */}
                {authProblem && <TriangleAlertIcon aria-hidden className="size-4 shrink-0 text-state-needs-you" />}
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
        {/* Issue #395: the chord was documented in docs/design/index.md's Keyboard table
            with no real handler behind it until now -- this Kbd is the tooltip's own
            "honesty rule" (KeyboardShortcutsDialog.tsx:2-6) extended to every icon-only
            control's tooltip, not just that dialog. */}
        <TooltipContent side="top">
          Settings
          <KbdGroup>
            <Kbd>Ctrl</Kbd>
            {/* Quality-gate remediation (PR #637 gate, optional a11y): spells the lone
                comma glyph out for assistive tech, which reads it ambiguously on its own. */}
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
