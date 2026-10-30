import { IMAGE_ONLY_QUEUE_TEXT } from '@/state'
import type { AttachmentsState, PendingImageAttachment } from './attachments'
import type { DerivedChip } from './queuedChips'
import { stripFileAttachmentsMarkerForDisplay } from './anyFileAttachments'

export const SECOND_IMAGE_ONLY_REFUSAL =
  'Only one image-only message can wait in the queue. Add some text, or send this once the queued image has gone.'

/** FR-041: the ONE predicate Enter, the Send button's `aria-disabled` and its click all use. */
export function hasSendableContent(text: string, attachments: AttachmentsState): boolean {
  return text.trim() !== '' || attachments.images.length > 0
}

export function isImageOnlyDraft(text: string, attachments: AttachmentsState): boolean {
  return text.trim() === '' && attachments.images.length > 0
}

export function isImageOnlyQueued(followUp: readonly string[], steering: readonly string[]): boolean {
  return followUp.includes(IMAGE_ONLY_QUEUE_TEXT) || steering.includes(IMAGE_ONLY_QUEUE_TEXT)
}

export function imageDisplayNames(images: readonly PendingImageAttachment[]): string[] {
  return images.map((image) => image.name ?? 'pasted image')
}

function isImageOnlyChip(chip: DerivedChip): boolean {
  return chip.text === IMAGE_ONLY_QUEUE_TEXT
}

export function queuedChipDisplayText(chip: DerivedChip, imageOnlyNames: readonly string[] | undefined): string {
  if (isImageOnlyChip(chip)) return imageOnlyNames?.length ? `Image (${imageOnlyNames.join(', ')})` : 'Image'
  return stripFileAttachmentsMarkerForDisplay(chip.text)
}

/** The text `chat.removeQueued`/`chat.sendNow` must match: `""` for the image-only follow-up. */
export function queuedChipRpcText(chip: DerivedChip): string {
  return isImageOnlyChip(chip) ? '' : chip.text
}
