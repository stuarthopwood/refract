// Issue #744 (spec 009 FR-041, FR-042): what makes a draft sendable, and the one-at-a-time rule
// for an image-only follow-up. Kept out of MessageInput.tsx (at its `check:file-size` baseline).
//
// Probe (2026-10-22, OMP 18.12.5): `prompt` with `message: ""` plus `images` is accepted and the
// model sees the image, so an image-only draft goes out with an empty message, never invented
// text. While a turn runs it queues as a follow-up that OMP's `queue_update` lists as
// `IMAGE_ONLY_QUEUE_TEXT`; `remove_queued_message`/`promote_queued_message` match it by `""`. Two
// such follow-ups could not be told apart, so only one may wait at a time.
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

/** True when `chip` is a queued image-only follow-up (FR-042). A typed follow-up reading exactly
 * "[Image]" is indistinguishable in OMP's queue and is treated the same way (accepted edge). */
function isImageOnlyChip(chip: DerivedChip): boolean {
  return chip.text === IMAGE_ONLY_QUEUE_TEXT
}

/** The chip's visible label: "Image (<filename>)" for the image-only follow-up ("Image" when the
 * names are unknown, e.g. it was queued before a reload). */
export function queuedChipDisplayText(chip: DerivedChip, imageOnlyNames: readonly string[] | undefined): string {
  if (isImageOnlyChip(chip)) return imageOnlyNames?.length ? `Image (${imageOnlyNames.join(', ')})` : 'Image'
  return stripFileAttachmentsMarkerForDisplay(chip.text)
}

/** The text `chat.removeQueued`/`chat.sendNow` must match: `""` for the image-only follow-up. */
export function queuedChipRpcText(chip: DerivedChip): string {
  return isImageOnlyChip(chip) ? '' : chip.text
}
