// Status bar (docs/DESIGN.md "Layout": "A status bar along the bottom carries the app-wide
// Approval mode switch."; CONTEXT.md "Approval mode": Ask/Edit freely/Auto, reads are never
// prompted). T033 (the switch) and the T039 low-memory notice (contracts/ipc.md
// `memory:warning`, FR-037) share this bar because both are small, always-visible controls.
import { useState } from 'react'
import { AlertTriangleIcon } from 'lucide-react'
import { badgeVariants } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useMemoryStore, useSessionsStore, useSettingsStore } from '@/state'
import type { ApprovalMode } from '../../../shared/model'

const MODE_ITEMS: Array<{ value: ApprovalMode; label: string; hint: string }> = [
  { value: 'ask', label: 'Ask', hint: 'Prompts for file changes and commands. Reads are never prompted.' },
  { value: 'edit-freely', label: 'Edit freely', hint: 'Prompts for commands only. Reads and file changes are never prompted.' },
  { value: 'auto', label: 'Auto', hint: 'Never prompts. Reads are never prompted either way.' }
]

function pluralAgents(count: number): string {
  return `${count} agent${count === 1 ? '' : 's'} running`
}

export function StatusBar() {
  const approvalMode = useSettingsStore((state) => state.settings.approvalMode)
  const setApprovalMode = useSettingsStore((state) => state.setApprovalMode)
  const warning = useMemoryStore((state) => state.warning)
  const sessions = useSessionsStore((state) => state.sessions)
  const stopAgent = useSessionsStore((state) => state.stopAgent)
  const [memoryOpen, setMemoryOpen] = useState(false)

  const liveSessions = sessions.filter((session) => session.status !== 'stopped')

  function handleModeChange(value: string): void {
    // ToggleGroup type="single" deselects on a repeat click; Approval mode always has a value.
    if (!value) return
    void setApprovalMode(value as ApprovalMode)
  }

  return (
    <footer className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-3 text-xs text-muted-foreground">
      <ToggleGroup type="single" size="sm" value={approvalMode} onValueChange={handleModeChange} aria-label="Approval mode">
        {MODE_ITEMS.map((item) => (
          <Tooltip key={item.value}>
            <TooltipTrigger asChild>
              <ToggleGroupItem value={item.value} aria-label={item.label}>
                {item.label}
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>{item.hint}</TooltipContent>
          </Tooltip>
        ))}
      </ToggleGroup>

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
    </footer>
  )
}
