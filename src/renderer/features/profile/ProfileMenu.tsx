import { Fragment, useRef, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import {
  ActivityIcon,
  ExternalLinkIcon,
  KeyboardIcon,
  LayersIcon,
  LogInIcon,
  LogOutIcon,
  PaletteIcon,
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
import { useThemeEntries } from '@/lib/useThemeEntries'
import type { ThemeEntry } from '@/lib/themeGroups'
import { useAccountsStore, useThemeStore, useViewStore } from '@/state'
import type { GithubStatus } from '@/state'
import type { GitHubAccount } from '../../../shared/accounts'
import { UpdateMenuItem } from './UpdateMenuItem'

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
  onUpdateNow(): void
  onThemeApplied(label: string): void
}

function ThemeSubmenu({ onThemeApplied }: { onThemeApplied(label: string): void }) {
  const { builtinGroups, customs, all, isActive, choose } = useThemeEntries()
  const activeEntry = all.find(isActive)
  const [open, setOpen] = useState(false)
  const subContentRef = useRef<HTMLDivElement>(null)
  const activeItemRef = useRef<HTMLDivElement>(null)
  const renderItem = (e: ThemeEntry) => (
    <DropdownMenuRadioItem key={e.key} value={e.key} ref={e === activeEntry ? activeItemRef : undefined}>
      <span className="min-w-0 flex-1 truncate">{e.name}</span>
      <ThemeSwatchChip swatch={e.swatch} swatchPrimary={e.swatchPrimary} />
    </DropdownMenuRadioItem>
  )

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
          value={activeEntry?.key}
          onValueChange={(value) => {
            const entry = all.find((e) => e.key === value)
            if (entry) void choose(entry).then((ok) => ok && onThemeApplied(entry.name))
          }}
        >
          {builtinGroups.map((group) => (
            <Fragment key={group.label}>
              <DropdownMenuLabel>{group.label} themes</DropdownMenuLabel>
              {group.entries.map(renderItem)}
            </Fragment>
          ))}
          {customs.length > 0 && <DropdownMenuLabel>Custom</DropdownMenuLabel>}
          {customs.map(renderItem)}
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

function CommonMenuItems({
  onKeyboardShortcuts,
  onHealthCheck,
  onWhatsNew,
  onUpdateNow
}: {
  onKeyboardShortcuts(): void
  onHealthCheck(): void
  onWhatsNew(): void
  onUpdateNow(): void
}) {
  return (
    <>
      <DropdownMenuItem onSelect={onKeyboardShortcuts}>
        <KeyboardIcon aria-hidden />
        Keyboard shortcuts
      </DropdownMenuItem>
      {/* Update entry (issue #569, spec 008 FR-021, T024b): always present, fixed between
          Keyboard shortcuts and Health check per FR-018. */}
      <UpdateMenuItem onUpdateNow={onUpdateNow} />
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
  onUpdateNow,
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
          <ExternalLink href="https://cli.github.com" className="w-full"><span className="flex-1">Install GitHub CLI</span></ExternalLink>
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
            <Spinner />
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
          <Spinner />
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
        onUpdateNow={onUpdateNow}
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
