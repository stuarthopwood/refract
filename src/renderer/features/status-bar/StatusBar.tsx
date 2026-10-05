// Status bar (docs/DESIGN.md "Layout"): the T039 low-memory notice (contracts/ipc.md
// `memory:warning`, FR-037) and the omp-version notice (readiness.ts, health-store.ts) are the
// two always-visible controls here. The Approval mode switch this bar used to carry (T033)
// moved to the ApprovalModePill above the message box (MessageInput.tsx, T098, FR-056):
// Refract's Approval mode control lives there now, not here.
import { useState } from 'react'
import { AlertTriangleIcon } from 'lucide-react'
import { badgeVariants } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useHealthStore, useMemoryStore, useSessionsStore } from '@/state'

function pluralAgents(count: number): string {
  return `${count} agent${count === 1 ? '' : 's'} running`
}

export function StatusBar() {
  const warning = useMemoryStore((state) => state.warning)
  const ompVersionWarning = useHealthStore((state) => state.ompVersionWarning)
  const sessions = useSessionsStore((state) => state.sessions)
  const stopAgent = useSessionsStore((state) => state.stopAgent)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [ompOpen, setOmpOpen] = useState(false)

  const liveSessions = sessions.filter((session) => session.status !== 'stopped')

  return (
    <footer className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-3 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        {warning && (
          <Popover open={memoryOpen} onOpenChange={setMemoryOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  badgeVariants({ variant: 'outline' }),
                  'h-6 gap-1.5 border-state-needs-you/50 bg-state-needs-you/10 px-2.5 text-state-needs-you hover:bg-state-needs-you/20'
                )}
              >
                <AlertTriangleIcon aria-hidden className="size-3" />
                Low memory: {pluralAgents(warning.liveAgents)}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end">
              <p className="font-medium text-foreground">Free up memory</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Refract never stops an agent on its own. Stop one below to free memory.
              </p>
              {liveSessions.length === 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">No running agents.</p>
              ) : (
                <ul className="mt-3 flex flex-col gap-1">
                  {liveSessions.map((session) => (
                    <li key={session.id} className="flex items-center justify-between gap-2">
                      <span className="truncate text-foreground">{session.name}</span>
                      <Button size="xs" variant="outline" onClick={() => void stopAgent(session.id)}>
                        Stop agent
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </PopoverContent>
          </Popover>
        )}
        {ompVersionWarning && (
          <Popover open={ompOpen} onOpenChange={setOmpOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  badgeVariants({ variant: 'outline' }),
                  'h-6 gap-1.5 border-state-needs-you/50 bg-state-needs-you/10 px-2.5 text-state-needs-you hover:bg-state-needs-you/20'
                )}
              >
                <AlertTriangleIcon aria-hidden className="size-3" />
                omp {ompVersionWarning.found}: unverified version
              </button>
            </PopoverTrigger>
            <PopoverContent align="end">
              <p className="font-medium text-foreground">Unverified omp version</p>
              <p className="mt-1 text-xs text-muted-foreground">{ompVersionWarning.hint}</p>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </footer>
  )
}