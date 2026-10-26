// Manage accounts' OMP provider section (spec 008 FR-016, T019, research.md Decision 6 /
// FINDINGS item 43): read-only -- OMP 18.6.1 has no `/login`/`/logout` over rpc-ui, so this
// never offers a sign-in or sign-out action, only the read and an instruction to run
// `omp login` in a terminal (never `/logout`: no terminal counterpart was found for it either).
// A real read spawns a scratch `omp` process (~4.7 s measured), so it is never fetched eagerly:
// ManageAccountsDialog.tsx calls `refreshOmpProviders()` once when the dialog opens; this
// component only re-triggers it from "Check again"/"Retry", and otherwise just renders whatever
// the store already has (stale-while-revalidate -- cached data is never hidden behind a loading
// skeleton for a later refresh, only for the very first read of the app session).
import { useEffect, useRef, useState } from 'react'
import { CheckIcon, ChevronDownIcon, CopyIcon, LoaderCircleIcon, MinusIcon, TriangleAlertIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { ompSummaryLine, splitOmpProviders } from '@/lib/account-format'
import { notify, useAccountsStore } from '@/state'

export interface OmpProvidersSectionProps {
  /** The dialog's own shared live regions (ManageAccountsDialog.tsx) -- this section never owns
   *  a live region of its own, so a screen reader never has more than the two existing channels
   *  to listen to. */
  announcePolite(message: string): void
  announceAssertive(message: string): void
}

export function OmpProvidersSection({ announcePolite, announceAssertive }: OmpProvidersSectionProps) {
  const providers = useAccountsStore((state) => state.ompProviders)
  const status = useAccountsStore((state) => state.ompStatus)
  const refreshing = useAccountsStore((state) => state.ompRefreshing)

  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const checkAgainRef = useRef<HTMLButtonElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Guards against setting local state after this section unmounts (closing the dialog mid-read
  // is safe: the store call itself still completes and stores its result regardless).
  const mountedRef = useRef(true)
  useEffect(() => {
    // StrictMode mounts, unmounts, then remounts every component in development: without resetting
    // this on mount, the cleanup below would leave the guard false for good and every post-await
    // step (announcement, focus, "Copied") would be skipped.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    }
  }, [])

  const { signedIn, other } = splitOmpProviders(providers)
  const total = providers.length
  const initialLoading = status === 'loading'

  async function handleRefresh(fromRetry: boolean): Promise<void> {
    const result = await useAccountsStore.getState().refreshOmpProviders()
    if (!mountedRef.current) return
    if (result.ok) {
      const fresh = useAccountsStore.getState().ompProviders
      const freshSignedIn = fresh.filter((provider) => provider.authenticated).length
      announcePolite(`OMP providers: ${freshSignedIn} of ${fresh.length} signed in`)
      checkAgainRef.current?.focus()
    } else {
      announceAssertive('Could not read OMP providers')
      if (fromRetry) retryRef.current?.focus()
      else checkAgainRef.current?.focus()
    }
  }

  async function handleCopy(): Promise<void> {
    // Same reason as AddAccountPanel.tsx's handleCopy: the sandboxed renderer denies every
    // Clipboard API permission, so this goes straight through main's own allowlisted channel.
    const result = await window.refract.clipboard.writeText('omp login')
    if (!mountedRef.current) return
    if (!result.ok) {
      notify(result.error)
      announceAssertive('Could not copy the command')
      return
    }
    setCopied(true)
    announcePolite('Command copied to clipboard')
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    copyTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) setCopied(false)
    }, 2000)
  }

  return (
    <section aria-labelledby="omp-providers-heading" aria-busy={initialLoading || undefined} className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id="omp-providers-heading" className="truncate text-sm font-medium">
            OMP provider sign-in
          </h3>
          <p className="text-sm text-muted-foreground">
            Refract uses the model providers your local OMP agent is signed in to. These are separate from your GitHub accounts.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {refreshing && total > 0 && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
              Checking…
            </span>
          )}
          <Button
            ref={checkAgainRef}
            variant="ghost"
            size="xs"
            aria-disabled={refreshing || undefined}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={() => {
              if (!refreshing) void handleRefresh(false)
            }}
          >
            Check again
          </Button>
        </div>
      </div>

      {initialLoading ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">Checking OMP providers…</p>
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      ) : total > 0 ? (
        <>
          <p className="text-xs text-muted-foreground">{ompSummaryLine(signedIn.length, total)}</p>

          {signedIn.length === 0 ? (
            <p className="text-xs text-muted-foreground">No provider is signed in.</p>
          ) : (
            <ul role="list" aria-label="Signed in OMP providers" className="flex flex-col gap-1">
              {signedIn.map((provider) => (
                <li key={provider.id} className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate font-code text-xs" title={provider.id}>
                    {provider.id}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-xs">
                    <CheckIcon aria-hidden className="size-3.5" />
                    Signed in
                  </span>
                </li>
              ))}
            </ul>
          )}

          {other.length > 0 && (
            <Collapsible open={expanded} onOpenChange={setExpanded}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="xs" className="w-fit">
                  <ChevronDownIcon aria-hidden className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
                  {expanded ? 'Show signed in only' : `Show all ${total} providers…`}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul role="list" aria-label="Other OMP providers" className="mt-2 flex max-h-36 flex-col gap-1 overflow-y-auto pr-3">
                  {other.map((provider) => (
                    <li key={provider.id} className="flex min-w-0 items-center justify-between gap-2">
                      <span className="truncate font-code text-xs" title={provider.id}>
                        {provider.id}
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <MinusIcon aria-hidden className="size-3.5" />
                        Not signed in
                      </span>
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      ) : status === 'ready' ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">No providers reported by OMP</p>
          <p className="text-xs text-muted-foreground">OMP returned an empty provider list.</p>
        </div>
      ) : null}

      {status === 'error' && (
        <div className="flex flex-col gap-1 rounded-md border border-border p-2">
          <span className="flex items-center gap-1 text-xs text-state-needs-you">
            <TriangleAlertIcon aria-hidden className="size-3.5" />
            Could not read OMP providers
          </span>
          <p className="text-xs text-muted-foreground">OMP did not respond or returned an error.</p>
          <div className="flex justify-end">
            <Button
              ref={retryRef}
              variant="outline"
              size="xs"
              aria-disabled={refreshing || undefined}
              className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
              onClick={() => {
                if (!refreshing) void handleRefresh(true)
              }}
            >
              Retry
            </Button>
          </div>
        </div>
      )}

      <div className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border p-2">
        <p className="min-w-0 text-xs text-muted-foreground">
          To sign in to another provider, run <code className="font-code">omp login</code> in a terminal.
        </p>
        {/* No `aria-label` (WCAG 2.5.3 Label in Name, quality-gate remediation accessibility-
            auditor Low): the accessible name now matches the visible "Copy command"/"Copied"
            text exactly, the same fix AddAccountPanel.tsx's own Copy code button already has. */}
        <Button variant="outline" size="xs" className="shrink-0" onClick={() => void handleCopy()}>
          {copied ? <CheckIcon aria-hidden className="size-3.5" /> : <CopyIcon aria-hidden className="size-3.5" />}
          {copied ? 'Copied' : 'Copy command'}
        </Button>
      </div>
    </section>
  )
}
