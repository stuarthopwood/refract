import { useEffect, useRef, useState } from 'react'
import { CheckIcon, ChevronDownIcon, MinusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { CopyButton } from '@/components/ui/copy-button'
import { Skeleton } from '@/components/ui/skeleton'
import { InlineStatus } from '@/components/InlineStatus'
import { ScreenSection } from '@/components/ScreenSection'
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
      announcePolite(`Agent providers: ${freshSignedIn} of ${fresh.length} signed in`)
      checkAgainRef.current?.focus()
    } else {
      announceAssertive('Could not read the agent providers')
      checkAgainRef.current?.focus()
    }
  }

  return (
    <ScreenSection
      title="Agent provider sign-in"
      headingLevel={3}
      busy={initialLoading}
      note="Refract uses the model providers your local agent is signed in to. These are separate from your GitHub accounts."
      actions={
        <>
          {refreshing && total > 0 && (
            <InlineStatus tone="loading" density="compact" className="p-0">
              Checking…
            </InlineStatus>
          )}
          <Button
            ref={checkAgainRef}
            variant="text"
            size="sm"
            className="aria-disabled:opacity-50"
            aria-disabled={refreshing || undefined}
            onClick={() => {
              if (!refreshing) void handleRefresh()
            }}
          >
            Check again
          </Button>
        </>
      }
    >
      {initialLoading ? (
        <div className="flex flex-col gap-2">
          <InlineStatus tone="loading" density="compact" className="p-0">
            Checking agent providers…
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
            <ul role="list" aria-label="Signed-in agent providers" className="flex flex-col gap-1">
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
                <ul role="list" aria-label="Other agent providers" className="mt-2 flex flex-col gap-1">
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
          The agent returned an empty provider list.
        </InlineStatus>
      ) : null}

      {status === 'error' && (
        <InlineStatus tone={total > 0 ? 'notice' : 'error'} density="compact" className="p-0">
          {total > 0 ? 'Could not refresh the agent providers. Showing the last result.' : 'Could not read the agent providers. The agent did not respond or returned an error.'}
        </InlineStatus>
      )}

      <div className="flex min-w-0 items-center justify-between gap-2">
        <InlineStatus density="compact" className="min-w-0 p-0">
          To sign in to another provider, run <code className="font-code">omp login</code> in a terminal.
        </InlineStatus>
        <CopyButton showLabel getText={() => 'omp login'} label="Copy command" announcement="Command copied to clipboard" />
      </div>
    </ScreenSection>
  )
}
