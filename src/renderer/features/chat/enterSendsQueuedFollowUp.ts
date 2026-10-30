import type { AttachmentsState } from './attachments'
import type { DerivedChip } from './queuedChips'

/** Discriminated on `applies` so `chip` is only reachable on the `true` branch. */
export type EnterSendsQueuedFollowUp = { applies: true; chip: DerivedChip } | { applies: false }

/** Whether Enter on a blank composer should send the oldest queued follow-up, and which chip. Blank means exactly `''` with no attachments or reads in flight; steering chips are skipped. */
export function computeEnterSendsQueuedFollowUp(
  text: string,
  attachments: AttachmentsState,
  pendingAttachmentReads: number,
  chips: readonly DerivedChip[],
  showSlashMenu: boolean,
  ghost: { text: string } | null,
  disabled: boolean
): EnterSendsQueuedFollowUp {
  if (disabled) return { applies: false }
  const isBlank =
    text === '' &&
    attachments.images.length === 0 &&
    attachments.textChips.length === 0 &&
    attachments.files.length === 0 &&
    pendingAttachmentReads === 0
  if (showSlashMenu || (ghost && ghost.text === text) || !isBlank) return { applies: false }
  const chip = chips.find((c) => c.queue === 'followUp')
  return chip ? { applies: true, chip } : { applies: false }
}
