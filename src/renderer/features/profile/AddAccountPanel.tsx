// Inline add-account flow: rendered under Manage accounts' section header, never as a nested
// dialog, so the one-time code stays visible beside the account list it is about to extend.
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CopyButton } from '@/components/ui/copy-button'
import { ExternalLink } from '@/components/ExternalLink'
import { InlineStatus } from '@/components/InlineStatus'
import { formatDeviceCode } from '@/lib/account-format'
import type { GitHubAddFlowProgress } from '../../../shared/accounts'

export interface AddAccountPanelProps {
  /** The running flow's progress, or `null` before the first progress event arrives. */
  flow: GitHubAddFlowProgress | null
  /** True from the moment `addAccountStart()`'s own request is sent until it resolves or fails outright. */
  starting: boolean
  /** True from the Cancel click until the flow's process has actually ended (about 2 s). */
  cancelling?: boolean
  /** Set when the flow re-signs-in an existing account; changes the title only. */
  reauthLogin?: string | null
  onCancel(flowId: string): void
  onRetry(): void
  onDismiss(): void
}

/** The code spelled out character by character for a screen reader; hyphens are only visual grouping. */
function spellOutCode(code: string): string {
  return code.replace(/-/g, '').split('').join(' ')
}

export function AddAccountPanel({ flow, starting, cancelling = false, reauthLogin = null, onCancel, onRetry, onDismiss }: AddAccountPanelProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const copyRef = useRef<HTMLDivElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)
  const code = flow?.code ?? ''
  const status = flow?.status

  // Focus map: Cancel while waiting for the code, the Copy button once it appears, Retry once the flow fails.
  useEffect(() => {
    if (status === 'failed') retryRef.current?.focus()
    else if (code) copyRef.current?.querySelector('button')?.focus()
    else cancelRef.current?.focus()
  }, [status, code])

  if (!flow && !starting) return null

  return (
    <Card size="sm" className="min-w-0 gap-2">
      <CardHeader>
        <CardTitle>{reauthLogin ? `Sign in again as @${reauthLogin}` : 'Add GitHub account'}</CardTitle>
        <CardAction>
          {status === 'failed' ? (
            <div className="flex items-center gap-1">
              <Button ref={retryRef} variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
              <Button variant="ghost" size="sm" onClick={onDismiss}>
                Dismiss
              </Button>
            </div>
          ) : (
            // `aria-disabled`, not `disabled`: a disabled focused button drops focus to <body>.
            <Button
              ref={cancelRef}
              variant="ghost"
              size="sm"
              className="aria-disabled:opacity-50"
              aria-disabled={!flow || cancelling || undefined}
              onClick={() => flow && !cancelling && onCancel(flow.flowId)}
            >
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-2">
        {status === 'failed' ? (
          <InlineStatus tone="error" density="compact" className="p-0 text-sm">
            {flow?.detail ?? 'Sign-in did not finish.'}
          </InlineStatus>
        ) : !code ? (
          <InlineStatus tone="loading" density="compact" className="p-0 text-sm">
            Starting sign-in…
          </InlineStatus>
        ) : (
          <ol className="flex min-w-0 list-decimal flex-col gap-2 pl-6 text-sm">
            <li>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span aria-hidden className="font-code text-xl font-medium tracking-widest">
                  {formatDeviceCode(code)}
                </span>
                <span className="sr-only">One-time code: {spellOutCode(code)}</span>
                <div ref={copyRef}>
                  <CopyButton showLabel getText={() => code} label="Copy code" announcement="Code copied" />
                </div>
              </div>
            </li>
            <li>
              Enter the code on GitHub in the browser window that opened. If it did not open, go to the{' '}
              <ExternalLink href="https://github.com/login/device" className="underline underline-offset-2">
                GitHub device page
              </ExternalLink>
              .
            </li>
            <li>
              <InlineStatus tone="loading" density="compact" className="inline p-0 text-sm">
                Waiting for GitHub…
              </InlineStatus>
            </li>
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
