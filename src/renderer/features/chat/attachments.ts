// Composer attachments (spec 009): pending images and oversized-text chips held only in the
// renderer's own memory for the draft currently being composed (data-model.md "Held in memory").
// Pure types and helpers; MessageInput.tsx owns the actual state and wiring, AttachmentStrip.tsx
// and the preview modals own the presentation.
import type { ImageContent, SupportedImageMimeType } from '../../../shared/frames'
import { LARGE_PASTE_CHIP_THRESHOLD, MAX_IMAGE_INPUT_BYTES, SUPPORTED_IMAGE_MIME_TYPES } from '../../../shared/images'

export interface PendingImageAttachment {
  kind: 'image'
  id: string // uuid, local only, never sent
  mimeType: SupportedImageMimeType
  base64: string // exactly the payload sent as ImageContent.data
  byteLength: number // decoded size; already checked against MAX_IMAGE_INPUT_BYTES
  previewUrl: string // `data:${mimeType};base64,${base64}`, used for the thumbnail and the modal
}

export interface PendingTextChip {
  kind: 'text-chip'
  id: string // uuid, local only
  text: string // full original pasted text, byte-for-byte, never modified
  label: string // literal substring inserted into the textarea's own value at the paste position
}

export interface AttachmentsState {
  images: PendingImageAttachment[]
  textChips: PendingTextChip[]
}

export const EMPTY_ATTACHMENTS: AttachmentsState = { images: [], textChips: [] }

function isSupportedImageMimeType(value: string): value is SupportedImageMimeType {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(value)
}

/** A standard Chromium paste yields at most one image representation per event (research.md
 * Decision 7); an image representation always wins over a plain-text one when both are present
 * (Edge Cases) -- callers check this before ever looking at `getData('text/plain')`. */
export function findClipboardImageItem(data: DataTransfer): File | null {
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) return file
    }
  }
  return null
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

function base64FromDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
}

/** Re-encodes anything that isn't already PNG/JPEG/GIF/WebP to PNG via an off-screen canvas
 * (FR-002; research.md Decision 7): Refract never relies on OMP's own fallback/conversion for an
 * unsupported source format. Throws on a paste that cannot even be decoded as an image (corrupt
 * data, an unsupported binary format) -- the caller turns that into the Edge Cases' inline error. */
async function reencodeToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context unavailable')
    ctx.drawImage(bitmap, 0, 0)
    const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!pngBlob) throw new Error('canvas.toBlob produced no PNG blob')
    return pngBlob
  } finally {
    bitmap.close()
  }
}

export type ImageAttachResult =
  | { ok: true; attachment: PendingImageAttachment }
  | { ok: false; reason: 'too-large'; byteLength: number }
  | { ok: false; reason: 'decode-failed' }

/** Validates and, if needed, re-encodes a pasted image `File` into a `PendingImageAttachment`
 * (FR-001 to FR-003). The 20 MiB cap is checked against the blob actually about to be sent (after
 * any re-encode), never the original source's size, and Refract never attempts to shrink an
 * over-cap image to fit (FR-003) -- it is rejected outright. */
export async function buildImageAttachment(file: File): Promise<ImageAttachResult> {
  let blob: Blob = file
  let mimeType: string = file.type
  try {
    if (!isSupportedImageMimeType(mimeType)) {
      blob = await reencodeToPng(blob)
      mimeType = 'image/png'
    }
  } catch {
    return { ok: false, reason: 'decode-failed' }
  }
  if (blob.size > MAX_IMAGE_INPUT_BYTES) return { ok: false, reason: 'too-large', byteLength: blob.size }
  let dataUrl: string
  try {
    dataUrl = await readAsDataUrl(blob)
  } catch {
    return { ok: false, reason: 'decode-failed' }
  }
  const base64 = base64FromDataUrl(dataUrl)
  return {
    ok: true,
    attachment: {
      kind: 'image',
      id: crypto.randomUUID(),
      mimeType: mimeType as SupportedImageMimeType,
      base64,
      byteLength: blob.size,
      previewUrl: dataUrl
    }
  }
}

/** FR-006: the wire-level shape sent as one entry of the outgoing command's `images` array. */
export function toImageContent(attachment: PendingImageAttachment): ImageContent {
  return { type: 'image', data: attachment.base64, mimeType: attachment.mimeType }
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const LABEL_FIRST_LINE_MAX = 40

/** `PendingTextChip.label` (data-model.md "Rules"): the first line of the pasted text, truncated
 * to a readable length, plus a character count, with a disambiguating index appended when it
 * would otherwise collide with another pending chip's label (e.g. two pastes of the same short
 * function each producing the same label). */
export function buildChipLabel(text: string, existingLabels: ReadonlySet<string>): string {
  const firstLine = text.split('\n', 1)[0] ?? ''
  const truncated = firstLine.length > LABEL_FIRST_LINE_MAX ? `${firstLine.slice(0, LABEL_FIRST_LINE_MAX)}…` : firstLine
  const base = `${truncated} (${text.length} chars)`
  if (!existingLabels.has(base)) return base
  let index = 2
  while (existingLabels.has(`${base} #${index}`)) index++
  return `${base} #${index}`
}

/** FR-010, FR-011: over the threshold collapses to a chip; at or under it, paste exactly as
 * today. */
export function isLargePaste(text: string): boolean {
  return text.length > LARGE_PASTE_CHIP_THRESHOLD
}

/** FR-014, Edge Cases: a chip is dropped the moment its label no longer appears intact in the
 * draft -- an explicit delete and an edit that breaks the label are both covered the same way,
 * since `label` is also the correlation/editing-detection key (data-model.md, research.md
 * Decision 10). */
export function pruneDanglingChips(text: string, chips: readonly PendingTextChip[]): PendingTextChip[] {
  return chips.filter((chip) => text.includes(chip.label))
}

/** FR-013, FR-015: substitutes every still-pending chip's full original text back into the draft
 * at its own current position, independently of the others and of their order -- each chip looks
 * up its own label's current index at the moment it is processed, so an earlier substitution
 * shifting the string never corrupts a later chip's own replacement. */
export function substituteChips(message: string, chips: readonly PendingTextChip[]): string {
  let result = message
  for (const chip of chips) {
    const index = result.indexOf(chip.label)
    if (index === -1) continue // already dropped (Edge Cases); nothing to substitute
    result = result.slice(0, index) + chip.text + result.slice(index + chip.label.length)
  }
  return result
}

export interface ChipOccurrence {
  chip: PendingTextChip
  start: number
  end: number
}

/** Every pending chip's current position in `text` (research.md Decision 10: the label is the
 * correlation key, so its live `indexOf` is also the overlay's own position), sorted left to
 * right for the overlay renderer below. */
export function findChipOccurrences(text: string, chips: readonly PendingTextChip[]): ChipOccurrence[] {
  const occurrences: ChipOccurrence[] = []
  for (const chip of chips) {
    const start = text.indexOf(chip.label)
    if (start === -1) continue
    occurrences.push({ chip, start, end: start + chip.label.length })
  }
  return occurrences.sort((a, b) => a.start - b.start)
}
