import { BookmarkCheckIcon, HandIcon, PencilLineIcon, ZapIcon } from 'lucide-react'
import { ModePill, type ModePillItem } from '@/components/ModePill'
import { useSessionsStore, useSettingsStore } from '@/state'
import type { ApprovalMode } from '../../../shared/model'

const MODE_ITEMS: ModePillItem<ApprovalMode>[] = [
  { value: 'ask', label: 'Ask', hint: 'Prompts for file changes and commands.', icon: HandIcon },
  { value: 'ask-and-remember', label: 'Ask and remember', hint: 'Prompts for file reads, changes and commands; remembers the files and folders you approve.', icon: BookmarkCheckIcon },
  { value: 'edit-freely', label: 'Edit freely', hint: 'Prompts for commands only.', icon: PencilLineIcon },
  { value: 'auto', label: 'Auto', hint: 'Never prompts.', icon: ZapIcon }
]

export function ApprovalModePill({ sessionId }: { sessionId: string }) {
  const approvalMode = useSettingsStore((state) => state.settings.approvalMode)
  const setApprovalMode = useSettingsStore((state) => state.setApprovalMode)
  const session = useSessionsStore((state) => state.sessions.find((candidate) => candidate.id === sessionId))
  const isLive = session !== undefined && session.status !== 'stopped'
  const pendingMode = isLive ? session!.pendingMode : null
  const currentMode = isLive ? session!.launchedMode : approvalMode
  const pendingItem = pendingMode ? MODE_ITEMS.find((item) => item.value === pendingMode) : undefined

  function handleSelect(mode: ApprovalMode): void {
    if (mode === approvalMode) return
    void setApprovalMode(mode)
  }

  return (
    <ModePill
      scope={sessionId}
      noun="approval mode"
      items={MODE_ITEMS}
      value={currentMode}
      pendingLabel={pendingItem ? `${pendingItem.label} after this turn` : null}
      onSelect={handleSelect}
    />
  )
}
