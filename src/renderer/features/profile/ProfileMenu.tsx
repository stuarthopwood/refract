import { useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ActivityIcon,
  ExternalLinkIcon,
  KeyboardIcon,
  LayersIcon,
  LoaderCircleIcon,
  LogInIcon,
  LogOutIcon,
  DownloadIcon,
  PaletteIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  TriangleAlertIcon,
  UsersIcon
} from 'lucide-react'
import { ExternalLink } from '@/components/ExternalLink'
import { UserAvatar } from '@/components/UserAvatar'
import { ThemeSwatchChip } from '@/components/ui/theme-swatch-chip'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { updateUnavailableReasonText } from '@/lib/updateStatus'
import { useAccountsStore, useActiveThemeId, useThemeStore, useUpdateStore, useViewStore } from '@/state'
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
  onSignIn(): void
  onSignOut(): void
  onFixSignIn(): void
  onCheckGithubAgain(): void
  onKeyboardShortcuts(): void
  onHealthCheck(): void
  onWhatsNew(): void
  onThemeApplied(label: string): void
}

function ThemeSubmenu({ onThemeApplied }: { onThemeApplied(label: string): void }) {
  const activeId = useActiveThemeId()
  const customId = useThemeStore((s) => s.customId)
  const customThemes = useThemeStore((s) => s.customThemes)
  const [open, setOpen] = useState(false)
  const subContentRef = useRef<HTMLDivElement>(null)
  const activeItemRef = useRef<HTMLDivElement>(null)

  function chooseTheme(id: ThemeId, name: string): void {
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
        void useThemeStore.getState().refreshCustomThemes()
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
      <DropdownMenuSubContent ref={subContentRef} className="max-w-64" sideOffset={4} alignOffset={-4} collisionPadding={8}>
        <DropdownMenuRadioGroup
          value={customId ? `custom:${customId}` : activeId}
          onValueChange={(value) => {
            if (value.startsWith('custom:')) {
              const custom = customThemes.find((t) => `custom:${t.id}` === value)
              if (custom && custom.id !== customId) void useThemeStore.getState().saveCustom(custom.id).then((ok) => ok && onThemeApplied(custom.name))
              return
            }
            const theme = THEME_LIST.find((candidate) => candidate.id === value)
            if (theme && (theme.id !== activeId || customId)) chooseTheme(theme.id, theme.name)
          }}
        >
          {THEME_LIST.map((theme) => {
            const isActive = theme.id === activeId && !customId
            return (
              <DropdownMenuRadioItem
                key={theme.id}
                value={theme.id}
                ref={isActive ? activeItemRef : undefined}
              >
                <span className="min-w-0 flex-1 truncate">{theme.name}</span>
                {/* #1043/#1070: the shared two-colour chip (`ThemeSwatchChip`), the same one Settings > Appearance draws. */}
                <ThemeSwatchChip swatch={theme.swatch} swatchPrimary={theme.swatchPrimary} />
              </DropdownMenuRadioItem>
            )
          })}
          {customThemes.length > 0 && <DropdownMenuLabel>Custom</DropdownMenuLabel>}
          {customThemes.map((t) => (
            <DropdownMenuRadioItem key={t.id} value={`custom:${t.id}`} ref={t.id === customId ? activeItemRef : undefined}>
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              <ThemeSwatchChip swatch={t.tokens.background ?? THEMES[t.base].swatch} swatchPrimary={t.tokens.primary ?? THEMES[t.base].swatchPrimary} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => useViewStore.getState().openSettings('appearance')}>
          <SlidersHorizontalIcon aria-hidden />
          Appearance settings…
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function UpdateMenuItem() {
  const updateState = useUpdateStore((state) => state.state)
  const phase = updateState?.phase
  const busy = phase === 'checking' || phase === 'downloading' || phase === 'installing'
  const busyLabel = phase === 'checking' ? 'Checking for updates…' : phase === 'downloading' ? 'Downloading update…' : phase === 'installing' ? 'Installing update…' : 'Check for updates'

  function handleCheckAgain(): void {
    const id = toast.loading('Checking for updates…')
    void window.refract.updates
      .check()
      .then((result) => {
        if (!result.ok) {
          toast.error(result.error.message, { id })
          return
        }
        const next = result.value
        if (next.phase === 'failed') {
          toast.error(next.lastError ?? 'Update failed for an unknown reason.', { id })
        } else if (next.phase === 'idle' && next.unavailableReason !== undefined) {
          toast.warning(updateUnavailableReasonText(next.unavailableReason), { id })
        } else if (next.phase === 'idle') {
          toast.info('Refract is up to date.', { id })
        } else if (next.phase === 'available') {
          toast.info(`Refract v${next.availableVersion} is available. Download it from the status bar.`, { id })
        } else if (next.phase === 'downloading') {
          toast.info('An update is already downloading.', { id })
        } else if (next.phase === 'downloaded') {
          toast.info(`Refract v${next.availableVersion} is downloaded; it installs the next time you quit.`, { id })
        } else if (next.phase === 'installing') {
          toast.info('Refract is installing the update.', { id })
        }
      })
      .catch(() => toast.error('Could not check for updates.', { id }))
  }

  if (phase === 'downloaded') {
    return (
      <DropdownMenuItem onSelect={() => toast.info('Refract updates automatically the next time you quit.')}>
        <RefreshCwIcon aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span>Restart to update</span>
          <span className="text-xs text-muted-foreground">Installs when you quit</span>
        </span>
        {updateState?.availableVersion && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            <span aria-hidden> </span>
            <span className="sr-only"> version </span>v{updateState.availableVersion}
          </span>
        )}
      </DropdownMenuItem>
    )
  }

  return (
    <DropdownMenuItem
      aria-disabled={busy || undefined}
      onSelect={(event) => {
        if (busy) {
          event.preventDefault()
          return
        }
        handleCheckAgain()
      }}
    >
      {busy ? <LoaderCircleIcon aria-hidden className="animate-spin" /> : <RefreshCwIcon aria-hidden />}
      {busyLabel}
    </DropdownMenuItem>
  )
}


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
        <ExternalLinkIcon aria-hidden className="size-4" />
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
  const githubRefreshing = useAccountsStore((state) => state.githubRefreshing)
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
          <DropdownMenuLabel className="flex items-center gap-2 font-normal">
            <UserAvatar name={account.displayName ?? account.login} src={account.avatarDataUrl ?? undefined} />
            <div className="flex min-w-0 flex-1 flex-col leading-tight">
              {/* UI M4 (quality-gate remediation): icon plus text, never colour alone, when the
                  ACTIVE account's own GitHub sign-in needs attention. */}
              <span className="flex items-center gap-1 truncate text-sm">
                {account.state !== 'success' && (
                  <TriangleAlertIcon aria-hidden className="size-4 shrink-0 text-state-needs-you" />
                )}
                <span className="truncate" title={account.displayName ?? account.login}>{account.displayName ?? account.login}</span>
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
          <ExternalLink href="https://cli.github.com" className="w-full"><DownloadIcon aria-hidden /><span className="flex-1">Install GitHub CLI</span><span className="sr-only">Opens in your browser</span></ExternalLink>
        </DropdownMenuItem>
      ) : githubStatus === 'error' ? (
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
