// The "GitHub" block at the top of the session list (#504, ui-architect ruling): Pull requests
// (specs/003-pull-request-management FR-001) and Issues, kept apart from the Project groups below
// by a divider. A `role="group"` inside the existing Sessions `<nav>` (never a nested landmark).
// `aria-current` gives the open view a visible AND accessible signal, never colour alone (FR-030).
import { useEffect, type ComponentType, type ReactNode } from 'react'
import { CircleDotIcon, GitPullRequestIcon, HouseIcon } from 'lucide-react'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { SIDEBAR_NAV_BUTTON_CLASS } from '@/components/sidebarNavButtonClass'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useDefaultRepositoryId } from '@/lib/defaultRepository'
import { useAccountsStore, usePullRequestsStore, useSessionsStore, useSplitStore, useViewStore } from '@/state'

interface NavItemProps {
  active: boolean
  label: string
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  onClick(): void
  children?: ReactNode
  text: string
}

function NavItem({ active, label, icon: Icon, onClick, children, text }: NavItemProps) {
  return (
    <Button
      variant="ghost"
      aria-current={active ? 'page' : undefined}
      // `data-choice-item` joins this entry to the shared square-choice selector (globals.css).
      data-choice-item
      // The forced-colors outline classes draw a real focus ring where `Button`'s box-shadow ring is stripped.
      className={cn(
        'relative mx-2',
        SIDEBAR_NAV_BUTTON_CLASS,
        'forced-colors:focus-visible:outline-solid forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-[-2px]',
        active && 'bg-sidebar-accent text-sidebar-accent-foreground'
      )}
      aria-label={label}
      onClick={onClick}
    >
      {active && <ActiveIndicatorBar />}
      <Icon aria-hidden className="size-4" />
      <span className="min-w-0 truncate">{text}</span>
      {children}
    </Button>
  )
}

export function GitHubNavGroup() {
  const openPullRequests = useViewStore((state) => state.openPullRequests)
  const openIssues = useViewStore((state) => state.openIssues)
  const view = useViewStore((state) => state.view)
  const openHome = useViewStore((state) => state.openHome)
  const noPane = useSplitStore((state) => state.paneSessionIds.length === 0)
  const needsYouCount = useSessionsStore((state) => state.sessions.filter((s) => s.status === 'needs-you' && !s.archivedAt && !s.hiddenAt).length)
  const selectPullRequest = usePullRequestsStore((state) => state.select)
  // Defaults to the focused pane's Session's repository, then the first added one; the view's own
  // Project control changes it afterward (issue #569: shared, reactive hook).
  const defaultRepositoryId = useDefaultRepositoryId()
  const githubStatus = useAccountsStore((state) => state.githubStatus)
  const activeCount = usePullRequestsStore((state) =>
    defaultRepositoryId ? state.activeCountFor(defaultRepositoryId).count : null
  )
  // `null` covers never fetched, zero and unavailable alike: all render as nothing (#569 decision 4).
  const activeCountLabel =
    githubStatus === 'ready' && activeCount !== null && activeCount > 0 ? (activeCount >= 30 ? '30+' : String(activeCount)) : null
  // Issue #569 decision 2(a)/(b): fetches once per default repository with no cached count yet,
  // never on a timer; focus refresh and the explicit Refresh live in `init-stores.ts` and the list.
  useEffect(() => {
    if (!defaultRepositoryId) return
    if (githubStatus !== 'ready') return
    if (usePullRequestsStore.getState().activeCountByRepository[defaultRepositoryId]) return
    void usePullRequestsStore.getState().refreshActiveCount(defaultRepositoryId)
  }, [defaultRepositoryId, githubStatus])

  function handleOpenPullRequests(): void {
    if (!defaultRepositoryId) return
    selectPullRequest(null)
    openPullRequests()
  }

  return (
    <div role="group" aria-label="Views" className="flex shrink-0 flex-col gap-1 pt-2">
      <NavItem
        active={view === 'home' || (view === 'chat' && noPane)}
        icon={HouseIcon}
        text="Home"
        label={needsYouCount > 0 ? `Home, ${needsYouCount} need you` : 'Home'}
        onClick={openHome}
      >
        {needsYouCount > 0 && (
          <span className="ml-auto shrink-0 text-xs font-normal tabular-nums text-muted-foreground">{needsYouCount} need you</span>
        )}
      </NavItem>
      <NavItem
        active={view === 'pull-requests'}
        icon={GitPullRequestIcon}
        text="Pull requests"
        label={activeCountLabel ? `Pull requests, ${activeCountLabel} active` : 'Pull requests'}
        onClick={handleOpenPullRequests}
      >
        {/* A plain trailing count, never a box or brackets; folded into the aria-label above. */}
        {activeCountLabel && (
          <span className="ml-auto shrink-0 text-xs font-normal tabular-nums text-muted-foreground">{activeCountLabel} active</span>
        )}
      </NavItem>
      <NavItem active={view === 'issues'} icon={CircleDotIcon} text="Issues" label="Issues" onClick={openIssues} />
      <div role="separator" className="mx-2 mt-2 border-t border-divider" />
    </div>
  )
}
