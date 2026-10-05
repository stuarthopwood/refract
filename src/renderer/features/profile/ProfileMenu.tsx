// The profile menu's content (docs/DESIGN.md "Layout", spec 008 FR-003, FR-004, FR-008 to
// FR-011, FR-014, FR-018 to FR-024): the account header (avatar + display name + `@handle` on
// host) plus Manage accounts, Theme, Keyboard shortcuts, Health check, What's new, and Sign out
// when signed in; a Sign in action plus the rest of that same list when signed out; an Install
// action plus the rest of that same list when the GitHub CLI itself is missing (FR-014).
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
import {
  ActivityIcon,
  CheckIcon,
  ExternalLinkIcon,
  KeyboardIcon,
  LayersIcon,
  LogOutIcon,
  PaletteIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
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
import { useActiveThemeId, useThemeStore, useViewStore } from '@/state'
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
 *  the active one marked by both a check icon and the word "Current" (never colour alone), with
 *  the exact swatch-by-data-not-by-hardcoded-hex approach ThemePicker.tsx already uses (each
 *  theme's own real `--background` value, not an invented accent). Choosing a DIFFERENT preset
 *  saves it immediately via `useThemeStore.getState().save` (a menu is a transient overlay --
 *  Settings' own Appearance section is where a live preview with Save/Cancel belongs); choosing
 *  the already-active preset is a deliberate no-op, the same FR-002/FR-006 deviation note
 *  ThemePicker.tsx's own `choose` already documents. Selecting either a preset or "Appearance
 *  settings…" closes the whole menu and returns focus to the profile item's name button via
 *  Radix's own default close-auto-focus (no `Trigger`-less dialog is opened here, so that
 *  default -- unlike ManageAccountsDialog/SignOutDialog's -- is exactly the right behaviour). */
function ThemeSubmenu({ onThemeApplied }: { onThemeApplied(label: string): void }) {
  const activeId = useActiveThemeId()

  function chooseTheme(id: ThemeId, name: string): void {
    if (id === activeId) return
    void useThemeStore.getState().save(id).then((ok) => {
      if (ok) onThemeApplied(name)
    })
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <PaletteIcon aria-hidden />
        Theme
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent sideOffset={4} alignOffset={-4} collisionPadding={8}>
        {THEME_LIST.map((theme) => (
          <DropdownMenuItem key={theme.id} onSelect={() => chooseTheme(theme.id, theme.name)}>
            <span
              aria-hidden
              className="size-3.5 shrink-0 rounded-full border border-border"
              style={{ backgroundColor: theme.swatch }}
            />
            <span className="flex-1">{theme.name}</span>
            {theme.id === activeId && (
              <span className="flex items-center gap-1 text-xs font-medium">
                <CheckIcon aria-hidden className="size-3.5" />
                Current
              </span>
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => useViewStore.getState().openSettings('appearance')}>
          <SlidersHorizontalIcon aria-hidden />
          Appearance settings…
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** Keyboard shortcuts, Health check, and What's new: identical in every GitHub sign-in state, so
 *  rendered once and shared across all three branches below. */
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
  return (
    <DropdownMenuContent
      side="top"
      align="start"
      sideOffset={6}
      collisionPadding={8}
      className="w-64 max-h-[calc(100vh-4.5rem)] overflow-y-auto"
    >
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
          <DropdownMenuItem onSelect={onManageAccounts}>
            <UsersIcon aria-hidden />
            Manage accounts
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onManageSessions}>
            <LayersIcon aria-hidden />
            Manage sessions
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <ThemeSubmenu onThemeApplied={onThemeApplied} />
          <CommonMenuItems onKeyboardShortcuts={onKeyboardShortcuts} onHealthCheck={onHealthCheck} onWhatsNew={onWhatsNew} />
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onSignOut}>
            <LogOutIcon aria-hidden />
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
          <DropdownMenuItem onSelect={onManageAccounts}>
            <UsersIcon aria-hidden />
            Manage accounts
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onManageSessions}>
            <LayersIcon aria-hidden />
            Manage sessions
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <ThemeSubmenu onThemeApplied={onThemeApplied} />
          <CommonMenuItems onKeyboardShortcuts={onKeyboardShortcuts} onHealthCheck={onHealthCheck} onWhatsNew={onWhatsNew} />
        </>
      ) : githubStatus === 'signed-out' ? (
        <>
          <DropdownMenuItem onSelect={onSignIn}>Sign in to GitHub…</DropdownMenuItem>
          <DropdownMenuItem onSelect={onManageAccounts}>
            <UsersIcon aria-hidden />
            Manage accounts
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onManageSessions}>
            <LayersIcon aria-hidden />
            Manage sessions
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <ThemeSubmenu onThemeApplied={onThemeApplied} />
          <CommonMenuItems onKeyboardShortcuts={onKeyboardShortcuts} onHealthCheck={onHealthCheck} onWhatsNew={onWhatsNew} />
        </>
      ) : (
        <DropdownMenuItem disabled>Sign in to GitHub…</DropdownMenuItem>
      )}
    </DropdownMenuContent>
  )
}
