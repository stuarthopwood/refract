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
// The Theme submenu, the update entry, and What's new are the three exceptions: each is fully
// self-contained (reading `useThemeStore`/`useUpdateStore`/`useViewStore` directly, the same way
// `ProfileItem.tsx`'s own cog button already calls `useViewStore` inline), since none needs a
// sibling dialog -- Theme only needs `onThemeApplied` to reach ProfileItem's shared live region,
// the update entry (issue #569, spec 008 FR-021, T024b) only ever shows a toast confirming or
// reporting a check, and What's new only ever shows a toast too.
import { useRef, useState } from 'react'
import { toast } from 'sonner'
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
  RefreshCwIcon,
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
import { updateUnavailableReasonText } from '@/lib/updateStatus'
import { notify, useAccountsStore, useActiveThemeId, useThemeStore, useUpdateStore, useViewStore } from '@/state'
import type { GithubStatus } from '@/state'
import { THEMES } from '../../../shared/themes'
import type { ThemeId } from '../../../shared/themes'
import type { GitHubAccount } from '../../../shared/accounts'

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
  /** UI N4 (quality-gate remediation, gate-3): "Fix sign-in…"/"Check GitHub connection…"
   *  below -- opens Manage accounts and focuses the ACTIVE account's own recovery control,
   *  without starting any flow itself (distinct from `onSignIn`, which starts one immediately). */
  onFixSignIn(): void
  /** A11y M1 / UI N3 (quality-gate remediation, gate-3): the 'error' state's own "GitHub
   *  unavailable / Check again" item below -- guarded/announced by the caller (ProfileItem.tsx),
   *  since this item unmounts the instant the menu closes and can never announce its own result. */
  onCheckGithubAgain(): void
  onKeyboardShortcuts(): void
  onHealthCheck(): void
  onWhatsNew(): void
  /** Called once a Theme submenu preset actually saves successfully, so ProfileItem.tsx can
   *  announce "Applied theme {label}" through its existing polite live region (FR-027). */
  onThemeApplied(label: string): void
}

/** The Theme submenu (FR-019, T022): every built-in preset in `THEMES`' own declaration order,
 *  the active one marked by a trailing check icon plus the word "Current" -- the ONLY
 *  current-theme marker (gate round 6 fix, `agent://Arch877`: this row used to ALSO draw a
 *  permanent 2px `--active-indicator` bar, which clashed once every dropdown menu's own
 *  keyboard-focus cue became that SAME bar, gate round 5 -- "Decided (Skippy, delegated by
 *  Stuart 2026-10-15)": in a DROPDOWN MENU specifically, the bar means keyboard focus only;
 *  `docs/DESIGN.md`'s "Active/selected indicator" rule still covers every OTHER current/
 *  selected surface, e.g. the session list row and conversation-history entry, unchanged), with
 *  the exact swatch-by-data-not-by-hardcoded-hex approach ThemePicker.tsx already uses (each
 *  theme's own real `--background` value, not an invented accent). Choosing a DIFFERENT preset
 *  saves it immediately via `useThemeStore.getState().save` (a menu is a transient overlay --
 *  Settings'
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
            >
              {/* Gate round 6 fix (`agent://Arch877` Medium 2): this row used to ALSO draw a
                  permanent 2px indigo bar plus a 4px ring-coloured focus override whenever this
                  theme was the active one -- once the shared `DropdownMenuItem` focus cue became
                  the SAME indigo `--active-indicator` (gate round 5), arrowing onto a DIFFERENT
                  theme showed two visually identical indigo bars, with only a sub-1.3:1
                  `bg-accent` telling them apart. The trailing "Current" text below is the ONLY
                  current-theme marker now; the bar means focus alone, same as every other menu. */}
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

/** The update entry (spec 008 FR-021, T024b; issue #569 decision 5): always present in the fixed
 *  order (FR-018), self-contained like `ThemeSubmenu` above -- reads `useUpdateStore` directly
 *  rather than threading a new prop through `ProfileItem.tsx`. Exactly two renderings, not the
 *  status bar's full idle/checking/available/downloading/downloaded/failed/unavailable detail
 *  (`StatusBar.tsx`, which keeps the Download/Retry actions entirely to itself): "Restart to
 *  update" with a plain trailing version once a download is waiting for the next quit, "Check
 *  for updates" otherwise. Selecting "Restart to update" only confirms with a toast -- it never
 *  quits or installs. Selecting "Check for updates" re-runs the check and shows one outcome
 *  toast; `aria-disabled` (same guarded-`onSelect` pattern as the "GitHub unavailable" row
 *  above) while a check, download, or install is already running, swapping in the same
 *  `LoaderCircleIcon` that row's own busy state uses. */
function UpdateMenuItem() {
  const updateState = useUpdateStore((state) => state.state)
  const phase = updateState?.phase
  const busy = phase === 'checking' || phase === 'downloading' || phase === 'installing'

  function handleCheckAgain(): void {
    void window.refract.updates.check().then((result) => {
      if (!result.ok) {
        notify(result.error)
        return
      }
      const next = result.value
      if (next.phase === 'failed') {
        toast.error(next.lastError ?? 'Update failed for an unknown reason.')
      } else if (next.phase === 'idle' && next.unavailableReason !== undefined) {
        toast.error(updateUnavailableReasonText(next.unavailableReason))
      } else if (next.phase === 'idle') {
        toast.success('Refract is up to date.')
      } else {
        toast.success('An update is available.')
      }
    })
  }

  if (phase === 'downloaded') {
    return (
      <DropdownMenuItem onSelect={() => toast.info('Refract updates automatically the next time you quit.')}>
        <RefreshCwIcon aria-hidden />
        <span className="flex-1">Restart to update</span>
        <span className="text-xs text-muted-foreground">v{updateState?.availableVersion}</span>
      </DropdownMenuItem>
    )
  }

  return (
    <DropdownMenuItem
      aria-disabled={busy || undefined}
      aria-label={busy ? 'Check for updates, checking…' : undefined}
      onSelect={(event) => {
        if (busy) {
          event.preventDefault()
          return
        }
        handleCheckAgain()
      }}
    >
      {busy ? <LoaderCircleIcon aria-hidden className="animate-spin" /> : <RefreshCwIcon aria-hidden />}
      Check for updates
    </DropdownMenuItem>
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
      {/* Update entry (issue #569, spec 008 FR-021, T024b): always present, fixed between
          Keyboard shortcuts and Health check per FR-018. */}
      <UpdateMenuItem />
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
  onFixSignIn,
  onCheckGithubAgain,
  onKeyboardShortcuts,
  onHealthCheck,
  onWhatsNew,
  onThemeApplied
}: ProfileMenuContentProps) {
  const signedIn = githubStatus === 'ready' && account !== undefined
  // A11y M1 (quality-gate remediation, gate-3): reactive, not a `getState()` read -- while a
  // window-focus-triggered refresh (init-stores.ts) is already in flight when this menu opens,
  // the 'error' row below shows "Checking…" instead of re-offering "Check again" for a read
  // that is already running.
  const githubRefreshing = useAccountsStore((state) => state.githubRefreshing)
  // UI N4 (quality-gate remediation, gate-3): an unreachable host (the `problem` field, or the
  // legacy `timeout` state before it existed) reads "Can't reach GitHub"/"Check GitHub
  // connection…" -- Sign in again cannot fix an unreachable host, so neither wording nor the
  // action it promises should claim it can.
  const unreachable = account !== undefined && (account.problem === 'unreachable' || account.state === 'timeout')
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
                {account.state !== 'success'
                  ? unreachable
                    ? "Can't reach GitHub"
                    : 'GitHub sign-in needs attention'
                  : `@${account.login} on ${account.host}`}
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
        // as nobody being signed in). A11y M1 / UI N3 (quality-gate remediation, gate-3): guarded
        // by `githubRefreshing` (same pattern as Manage accounts' own Add account) so a refresh
        // already running (e.g. the window-focus one, init-stores.ts) cannot be restarted from
        // here. The result is announced by the caller (ProfileItem.tsx's `onCheckGithubAgain`)
        // once this item has already unmounted. No `aria-label` while idle (quality-gate
        // remediation, Code LOW 7 / A11y Medium, gate-4): the row's two text nodes ("GitHub
        // unavailable", "Check again") already give an accessible name that starts with the
        // visible text, which a fixed label used to break (WCAG 2.5.3 Label in Name) -- only the
        // busy state still needs one, since its visible text changes to "Checking…" but the
        // concatenated default name would otherwise still read "...Check again".
        <DropdownMenuItem
          key="first-row"
          aria-disabled={githubRefreshing || undefined}
          aria-label={githubRefreshing ? 'GitHub unavailable, Checking…' : undefined}
          onSelect={(event) => {
            if (githubRefreshing) {
              event.preventDefault()
              return
            }
            onCheckGithubAgain()
          }}
        >
          {githubRefreshing ? (
            <LoaderCircleIcon aria-hidden className="animate-spin" />
          ) : (
            <TriangleAlertIcon aria-hidden />
          )}
          <span className="flex-1">GitHub unavailable</span>
          <span className="text-xs text-muted-foreground">{githubRefreshing ? 'Checking…' : 'Check again'}</span>
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
        <DropdownMenuItem key="fix-sign-in" onSelect={onFixSignIn}>
          <TriangleAlertIcon aria-hidden />
          {unreachable ? 'Check GitHub connection…' : 'Fix sign-in…'}
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
