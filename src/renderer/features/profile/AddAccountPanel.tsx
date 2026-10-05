// Inline add-account flow (FR-009, T017): rendered directly under Manage accounts' section
// header, never as a nested dialog -- the one-time code and its progress need to stay visible
// alongside the account list it is about to extend, not hide it behind a second modal layer.
import { useEffect, useRef, useState } from 'react'
import { CheckIcon, CopyIcon, ExternalLinkIcon, LoaderCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { formatDeviceCode } from '@/lib/account-format'
import type { GitHubAddFlowProgress } from '../../../shared/ipc'

export interface AddAccountPanelProps {
  /** The running flow's progress, or `null` before the first progress event arrives. */
  flow: GitHubAddFlowProgress | null
  /** True from the moment `addAccountStart()`'s own request is sent until either it resolves
   *  with a `flowId` (at which point `flow` becomes non-null) or fails outright. */
  starting: boolean
  onCancel(flowId: string): void
  onRetry(): void
}

/** The one-time code spelled out character by character for a screen reader (the visible
 *  grouped text is marked `aria-hidden` so this is the only copy actually read). Hyphens are
 *  dropped -- they are a visual grouping aid, not a character to announce. */
function spellOutCode(code: string): string {
  return code.replace(/-/g, '').split('').join(' ')
}

export function AddAccountPanel({ flow, starting, onCancel, onRetry }: AddAccountPanelProps) {
  const [copied, setCopied] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const copyRef = useRef<HTMLButtonElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)
  const code = flow?.code ?? ''
  const status = flow?.status

  // Focus map (approved design): Cancel while waiting for the code, Copy code once it appears,
  // Retry once the flow fails.
  useEffect(() => {
    if (status === 'failed') {
      retryRef.current?.focus()
    } else if (code) {
      copyRef.current?.focus()
    } else {
      cancelRef.current?.focus()
    }
  }, [status, code])

  useEffect(() => {
    setCopied(false)
  }, [flow?.flowId])

  async function handleCopy(): Promise<void> {
    // The ungrouped code with its own hyphen (if any), exactly as `gh` emits it -- never the
    // cosmetic XXXX-XXXX grouping, which is a display-only transform.
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!flow && !starting) return null

  return (
    <Card size="sm" className="gap-2">
      <CardHeader>
        <CardTitle>Add GitHub account</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">Enter this code on GitHub to finish signing in.</p>

        {status === 'failed' ? (
          <>
            <p role="alert" className="text-sm text-destructive">
              Sign-in failed. Check your connection and retry.
            </p>
            {flow?.detail && <p className="text-xs text-muted-foreground">{flow.detail}</p>}
            <div className="flex justify-end">
              <Button ref={retryRef} variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            </div>
          </>
        ) : !code ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
            Starting sign-in…
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <div>
                <span className="text-xs text-muted-foreground">One-time code</span>
                <div className="flex items-center gap-2">
                  <span aria-hidden className="font-code text-xl font-semibold tracking-widest">
                    {formatDeviceCode(code)}
                  </span>
                  <span className="sr-only">One-time code: {spellOutCode(code)}</span>
                </div>
              </div>
              <Button ref={copyRef} variant="outline" size="sm" onClick={() => void handleCopy()} aria-label="Copy one-time code">
                {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
                {copied ? 'Copied' : 'Copy code'}
              </Button>
              <span aria-live="polite" aria-atomic="true" className="sr-only">
                {copied ? 'Code copied' : ''}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircleIcon aria-hidden className={cn('size-4 animate-spin')} />
              Waiting for GitHub…
            </div>
            <a
              href="https://github.com/login/device"
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex w-fit items-center gap-1.5 text-sm underline underline-offset-2"
            >
              <ExternalLinkIcon aria-hidden className="size-3.5" />
              Open the GitHub device page
            </a>
            <div className="flex justify-end">
              <Button ref={cancelRef} variant="ghost" size="sm" onClick={() => flow && onCancel(flow.flowId)}>
                Cancel
              </Button>
            </div>
          </>
        )}

        {!code && status !== 'failed' && (
          <div className="flex justify-end">
            <Button ref={cancelRef} variant="ghost" size="sm" onClick={() => flow && onCancel(flow.flowId)} disabled={!flow}>
              Cancel
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
