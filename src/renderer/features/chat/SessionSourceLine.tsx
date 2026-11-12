import { MessageSquareIcon } from 'lucide-react'
import { SourceTag } from '@/components/SourceTag'
import { focusSessionPane } from '@/lib/focus'
import { useSessionsStore, useSplitStore } from '@/state'
import type { MessageSource } from '../../../shared/model'

interface SessionSourceLineProps {
  source: MessageSource
  /** Names the line so the bubble can take its accessible name from it. */
  id: string
}

/** "From Session <name>" above a user turn another Session sent (#1858, ADR 0008). */
export function SessionSourceLine({ source, id }: SessionSourceLineProps) {
  // Looked up here, not in the row, so ordinary user turns never subscribe to the sessions list.
  const senderExists = useSessionsStore((state) => state.sessions.some((s) => s.id === source.sessionId))
  // `replaceFocused` swaps the visible pane (the sidebar row's own path); `open(id, true)` is the
  // user-initiated switch. The click leaves focus on a button that is about to unmount, so it is
  // moved to the new pane once that has rendered.
  const action = senderExists
    ? {
        label: source.name,
        ariaLabel: `Open Session ${source.name}`,
        onActivate: () => {
          useSplitStore.getState().replaceFocused(source.sessionId)
          void useSessionsStore.getState().open(source.sessionId, true)
          requestAnimationFrame(() => focusSessionPane(source.sessionId))
        }
      }
    : undefined
  return (
    <div id={id} className="mb-1 flex justify-end text-xs">
      <SourceTag icon={MessageSquareIcon} label={senderExists ? 'From Session' : `From Session ${source.name} (deleted)`} action={action} />
    </div>
  )
}
