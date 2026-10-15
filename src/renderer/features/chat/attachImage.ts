// Gate round 2 (code-reviewer LOW): `attachImageFile` lives in its own module, outside the
// import cycle `attachments.ts` would otherwise have with `state/draft-store.ts` -- that file
// needs `@/state` (`notify`, `useDraftStore`), and `draft-store.ts` imports types FROM
// `attachments.ts`, so having both directions in one file worked only because `@/state` happened
// to load first; any entry point loading `attachments.ts` first (a future unit test, say) would
// hit a load-time ReferenceError. This file only imports FROM `attachments.ts` and `@/state`,
// never the other way, so it adds no cycle.
import { buildImageAttachment, formatByteSize } from './attachments'
import { notify, useDraftStore } from '@/state'
import { MAX_IMAGE_INPUT_BYTES } from '../../../shared/images'

/** Validates `file` via `buildImageAttachment` and either toasts the rejection reason or commits
 * the resulting attachment to the draft store and announces it -- the single path both a pasted
 * clipboard image (`MessageInput.tsx`'s own `handlePaste`) and the composer's Attach button
 * (`ComposerPickers.tsx`'s `AttachButton`) go through, so neither the toast wording nor the
 * draft-store write can drift between the two (gate round 1, code-reviewer MEDIUM finding: they
 * used to be two independent four-line copies of this exact sequence). */
export async function attachImageFile(sessionId: string, file: File): Promise<void> {
  const result = await buildImageAttachment(file)
  if (!result.ok) {
    notify({
      code: result.reason === 'too-large' ? 'image-too-large' : 'invalid-argument',
      message:
        result.reason === 'too-large'
          ? `Image is too large to attach (over the ${formatByteSize(MAX_IMAGE_INPUT_BYTES)} limit); nothing was attached.`
          : 'That image could not be read; nothing was attached.'
    })
    return
  }
  useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, images: [...prev.images, result.attachment] }))
  useDraftStore.getState().announceAttachment(sessionId, `Image attached, ${formatByteSize(result.attachment.byteLength)}.`)
}
