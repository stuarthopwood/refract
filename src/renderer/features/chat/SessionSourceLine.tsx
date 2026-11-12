import { MessageSquareIcon } from 'lucide-react'
import { SourceTag } from '@/components/SourceTag'
import { useSessionsStore, useSplitStore } from '@/state'
import type { MessageSource } from '../../../shared/model'

interface SessionSourceLineProps {
  source: MessageSource
  /** False once the sender Session was deleted: the line then shows its id as plain text. */
  senderExists: boolean
  /** Names the line so the bubble can take its accessible name from it. */
  id: string
}

/** "From Session <name>" above a user turn another Session sent (#1858, ADR 0008). */
export function SessionSourceLine({ source, senderExists, id }: SessionSourceLineProps) {
  // `replaceFocused` swaps the visible pane (the sidebar row's own path); `open(id, true)` is the
  // user-initiated switch. No focus call, so focus never jumps.
  const action = senderExists
    ? {
        label: source.name,
        onActivate: () => {
          useSplitStore.getState().replaceFocused(source.sessionId)
          void useSessionsStore.getState().open(source.sessionId, true)
        }
      }
    : undefined
  return (
    <div id={id} className="mb-1 flex justify-end text-xs">
      <SourceTag icon={MessageSquareIcon} label={senderExists ? 'From Session' : `From Session ${source.sessionId}`} action={action} />
    </div>
  )
}
