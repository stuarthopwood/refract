import { MessageSquareIcon } from 'lucide-react'
import { SourceTag } from '@/components/SourceTag'

/** Label above the first message of a Conversation an agent opened with its own note (#1861). */
export function HandoffNoteLine({ id }: { id: string }) {
  return (
    <div id={id} className="mb-1 flex justify-end text-xs">
      <SourceTag icon={MessageSquareIcon} label="Handoff note from the previous Conversation" />
    </div>
  )
}
