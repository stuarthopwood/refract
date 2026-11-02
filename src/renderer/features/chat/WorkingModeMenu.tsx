import { BellOffIcon, ListChecksIcon, MessagesSquareIcon, MousePointerClickIcon } from 'lucide-react'
import { ModePill, type ModePillItem } from '@/components/ModePill'
import { useSessionsStore } from '@/state'
import type { WorkingMode } from '../../../shared/workingMode'

const MODE_ITEMS: ModePillItem<WorkingMode>[] = [
  { value: 'interactive', label: 'Interactive', hint: 'Normal turns; you answer questions.', icon: MousePointerClickIcon },
  { value: 'plan', label: 'Plan mode', hint: 'Plans first. Restarts the Session to switch.', icon: ListChecksIcon },
  { value: 'grill', label: 'Grill mode', hint: 'Interviews you one question at a time before any code edits.', icon: MessagesSquareIcon },
  { value: 'away', label: 'Away mode', hint: 'Answers questions itself; denies approvals after 5 minutes.', icon: BellOffIcon }
]

/** Per-Session working-mode picker; Approval mode stays app-wide in its own pill. */
export function WorkingModeMenu({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore((state) => state.sessions.find((candidate) => candidate.id === sessionId))
  const currentMode = session?.workingMode ?? 'interactive'
  const pendingMode = session?.workingModePending ?? null
  const pendingItem = pendingMode ? MODE_ITEMS.find((item) => item.value === pendingMode) : undefined

  function handleSelect(mode: WorkingMode): void {
    if (mode === currentMode && !pendingMode) return
    window.refract.workingMode.set(sessionId, mode).catch((error: unknown) => {
      console.error('working mode change failed', error)
    })
  }

  return (
    <ModePill
      scope={sessionId}
      noun="working mode"
      items={MODE_ITEMS}
      value={currentMode}
      pendingLabel={pendingItem ? `${pendingItem.label} after this turn` : null}
      onSelect={handleSelect}
    />
  )
}
