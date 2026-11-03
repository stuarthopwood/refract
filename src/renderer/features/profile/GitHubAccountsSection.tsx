import type { RefObject } from 'react'
import { LoaderCircleIcon } from 'lucide-react'
import { ExternalLink } from '@/components/ExternalLink'
import { InlineStatus } from '@/components/InlineStatus'
import { ScreenSection } from '@/components/ScreenSection'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import type { GitHubAccount, GitHubAddFlowProgress } from '../../../shared/accounts'
import type { GithubStatus } from '@/state/accounts'
import { AddAccountPanel } from './AddAccountPanel'
import { GitHubAccountRow, type AccountRowRefs } from './GitHubAccountRow'
import { rowKey } from './accountDialogFocus'

export interface GitHubAccountsSectionProps {
  status: GithubStatus
  /** Active account first. */
  accounts: GitHubAccount[]
  rowRefs: AccountRowRefs
  addAccountRef: RefObject<HTMLButtonElement | null>
  installLinkRef: RefObject<HTMLAnchorElement | null>
  checkAgainHeaderRef: RefObject<HTMLButtonElement | null>
  githubRefreshing: boolean
  starting: boolean
  addFlow: GitHubAddFlowProgress | null
  cancellingFlow: boolean
  reauthLogin: string | null
  pendingSwitch: { host: string; login: string } | null
  onHeaderCheckAgain(): void
  onAddAccount(): void
  onSignInAgain(login: string): void
  onCancelFlow(flowId: string): void
  onRetryFlow(): void
  onDismissFlow(): void
  onRowCheckAgain(account: GitHubAccount): void
  onSwitch(account: GitHubAccount): void
  onSignOut(account: GitHubAccount): void
}

export function GitHubAccountsSection(props: GitHubAccountsSectionProps) {
  const { status, accounts, rowRefs, addFlow, starting, githubRefreshing, pendingSwitch } = props
  const flowActive = starting || addFlow?.status === 'waiting'

  const headerCheckAgain = (
    <Button
      ref={props.checkAgainHeaderRef}
      variant="ghost"
      size="sm"
      className="shrink-0 aria-disabled:opacity-50"
      aria-disabled={githubRefreshing || undefined}
      onClick={() => {
        if (!githubRefreshing) props.onHeaderCheckAgain()
      }}
    >
      {githubRefreshing ? 'Checking…' : 'Check again'}
    </Button>
  )

  if (status === 'missing-cli') {
    return (
      <ScreenSection title="GitHub CLI not found" headingLevel={3} actions={headerCheckAgain} className="min-w-0">
        <p className="text-sm text-muted-foreground">Refract signs in through the GitHub CLI so it never stores your token.</p>
        <Button asChild variant="ghost" size="sm" className="w-fit">
          <ExternalLink ref={props.installLinkRef} href="https://cli.github.com">
            Install GitHub CLI
          </ExternalLink>
        </Button>
      </ScreenSection>
    )
  }

  if (status === 'loading') {
    return (
      <ScreenSection title="GitHub accounts" headingLevel={3} busy className="min-w-0">
        <InlineStatus
          tone="loading"
          density="compact"
          className="p-0"
          leading={<LoaderCircleIcon aria-hidden className="mr-1 inline size-[1em] align-[-0.125em] animate-spin motion-reduce:animate-none" />}
        >
          Checking GitHub sign-in…
        </InlineStatus>
      </ScreenSection>
    )
  }

  if (status === 'error') {
    return (
      <ScreenSection title="GitHub accounts" headingLevel={3} actions={headerCheckAgain} className="min-w-0">
        <InlineStatus tone="error" density="compact" className="p-0">
          Couldn't read your GitHub CLI accounts.
        </InlineStatus>
      </ScreenSection>
    )
  }

  return (
    <ScreenSection
      title="GitHub accounts"
      headingLevel={3}
      className="min-w-0"
      actions={
        <Button
          ref={props.addAccountRef}
          variant={accounts.length === 0 ? 'default' : 'ghost'}
          size="sm"
          className="aria-disabled:opacity-50"
          aria-disabled={flowActive || undefined}
          onClick={() => {
            if (!flowActive) props.onAddAccount()
          }}
        >
          Add account
        </Button>
      }
    >
      <AddAccountPanel
        flow={addFlow}
        starting={starting}
        cancelling={props.cancellingFlow}
        reauthLogin={props.reauthLogin}
        onCancel={props.onCancelFlow}
        onRetry={props.onRetryFlow}
        onDismiss={props.onDismissFlow}
      />
      {accounts.length === 0 ? (
        <Empty className="border p-4">
          <EmptyHeader>
            <EmptyTitle>No GitHub account is signed in</EmptyTitle>
            <EmptyDescription>Sign in to review pull requests and check for updates.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul role="list" className="flex min-w-0 flex-col gap-2">
          {accounts.map((account) => (
            <GitHubAccountRow
              key={rowKey(account.host, account.login)}
              account={account}
              refs={rowRefs}
              busy={pendingSwitch !== null && pendingSwitch.host === account.host && pendingSwitch.login === account.login}
              switchDisabled={pendingSwitch !== null}
              githubRefreshing={githubRefreshing}
              flowActive={flowActive}
              onCheckAgain={props.onRowCheckAgain}
              onSignInAgain={props.onSignInAgain}
              onSwitch={props.onSwitch}
              onSignOut={props.onSignOut}
            />
          ))}
        </ul>
      )}
    </ScreenSection>
  )
}
