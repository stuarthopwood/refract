// The profile menu's content (docs/DESIGN.md "Layout", spec 008 FR-003, FR-004, FR-008 to
// FR-011, FR-014, FR-018 to FR-024): a state-specific first row -- the account header (avatar +
// display name + `@handle` on host) when signed in, a Sign in action when signed out, an Install
// action when the GitHub CLI itself is missing (FR-014), or a disabled "Checking GitHub
// sign-in…" row while the initial status read is still in flight -- followed by one shared block
// (Manage accounts, Manage sessions, Theme, Keyboard shortcuts, Health check, What's new)
// rendered exactly once so React never remounts it (and drops focus) on a `githubStatus` change
// while the menu is open, then Sign out only when signed in (post-build review, GateCode008
// Medium: this used to be four near-identical copies of that shared block, one per branch).
// `ProfileItem.tsx` wraps this in a `DropdownMenu`, so arrow-key navigation, Esc-to-close, and
// focus-return-to-trigger all come for free from Radix's primitive -- nothing here hand-rolls any
// of that. `ProfileItem.tsx` owns every dialog this menu can open (Manage accounts, Sign out,
// Keyboard shortcuts, Health check) as siblings of the `DropdownMenu`, since a menu item unmounts
// the moment the menu closes -- this component only calls the callbacks it is given for those.
// The Theme submenu and What's new are the two exceptions: both are fully self-contained (reading
// `useThemeStore`/`useViewStore` directly, the same way `ProfileItem.tsx`'s own cog button
// already calls `useViewStore` inline), since neither needs a sibling dialog -- Theme only needs
// `onThemeApplied` to reach ProfileItem's shared live region, and What's new only ever shows a
// toast.
//
// One reserved slot, left as a comment rather than a disabled/stub item (a control that opens
// nothing is worse than no control): the update entry lands between Keyboard shortcuts and
// Health check once spec 006 ships `updates.get()`/`updates:changed` (tasks.md T024b) -- no
// `updates` IPC, preload method, or store exists yet.
import { useRef, useState } from 'react'
import {
  ActivityIcon,
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  KeyboardIcon,
  LayersIcon,
  LoaderCircleIcon,
  LogInIcon,
  LogOutIcon,
  PaletteIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  TriangleAlertIcon,
  UsersIcon
} from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { initials } from '@/lib/initials'
import { useAccountsStore, useActiveThemeId, useThemeStore, useViewStore } from '@/state'
import type { GithubStatus } from '@/state'
import { THEMES } from '../../../shared/themes'
import type { ThemeId } from '../../../shared/themes'
import type { GitHubAccount } from '../../../shared/ipc'

const THEME_LIST = Object.values(THEMES)

export interface ProfileMenuContentProps {
  account: GitHubAccount | undefined
  githubStatus: GithubStatus
  onManageAccounts(): void
  onManageSessions(): void
  /** Signed-out "Sign in to GitHub…" item (FR-009, FR-010): opens Manage accounts AND starts the
   *  add-account flow immediately, since there is nowhere else signed-out to put a Sign in
   *  action that can actually show the flow's one-time code. */
  onSignIn(): void
  onSignOut(): void
  onKeyboardShortcuts(): void
  onHealthCheck(): void
  onWhatsNew(): void
  /** Called once a Theme submenu preset actually saves successfully, so ProfileItem.tsx can
   *  announce "Applied theme {label}" through its existing polite live region (FR-027). */
  onThemeApplied(label: string): void
}

/** The Theme submenu (FR-019, T022): every built-in preset in `THEMES`' own declaration order,
 *  the active one marked by a check icon, the word "Current", AND the same shared 2px
 *  `--active-indicator` bar every other "current/selected" surface in the app uses
 *  (docs/DESIGN.md "Active/selected indicator"; never colour alone), with the exact
 *  swatch-by-data-not-by-hardcoded-hex approach ThemePicker.tsx already uses (each theme's own
 *  real `--background` value, not an invented accent). Choosing a DIFFERENT preset saves it
 *  immediately via `useThemeStore.getState().save` (a menu is a transient overlay -- Settings'
 *  own Appearance section is where a live preview with Save/Cancel belongs); choosing the
 *  already-active preset is a deliberate no-op, the same FR-002/FR-006 deviation note
 *  ThemePicker.tsx's own `choose` already documents. Selecting a preset closes the whole menu
 *  and returns focus to the profile item's name button via Radix's own default close-auto-focus
 *  (no `Trigger`-less dialog is opened here, so that default is exactly right); selecting
 *  "Appearance settings…" instead opens the Settings screen, which unmounts ProfileItem
 *  entirely, so focus goes to the Settings screen's own heading instead (SettingsScreen.tsx:66-68
 *  focuses it on mount, not any "first focusable control"). The submenu is
 *  controlled (`open`/`onOpenChange`) so that opening it moves focus to the active preset --
 *  but only when the submenu was opened by keyboard (the `contains` check below leaves a
 *  pointer-hover open alone, since a mouse user never wants focus silently stolen). Radix alone
 *  would otherwise focus the first item in `THEME_LIST`, which only happened to be the active
 *  preset while "Dark" (the first theme) was also current -- any other active preset, e.g.
 *  "Dark (high contrast)", left a habitual Enter press on the wrong, first-listed row. */
function ThemeSubmenu({ onThemeApplied }: { onThemeApplied(label: string): void }) {
  const activeId = useActiveThemeId()
  const [open, setOpen] = useState(false)
  const subContentRef = useRef<HTMLDivElement>(null)
  const activeItemRef = useRef<HTMLDivElement>(null)

  function chooseTheme(id: ThemeId, name: string): void {
    if (id === activeId) return
    void useThemeStore.getState().save(id).then((ok) => {
      if (ok) onThemeApplied(name)
    })
  }

  return (
    <DropdownMenuSub
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) return
        requestAnimationFrame(() => {
          if (subContentRef.current?.contains(document.activeElement)) {
            activeItemRef.current?.focus()
          }
        })
      }}
    >
      <DropdownMenuSubTrigger>
        <PaletteIcon aria-hidden />
        Theme
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent ref={subContentRef} sideOffset={4} alignOffset={-4} collisionPadding={8}>
        {THEME_LIST.map((theme) => {
          const isActive = theme.id === activeId
          return (
            <DropdownMenuItem
              key={theme.id}
              ref={isActive ? activeItemRef : undefined}
              onSelect={() => chooseTheme(theme.id, theme.name)}
              className={isActive ? 'focus:shadow-[inset_4px_0_0_0_var(--color-ring)]' : undefined}
            >
              {isActive && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-active-indicator" />}
              <span
                aria-hidden
                className="size-4 shrink-0 rounded-full border border-border"
                style={{ backgroundColor: theme.swatch }}
              />
              <span className="flex-1">{theme.name}</span>
              {isActive && (
                <span className="flex items-center gap-1 text-xs font-medium">
                  <CheckIcon aria-hidden className="size-3.5" />
                  Current
                </span>
              )}
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => useViewStore.getState().openSettings('appearance')}>
          <SlidersHorizontalIcon aria-hidden />
          Appearance settings…
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** Keyboard shortcuts, Health check, and What's new: common to every GitHub sign-in state, so
 *  extracted here and rendered exactly once by `ProfileMenuContent` below, regardless of state. */
function CommonMenuItems({
  onKeyboardShortcuts,
  onHealthCheck,
  onWhatsNew
}: {
  onKeyboardShortcuts(): void
  onHealthCheck(): void
  onWhatsNew(): void
}) {
  return (
    <>
      <DropdownMenuItem onSelect={onKeyboardShortcuts}>
        <KeyboardIcon aria-hidden />
        Keyboard shortcuts
      </DropdownMenuItem>
      {/* Update entry slot (spec 006, tasks.md T024b): reserved here, between Keyboard shortcuts
          and Health check, until spec 006 ships `updates.get()`/`updates:changed`. */}
      <DropdownMenuItem onSelect={onHealthCheck}>
        <ActivityIcon aria-hidden />
        Health check
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onWhatsNew}>
        <SparklesIcon aria-hidden />
        <span className="flex-1">What's new</span>
        <ExternalLinkIcon aria-hidden className="size-3.5" />
        <span className="sr-only"> Opens in your browser</span>
      </DropdownMenuItem>
    </>
  )
}

export function ProfileMenuContent({
  account,
  githubStatus,
  onManageAccounts,
  onManageSessions,
  onSignIn,
  onSignOut,
  onKeyboardShortcuts,
  onHealthCheck,
  onWhatsNew,
  onThemeApplied
}: ProfileMenuContentProps) {
  const signedIn = githubStatus === 'ready' && account !== undefined
  return (
    <DropdownMenuContent
      side="top"
      align="start"
      sideOffset={6}
      collisionPadding={8}
      className="w-64 max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto"
    >
      {signedIn && account ? (
        <>
          <DropdownMenuLabel className="flex items-center gap-2.5 font-normal">
            <Avatar>
              <AvatarImage src={account.avatarDataUrl ?? undefined} alt="" />
              <AvatarFallback>{initials(account.displayName ?? account.login)}</AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 flex-col leading-tight">
              {/* UI M4 (quality-gate remediation): icon plus text, never colour alone, when the
                  ACTIVE account's own GitHub sign-in needs attention. */}
              <span className="flex items-center gap-1 truncate text-sm font-medium">
                {account.state !== 'success' && (
                  <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-state-needs-you" />
                )}
                <span className="truncate">{account.displayName ?? account.login}</span>
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {account.state !== 'success' ? 'GitHub sign-in needs attention' : `@${account.login} on ${account.host}`}
              </span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
        </>
      ) : githubStatus === 'missing-cli' ? (
        <DropdownMenuItem key="first-row" asChild>
          <a href="https://cli.github.com" target="_blank" rel="noreferrer noopener" className="flex items-center gap-2">
            <DownloadIcon aria-hidden />
            <span className="flex-1">Install GitHub CLI</span>
            <ExternalLinkIcon aria-hidden className="size-3.5" />
            <span className="sr-only"> Opens in your browser</span>
          </a>
        </DropdownMenuItem>
      ) : githubStatus === 'error' ? (
        // UI M3 (quality-gate remediation): a `gh-failed`/thrown-invoke read offers a way to
        // retry instead of silently claiming "Sign in" (which would misreport an unreadable CLI
        // as nobody being signed in).
        <DropdownMenuItem key="first-row" onSelect={() => void useAccountsStore.getState().refreshGithub()}>
          <TriangleAlertIcon aria-hidden />
          <span className="flex-1">GitHub unavailable</span>
          <span className="text-xs text-muted-foreground">Check again</span>
        </DropdownMenuItem>
      ) : githubStatus === 'signed-out' || githubStatus === 'ready' ? (
        <DropdownMenuItem key="first-row" onSelect={onSignIn}>
          <LogInIcon aria-hidden />
          Sign in to GitHub…
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem key="first-row" disabled>
          <LoaderCircleIcon aria-hidden className="animate-spin" />
          Checking GitHub sign-in…
        </DropdownMenuItem>
      )}
      {/* Shared block (GateCode008 Medium): identical in every `githubStatus`, so rendered exactly
          once here instead of once per branch above -- keyed so a `githubStatus` change while the
          menu is open (e.g. sign-in finishing) can never remount, and drop focus from, any of
          these items (Phase 6 re-check, NEW-A). */}
      {/* UI M4 (quality-gate remediation): a direct way to reach the fix, next to the header's
          own warning above, whenever the active account's sign-in needs attention. */}
      {signedIn && account && account.state !== 'success' && (
        <DropdownMenuItem key="fix-sign-in" onSelect={onManageAccounts}>
          <TriangleAlertIcon aria-hidden />
          Fix sign-in…
        </DropdownMenuItem>
      )}
      <DropdownMenuItem key="manage-accounts" onSelect={onManageAccounts}>
        <UsersIcon aria-hidden />
        Manage accounts
      </DropdownMenuItem>
      <DropdownMenuItem key="manage-sessions" onSelect={onManageSessions}>
        <LayersIcon aria-hidden />
        Manage sessions
      </DropdownMenuItem>
      <DropdownMenuSeparator key="shared-separator" />
      <ThemeSubmenu key="theme" onThemeApplied={onThemeApplied} />
      <CommonMenuItems
        key="common"
        onKeyboardShortcuts={onKeyboardShortcuts}
        onHealthCheck={onHealthCheck}
        onWhatsNew={onWhatsNew}
      />
      {signedIn && (
        <>
          <DropdownMenuSeparator key="sign-out-separator" />
          <DropdownMenuItem key="sign-out" variant="destructive" onSelect={onSignOut}>
            <LogOutIcon aria-hidden />
            Sign out
          </DropdownMenuItem>
        </>
      )}
    </DropdownMenuContent>
  )
}
