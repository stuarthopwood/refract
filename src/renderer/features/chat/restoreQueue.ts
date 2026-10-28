// Spec 030 (#517): Stop returns every queued message to the composer. Shared by the Stop button
// and Ctrl+Shift+X so both behave the same (FR-006).
import { toast } from 'sonner'
import { IMAGE_ONLY_QUEUE_TEXT, notify, useDraftStore } from '@/state'
import type { StopResult } from '../../../shared/ipc'
import { SUPPORTED_IMAGE_MIME_TYPES } from '../../../shared/images'
import type { PendingImageAttachment } from './attachments'
import { remainingAttachmentSlots } from './attachDroppedPaths'

function toAttachment(image: StopResult['messages'][number]['images'][number]): PendingImageAttachment | null {
  if (!(SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(image.mimeType)) return null
  const padding = image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0
  return {
    kind: 'image',
    id: crypto.randomUUID(),
    mimeType: image.mimeType,
    base64: image.data,
    byteLength: Math.floor((image.data.length * 3) / 4) - padding,
    previewUrl: `data:${image.mimeType};base64,${image.data}`
  }
}

/** Appends the withdrawn messages below whatever the developer already typed (blank line
 * between), adds their images, announces the count and focuses the composer. */
export function restoreQueuedMessages(sessionId: string, restored: StopResult, focusComposer: () => void): void {
  // The "[Image]" placeholder is only dropped when the entry carries images (a real typed "[Image]" stays).
  const texts = restored.messages
    .filter((message) => message.text.trim() !== '' && !(message.text === IMAGE_ONLY_QUEUE_TEXT && message.images.length > 0))
    .map((message) => message.text)
  const accepted = restored.messages.flatMap((message) => message.images).map(toAttachment).filter((image): image is PendingImageAttachment => image !== null)
  const images = accepted.slice(0, remainingAttachmentSlots(sessionId))
  const count = Math.max(texts.length, images.length > 0 ? restored.messages.filter((message) => message.images.length > 0).length : 0)
  if (count > 0) {
    const store = useDraftStore.getState()
    const existing = store.bySession[sessionId]?.text ?? ''
    if (texts.length > 0) store.setText(sessionId, [existing.trimEnd(), ...texts].filter((part) => part !== '').join('\n\n'))
    if (images.length > 0) store.setAttachments(sessionId, (prev) => ({ ...prev, images: [...prev.images, ...images] }))
    store.announceAttachment(sessionId, `${count} queued ${count === 1 ? 'message' : 'messages'} returned to the editor.`)
    focusComposer()
  }
  if (images.length < accepted.length) toast.warning('Some restored images did not fit the attachment limit and were not returned.')
  if (restored.imagesDropped) toast.warning('Images in the returned queued messages were too large to restore and were dropped.')
  if (restored.truncated) toast.warning('Some queued messages were too large to restore and were not returned.')
}

export async function stopAndRestore(sessionId: string, focusComposer: () => void): Promise<void> {
  const result = await window.refract.chat.stop(sessionId)
  if (!result.ok) {
    notify(result.error)
    return
  }
  restoreQueuedMessages(sessionId, result.value, focusComposer)
}
