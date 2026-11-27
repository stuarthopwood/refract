import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { formatByteSize } from '@/lib/formatBytes'
import { conversationTitle } from './conversationDelete'
import type { ConversationDelete } from './useConversationDelete'

/** Confirm, or explain why the picked Conversation cannot be deleted; shared by the header switcher and the Session row's list. */
export function ConversationDeleteDialog({ remove }: { remove: ConversationDelete }) {
  return (
    <ConfirmAlertDialog
      open={remove.target !== null}
      busy={false}
      title={remove.refusal ? 'This Conversation cannot be deleted' : `Delete “${remove.target ? conversationTitle(remove.target) : ''}”?`}
      description={
        remove.refusal ??
        `This removes the Conversation's history file and its attachments (${formatByteSize(remove.target?.sizeBytes ?? 0)}). It cannot be undone.`
      }
      confirmLabel={remove.refusal ? undefined : 'Delete'}
      tone="destructive"
      onCancel={remove.cancel}
      onConfirm={() => void remove.confirm()}
      onCloseAutoFocus={() => false}
    />
  )
}
