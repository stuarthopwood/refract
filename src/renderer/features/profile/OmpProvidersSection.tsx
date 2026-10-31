import { useEffect, useRef, useState } from 'react'
import { CheckIcon, ChevronDownIcon, MinusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { CopyButton } from '@/components/ui/copy-button'
import { Skeleton } from '@/components/ui/skeleton'
import { InlineStatus } from '@/components/InlineStatus'
import { cn } from '@/lib/utils'
import { ompSummaryLine, splitOmpProviders } from '@/lib/account-format'
import { useAccountsStore } from '@/state'

export interface OmpProvidersSectionProps {
  announcePolite(message: string): void
  announceAssertive(message: string): void
}

export function OmpProvidersSection({ announcePolite, announceAssertive }: OmpProvidersSectionProps) {
  const providers = useAccountsStore((state) => state.ompProviders)
  const status = useAccountsStore((state) => state.ompStatus)
  const refreshing = useAccountsStore((state) => state.ompRefreshing)

  const [expanded, setExpanded] = useState(false)
  const checkAgainRef = useRef<HTMLButtonElement>(null)
  // Guards against setting local state after this section unmounts (closing the dialog mid-read
  // is safe: the store call itself still completes and stores its result regardless).
  const mountedRef = useRef(true)
  useEffect(() => {
    // StrictMode mounts, unmounts, then remounts every component in development: without resetting
    // this on mount, the cleanup below would leave the guard false for good and every post-await
    // step (announcement, focus) would be skipped.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const { signedIn, other } = splitOmpProviders(providers)
  const total = providers.length
  const initialLoading = status === 'loading'

  async function handleRefresh(): Promise<void> {
    const result = await useAccountsStore.getState().refreshOmpProviders()
    if (!mountedRef.current) return
    if (result.ok) {
      const fresh = useAccountsStore.getState().ompProviders
      const freshSignedIn = fresh.filter((provider) => provider.authenticated).length
      announcePolite(`OMP providers: ${freshSignedIn} of ${fresh.length} signed in`)
      checkAgainRef.current?.focus()
    } else {
      announceAssertive('Could not read OMP providers')
      checkAgainRef.current?.focus()
    }
  }

  return (
    <section aria-labelledby="omp-providers-heading" aria-busy={initialLoading || undefined} className="flex min-w-0 flex-col gap-2">
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
            <InlineStatus tone="loading" density="compact" className="p-0">
              Checking…
            </InlineStatus>
          )}
          <Button
            ref={checkAgainRef}
            variant="text"
            size="sm"
            aria-disabled={refreshing || undefined}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={() => {
              if (!refreshing) void handleRefresh()
            }}
          >
            Check again
          </Button>
        </div>
      </div>
      {initialLoading ? (
        <div className="flex flex-col gap-2">
          <InlineStatus tone="loading" density="compact" className="p-0">
            Checking OMP providers…
          </InlineStatus>
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      ) : total > 0 ? (
        <>
          <InlineStatus density="compact" className="p-0">
            {ompSummaryLine(signedIn.length, total)}
          </InlineStatus>

          {signedIn.length === 0 ? (
            <InlineStatus density="compact" className="p-0">
              No provider is signed in.
            </InlineStatus>
          ) : (
            <ul role="list" aria-label="Signed in OMP providers" className="flex flex-col gap-1">
              {signedIn.map((provider) => (
                <li key={provider.id} className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate font-code text-xs" title={provider.id}>
                    {provider.id}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-xs">
                    <CheckIcon aria-hidden className="size-4" />
                    Signed in
                  </span>
                </li>
              ))}
            </ul>
          )}

          {other.length > 0 && (
            <Collapsible open={expanded} onOpenChange={setExpanded}>
              <CollapsibleTrigger asChild>
                <Button variant="text" size="sm" className="w-fit">
                  <ChevronDownIcon aria-hidden className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
                  {expanded ? 'Show signed in only' : `Show all ${total} providers…`}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul role="list" aria-label="Other OMP providers" className="mt-2 flex flex-col gap-1">
                  {other.map((provider) => (
                    <li key={provider.id} className="flex min-w-0 items-center justify-between gap-2">
                      <span className="truncate font-code text-xs" title={provider.id}>
                        {provider.id}
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <MinusIcon aria-hidden className="size-4" />
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
        <InlineStatus density="compact" className="p-0">
          OMP returned an empty provider list.
        </InlineStatus>
      ) : null}

      {status === 'error' && (
        <InlineStatus tone={total > 0 ? 'notice' : 'error'} density="compact" className="p-0">
          {total > 0 ? 'Could not refresh OMP providers. Showing the last result.' : 'Could not read OMP providers. OMP did not respond or returned an error.'}
        </InlineStatus>
      )}

      <div className="flex min-w-0 items-center justify-between gap-2">
        <InlineStatus density="compact" className="min-w-0 p-0">
          To sign in to another provider, run <code className="font-code">omp login</code> in a terminal.
        </InlineStatus>
        <CopyButton showLabel getText={() => 'omp login'} label="Copy command" announcement="Command copied to clipboard" />
      </div>
    </section>
  )
}
